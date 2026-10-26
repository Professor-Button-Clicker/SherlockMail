import fs from 'fs';
import path from 'path';

const DELIMITER = { csv: ',', tsv: '\t' };

function escapeCsvField(value, delim = ',') {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(delim) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeDelimited(rows, columns, delim) {
  const lines = [columns.map(c => escapeCsvField(c.header, delim)).join(delim)];
  for (const row of rows) {
    lines.push(columns.map(c => escapeCsvField(c.accessor(row), delim)).join(delim));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const EMAIL_COLUMNS = [
  { header: 'MessageId', accessor: r => r.message_id || r.messageId || '' },
  { header: 'Subject', accessor: r => r.subject || '' },
  { header: 'From', accessor: r => r.from_address || r.from || '' },
  { header: 'To', accessor: r => r.to_addresses || r.to || '' },
  { header: 'Cc', accessor: r => r.cc_addresses || r.cc || '' },
  { header: 'Bcc', accessor: r => r.bcc_addresses || r.bcc || '' },
  { header: 'Date', accessor: r => r.date || r.sent_date || '' },
  { header: 'ReceivedDate', accessor: r => r.received_date || r.receivedDate || '' },
  { header: 'Folder', accessor: r => r.folder || '' },
  { header: 'Size', accessor: r => r.size || r.byte_length || '' },
  { header: 'HasAttachments', accessor: r => r.has_attachments != null ? r.has_attachments : (r.attachments?.length > 0 ? 'Yes' : 'No') },
  { header: 'AttachmentCount', accessor: r => r.attachment_count || r.attachments?.length || 0 },
  { header: 'Importance', accessor: r => r.importance || r.priority || 'Normal' },
  { header: 'HashSHA256', accessor: r => r.hash_sha256 || r.hashSha256 || '' },
  { header: 'HashMD5', accessor: r => r.hash_md5 || r.hashMd5 || '' },
  { header: 'BodyPreview', accessor: r => (r.body_text || r.bodyPreview || '').slice(0, 200) },
  { header: 'ContentType', accessor: r => r.content_type || r.contentType || '' },
  { header: 'InternetHeaders', accessor: r => typeof r.internet_headers === 'string' ? r.internet_headers : JSON.stringify(r.internet_headers || '') },
];

const ATTACHMENT_COLUMNS = [
  { header: 'AttachmentId', accessor: r => r.id || r.attachmentId || '' },
  { header: 'ParentMessageId', accessor: r => r.message_id || r.parentMessageId || '' },
  { header: 'Filename', accessor: r => r.filename || r.name || '' },
  { header: 'Size', accessor: r => r.size || r.byte_length || '' },
  { header: 'ContentType', accessor: r => r.content_type || r.contentType || r.mime || '' },
  { header: 'HashSHA256', accessor: r => r.hash_sha256 || r.hashSha256 || '' },
  { header: 'HashMD5', accessor: r => r.hash_md5 || r.hashMd5 || '' },
  { header: 'IsInline', accessor: r => r.is_inline != null ? r.is_inline : '' },
  { header: 'ContentId', accessor: r => r.content_id || '' },
];

const CALENDAR_COLUMNS = [
  { header: 'EventId', accessor: r => r.id || r.eventId || '' },
  { header: 'Subject', accessor: r => r.subject || r.summary || '' },
  { header: 'Start', accessor: r => r.start || r.start_date || '' },
  { header: 'End', accessor: r => r.end || r.end_date || '' },
  { header: 'Location', accessor: r => r.location || '' },
  { header: 'Organizer', accessor: r => r.organizer || '' },
  { header: 'Attendees', accessor: r => Array.isArray(r.attendees) ? r.attendees.join('; ') : (r.attendees || '') },
  { header: 'Recurrence', accessor: r => r.recurrence || '' },
  { header: 'Status', accessor: r => r.status || '' },
];

const CONTACT_COLUMNS = [
  { header: 'ContactId', accessor: r => r.id || r.contactId || '' },
  { header: 'DisplayName', accessor: r => r.display_name || r.displayName || '' },
  { header: 'EmailAddresses', accessor: r => Array.isArray(r.email_addresses) ? r.email_addresses.join('; ') : (r.email_addresses || r.email || '') },
  { header: 'PhoneNumbers', accessor: r => Array.isArray(r.phone_numbers) ? r.phone_numbers.join('; ') : (r.phone_numbers || '') },
  { header: 'Company', accessor: r => r.company || r.organization || '' },
  { header: 'JobTitle', accessor: r => r.job_title || r.title || '' },
  { header: 'Notes', accessor: r => (r.notes || '').slice(0, 200) },
];

const DOCUMENT_COLUMNS = [
  { header: 'DocumentId', accessor: r => r.id || r.documentId || '' },
  { header: 'Name', accessor: r => r.name || r.filename || '' },
  { header: 'MimeType', accessor: r => r.mime_type || r.mimeType || r.contentType || '' },
  { header: 'Size', accessor: r => r.size || '' },
  { header: 'CreatedDate', accessor: r => r.created_date || r.createdDate || '' },
  { header: 'ModifiedDate', accessor: r => r.modified_date || r.modifiedDate || '' },
  { header: 'Owner', accessor: r => r.owner || '' },
  { header: 'DriveId', accessor: r => r.drive_id || r.driveId || '' },
  { header: 'HashSHA256', accessor: r => r.hash_sha256 || '' },
  { header: 'DownloadUrl', accessor: r => r.download_url || '' },
];

const DRIVE_COLUMNS = [
  { header: 'ItemId', accessor: r => r.id || r.itemId || '' },
  { header: 'Name', accessor: r => r.name || r.filename || '' },
  { header: 'MimeType', accessor: r => r.mime_type || r.mimeType || '' },
  { header: 'Size', accessor: r => r.size || r.byte_length || '' },
  { header: 'Owner', accessor: r => r.owner || '' },
  { header: 'CreatedTime', accessor: r => r.created_time || r.createdDate || '' },
  { header: 'ModifiedTime', accessor: r => r.modified_time || r.modifiedDate || '' },
  { header: 'ParentFolder', accessor: r => r.parent_folder || r.parentId || '' },
  { header: 'Shared', accessor: r => r.shared || '' },
  { header: 'HashSHA256', accessor: r => r.hash_sha256 || '' },
  { header: 'WebViewLink', accessor: r => r.web_view_link || '' },
  { header: 'Version', accessor: r => r.version || '' },
];

const AUDIT_COLUMNS = [
  { header: 'Timestamp', accessor: r => r.created_at || r.timestamp || '' },
  { header: 'EventType', accessor: r => r.event_type || r.eventType || '' },
  { header: 'Action', accessor: r => r.action || '' },
  { header: 'Details', accessor: r => typeof r.details === 'object' ? JSON.stringify(r.details) : (r.details || '') },
  { header: 'Hash', accessor: r => r.hash || '' },
  { header: 'PrevHash', accessor: r => r.prev_hash || '' },
];

const HASH_COLUMNS = [
  { header: 'ItemId', accessor: r => r.message_id || r.item_id || r.id || '' },
  { header: 'ItemType', accessor: r => r.type || 'email' },
  { header: 'Filename', accessor: r => r.filename || r.filePath || '' },
  { header: 'Size', accessor: r => r.size || r.byteLength || '' },
  { header: 'MD5', accessor: r => r.md5 || r.hash_md5 || '' },
  { header: 'SHA1', accessor: r => r.sha1 || r.hash_sha1 || '' },
  { header: 'SHA256', accessor: r => r.sha256 || r.hash_sha256 || '' },
  { header: 'SHA384', accessor: r => r.sha384 || '' },
  { header: 'SHA512', accessor: r => r.sha512 || '' },
];

const TIMESTAMP_COLUMNS = [
  { header: 'TimestampId', accessor: r => r.id || '' },
  { header: 'TSA', accessor: r => r.tsa_name || r.tsaName || '' },
  { header: 'TSAUrl', accessor: r => r.tsa_url || r.tsaUrl || '' },
  { header: 'Status', accessor: r => r.status || '' },
  { header: 'GenTime', accessor: r => r.gen_time || r.genTime || '' },
  { header: 'TargetHash', accessor: r => r.target_hash || r.targetHash || '' },
  { header: 'HashAlgorithm', accessor: r => r.hash_algorithm || r.hashAlgorithm || '' },
  { header: 'SerialNumber', accessor: r => r.serial_number || r.serialNumber || '' },
  { header: 'TargetType', accessor: r => r.target_type || r.targetType || '' },
];

const SNAPSHOT_COLUMNS = [
  { header: 'SnapshotId', accessor: r => r.id || '' },
  { header: 'FolderPath', accessor: r => r.folder_path || r.folderPath || '' },
  { header: 'FileCount', accessor: r => r.file_count || r.fileCount || '' },
  { header: 'TotalSize', accessor: r => r.total_size || r.totalSize || '' },
  { header: 'ManifestHash', accessor: r => r.manifest_hash || r.manifestHash || '' },
  { header: 'CreatedAt', accessor: r => r.created_at || '' },
];

const EXPORT_MAP = {
  email: EMAIL_COLUMNS,
  attachment: ATTACHMENT_COLUMNS,
  calendar: CALENDAR_COLUMNS,
  contact: CONTACT_COLUMNS,
  document: DOCUMENT_COLUMNS,
  drive: DRIVE_COLUMNS,
  audit: AUDIT_COLUMNS,
  hash: HASH_COLUMNS,
  timestamp: TIMESTAMP_COLUMNS,
  snapshot: SNAPSHOT_COLUMNS,
};

export class MetadataExportService {

  static getAvailableExportTypes() {
    return Object.keys(EXPORT_MAP).map(key => ({
      type: key,
      columnCount: EXPORT_MAP[key].length,
      columns: EXPORT_MAP[key].map(c => c.header),
    }));
  }

  static exportToString(data, type, format = 'csv') {
    const columns = EXPORT_MAP[type];
    if (!columns) throw new Error(`Unknown export type: ${type}. Available: ${Object.keys(EXPORT_MAP).join(', ')}`);
    const delim = DELIMITER[format] || ',';
    return writeDelimited(data, columns, delim);
  }

  static exportToFile(data, type, filePath, format = 'csv') {
    const content = this.exportToString(data, type, format);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, format, type, rowCount: data.length, columnCount: EXPORT_MAP[type].length, byteLength: Buffer.byteLength(content) };
  }

  static exportMultiple(datasets, outputDir, format = 'csv') {
    fs.mkdirSync(outputDir, { recursive: true });
    const results = [];
    for (const { type, data, filename } of datasets) {
      const ext = format === 'tsv' ? '.tsv' : '.csv';
      const fn = filename || `${type}_export${ext}`;
      const fp = path.join(outputDir, fn);
      results.push(this.exportToFile(data, type, fp, format));
    }
    return results;
  }

  static getColumns(type) {
    const columns = EXPORT_MAP[type];
    if (!columns) return null;
    return columns.map(c => c.header);
  }
}
