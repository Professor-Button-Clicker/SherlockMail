import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ContainerService } from './container-service.js';
import { caseFields } from '../util/case-fields.js';

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
    if (project.case_name || project.caseName) report += `Case Name:     ${project.case_name || project.caseName}\n`;
    report += `Evidence ID:   ${caseFields(project).evidenceId || 'N/A'}\n`;
    report += `Custodian:     ${caseFields(project).custodianName || 'N/A'}\n`;
    report += `Examiner:      ${project.examiner_name || project.examinerName || 'N/A'}\n`;
    report += `Target:        ${project.target_email || project.targetEmail}\n`;
    report += `Provider:      ${project.provider_type || project.providerType}\n`;
    report += `Created:       ${project.created_at || project.createdAt}\n`;
    report += `Report Date:   ${now}\n`;
    report += `Tool:          SherlockMail v0.10.0\n\n`;

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
    report += `Tool:          SherlockMail v0.10.0\n\n`;

    report += `Total Files Tracked: ${driveItems.length}\n`;
    report += `Total Revisions:     ${revisions.length}\n\n`;

    if (options.notAvailable?.length) {
      report += `${sep}\nFILES WHOSE REVISIONS COULD NOT BE READ\n${thin}\n\n`;
      for (const n of options.notAvailable) report += `${n.name}: ${n.error}\n`;
      report += `\n`;
    }

    if (options.notAvailable?.length) {
      report += `${sep}\nFILES WHOSE REVISIONS COULD NOT BE READ\n${thin}\n\n`;
      for (const n of options.notAvailable) report += `${n.name}: ${n.error}\n`;
      report += `\n`;
    }

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

  // sources: [{ dir, prefix }]. Every file in those folders goes into the archive; a log of any type counts.
  static compressLogs(projectId, sources, outputPath) {
    const entries = [];
    for (const { dir, prefix } of sources) {
      if (!fs.existsSync(dir)) continue;
      for (const file of ContainerService.collectFiles(dir)) {
        entries.push({ path: file.path, name: path.posix.join(prefix, path.relative(dir, file.path).replace(/\\/g, '/')) });
      }
    }
    if (entries.length === 0) return { compressed: false, reason: 'This project has no log files yet' };
    const zip = ContainerService.writeZip(entries, outputPath);
    return {
      compressed: true,
      outputPath,
      size: zip.size,
      fileCount: zip.fileCount,
      totalUncompressed: zip.totalOriginalSize,
      compressionRatio: zip.compressionRatio,
      hash: zip.hashes.sha256,
      format: 'ZIP (deflate)',
    };
  }
}
