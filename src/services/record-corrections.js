import crypto from 'crypto';
import fs from 'fs';
import { simpleParser } from 'mailparser';
import { addAuditEntry, getUncheckedMessages, saveRecordCorrections } from '../db/database.js';
import { protectionFlags } from './crypto-service.js';

// Versions before 0.10.0 recorded two things wrongly, and the cases they collected still carry them:
//  - signed and encrypted mail was never flagged, so "No" only meant nobody had looked
//  - a message with no Date header and no server date was given the time of collection as its date
// Opening a case changes nothing: until the examiner asks for this check, QC and the metadata export say "Not
// checked". The check works out the right values from the collected files, which it only reads. A file that is
// missing or no longer matches its recorded SHA-256 proves nothing, so that message stays "Not checked" and can
// be checked again later, for example once an evidence drive is back. Every change goes in the case's audit log.

const BATCH_SIZE = 200;
const SAME_TIME_AS_COLLECTION_MS = 5 * 60 * 1000;

// The old fallback only applied when the email had no usable date and the server gave none. Records from before
// the server date was stored can hold a real one with no way to tell, so the date must also match the collection.
async function dateWasInvented(m, raw) {
  if (!m.date || m.internal_date || !m.acquired_at) return false;
  const gap = Math.abs(new Date(m.date).getTime() - new Date(m.acquired_at).getTime());
  if (!(gap <= SAME_TIME_AS_COLLECTION_MS)) return false;
  const parsed = await simpleParser(raw);
  return !(parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()));
}

async function checkMessage(m) {
  try {
    if (!m.eml_path || !m.hash_sha256) return null;
    const raw = await fs.promises.readFile(m.eml_path);
    if (crypto.createHash('sha256').update(raw).digest('hex') !== m.hash_sha256) return null;
    const { isEncrypted, isSigned } = protectionFlags(raw);
    return { id: m.id, isEncrypted, isSigned, date: await dateWasInvented(m, raw) ? null : m.date };
  } catch {
    return null;
  }
}

function describeCorrections(change) {
  const parts = [];
  if (change.markedSigned.length) parts.push(`${change.markedSigned.length} marked as signed`);
  if (change.markedEncrypted.length) parts.push(`${change.markedEncrypted.length} marked as encrypted`);
  if (change.datesRemoved.length) parts.push(`${change.datesRemoved.length} date(s) removed that were the time of collection, not the message's date`);
  return `Records made by an earlier version corrected from the collected files, which were only read: ${parts.join(', ')}`;
}

async function runCheck(project) {
  const totals = { checked: 0, corrected: 0, notChecked: 0 };
  let after = 0;
  for (;;) {
    const rows = getUncheckedMessages(project.id, after, BATCH_SIZE);
    if (!rows.length) break;
    after = rows[rows.length - 1].rowid;

    const updates = [];
    const change = { markedSigned: [], markedEncrypted: [], datesRemoved: [] };
    for (const m of rows) {
      const result = await checkMessage(m);
      if (!result) { totals.notChecked++; continue; }
      totals.checked++;
      updates.push(result);

      const newlySigned = result.isSigned && !m.is_signed;
      const newlyEncrypted = result.isEncrypted && !m.is_encrypted;
      const dateRemoved = result.date !== m.date;
      if (newlySigned) change.markedSigned.push(m.id);
      if (newlyEncrypted) change.markedEncrypted.push(m.id);
      if (dateRemoved) change.datesRemoved.push({ id: m.id, was: m.date });
      if (newlySigned || newlyEncrypted || dateRemoved) totals.corrected++;
    }
    const anyChange = change.markedSigned.length || change.markedEncrypted.length || change.datesRemoved.length;
    saveRecordCorrections(updates, anyChange ? { projectId: project.id, description: describeCorrections(change), details: change, examiner: project.examiner_name } : null);
  }
  if (totals.checked || totals.notChecked) {
    addAuditEntry(project.id, 'OLDER_RECORDS_CHECKED',
      `Older records checked at the examiner's request: ${totals.checked} checked, ${totals.corrected} corrected, ${totals.notChecked} could not be checked because the collected file is missing or no longer matches its hash`,
      totals, project.examiner_name);
  }
  return totals;
}

const running = new Map();

export function checkOlderRecords(project) {
  if (!running.has(project.id)) {
    running.set(project.id, runCheck(project).finally(() => running.delete(project.id)));
  }
  return running.get(project.id);
}
