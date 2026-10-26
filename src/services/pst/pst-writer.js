// Messaging layer of a PST (MS-PST section 2.4): the message store, the folder hierarchy and its
// tables, the template tables, the named-property map, and message, recipient and attachment objects.
import crypto from 'crypto';
import { NdbWriter } from './ndb.js';
import { PT, tag, buildPC, buildTC, Subnodes, encodeValue } from './ltp.js';
import { pstCrc } from './crc.js';

export const NID = {
  MESSAGE_STORE: 0x21, NAME_TO_ID_MAP: 0x61, ROOT_FOLDER: 0x122, SEARCH_MANAGEMENT_QUEUE: 0x1E1,
  SEARCH_ACTIVITY_LIST: 0x201, HIERARCHY_TEMPLATE: 0x60D, CONTENTS_TEMPLATE: 0x60E, FAI_TEMPLATE: 0x60F,
  SEARCH_CONTENTS_TEMPLATE: 0x610, ATTACHMENT_TABLE: 0x671, RECIPIENT_TABLE: 0x692,
  IPM_SUBTREE: 0x8022, SEARCH_ROOT: 0x8042, DELETED_ITEMS: 0x8062, SPAM_SEARCH_FOLDER: 0x2223,
};
const T = { NORMAL_FOLDER: 0x02, NORMAL_MESSAGE: 0x04, ATTACHMENT: 0x05, HIERARCHY: 0x0D, CONTENTS: 0x0E, FAI: 0x0F };
const nidOf = (index, type) => ((index << 5) | type) >>> 0;
const nidIndex = nid => nid >>> 5;

export const PS_MAPI = '00020328-0000-0000-C000-000000000046';
export const PS_PUBLIC_STRINGS = '00020329-0000-0000-C000-000000000046';
export const PS_INTERNET_HEADERS = '00020386-0000-0000-C000-000000000046';
export const ORIGINAL_SHA256_NAME = 'x-sherlockmail-original-sha256';

