import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';

export class ReportService {

  // ── History Report Export (Feature 18) ──

  static generateHistoryReport(project, auditLog, acquisitions, exports, options = {}) {
    const now = new Date().toISOString();
    const sep = '='.repeat(72);
    const thin = '-'.repeat(72);

    let report = `${sep}\n`;
    report += `SHERLOCKMAIL FORENSIC HISTORY REPORT\n`;
    report += `${sep}\n\n`;
    report += `Project:       ${project.name}\n`;
    report += `Case ID:       ${project.case_id || project.caseId || 'N/A'}\n`;
    report += `Case Name:     ${project.case_name || project.caseName || 'N/A'}\n`;
    report += `Examiner:      ${project.examiner_name || project.examinerName || 'N/A'}\n`;
    report += `Target:        ${project.target_email || project.targetEmail}\n`;
    report += `Provider:      ${project.provider_type || project.providerType}\n`;
    report += `Created:       ${project.created_at || project.createdAt}\n`;
    report += `Report Date:   ${now}\n`;
    report += `Tool:          SherlockMail v0.9.0\n\n`;

    // Acquisition History
    report += `${sep}\nACQUISITION HISTORY\n${thin}\n\n`;
    if (acquisitions.length === 0) {
      report += `No acquisitions recorded.\n\n`;
    } else {
      for (let i = 0; i < acquisitions.length; i++) {
        const acq = acquisitions[i];
        report += `[Acquisition ${i + 1}] ${acq.id}\n`;
        report += `  Status:     ${acq.status}\n`;
        report += `  Started:    ${acq.started_at || 'N/A'}\n`;
        report += `  Completed:  ${acq.completed_at || 'N/A'}\n`;
        report += `  Messages:   ${acq.acquired_messages || 0} / ${acq.total_messages || 0}\n`;
        report += `  Failed:     ${acq.failed_messages || 0}\n`;
        report += `  Skipped:    ${acq.skipped_messages || 0}\n`;
        report += `  Bytes:      ${acq.total_bytes || 0}\n\n`;
      }
    }

    // Export History
    report += `${sep}\nEXPORT HISTORY\n${thin}\n\n`;
    if (exports.length === 0) {
      report += `No exports recorded.\n\n`;
    } else {
      for (let i = 0; i < exports.length; i++) {
        const exp = exports[i];
        report += `[Export ${i + 1}] ${exp.id}\n`;
        report += `  Format:     ${exp.format}\n`;
        report += `  Status:     ${exp.status}\n`;
        report += `  Messages:   ${exp.message_count || 0}\n`;
        report += `  Bytes:      ${exp.total_bytes || 0}\n`;
        report += `  Output:     ${exp.output_dir || 'N/A'}\n`;
        report += `  SHA-256:    ${exp.hash_sha256 || 'N/A'}\n\n`;
      }
    }

    // Full Audit Trail
    report += `${sep}\nAUDIT TRAIL (${auditLog.length} entries)\n${thin}\n\n`;
    for (const entry of auditLog) {
      report += `[${entry.timestamp}] ${entry.event_type}\n`;
      report += `  ${entry.description}\n`;
      report += `  Hash: ${entry.hash}\n`;
      if (entry.examiner) report += `  Examiner: ${entry.examiner}\n`;
      report += `\n`;
    }

    report += `${sep}\n`;
    report += `END OF HISTORY REPORT\n`;
    const reportHash = crypto.createHash('sha256').update(report).digest('hex');
    report += `Report SHA-256: ${reportHash}\n`;
    report += `${sep}\n`;

    return {
      content: report,
      filename: `history_report_${project.id.substring(0, 8)}_${now.replace(/[:.]/g, '-')}.txt`,
      hash: reportHash,
      size: Buffer.byteLength(report),
      auditEntries: auditLog.length,
      acquisitions: acquisitions.length,
      exports: exports.length,
    };
  }

  // ── Revision Report Export (Feature 19) ──

