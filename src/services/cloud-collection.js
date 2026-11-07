import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Listings of what an account holds in Google and Microsoft cloud services. Every call follows the provider's
// paging to the end, so a count here is the whole folder, not the first page. Files are downloaded by the
// Drive/OneDrive collection (drive-collector.js), which also verifies them.

const GRAPH = process.env.SHERLOCKMAIL_GRAPH_URL || 'https://graph.microsoft.com/v1.0';
const GOOGLE_ROOT = (process.env.SHERLOCKMAIL_GOOGLE_API_URL || 'https://www.googleapis.com/').replace(/\/$/, '');
const PEOPLE_ROOT = process.env.SHERLOCKMAIL_GOOGLE_API_URL ? GOOGLE_ROOT : 'https://people.googleapis.com';
const REQUEST_TIMEOUT_MS = 120000;

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeId(id) {
  return encodeURIComponent(id);
}

export class CloudCollectionService {

  // ── Google Drive ──

  static async listGoogleDriveItems(accessToken, options = {}) {
    const query = options.query || 'trashed=false';
    const fields = 'files(id,name,mimeType,size,createdTime,modifiedTime,owners,shared,webViewLink,parents,md5Checksum,sha256Checksum),nextPageToken';
    const url = `${GOOGLE_ROOT}/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const files = await this._allGooglePages(url, accessToken, 'files');
    return {
      items: files.map(f => ({
        id: uuidv4(),
        provider: 'google_drive',
        itemType: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        name: f.name,
        mimeType: f.mimeType,
        size: parseInt(f.size, 10) || 0,
        remoteId: f.id,
        parentId: f.parents?.[0] || null,
        webUrl: f.webViewLink,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.emailAddress || null,
        shared: !!f.shared,
      })),
    };
  }

  static async getGoogleDriveRevisions(accessToken, fileId) {
    const fields = encodeURIComponent('revisions(id,modifiedTime,lastModifyingUser,size,md5Checksum),nextPageToken');
    const revisions = await this._allGooglePages(`${GOOGLE_ROOT}/drive/v3/files/${encodeId(fileId)}/revisions?fields=${fields}&pageSize=200`, accessToken, 'revisions');
    return revisions.map(r => ({
      id: uuidv4(),
      revisionId: r.id,
      modifiedTime: r.modifiedTime,
      modifier: r.lastModifyingUser?.emailAddress || null,
      size: parseInt(r.size, 10) || 0,
      md5: r.md5Checksum || null,
    }));
  }

  static async listGoogleSharedDrives(accessToken) {
    const drives = await this._allGooglePages(`${GOOGLE_ROOT}/drive/v3/drives?pageSize=100`, accessToken, 'drives');
    return drives.map(d => ({ id: uuidv4(), provider: 'google_drive', itemType: 'shared_drive', name: d.name, remoteId: d.id }));
  }

  // ── OneDrive ──

  static async listOneDriveItems(accessToken, options = {}) {
    const base = this._graphUser(options.userId);
    const items = [];
    const walk = async (folderId, parentPath) => {
      const rows = await this._allGraphPages(`${GRAPH}${base}/drive/items/${encodeId(folderId)}/children?$top=200`, accessToken);
      for (const item of rows) {
        items.push(this._driveItem(item, 'onedrive', parentPath));
        if (item.folder && options.recursive !== 'false') await walk(item.id, `${parentPath}/${item.name}`);
      }
    };
    await walk(options.folderId || 'root', '');
    return { items };
  }

  static async getOneDriveRevisions(accessToken, itemId, userId) {
    const rows = await this._allGraphPages(`${GRAPH}${this._graphUser(userId)}/drive/items/${encodeId(itemId)}/versions`, accessToken);
    return rows.map(v => ({
      id: uuidv4(),
      revisionId: v.id,
      modifiedTime: v.lastModifiedDateTime,
      modifier: v.lastModifiedBy?.user?.email || v.lastModifiedBy?.user?.displayName || null,
      size: v.size || 0,
    }));
  }

  // ── SharePoint ──

  static async listSharePointSites(accessToken, searchQuery) {
    const rows = await this._allGraphPages(`${GRAPH}/sites?search=${encodeURIComponent(searchQuery || '*')}`, accessToken);
    return rows.map(s => ({
      id: uuidv4(),
      provider: 'sharepoint',
      itemType: 'site',
      name: s.displayName,
      remoteId: s.id,
      webUrl: s.webUrl,
      metadata: { description: s.description, hostname: s.siteCollection?.hostname },
    }));
  }

  static async listSharePointDocuments(accessToken, siteId, options = {}) {
    const root = options.driveId
      ? `${GRAPH}/sites/${encodeId(siteId)}/drives/${encodeId(options.driveId)}`
      : `${GRAPH}/sites/${encodeId(siteId)}/drive`;
    const items = [];
    const walk = async (url, parentPath) => {
      for (const item of await this._allGraphPages(url, accessToken)) {
        items.push(this._driveItem(item, 'sharepoint', parentPath));
        if (item.folder) await walk(`${root}/items/${encodeId(item.id)}/children`, `${parentPath}/${item.name}`);
      }
    };
    await walk(`${root}/root/children`, '');
    return items;
  }

  // ── Google Calendar ──

  static async listGoogleCalendarEvents(accessToken, options = {}) {
    const calendarId = options.calendarId || 'primary';
    let url = `${GOOGLE_ROOT}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=2500&singleEvents=true&orderBy=startTime&showDeleted=true`;
    if (options.timeMin) url += `&timeMin=${encodeURIComponent(options.timeMin)}`;
    if (options.timeMax) url += `&timeMax=${encodeURIComponent(options.timeMax)}`;
    const events = await this._allGooglePages(url, accessToken, 'items');
    return {
      raw: events,
      events: events.map(e => ({
        id: uuidv4(),
        provider: 'google',
        eventId: e.id,
        summary: e.summary || '(no title)',
        description: e.description || null,
        location: e.location || null,
        startTime: e.start?.dateTime || e.start?.date || null,
        endTime: e.end?.dateTime || e.end?.date || null,
        organizer: e.organizer?.email || null,
        attendees: (e.attendees || []).map(a => ({ email: a.email, status: a.responseStatus })),
        recurrence: e.recurrence?.join('; ') || null,
        status: e.status,
        hashSha256: sha256Json(e),
      })),
    };
  }

  // ── Contacts ──

  static async listGoogleContacts(accessToken) {
    const url = `${PEOPLE_ROOT}/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,biographies&pageSize=1000`;
    const people = await this._allGooglePages(url, accessToken, 'connections');
    return {
      raw: people,
      contacts: people.map(p => ({
        id: uuidv4(),
        provider: 'google',
        contactId: p.resourceName,
        displayName: p.names?.[0]?.displayName || null,
        emailAddresses: (p.emailAddresses || []).map(e => e.value),
        phoneNumbers: (p.phoneNumbers || []).map(ph => ph.value),
        organization: p.organizations?.[0]?.name || null,
        title: p.organizations?.[0]?.title || null,
        hashSha256: sha256Json(p),
      })),
    };
  }

  static async listMicrosoftContacts(accessToken, options = {}) {
    const rows = await this._allGraphPages(`${GRAPH}${this._graphUser(options.userId)}/contacts?$top=200`, accessToken);
    return {
      raw: rows,
      contacts: rows.map(c => ({
        id: uuidv4(),
        provider: 'microsoft',
        contactId: c.id,
        displayName: c.displayName || null,
        emailAddresses: (c.emailAddresses || []).map(e => e.address),
        phoneNumbers: [c.mobilePhone, ...(c.businessPhones || []), ...(c.homePhones || [])].filter(Boolean),
        organization: c.companyName || null,
        title: c.jobTitle || null,
        hashSha256: sha256Json(c),
      })),
    };
  }

  // ── Helpers ──

  static _graphUser(userId) {
    return userId && userId !== 'me' ? `/users/${encodeId(userId)}` : '/me';
  }

  static _driveItem(item, provider, parentPath) {
    return {
      id: uuidv4(),
      provider,
      itemType: item.folder ? 'folder' : 'file',
      name: item.name,
      mimeType: item.file?.mimeType || null,
      size: item.size || 0,
      remoteId: item.id,
      parentId: item.parentReference?.id || null,
      path: `${parentPath}/${item.name}`,
      webUrl: item.webUrl,
      createdTime: item.createdDateTime,
      modifiedTime: item.lastModifiedDateTime,
      owner: item.createdBy?.user?.email || null,
      shared: !!item.shared,
    };
  }

  static async _apiGet(url, accessToken) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body.slice(0, 300);
      try { const j = JSON.parse(body); message = j.error?.message || message; } catch { /* the raw text is the message */ }
      const err = new Error(`The service refused the request (HTTP ${res.status}): ${message}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(body);
  }

  static async _allGooglePages(firstUrl, accessToken, listKey) {
    const rows = [];
    let pageToken = null;
    do {
      const data = await this._apiGet(pageToken ? `${firstUrl}&pageToken=${encodeURIComponent(pageToken)}` : firstUrl, accessToken);
      rows.push(...(data[listKey] || []));
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return rows;
  }

  static async _allGraphPages(firstUrl, accessToken) {
    const rows = [];
    for (let url = firstUrl; url;) {
      const data = await this._apiGet(url, accessToken);
      rows.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    return rows;
  }
}