// Property tags used by the writer.
export const P = {
  Importance: tag(0x0017, PT.I4), MessageClass: tag(0x001A, PT.UNICODE), Priority: tag(0x0026, PT.I4),
  Sensitivity: tag(0x0036, PT.I4), Subject: tag(0x0037, PT.UNICODE), ClientSubmitTime: tag(0x0039, PT.SYSTIME),
  SentRepresentingSearchKey: tag(0x003B, PT.BINARY), SentRepresentingEntryId: tag(0x0041, PT.BINARY),
  SentRepresentingName: tag(0x0042, PT.UNICODE), MessageToMe: tag(0x0057, PT.BOOL), MessageCcMe: tag(0x0058, PT.BOOL),
  SentRepresentingAddressType: tag(0x0064, PT.UNICODE), SentRepresentingEmailAddress: tag(0x0065, PT.UNICODE),
  ConversationTopic: tag(0x0070, PT.UNICODE), ConversationIndex: tag(0x0071, PT.BINARY),
  TransportMessageHeaders: tag(0x007D, PT.UNICODE), RecipientType: tag(0x0C15, PT.I4),
  SenderEntryId: tag(0x0C19, PT.BINARY), SenderName: tag(0x0C1A, PT.UNICODE), SenderSearchKey: tag(0x0C1D, PT.BINARY),
  SenderAddressType: tag(0x0C1E, PT.UNICODE), SenderEmailAddress: tag(0x0C1F, PT.UNICODE),
  DisplayBcc: tag(0x0E02, PT.UNICODE), DisplayCc: tag(0x0E03, PT.UNICODE), DisplayTo: tag(0x0E04, PT.UNICODE),
  ParentDisplay: tag(0x0E05, PT.UNICODE), MessageDeliveryTime: tag(0x0E06, PT.SYSTIME), MessageFlags: tag(0x0E07, PT.I4),
  MessageSize: tag(0x0E08, PT.I4), Responsibility: tag(0x0E0F, PT.BOOL), MessageStatus: tag(0x0E17, PT.I4),
  AttachSize: tag(0x0E20, PT.I4), AttachNumber: tag(0x0E21, PT.I4), ExchangeRemoteHeader: tag(0x0E2A, PT.BOOL),
  ReplItemid: tag(0x0E30, PT.I4), ReplChangenum: tag(0x0E33, PT.I8), ReplVersionHistory: tag(0x0E34, PT.BINARY),
  ReplFlags: tag(0x0E38, PT.I4), ReplCopiedfromVersionhistory: tag(0x0E3C, PT.BINARY), ReplCopiedfromItemid: tag(0x0E3D, PT.BINARY),
  RecordKey: tag(0x0FF9, PT.BINARY), ObjectType: tag(0x0FFE, PT.I4), EntryId: tag(0x0FFF, PT.BINARY),
  Body: tag(0x1000, PT.UNICODE), Html: tag(0x1013, PT.BINARY), NativeBody: tag(0x1016, PT.I4),
  InternetMessageId: tag(0x1035, PT.UNICODE), InternetReferences: tag(0x1039, PT.UNICODE), InReplyToId: tag(0x1042, PT.UNICODE),
  FlagStatus: tag(0x1090, PT.I4), ItemTemporaryFlags: tag(0x1097, PT.I4),
  RowId: tag(0x3000, PT.I4), DisplayName: tag(0x3001, PT.UNICODE), AddressType: tag(0x3002, PT.UNICODE),
  EmailAddress: tag(0x3003, PT.UNICODE), CreationTime: tag(0x3007, PT.SYSTIME), LastModificationTime: tag(0x3008, PT.SYSTIME),
  SearchKey: tag(0x300B, PT.BINARY), ValidFolderMask: tag(0x35DF, PT.I4), IpmSubTreeEntryId: tag(0x35E0, PT.BINARY),
  IpmWastebasketEntryId: tag(0x35E3, PT.BINARY), FinderEntryId: tag(0x35E7, PT.BINARY),
  ContentCount: tag(0x3602, PT.I4), ContentUnreadCount: tag(0x3603, PT.I4), Subfolders: tag(0x360A, PT.BOOL),
  ContainerClass: tag(0x3613, PT.UNICODE), AttachDataBinary: tag(0x3701, PT.BINARY), AttachDataObject: tag(0x3701, PT.OBJECT),
  AttachExtension: tag(0x3703, PT.UNICODE), AttachFilename: tag(0x3704, PT.UNICODE), AttachMethod: tag(0x3705, PT.I4),
  AttachLongFilename: tag(0x3707, PT.UNICODE), RenderingPosition: tag(0x370B, PT.I4), AttachMimeTag: tag(0x370E, PT.UNICODE),
  AttachContentId: tag(0x3712, PT.UNICODE), AttachFlags: tag(0x3714, PT.I4), DisplayType: tag(0x3900, PT.I4),
  SmtpAddress: tag(0x39FE, PT.UNICODE), SevenBitDisplayName: tag(0x39FF, PT.UNICODE), TransmittableDisplayName: tag(0x3A20, PT.UNICODE),
  SendRichInfo: tag(0x3A40, PT.BOOL), InternetCodepage: tag(0x3FDE, PT.I4),
  SenderSmtpAddress: tag(0x5D01, PT.UNICODE), SentRepresentingSmtpAddress: tag(0x5D02, PT.UNICODE),
  RecipientOrder: tag(0x5FDF, PT.I4), RecipientDisplayName: tag(0x5FF6, PT.UNICODE), RecipientFlags: tag(0x5FFD, PT.I4),
  SecureSubmitFlags: tag(0x65C6, PT.I4), PstLrNoRestrictions: tag(0x6633, PT.BOOL),
  PstHiddenCount: tag(0x6635, PT.I4), PstHiddenUnread: tag(0x6636, PT.I4), LtpParentNid: tag(0x67F1, PT.I4),
  LtpRowId: tag(0x67F2, PT.I4), LtpRowVer: tag(0x67F3, PT.I4), PstPassword: tag(0x67FF, PT.I4),
  ReportName: tag(0x003A, PT.UNICODE), OfflineAddressBookName: tag(0x6800, PT.UNICODE), SendOutlookRecallReport: tag(0x6803, PT.BOOL),
  OfflineAddressBookTruncatedProperties: tag(0x6805, PT.MV_I4), ReplItemidFai: tag(0x682F, PT.UNICODE),
  ViewDescriptorFlags: tag(0x7003, PT.I4), ViewDescriptorLinkTo: tag(0x7004, PT.BINARY), ViewDescriptorViewFolder: tag(0x7005, PT.BINARY),
  ViewDescriptorName: tag(0x7006, PT.UNICODE), ViewDescriptorVersion: tag(0x7007, PT.I4), AttachmentHidden: tag(0x7FFE, PT.BOOL),
};

