// Read-only views of parts of an Exchange mailbox that matter in an investigation, over a connected EwsHandler.
// A folder or feature the server refuses is reported with its error: "could not read" is never shown as "empty".

const RECOVERABLE_FOLDERS = ['Recoverable Items/Deletions', 'Recoverable Items/Purges', 'Recoverable Items/Versions'];
const FLAGGED_RULE_ACTIONS = new Set(['ForwardToRecipients', 'ForwardAsAttachmentToRecipients', 'RedirectToRecipients', 'Delete', 'PermanentDelete']);

const KNOWN_VERSIONS = [
  { match: v => v.major === 15 && v.minor >= 20, name: 'Exchange Online', year: 'Online', online: true },
  { match: v => v.major === 15 && v.minor === 2, name: 'Exchange Server 2019', year: '2019' },
  { match: v => v.major === 15 && v.minor === 1, name: 'Exchange Server 2016', year: '2016' },
  { match: v => v.major === 15 && v.minor === 0, name: 'Exchange Server 2013', year: '2013' },
  { match: v => v.major === 14, name: 'Exchange Server 2010', year: '2010' },
  { match: v => v.major === 8, name: 'Exchange Server 2007', year: '2007' },
];

export class ExchangeAdvancedService {

  static async getRecoverableItems(handler, targetEmail, options = {}) {
    const folders = [];
    for (const folder of RECOVERABLE_FOLDERS) {
      try {
        const { total, items } = await handler.listItemSummaries(folder, { limit: options.limit || 1000 });
        folders.push({ folder, itemCount: total, items });
      } catch (err) {
        folders.push({ folder, itemCount: null, error: err.message });
      }
    }
    return {
      targetEmail,
      totalRecoverableItems: folders.reduce((s, r) => s + (r.itemCount || 0), 0),
      unreadableFolders: folders.filter(f => f.error).length,
      folders,
      forensicNote: 'Recoverable Items hold deleted mail that has not yet been purged. These folders are listed in Collect, step 4, and can be collected like any other folder.',
    };
  }

  static async getPublicFolders(handler) {
    try {
      const folders = await handler.listFoldersUnder('publicfoldersroot');
      return { totalFolders: folders.length, folders: folders.map(f => ({ name: f.name, totalMessages: f.totalMessages, id: f.ewsFolderId })), forensicNote: 'Public folders may hold organizational communications relevant to the investigation scope.' };
    } catch (err) {
      return { totalFolders: null, folders: [], error: err.message };
    }
  }

  static async getArchiveMailbox(handler, targetEmail) {
    try {
      const folders = await handler.listFoldersUnder('archivemsgfolderroot');
      return {
        targetEmail,
        hasArchive: folders.length > 0,
        totalFolders: folders.length,
        folders: folders.map(f => ({ name: f.name, totalMessages: f.totalMessages, path: `Online Archive/${f.name}` })),
        forensicNote: 'Archive mailboxes hold older messages moved by retention policies. They are listed in Collect, step 4, as "Online Archive".',
      };
    } catch (err) {
      // A mailbox with no archive answers with this code; anything else is a real failure to read.
      if (err.ewsCode === 'ErrorFolderNotFound') return { targetEmail, hasArchive: false, totalFolders: 0, folders: [] };
      return { targetEmail, hasArchive: null, totalFolders: null, folders: [], error: err.message };
    }
  }

  static async getInboxRules(handler, targetEmail) {
    try {
      const rules = await handler.getInboxRules(targetEmail);
      return {
        targetEmail,
        totalRules: rules.length,
        rules,
        redFlags: rules.filter(r => r.actions.some(a => FLAGGED_RULE_ACTIONS.has(a.type))),
        forensicNote: 'Inbox rules can move, delete or forward mail automatically. Rules that forward outside the organization or delete mail are significant.',
      };
    } catch (err) {
      return { targetEmail, totalRules: null, rules: [], redFlags: [], error: err.message };
    }
  }

  // The version the server states in every EWS response.
  static detectExchangeVersion(handler) {
    const serverVersion = handler.serverVersion;
    if (!serverVersion) return { serverVersion: null, error: 'The server did not state its version' };
    const [major, minor] = serverVersion.split('.').map(Number);
    const known = KNOWN_VERSIONS.find(k => k.match({ major, minor }));
    return { ewsUrl: handler.ewsUrl, serverVersion, product: known?.name || 'Unknown Exchange version', exchangeYear: known?.year || null, isOnline: !!known?.online };
  }
}
