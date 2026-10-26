import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { HashManager } from './hash-manager.js';

export class CloudCollectionService {

  // ── Google Drive ──

  static async listGoogleDriveItems(accessToken, options = {}) {
    const query = options.query || "'root' in parents and trashed=false";
    const fields = 'files(id,name,mimeType,size,createdTime,modifiedTime,owners,shared,webViewLink,parents),nextPageToken';
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=100`;
    if (options.pageToken) url += `&pageToken=${options.pageToken}`;

    const data = await this._apiGet(url, accessToken);
    return {
      items: (data.files || []).map(f => ({
        id: uuidv4(),
        provider: 'google_drive',
        itemType: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
        name: f.name,
        mimeType: f.mimeType,
        size: parseInt(f.size) || 0,
        remoteId: f.id,
        parentId: f.parents?.[0] || null,
        webUrl: f.webViewLink,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
        owner: f.owners?.[0]?.emailAddress || null,
        shared: !!f.shared,
      })),
      nextPageToken: data.nextPageToken || null,
    };
  }

  static async getGoogleDriveRevisions(accessToken, fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser,size)`;
    const data = await this._apiGet(url, accessToken);
    return (data.revisions || []).map(r => ({
      id: uuidv4(),
      revisionId: r.id,
      modifiedTime: r.modifiedTime,
      modifier: r.lastModifyingUser?.emailAddress || null,
      size: parseInt(r.size) || 0,
    }));
  }