// Column sets of the template tables, as Outlook writes them (MS-PST sections 2.4.4 to 2.4.8).
const HIERARCHY_COLUMNS = [P.ReplItemid, P.ReplChangenum, P.ReplVersionHistory, P.ReplFlags, P.DisplayName, P.ContentCount,
  P.ContentUnreadCount, P.Subfolders, P.ContainerClass, P.PstHiddenCount, P.PstHiddenUnread, P.LtpRowId, P.LtpRowVer];
const CONTENTS_COLUMNS = [P.Importance, P.MessageClass, P.Sensitivity, P.Subject, P.ClientSubmitTime, P.SentRepresentingName,
  P.MessageToMe, P.MessageCcMe, P.ConversationTopic, P.ConversationIndex, P.DisplayCc, P.DisplayTo, P.MessageDeliveryTime,
  P.MessageFlags, P.MessageSize, P.MessageStatus, P.ReplItemid, P.ReplChangenum, P.ReplVersionHistory, P.ReplFlags,
  P.ReplCopiedfromVersionhistory, P.ReplCopiedfromItemid, P.ItemTemporaryFlags, P.LastModificationTime, P.SecureSubmitFlags,
  P.LtpRowId, P.LtpRowVer];
const FAI_COLUMNS = [P.MessageClass, P.ReportName, P.ConversationTopic, P.MessageFlags, P.MessageStatus, P.DisplayName,
  P.LtpRowId, P.LtpRowVer, P.OfflineAddressBookName, P.SendOutlookRecallReport, P.OfflineAddressBookTruncatedProperties,
  P.ReplItemidFai, P.ViewDescriptorFlags, P.ViewDescriptorLinkTo, P.ViewDescriptorViewFolder, P.ViewDescriptorName,
  P.ViewDescriptorVersion];
const SEARCH_CONTENTS_COLUMNS = [P.Importance, P.MessageClass, P.Sensitivity, P.Subject, P.SentRepresentingName, P.MessageToMe,
  P.DisplayCc, P.DisplayTo, P.ParentDisplay, P.MessageDeliveryTime, P.MessageFlags, P.MessageSize, P.MessageStatus,
  P.ExchangeRemoteHeader, P.LastModificationTime, P.LtpParentNid, P.LtpRowId, P.LtpRowVer];
export const RECIPIENT_COLUMNS = [P.RecipientType, P.Responsibility, P.RecordKey, P.ObjectType, P.EntryId, P.DisplayName,
  P.AddressType, P.EmailAddress, P.SearchKey, P.DisplayType, P.SevenBitDisplayName, P.SendRichInfo, P.LtpRowId, P.LtpRowVer];
const MESSAGE_RECIPIENT_COLUMNS = [...RECIPIENT_COLUMNS, P.RowId, P.SmtpAddress, P.TransmittableDisplayName, P.RecipientOrder,
  P.RecipientDisplayName, P.RecipientFlags];
const ATTACHMENT_COLUMNS = [P.AttachSize, P.AttachFilename, P.AttachMethod, P.RenderingPosition, P.LtpRowId, P.LtpRowVer];
const MESSAGE_ATTACHMENT_COLUMNS = [...ATTACHMENT_COLUMNS, P.AttachLongFilename, P.AttachMimeTag, P.AttachContentId,
  P.AttachmentHidden, P.AttachFlags, P.AttachNumber];

export const ATTACH_BY_VALUE = 1;
export const ATTACH_EMBEDDED_MSG = 5;
export const MSGFLAG = { READ: 0x01, UNMODIFIED: 0x02, HASATTACH: 0x10 };

