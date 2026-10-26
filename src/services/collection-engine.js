import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import { v4 as uuidv4 } from 'uuid';

// Per-protocol throughput settings. Limits follow each provider's documented ceilings:
// Graph allows 4 concurrent requests per mailbox, Gmail 250 quota units/s (messages.get = 5),
// EWS GetItem is batched like FEC's BindToItems, IMAP uses parallel sessions with range FETCH.
// batchBytes caps a batch by server-reported size so one connection never vanishes into a huge batch.
export const COLLECTION_PROFILES = {
  imap:      { workers: 4, perWorkerConnection: true, batchSize: 50, batchBytes: 4 * 1024 * 1024 },
  pop3:      { workers: 1, perWorkerConnection: false, batchSize: 10, batchBytes: 4 * 1024 * 1024 },
  gmail_api: { workers: 10, perWorkerConnection: false, batchSize: 1, ratePerSec: 40 },
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
// Items that still fail after their own retries get one more attempt once the rest of the mailbox is
// done, after a pause: throttling and dropped sessions usually clear by then.
const FINAL_RETRY_DELAY_MS = 5000;

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry(fn, { attempts = 4, baseMs = 500, maxMs = 30000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
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

class RateLimiter {
  constructor(perSec) {
    this.interval = 1000 / perSec;
    this.nextSlot = 0;
  }

  async take() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.interval;
    if (slot > now) await sleep(slot - now);
  }
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
    if (progress.phase === 'collecting') {
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
export async function enumerateFolders({ primary, folders, limit = 0, searchCriteria, progress, signal, onFolderError }) {
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
      const { key, refs } = await withRetry(() => primary.enumerate(folder, { limit, searchCriteria }), { attempts: 3 });
      listings.push({ folder, key, refs });
      if (progress) progress.total += refs.length;
    } catch (err) {
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
  onRecord, onFailure, onFolderError, onTick, overrides = {}, signal,
}) {
  const profile = { ...COLLECTION_PROFILES[protocol] };
  if (overrides.workers > 0) profile.workers = Math.min(overrides.workers, 16);
  const stopTracker = startRateTracker(progress, onTick);
  const extraHandlers = [];
  progress.bytesDone = progress.bytesDone || 0;

  try {
    progress.phase = 'enumerating';
    const queue = [];
    const folderTotals = {};
    const { listings, duplicatesMerged, folderErrors } = await enumerateFolders({
      primary, folders, limit, searchCriteria, progress, signal, onFolderError,
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

    const limiter = profile.ratePerSec ? new RateLimiter(profile.ratePerSec) : null;

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
        await withRetry(async () => {
          const remaining = job.refs.filter(r => !delivered.has(r.key));
          if (!remaining.length) return;
          if (limiter) await limiter.take();
          if (handler.ensureConnected) await handler.ensureConnected();
          await handler.fetchBatch(job.key, remaining, deliver);
          if (job.refs.length === 1 && !delivered.size) throw new Error('Server returned no content for item');
        }, {
          attempts: job.refs.length > 1 ? 2 : 4,
          onRetry: (err) => {
            progress.retrying = true;
            progress.retryItem = `${job.folder} (${job.refs.length - delivered.size} item${job.refs.length - delivered.size === 1 ? '' : 's'}): ${err.message}`;
          },
        });
      } catch (err) {
        fetchError = err;
      } finally {
        progress.retrying = false;
      }
      await Promise.all(processing);

      for (const ref of job.refs.filter(r => !delivered.has(r.key))) {
        if (job.refs.length > 1) {
          queue.push({ ...job, refs: [ref] });
        } else {
          deferred.push({ job, ref, error: fetchError || new Error('Server returned no content for item') });
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
    if (deferred.length && !signal?.aborted) {
      progress.phase = 'retrying_failed';
      progress.retrying = true;
      progress.statusDetail = `Retrying ${deferred.length} item(s) that failed`;
      await abortableSleep(FINAL_RETRY_DELAY_MS, signal);
      const retryHandler = handlers[0];
      for (const [i, d] of deferred.entries()) {
        if (signal?.aborted) break;
        progress.retryItem = `${d.job.folder} #${d.ref.uid ?? '?'} (${i + 1} of ${deferred.length})`;
        let item = null;
        try {
          await withRetry(async () => {
            if (limiter) await limiter.take();
            if (retryHandler.ensureConnected) await retryHandler.ensureConnected();
            await retryHandler.fetchBatch(d.job.key, [d.ref], it => { if (it?.raw) item = it; });
            if (!item) throw new Error('Server returned no content for item');
          }, { attempts: 2 });
        } catch (err) {
          d.error = err;
        }
        if (item) {
          recovered++;
          d.done = true;
          await processItem(d.job, item);
        }
      }
      progress.retrying = false;
      progress.retryItem = '';
      progress.statusDetail = '';
    }
    for (const d of deferred) {
      if (d.done) continue;
      onFailure({ folder: d.job.folder, key: d.job.key, ref: d.ref, error: d.error, stage: 'fetch' });
      settle(d.ref);
    }
    progress.recoveredOnRetry = recovered;
    return { folderTotals, connections: handlers.length, recovered, canceled: !!signal?.aborted };
  } finally {
    stopTracker();
    await Promise.allSettled(extraHandlers.map(h => h.disconnect()));
  }
}