  static generateRevisionReport(project, driveItems, revisions, options = {}) {
    const now = new Date().toISOString();
    const sep = '='.repeat(72);
    const thin = '-'.repeat(72);

    let report = `${sep}\n`;
    report += `SHERLOCKMAIL CLOUD FILE REVISION REPORT\n`;
    report += `${sep}\n\n`;
    report += `Project:       ${project.name}\n`;
    report += `Target:        ${project.target_email || project.targetEmail}\n`;
    report += `Report Date:   ${now}\n`;
    report += `Tool:          SherlockMail v0.9.0\n\n`;

    report += `Total Files Tracked: ${driveItems.length}\n`;
    report += `Total Revisions:     ${revisions.length}\n\n`;

    const itemMap = new Map();
    for (const item of driveItems) itemMap.set(item.id, item);

    const revsByItem = new Map();
    for (const rev of revisions) {
      const itemId = rev.drive_item_id || rev.driveItemId;
      if (!revsByItem.has(itemId)) revsByItem.set(itemId, []);
      revsByItem.get(itemId).push(rev);
    }

    report += `${sep}\nFILE REVISIONS\n${thin}\n\n`;
    for (const [itemId, itemRevs] of revsByItem) {
      const item = itemMap.get(itemId);
      report += `File: ${item?.name || itemId}\n`;
      report += `  Provider:  ${item?.provider || 'unknown'}\n`;
      report += `  Path:      ${item?.path || 'N/A'}\n`;
      report += `  Revisions: ${itemRevs.length}\n\n`;

      for (let i = 0; i < itemRevs.length; i++) {
        const rev = itemRevs[i];
        report += `  [Rev ${i + 1}] ${rev.revision_id || rev.revisionId || 'N/A'}\n`;
        report += `    Modified:  ${rev.modified_time || rev.modifiedTime || 'N/A'}\n`;
        report += `    Modifier:  ${rev.modifier || 'N/A'}\n`;
        report += `    Size:      ${rev.size || 0} bytes\n`;
        report += `    SHA-256:   ${rev.hash_sha256 || rev.hashSha256 || 'N/A'}\n\n`;
      }
    }

    report += `${sep}\n`;
    const reportHash = crypto.createHash('sha256').update(report).digest('hex');
    report += `Report SHA-256: ${reportHash}\n`;
    report += `${sep}\n`;

    return {
      content: report,
      filename: `revision_report_${project.id.substring(0, 8)}_${now.replace(/[:.]/g, '-')}.txt`,
      hash: reportHash,
      size: Buffer.byteLength(report),
      fileCount: driveItems.length,
      revisionCount: revisions.length,
    };
  }

  // ── Log Compression (Feature 20) ──

  static async compressLogs(projectId, logsDir, outputPath) {
    const files = [];
    if (fs.existsSync(logsDir)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.log') || entry.name.endsWith('.txt') || entry.name.endsWith('.json')) {
            files.push(full);
          }
        }
      };
      walk(logsDir);
    }

    if (files.length === 0) return { compressed: false, reason: 'No log files found' };

    const parts = [];
    const entries = [];
    let offset = 0;

    for (const filePath of files) {
      const relPath = path.relative(logsDir, filePath);
      const content = fs.readFileSync(filePath);
      const crc = this._crc32(content);
      const compressed = zlib.deflateRawSync(content, { level: 6 });

      const nameBytes = Buffer.from(relPath, 'utf8');
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034B50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // UTF-8 flag
      header.writeUInt16LE(8, 8); // Deflate
      header.writeUInt16LE(dosTime, 10);
      header.writeUInt16LE(dosDate, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(content.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);

      entries.push({ offset, name: nameBytes, crc, compressedSize: compressed.length, uncompressedSize: content.length, dosTime, dosDate });
      parts.push(header, nameBytes, compressed);
      offset += 30 + nameBytes.length + compressed.length;
    }

    const cdStart = offset;
    for (const entry of entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014B50, 0);
      cd.writeUInt16LE(0x033F, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10); // Deflate
      cd.writeUInt16LE(entry.dosTime, 12);
      cd.writeUInt16LE(entry.dosDate, 14);
      cd.writeUInt32LE(entry.crc, 16);
      cd.writeUInt32LE(entry.compressedSize, 20);
      cd.writeUInt32LE(entry.uncompressedSize, 24);
      cd.writeUInt16LE(entry.name.length, 28);
      cd.writeUInt32LE(entry.offset, 42);
      parts.push(Buffer.concat([cd, entry.name]));
      offset += 46 + entry.name.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    parts.push(eocd);

    const archive = Buffer.concat(parts);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, archive);

    const totalUncompressed = entries.reduce((s, e) => s + e.uncompressedSize, 0);
    return {
      compressed: true,
      outputPath,
      size: archive.length,
      fileCount: files.length,
      totalUncompressed,
      compressionRatio: totalUncompressed > 0 ? ((1 - archive.length / totalUncompressed) * 100).toFixed(1) + '%' : '0%',
      hash: crypto.createHash('sha256').update(archive).digest('hex'),
      format: 'ZIP (deflate)',
    };
  }

  static _crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}