function guidBytes(guid) {
  const h = guid.replace(/-/g, '');
  const b = Buffer.from(h, 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

// Named properties (MS-PST section 2.4.7): string names in a GUID's property set, numbered from 0x8000.
class NameMap {
  constructor() { this.entries = []; this.byKey = new Map(); this.guids = []; this.strings = []; this.stringLen = 0; }

  tag(guid, name, type) {
    const key = `${guid.toUpperCase()}|${name.toLowerCase()}`;
    let idx = this.byKey.get(key);
    if (idx === undefined) {
      const g = guid.toUpperCase();
      let wGuid = g === PS_MAPI ? 1 : g === PS_PUBLIC_STRINGS ? 2 : 0;
      if (!wGuid) {
        let gi = this.guids.indexOf(g);
        if (gi === -1) { this.guids.push(g); gi = this.guids.length - 1; }
        wGuid = 3 + gi;
      }
      const nameBuf = Buffer.from(name, 'utf16le');
      const entry = Buffer.alloc(align4(4 + nameBuf.length));
      entry.writeUInt32LE(nameBuf.length, 0);
      nameBuf.copy(entry, 4);
      idx = this.entries.length;
      this.entries.push({ offset: this.stringLen, wGuid, crc: pstCrc(nameBuf) });
      this.strings.push(entry);
      this.stringLen += entry.length;
      this.byKey.set(key, idx);
    }
    return tag(0x8000 + idx, type);
  }

  props() {
    const record = (dw, e, i) => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(dw >>> 0, 0);
      b.writeUInt16LE(((e.wGuid << 1) | 1) & 0xFFFF, 4);
      b.writeUInt16LE(i, 6);
      return b;
    };
    const props = new Map([[tag(0x0001, PT.I4), 251]]);
    props.set(tag(0x0002, PT.BINARY), Buffer.concat(this.guids.map(guidBytes)));
    props.set(tag(0x0003, PT.BINARY), Buffer.concat(this.entries.map((e, i) => record(e.offset, e, i))));
    props.set(tag(0x0004, PT.BINARY), Buffer.concat(this.strings));
    const buckets = new Map();
    this.entries.forEach((e, i) => {
      const r = record(e.crc, e, i);
      const bucket = ((r.readUInt32LE(0) ^ (r.readUInt32LE(4) & 0xFFFF)) >>> 0) % 251;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(r);
    });
    for (const [b, list] of buckets) props.set(tag(0x1000 + b, PT.BINARY), Buffer.concat(list));
    return props;
  }
}
const align4 = n => Math.ceil(n / 4) * 4;

// A message ready to write: properties, recipient rows and attachments (which may embed a message).
// spec = { props: Map, recipients: [Map], attachments: [{ props: Map, data?: Buffer, embedded?: spec, embeddedSize?: number }] }

export class PstWriter {
  constructor(filePath, { displayName = 'SherlockMail Export' } = {}) {
    this.ndb = new NdbWriter(filePath);
    this.filePath = filePath;
    this.displayName = displayName;
    this.providerUid = crypto.randomBytes(16);
    this.names = new NameMap();
    this.created = new Date();
    this.nextFolderIndex = 0x404;
    this.nextMessageIndex = 0x10001;
    this.messageCount = 0;
    this.folders = new Map();
    const folder = (nid, parent, name, extra = {}) => {
      const f = { nid, parent, name, children: [], rows: [], unread: 0, ...extra };
      this.folders.set(nid, f);
      if (parent !== nid && this.folders.has(parent)) this.folders.get(parent).children.push(f);
      return f;
    };
    this.root = folder(NID.ROOT_FOLDER, NID.ROOT_FOLDER, '');
    this.ipm = folder(NID.IPM_SUBTREE, NID.ROOT_FOLDER, 'Top of Personal Folders');
    folder(NID.SEARCH_ROOT, NID.ROOT_FOLDER, 'Search Root');
    folder(NID.SPAM_SEARCH_FOLDER, NID.ROOT_FOLDER, 'SPAM Search Folder 2', { search: true });
    // libpff will not open a store whose named-property map has no entries, so the hash of the
    // original message is registered up front; every message written by SherlockMail carries it.
    this.namedTag(PS_INTERNET_HEADERS, ORIGINAL_SHA256_NAME, PT.UNICODE);
    folder(NID.DELETED_ITEMS, NID.IPM_SUBTREE, 'Deleted Items', { containerClass: 'IPF.Note', special: true });
  }

  get bytesWritten() { return this.ndb.bytesWritten; }

  namedTag(guid, name, type) { return this.names.tag(guid, name, type); }

  entryId(nid) {
    const b = Buffer.alloc(24);
    this.providerUid.copy(b, 4);
    b.writeUInt32LE(nid, 20);
    return b;
  }

  // Folder for a path of names under Top of Personal Folders, created on first use.
  folder(segments) {
    let parent = this.ipm;
    for (const name of segments) {
      let f = parent.children.find(c => c.name === name && !c.special);
      if (!f) {
        const nid = nidOf(this.nextFolderIndex++, T.NORMAL_FOLDER);
        f = { nid, parent: parent.nid, name, children: [], rows: [], unread: 0, containerClass: 'IPF.Note' };
        this.folders.set(nid, f);
        parent.children.push(f);
      }
      parent = f;
    }
    return parent;
  }

  _writeNodeFromPC(props, sub) {
    const blocks = buildPC(props, sub);
    return { bidData: this.ndb.writeDataTree(blocks), bidSub: sub.write() };
  }

  _writeTable(columns, rows) {
    const sub = new Subnodes(this.ndb);
    const blocks = buildTC(columns, rows, sub);
    return { bidData: this.ndb.writeDataTree(blocks), bidSub: sub.write() };
  }

  // Writes a message's PC and its subnodes (recipient table, attachment table and attachments).
  _writeMessageNode(spec) {
    const sub = new Subnodes(this.ndb);
    const recipientRows = spec.recipients.map((r, i) => ({ id: i, values: new Map([...r, [P.RowId, i]]) }));
    const recip = this._writeTable(MESSAGE_RECIPIENT_COLUMNS, recipientRows);
    sub.addNode(NID.RECIPIENT_TABLE, recip.bidData, recip.bidSub);
    if (spec.attachments.length) {
      const rows = spec.attachments.map((a, i) => {
        const anid = nidOf(0x8000 + i, T.ATTACHMENT);
        const asub = new Subnodes(this.ndb);
        const props = new Map(a.props);
        props.set(P.AttachNumber, i);
        props.set(P.ObjectType, 7);           // MAPI_ATTACH
        if (a.embedded) {
          const enid = nidOf(0x8000 + i, T.NORMAL_MESSAGE);
          const node = this._writeMessageNode(a.embedded);
          asub.addNode(enid, node.bidData, node.bidSub);
          const obj = Buffer.alloc(8);
          obj.writeUInt32LE(enid, 0);
          obj.writeUInt32LE(Math.min(a.embeddedSize || 0, 0xFFFFFFFF), 4);
          props.set(P.AttachDataObject, obj);
          props.set(P.AttachMethod, ATTACH_EMBEDDED_MSG);
        } else {
          props.set(P.AttachDataBinary, a.data || Buffer.alloc(0));
          props.set(P.AttachMethod, ATTACH_BY_VALUE);
        }
        const node = this._writeNodeFromPC(props, asub);
        sub.addNode(anid, node.bidData, node.bidSub);
        return { id: anid, values: props };
      });
      const att = this._writeTable(MESSAGE_ATTACHMENT_COLUMNS, rows);
      sub.addNode(NID.ATTACHMENT_TABLE, att.bidData, att.bidSub);
    }
    return this._writeNodeFromPC(spec.props, sub);
  }

  addMessage(folder, spec) {
    const nid = nidOf(this.nextMessageIndex++, T.NORMAL_MESSAGE);
    const node = this._writeMessageNode(spec);
    this.ndb.addNode(nid, node.bidData, node.bidSub, folder.nid);
    const row = new Map();
    for (const t of CONTENTS_COLUMNS) if (spec.props.has(t)) row.set(t, spec.props.get(t));
    folder.rows.push({ id: nid, values: row });
    if (!((spec.props.get(P.MessageFlags) || 0) & MSGFLAG.READ)) folder.unread++;
    this.messageCount++;
    return nid;
  }

  _folderProps(f) {
    const props = new Map([
      [P.DisplayName, f.name],
      [P.ContentCount, f.rows.length],
      [P.ContentUnreadCount, f.unread],
      [P.Subfolders, f.children.length > 0],
    ]);
    if (f.containerClass) props.set(P.ContainerClass, f.containerClass);
    return props;
  }

  _writeFolder(f) {
    const props = this._folderProps(f);
    const pc = this._writeNodeFromPC(props, new Subnodes(this.ndb));
    this.ndb.addNode(f.nid, pc.bidData, pc.bidSub, f.parent);
    if (f.search) return;
    const index = nidIndex(f.nid);
    const hierarchyRows = f.children.map(c => {
      const cp = this._folderProps(c);
      cp.set(P.PstHiddenCount, 0);
      cp.set(P.PstHiddenUnread, 0);
      return { id: c.nid, values: cp };
    });
    const tables = [
      [T.HIERARCHY, HIERARCHY_COLUMNS, hierarchyRows],
      [T.CONTENTS, CONTENTS_COLUMNS, f.rows],
      [T.FAI, FAI_COLUMNS, []],
    ];
    for (const [type, columns, rows] of tables) {
      const t = this._writeTable(columns, rows);
      this.ndb.addNode(nidOf(index, type), t.bidData, t.bidSub, 0);
    }
  }

  close() {
    try {
      for (const f of this.folders.values()) this._writeFolder(f);
      for (const [nid, cols] of [[NID.HIERARCHY_TEMPLATE, HIERARCHY_COLUMNS], [NID.CONTENTS_TEMPLATE, CONTENTS_COLUMNS],
        [NID.FAI_TEMPLATE, FAI_COLUMNS], [NID.SEARCH_CONTENTS_TEMPLATE, SEARCH_CONTENTS_COLUMNS],
        [NID.RECIPIENT_TABLE, RECIPIENT_COLUMNS], [NID.ATTACHMENT_TABLE, ATTACHMENT_COLUMNS]]) {
        const t = this._writeTable(cols, []);
        this.ndb.addNode(nid, t.bidData, t.bidSub, 0);
      }
      const names = this._writeNodeFromPC(this.names.props(), new Subnodes(this.ndb));
      this.ndb.addNode(NID.NAME_TO_ID_MAP, names.bidData, names.bidSub, 0);
      const store = this._writeNodeFromPC(new Map([
        [P.ReplFlags, 0],
        [P.RecordKey, this.providerUid],
        [P.DisplayName, this.displayName],
        [P.ValidFolderMask, 0x89],            // IPM subtree, wastebasket and finder are valid
        [P.IpmSubTreeEntryId, this.entryId(NID.IPM_SUBTREE)],
        [P.IpmWastebasketEntryId, this.entryId(NID.DELETED_ITEMS)],
        [P.FinderEntryId, this.entryId(NID.SEARCH_ROOT)],
        [P.PstLrNoRestrictions, true],
        [P.PstPassword, 0],
      ]), new Subnodes(this.ndb));
      this.ndb.addNode(NID.MESSAGE_STORE, store.bidData, store.bidSub, 0);
      this.ndb.addNode(NID.SEARCH_MANAGEMENT_QUEUE, 0, 0, 0);
      this.ndb.addNode(NID.SEARCH_ACTIVITY_LIST, 0, 0, 0);

      const rgnid = new Array(32).fill(0x400);
      const lastFolder = this.nextFolderIndex - 1;
      rgnid[T.NORMAL_FOLDER] = lastFolder;
      rgnid[0x03] = 0x4000;
      rgnid[T.NORMAL_MESSAGE] = this.nextMessageIndex - 1;
      rgnid[0x08] = 0x8000;
      rgnid[T.HIERARCHY] = lastFolder;
      rgnid[T.CONTENTS] = lastFolder;
      rgnid[T.FAI] = lastFolder;
      const result = this.ndb.finish({ rgnid });
      return { path: this.filePath, size: result.size, messageCount: this.messageCount, folderCount: this.folders.size };
    } catch (err) {
      this.ndb.abort();
      throw err;
    }
  }

  abort() { this.ndb.abort(); }
}

export { encodeValue };
