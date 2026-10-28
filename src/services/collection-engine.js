import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import { v4 as uuidv4 } from 'uuid';

// Per-protocol throughput settings. Limits follow each provider's documented ceilings:
// Graph allows 4 concurrent requests per mailbox; Gmail allows 15,000 quota units per user per minute
// (messages.get = 5, so at most 50 messages/s) and starts at half that, slowing further if refused;
// EWS GetItem is batched like FEC's BindToItems, IMAP uses parallel sessions with range FETCH.
// batchBytes caps a batch by server-reported size so one connection never vanishes into a huge batch.
export const COLLECTION_PROFILES = {
  imap:      { workers: 4, perWorkerConnection: true, batchSize: 50, batchBytes: 4 * 1024 * 1024 },
  pop3:      { workers: 1, perWorkerConnection: false, batchSize: 10, batchBytes: 4 * 1024 * 1024 },
  gmail_api: { workers: 8, perWorkerConnection: false, batchSize: 1, ratePerSec: 25 },
  graph:     { workers: 4, perWorkerConnection: false, batchSize: 1 },
  ews:       { workers: 4, perWorkerConnection: false, batchSize: 20, batchBytes: 8 * 1024 * 1024 },
};

function makeBatches(refs, maxItems, maxBytes) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const ref of refs) {
    if (cur.length && (cur.length >= maxItems || (maxBytes && bytes + (ref.size || 0) > maxBytes))) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(ref);
    bytes += ref.size || 0;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export function supportsEngine(protocol) {
  return Object.prototype.hasOwnProperty.call(COLLECTION_PROFILES, protocol);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXTRA_CONNECTION_WAIT_MS = 20000;
const MAX_RETRY_AFTER_MS = 120000;
// Items that still fail after their own retries are tried again once the rest of the mailbox is done, in
// up to FINAL_RETRY_ROUNDS rounds. Each round tries every remaining item once after a short pause, so a
// quota or a dropped session has time to clear between tries.
const FINAL_RETRY_ROUNDS = 50;
const FINAL_RETRY_DELAY_MS = Number(process.env.SHERLOCKMAIL_FINAL_RETRY_DELAY_MS) || 5000;
// When a provider refuses a request for its rate quota, every worker pauses for one quota window (Gmail
// counts per minute) unless the provider says how long to wait. Waiting for quota is not a failed
// attempt; items fail only once the provider has refused every request for THROTTLE_GIVE_UP_MS.
const THROTTLE_PAUSE_MS = Number(process.env.SHERLOCKMAIL_THROTTLE_PAUSE_MS) || 60000;
const THROTTLE_GIVE_UP_MS = Number(process.env.SHERLOCKMAIL_THROTTLE_GIVE_UP_MS) || 15 * 60000;
const MIN_RATE_PER_SEC = 2;

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// onThrottle(err) handles errors marked `throttled` (a provider's rate quota): it waits out the quota and
// returns true to try again without using up an attempt, or false to give up.
export async function withRetry(fn, { attempts = 4, baseMs = 500, maxMs = 30000, onRetry, onThrottle, signal } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err.throttled && onThrottle && !signal?.aborted) {
        if (await onThrottle(err)) { attempt--; continue; }
        break;
      }
      if (err.permanent || attempt === attempts) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = err.retryAfterMs != null
        ? Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS)
        : backoff / 2 + Math.random() * (backoff / 2);
      if (onRetry) await onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Paces requests for all workers together (perSec 0: no pacing) and waits out provider quotas. A quota
// refusal pauses every worker and halves the rate; the rate then creeps back up while requests succeed.
class Pacer {
  constructor(perSec = 0) {
    this.maxPerSec = perSec;
    this.perSec = perSec;
    this.nextSlot = 0;
    this.pausedUntil = 0;
    this.refusedSince = null; // first refusal since the last successful request
    this.successes = 0;
  }

  async take(signal) {
    for (;;) {
      if (signal?.aborted) return;
      const now = Date.now();
      if (now < this.pausedUntil) {
        await abortableSleep(this.pausedUntil - now, signal);
        continue;
      }
      if (!this.perSec) return;
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + 1000 / this.perSec;
      if (slot > now) await abortableSleep(slot - now, signal);
      // A pause that began while this worker waited for its slot applies to it too.
      if (Date.now() >= this.pausedUntil) return;
    }
  }

  async waitForPause(signal) {
    const ms = this.pausedUntil - Date.now();
    if (ms > 0) await abortableSleep(ms, signal);
  }

  succeeded() {
    this.refusedSince = null;
    if (!this.perSec || this.perSec >= this.maxPerSec) return;
    // Additive increase: one request/s more after about 30 s without a refusal.
    if (++this.successes >= this.perSec * 30) {
      this.perSec = Math.min(this.maxPerSec, this.perSec + 1);
      this.successes = 0;
    }
  }

  // Returns the new pause, or null when already pausing: requests that were in flight when the first
  // refusal arrived are refused too and must not halve the rate again.
  refused(pauseMs) {
    const now = Date.now();
    this.refusedSince ??= now;
    if (now < this.pausedUntil) return null;
    if (this.perSec) this.perSec = Math.max(Math.min(MIN_RATE_PER_SEC, this.maxPerSec), this.perSec / 2);
    this.pausedUntil = now + pauseMs;
    this.successes = 0;
    return { pauseMs, perSec: this.perSec };
  }

  exhausted() {
    return this.refusedSince != null && Date.now() - this.refusedSince >= THROTTLE_GIVE_UP_MS;
  }
}

const formatRate = perSec => (Number.isInteger(perSec) ? String(perSec) : perSec.toFixed(1));

function quotaGiveUpError(err) {
  const minutes = Math.round(THROTTLE_GIVE_UP_MS / 60000);
  const waited = minutes >= 1 ? `${minutes} min` : `${Math.round(THROTTLE_GIVE_UP_MS / 1000)} s`;
  const e = new Error(`${err?.message || 'Rate quota exceeded'} (the server refused every request for ${waited}; not collected)`);
  e.quotaGiveUp = true;
  return e;
}

function withNote(err, note) {
  const e = new Error(`${err?.message || 'Failed'} (${note})`);
  e.cause = err;
  return e;
}

// Shared handling of a quota refusal: pause everyone, report it once per pause, and wait. Returns false
// once the provider has refused everything for THROTTLE_GIVE_UP_MS.
async function waitOutQuota(pacer, err, { signal, progress, onThrottle }) {
  const pauseMs = err.retryAfterMs != null ? Math.min(Math.max(err.retryAfterMs, 1000), MAX_RETRY_AFTER_MS) : THROTTLE_PAUSE_MS;
  pacer.lastRefusal = err;
  const pause = pacer.refused(pauseMs);
  if (pacer.exhausted()) return false;
  if (pause && progress) {
    const detail = `Quota reached: pausing all requests for ${Math.round(pauseMs / 1000)} s`
      + (pause.perSec ? `, then continuing at ${formatRate(pause.perSec)} requests/s` : '');
    progress.throttlePauses = (progress.throttlePauses || 0) + 1;
    progress.quotaPausedUntil = pacer.pausedUntil;
    progress.statusDetail = detail;
    onThrottle?.({ message: err.message, pauseMs, perSec: pause.perSec, detail });
  }
  await pacer.waitForPause(signal);
  if (progress && progress.statusDetail?.startsWith('Quota reached') && Date.now() >= pacer.pausedUntil) progress.statusDetail = '';
  return !signal?.aborted;
}

const PARSER_OPTIONS = { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true };

function addressList(field) {
  return [].concat(field || []).flatMap(o => o?.value || []).map(a => a.address).filter(Boolean);
}

function isoOrNull(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function htmlToPlain(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function hashHex(algo, buf) {
  return crypto.createHash(algo).update(buf).digest('hex');
}

export async function buildMessageRecord(raw, extra = {}) {
  let parsed = null;
  try {
    parsed = await simpleParser(raw, PARSER_OPTIONS);
  } catch {
    // Unparseable MIME is still evidence: keep the raw bytes and hashes.
  }
  const attachments = (parsed?.attachments || []).map(att => {
    const rec = {
      id: uuidv4(),
      filename: att.filename || 'unnamed',
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      hashMd5: hashHex('md5', att.content),
      hashSha256: hashHex('sha256', att.content),
      disposition: att.contentDisposition || 'attachment',
      contentId: att.contentId || null,
      isInline: att.contentDisposition === 'inline',
    };
    // The decoded bytes ride along (not enumerable, so never serialized or stored) until the
    // collection decides whether to save attachments as files; then they are dropped.
    Object.defineProperty(rec, 'content', { value: att.content, enumerable: false, configurable: true, writable: true });
    return rec;
  });

  return {
    id: uuidv4(),
    subject: parsed?.subject || '(no subject)',
    fromAddress: parsed?.from?.text || '',
    toAddresses: addressList(parsed?.to),
    ccAddresses: addressList(parsed?.cc),
    bccAddresses: addressList(parsed?.bcc),
    date: isoOrNull(parsed?.date) || isoOrNull(extra.internalDate) || new Date().toISOString(),
    messageId: parsed?.messageId || null,
    inReplyTo: parsed?.inReplyTo || null,
    size: raw.length,
    flags: [],
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    contentType: parsed?.headers?.get('content-type')?.value || 'text/plain',
    hashMd5: hashHex('md5', raw),
    hashSha256: hashHex('sha256', raw),
    hashSha512: hashHex('sha512', raw),
    bodyText: parsed?.text || (parsed?.html ? htmlToPlain(parsed.html) : ''),
    bodyHtml: parsed?.html || '',
    headers: Object.fromEntries(parsed?.headers || []),
    attachments,
    rawMime: raw,
    ...extra,
  };
}

// Rolling throughput (EWMA over 1s samples) so the ETA tracks the current rate
// instead of an all-time average skewed by connection setup and enumeration.
const WARMUP_SAMPLES = 5;
const MIN_COLLECT_MS_FOR_ETA = 2000;

// ETA works in "units": each item weighs its server-reported size when sizes are known, so a
// mailbox whose large attachments sit in one folder doesn't make an item-count ETA swing wildly.
function startRateTracker(progress, onTick) {
  const KEYS = ['done', 'units', 'bytes'];
  let start = null;
  let last = null;
  let rates = null;
  let samples = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const cur = {
      t: now,
      done: progress.acquired + progress.failed + progress.skipped,
      units: progress.unitsDone || 0,
      bytes: progress.bytesDone || 0,
    };
    progress.elapsedMs = now - progress.startedAt;
    if (progress.quotaPausedUntil > now) {
      // Waiting for a provider quota: no meaningful rate or time remaining, and the pause must not drag
      // down the rate measured once requests resume.
      progress.itemsPerSec = 0;
      progress.estimateMs = progress.estimateItemsMs = progress.estimatedFinishAt = null;
    } else if (progress.phase === 'collecting') {
      if (!start) {
        start = cur;
      } else {
        samples++;
        const span = (now - start.t) / 1000;
        const dt = (now - last.t) / 1000;
        // Cumulative average while warming up (one slow first second would otherwise dominate), EWMA after.
        if (samples <= WARMUP_SAMPLES || !rates) {
          rates = Object.fromEntries(KEYS.map(k => [k, (cur[k] - start[k]) / span]));
        } else {
          for (const k of KEYS) rates[k] = 0.3 * ((cur[k] - last[k]) / dt) + 0.7 * rates[k];
        }
        progress.itemsPerSec = Math.round(rates.done * 10) / 10;
        progress.bytesPerSec = Math.round(rates.bytes);
        if (now - start.t >= MIN_COLLECT_MS_FOR_ETA) {
          const remainingUnits = Math.max(0, (progress.totalUnits || 0) - cur.units);
          const remainingItems = Math.max(0, progress.total - cur.done);
          progress.estimateMs = rates.units > 0 ? Math.round((remainingUnits / rates.units) * 1000) : null;
          progress.estimateItemsMs = rates.done > 0 ? Math.round((remainingItems / rates.done) * 1000) : null;
          progress.estimatedFinishAt = progress.estimateMs != null ? now + progress.estimateMs : null;
        }
      }
    }
    last = cur;
    onTick?.();
  }, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Lower rank = better home for a message that appears under several Gmail labels or folders.
function folderRank(folder) {
  const f = String(folder).replace(/^\[Gmail\]\//i, '').toLowerCase();
  if (f === 'inbox') return 0;
  if (/^sent( mail)?$/.test(f)) return 1;
  if (/^drafts?$/.test(f)) return 2;
  if (f === 'chat' || f === 'chats') return 3;
  if (f === 'spam' || f === 'junk') return 4;
  if (f === 'trash' || f === 'bin') return 5;
  if (f === 'all mail' || f === 'all_mail') return 9;
  if (/^(important|starred|unread)$/.test(f) || f.startsWith('category_')) return 8;
  return 6;
}

// Gmail labels are tags on one message, not copies: refs sharing a globalKey are collected once,
// filed under their best folder, and keep the full list of folders/labels they appeared in.
function mergeLabelDuplicates(listings) {
  const groups = new Map();
  for (const listing of listings) {
    for (const ref of listing.refs) {
      if (!ref.globalKey) continue;
      const rank = folderRank(listing.folder);
      const g = groups.get(ref.globalKey);
      if (!g) groups.set(ref.globalKey, { ref, rank, folders: [listing.folder] });
      else {
        g.folders.push(listing.folder);
        if (rank < g.rank) { g.ref = ref; g.rank = rank; }
      }
    }
  }
  let merged = 0;
  for (const listing of listings) {
    listing.refs = listing.refs.filter(ref => {
      if (!ref.globalKey) return true;
      const g = groups.get(ref.globalKey);
      if (g.ref !== ref) { merged++; return false; }
      ref.folderPaths = [listing.folder, ...g.folders.filter(f => f !== listing.folder)];
      return true;
    });
  }
  return merged;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function assignWeights(refs, progress) {
  const sized = refs.filter(r => r.size > 0);
  const useBytes = refs.length > 0 && sized.length >= refs.length * 0.9;
  const avg = sized.length ? sized.reduce((s, r) => s + r.size, 0) / sized.length : 1;
  let total = 0;
  for (const r of refs) {
    r.weight = useBytes ? (r.size > 0 ? r.size : avg) : 1;
    total += r.weight;
  }
  progress.etaBasis = useBytes ? 'bytes' : 'items';
  progress.totalUnits = total;
  progress.unitsDone = 0;
  progress.totalBytesEstimate = useBytes ? Math.round(total) : null;
}

/**
 * Lists every selected folder (with any server-side criteria) and merges Gmail label copies, without
 * downloading anything. Used by the collection itself and by the pre-collection estimate.
 */
export async function enumerateFolders({ primary, folders, limit = 0, searchCriteria, progress, signal, onFolderError, pacer = new Pacer(), onThrottle }) {
  const listings = [];
  const folderErrors = [];
  for (const [index, folder] of folders.entries()) {
    if (signal?.aborted) {
      if (progress) progress.foldersNotListed = folders.slice(index);
      break;
    }
    if (progress) {
      progress.currentFolder = folder;
      progress.statusDetail = `Listing ${folder} (folder ${index + 1} of ${folders.length})`;
    }
    try {
      const { key, refs } = await withRetry(() => primary.enumerate(folder, { limit, searchCriteria }), {
        attempts: 3, signal, onThrottle: err => waitOutQuota(pacer, err, { signal, progress, onThrottle }),
      });
      pacer.succeeded();
      listings.push({ folder, key, refs });
      if (progress) progress.total += refs.length;
    } catch (caught) {
      const err = caught.throttled && pacer.exhausted() ? quotaGiveUpError(caught) : caught;
      folderErrors.push({ folder, error: err });
      onFolderError?.(folder, err);
    }
  }
  const rawTotal = listings.reduce((s, l) => s + l.refs.length, 0);
  const duplicatesMerged = mergeLabelDuplicates(listings);
  return { listings, rawTotal, duplicatesMerged, folderErrors };
}

/**
 * Handler contract: enumerate(folder, opts) -> { key, refs: [{ key, uid, serviceId? }] },
 * fetchBatch(key, refs) -> [{ ref, raw: Buffer, meta }]; optional ensureConnected(),
 * cloneForWorker() (required when the profile uses a connection per worker).
 */
export async function runCollection({
  protocol, primary, folders, limit = 0, searchCriteria, progress,
  onRecord, onFailure, onFolderError, onTick, onThrottle, onDeferred, onRetryRound, overrides = {}, signal,
}) {
  const profile = { ...COLLECTION_PROFILES[protocol] };
  if (overrides.workers > 0) profile.workers = Math.min(overrides.workers, 16);
  const stopTracker = startRateTracker(progress, onTick);
  const extraHandlers = [];
  progress.bytesDone = progress.bytesDone || 0;
  progress.deferred = 0;
  const pacer = new Pacer(profile.ratePerSec || 0);
  const throttle = err => waitOutQuota(pacer, err, { signal, progress, onThrottle });

  try {
    progress.phase = 'enumerating';
    const queue = [];
    const folderTotals = {};
    const { listings, duplicatesMerged, folderErrors } = await enumerateFolders({
      primary, folders, limit, searchCriteria, progress, signal, onFolderError, pacer, onThrottle,
    });
    for (const { folder } of folderErrors) folderTotals[folder] = 0;
    progress.duplicatesMerged = duplicatesMerged;
    progress.total = 0;
    for (const { folder, key, refs } of listings) {
      folderTotals[folder] = refs.length;
      progress.total += refs.length;
      shuffle(refs);
      for (const batch of makeBatches(refs, profile.batchSize, profile.batchBytes)) queue.push({ folder, key, refs: batch });
    }
    // Random order keeps throughput stationary: mailboxes cluster large attachments by folder and date,
    // so collecting in server order makes any rate-based ETA wrong until the clusters are reached.
    shuffle(queue);
    assignWeights(queue.flatMap(j => j.refs), progress);
    const settle = ref => { progress.unitsDone += ref.weight || 1; };

    const handlers = [primary];
    if (profile.perWorkerConnection && profile.workers > 1 && queue.length > 1) {
      const wanted = Math.min(profile.workers, queue.length) - 1;
      progress.statusDetail = `Opening ${wanted} additional connection(s)`;
      // Extra sessions only speed things up: a server that is slow to accept them must not hold the
      // collection at 0%, so go ahead with whatever connected in time and drop late arrivals.
      let accepting = true;
      const attempts = Array.from({ length: wanted }, async () => {
        const h = primary.cloneForWorker();
        await h.connect();
        if (!accepting) { h.disconnect().catch(() => {}); return; }
        handlers.push(h);
        extraHandlers.push(h);
      });
      await Promise.race([
        Promise.allSettled(attempts),
        new Promise(r => setTimeout(r, EXTRA_CONNECTION_WAIT_MS)),
      ]);
      accepting = false;
    }
    progress.statusDetail = '';
    const workerHandlers = profile.perWorkerConnection
      ? handlers
      : Array.from({ length: Math.max(1, Math.min(profile.workers, queue.length)) }, () => primary);
    progress.connections = handlers.length;
    progress.workers = workerHandlers.length;
    progress.phase = 'collecting';

    const processItem = async (job, item) => {
      progress.bytesDone += item.raw.length;
      try {
        const msg = await buildMessageRecord(item.raw, {
          uid: item.ref.uid,
          serviceId: item.ref.serviceId || null,
          folder: job.folder,
          folderPaths: item.ref.folderPaths || [job.folder],
          ...item.meta,
        });
        await onRecord(msg, job.folder);
      } catch (err) {
        onFailure({ folder: job.folder, key: job.key, ref: item.ref, error: err, stage: 'process' });
      }
      settle(item.ref);
    };
    const deferred = [];

    // Handlers deliver each item as it arrives, so it is written and counted immediately rather than
    // when the whole batch completes; a retry only re-requests items not yet delivered.
    const processJob = async (handler, job) => {
      const delivered = new Set();
      const processing = [];
      const deliver = (item) => {
        if (!item?.raw || delivered.has(item.ref.key)) return;
        delivered.add(item.ref.key);
        processing.push(processItem(job, item));
      };
      let fetchError = null;
      try {
        // Once the provider has refused everything for the give-up period, stop asking.
        if (pacer.exhausted()) throw quotaGiveUpError(pacer.lastRefusal);
        await withRetry(async () => {
          const remaining = job.refs.filter(r => !delivered.has(r.key));
          if (!remaining.length) return;
          await pacer.take(signal);
          if (signal?.aborted) return;
          if (handler.ensureConnected) await handler.ensureConnected();
          await handler.fetchBatch(job.key, remaining, deliver);
          pacer.succeeded();
          if (job.refs.length === 1 && !delivered.size) throw new Error('Server returned no content for item');
        }, {
          attempts: job.refs.length > 1 ? 2 : 4,
          signal,
          onThrottle: throttle,
          onRetry: (err) => {
            progress.retrying = true;
            progress.retryItem = `${job.folder} (${job.refs.length - delivered.size} item${job.refs.length - delivered.size === 1 ? '' : 's'}): ${err.message}`;
          },
        });
      } catch (err) {
        fetchError = err.throttled && pacer.exhausted() ? quotaGiveUpError(err) : err;
      } finally {
        progress.retrying = false;
      }
      await Promise.all(processing);
      // Stopped by the examiner: items not delivered are reported as not collected, not as failed.
      if (signal?.aborted) return;

      for (const ref of job.refs.filter(r => !delivered.has(r.key))) {
        if (job.refs.length > 1) {
          queue.push({ ...job, refs: [ref] });
        } else {
          const error = fetchError || new Error('Server returned no content for item');
          deferred.push({ job, ref, error });
          progress.deferred++;
          onDeferred?.({ folder: job.folder, ref, error });
        }
      }
    };

    const worker = async (handler) => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (signal?.aborted) return;
        progress.currentFolder = job.folder;
        await processJob(handler, job);
      }
    };

    await Promise.all(workerHandlers.map(worker));

    let recovered = 0;
    let rounds = 0;
    // An error retrying cannot change (the message no longer exists, a malformed request) is not retried.
    let pending = deferred.filter(d => !d.error?.permanent);
    if (pending.length && !signal?.aborted) {
      progress.phase = 'retrying_failed';
      progress.retrying = true;
      // The final rounds get their own give-up period if the quota still refuses everything.
      pacer.refusedSince = null;
      while (pending.length && rounds < FINAL_RETRY_ROUNDS && !signal?.aborted && !pacer.exhausted()) {
        rounds++;
        progress.statusDetail = `Final retries: round ${rounds} of ${FINAL_RETRY_ROUNDS}, ${pending.length} item(s)`;
        onRetryRound?.({ round: rounds, of: FINAL_RETRY_ROUNDS, count: pending.length });
        await abortableSleep(FINAL_RETRY_DELAY_MS, signal);
        const roundQueue = pending.slice();
        let tried = 0;
        const retryWorker = async (handler) => {
          for (let d = roundQueue.shift(); d; d = roundQueue.shift()) {
            if (signal?.aborted || pacer.exhausted()) return;
            progress.retryItem = `${d.job.folder} #${d.ref.uid ?? '?'} (round ${rounds}, ${++tried} of ${pending.length})`;
            let item = null;
            try {
              await pacer.take(signal);
              if (signal?.aborted) return;
              d.tries = (d.tries || 0) + 1;
              if (handler.ensureConnected) await handler.ensureConnected();
              await handler.fetchBatch(d.job.key, [d.ref], it => { if (it?.raw) item = it; });
              pacer.succeeded();
              if (!item) throw new Error('Server returned no content for item');
            } catch (err) {
              // One try per round, quota refusals included; a refusal still pauses every worker.
              d.error = err;
              if (err.throttled) await waitOutQuota(pacer, err, { signal, progress, onThrottle });
              continue;
            }
            recovered++;
            d.done = true;
            progress.deferred--;
            await processItem(d.job, item);
          }
        };
        await Promise.all(workerHandlers.map(retryWorker));
        pending = pending.filter(d => !d.done && !d.error?.permanent);
      }
      progress.retrying = false;
      progress.retryItem = '';
      progress.statusDetail = '';
    }
    for (const d of deferred) {
      if (d.done) continue;
      let error = d.error;
      if (error?.permanent) error = withNote(error, 'not retried: the server will give the same answer');
      else if (error?.throttled && pacer.exhausted()) error = quotaGiveUpError(error);
      else if (d.tries) error = withNote(error, `still failing after ${d.tries} final ${d.tries === 1 ? 'retry' : 'retries'}`);
      onFailure({ folder: d.job.folder, key: d.job.key, ref: d.ref, error, stage: 'fetch' });
      settle(d.ref);
    }
    progress.deferred = 0;
    progress.recoveredOnRetry = recovered;
    return { folderTotals, connections: handlers.length, recovered, retryRounds: rounds, canceled: !!signal?.aborted };
  } finally {
    stopTracker();
    await Promise.allSettled(extraHandlers.map(h => h.disconnect()));
  }
}