  static async downloadGoogleDriveFile(accessToken, fileId, outputPath) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    return this._downloadFile(url, accessToken, outputPath);
  }

  static async listGoogleSharedDrives(accessToken) {
    const url = 'https://www.googleapis.com/drive/v3/drives?pageSize=100';
    const data = await this._apiGet(url, accessToken);
    return (data.drives || []).map(d => ({
      id: uuidv4(),
      provider: 'google_drive',
      itemType: 'shared_drive',
      name: d.name,
      remoteId: d.id,
    }));
  }

  // ── OneDrive ──

  static async listOneDriveItems(accessToken, options = {}) {
    const userId = options.userId || 'me';
    const folderId = options.folderId || 'root';
    const url = `https://graph.microsoft.com/v1.0/${userId === 'me' ? 'me' : `users/${userId}`}/drive/items/${folderId}/children?$top=100`;

    const data = await this._apiGet(url, accessToken);
    return {
      items: (data.value || []).map(item => ({
        id: uuidv4(),
        provider: 'onedrive',
        itemType: item.folder ? 'folder' : 'file',
        name: item.name,
        mimeType: item.file?.mimeType || null,
        size: item.size || 0,
        remoteId: item.id,
        parentId: item.parentReference?.id || null,
        path: item.parentReference?.path || null,
        webUrl: item.webUrl,
        createdTime: item.createdDateTime,
        modifiedTime: item.lastModifiedDateTime,
        owner: item.createdBy?.user?.email || null,
        shared: !!item.shared,
      })),
      nextLink: data['@odata.nextLink'] || null,
    };
  }

  static async getOneDriveRevisions(accessToken, itemId, userId) {
    const base = userId && userId !== 'me' ? `users/${userId}` : 'me';
    const url = `https://graph.microsoft.com/v1.0/${base}/drive/items/${itemId}/versions`;
    const data = await this._apiGet(url, accessToken);
    return (data.value || []).map(v => ({
      id: uuidv4(),
      revisionId: v.id,
      modifiedTime: v.lastModifiedDateTime,
      modifier: v.lastModifiedBy?.user?.email || null,
      size: v.size || 0,
    }));
  }

  static async downloadOneDriveFile(accessToken, itemId, outputPath, userId) {
    const base = userId && userId !== 'me' ? `users/${userId}` : 'me';
    const url = `https://graph.microsoft.com/v1.0/${base}/drive/items/${itemId}/content`;
    return this._downloadFile(url, accessToken, outputPath);
  }

  // ── SharePoint ──

  static async listSharePointSites(accessToken, searchQuery) {
    const url = searchQuery
      ? `https://graph.microsoft.com/v1.0/sites?search=${encodeURIComponent(searchQuery)}`
      : 'https://graph.microsoft.com/v1.0/sites?search=*';
    const data = await this._apiGet(url, accessToken);
    return (data.value || []).map(s => ({
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
    const driveId = options.driveId;
    const url = driveId
      ? `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/root/children`
      : `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root/children`;
    const data = await this._apiGet(url, accessToken);
    return (data.value || []).map(item => ({
      id: uuidv4(),
      provider: 'sharepoint',
      itemType: item.folder ? 'folder' : 'file',
      name: item.name,
      mimeType: item.file?.mimeType || null,
      size: item.size || 0,
      remoteId: item.id,
      webUrl: item.webUrl,
      createdTime: item.createdDateTime,
      modifiedTime: item.lastModifiedDateTime,
    }));
  }

  // ── Google Calendar ──

  static async listGoogleCalendarEvents(accessToken, options = {}) {
    const calendarId = options.calendarId || 'primary';
    let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=250&singleEvents=true&orderBy=startTime`;
    if (options.timeMin) url += `&timeMin=${encodeURIComponent(options.timeMin)}`;
    if (options.timeMax) url += `&timeMax=${encodeURIComponent(options.timeMax)}`;
    if (options.pageToken) url += `&pageToken=${options.pageToken}`;

    const data = await this._apiGet(url, accessToken);
    return {
      events: (data.items || []).map(e => ({
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
        hashSha256: crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex'),
      })),
      nextPageToken: data.nextPageToken || null,
    };
  }

  // ── Google Contacts ──

  static async listGoogleContacts(accessToken, options = {}) {
    let url = 'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=100';
    if (options.pageToken) url += `&pageToken=${options.pageToken}`;

    const data = await this._apiGet(url, accessToken);
    return {
      contacts: (data.connections || []).map(p => ({
        id: uuidv4(),
        provider: 'google',
        contactId: p.resourceName,
        displayName: p.names?.[0]?.displayName || null,
        emailAddresses: (p.emailAddresses || []).map(e => e.value),
        phoneNumbers: (p.phoneNumbers || []).map(ph => ph.value),
        organization: p.organizations?.[0]?.name || null,
        title: p.organizations?.[0]?.title || null,
        hashSha256: crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex'),
      })),
      nextPageToken: data.nextPageToken || null,
    };
  }

  // ── Microsoft Contacts ──

  static async listMicrosoftContacts(accessToken, options = {}) {
    const userId = options.userId || 'me';
    const url = `https://graph.microsoft.com/v1.0/${userId === 'me' ? 'me' : `users/${userId}`}/contacts?$top=100`;
    const data = await this._apiGet(url, accessToken);
    return {
      contacts: (data.value || []).map(c => ({
        id: uuidv4(),
        provider: 'microsoft',
        contactId: c.id,
        displayName: c.displayName || null,
        emailAddresses: (c.emailAddresses || []).map(e => e.address),
        phoneNumbers: [c.mobilePhone, ...(c.businessPhones || []), ...(c.homePhones || [])].filter(Boolean),
        organization: c.companyName || null,
        title: c.jobTitle || null,
        hashSha256: crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'),
      })),
      nextLink: data['@odata.nextLink'] || null,
    };
  }

  // ── Helpers ──

  static async _apiGet(url, accessToken) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      }, (res) => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode === 200) resolve(JSON.parse(body));
          else reject(new Error(`API ${res.statusCode}: ${body.substring(0, 200)}`));
        });
      });
      req.on('error', reject); req.end();
    });
  }

  static async _downloadFile(url, accessToken, outputPath) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return this._downloadFile(res.headers.location, accessToken, outputPath).then(resolve).catch(reject);
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const ws = fs.createWriteStream(outputPath);
        const hasher = HashManager.computeStreaming(['md5', 'sha256']);
        let totalBytes = 0;
        res.on('data', chunk => { ws.write(chunk); hasher.update(chunk); totalBytes += chunk.length; });
        res.on('end', () => {
          ws.end();
          const hashes = hasher.digest();
          resolve({ outputPath, size: totalBytes, ...hashes });
        });
        res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
  }
}
