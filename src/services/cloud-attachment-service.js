import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const LINK_PATTERNS = [
  { provider: 'google_drive', pattern: /https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|drive\/folders\/)([a-zA-Z0-9_-]+)/g, label: 'Google Drive' },
  { provider: 'google_docs', pattern: /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/g, label: 'Google Docs' },
  { provider: 'onedrive', pattern: /https?:\/\/(?:1drv\.ms|onedrive\.live\.com)\/[^\s"<>]+/g, label: 'OneDrive' },
  { provider: 'sharepoint', pattern: /https?:\/\/[a-z0-9-]+\.sharepoint\.com\/[^\s"<>]+/g, label: 'SharePoint' },
  { provider: 'dropbox', pattern: /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|sh|scl)\/[^\s"<>]+/g, label: 'Dropbox' },
  { provider: 'box', pattern: /https?:\/\/(?:app\.)?box\.com\/s\/[a-zA-Z0-9]+/g, label: 'Box' },
];

export class CloudAttachmentService {

  static scanMessages(messages) {
    const allLinks = [];
    const stats = { google_drive: 0, google_docs: 0, onedrive: 0, sharepoint: 0, dropbox: 0, box: 0 };

    for (const msg of messages) {
      const text = [
        msg.body_text || msg.bodyText || '',
        msg.body_html || msg.bodyHtml || '',
      ].join(' ');

      const links = this.detectLinks(text);
      for (const link of links) {
        stats[link.provider] = (stats[link.provider] || 0) + 1;
        allLinks.push({
          id: uuidv4(),
          messageId: msg.id,
          messageSubject: msg.subject,
          messageFrom: msg.from_address || msg.fromAddress,
          messageDate: msg.date,
          ...link,
        });
      }
    }

    const totalProviders = Object.values(stats).filter(v => v > 0).length;

    return {
      totalLinks: allLinks.length,
      totalProviders,
      byProvider: stats,
      links: allLinks,
      forensicNote: allLinks.length > 0
        ? 'Cloud-hosted attachments exist outside the mailbox. These links reference files stored on third-party platforms that are not captured by email collection alone. Consider separate preservation of linked cloud files.'
        : 'No cloud attachment links detected in collected messages.',
    };
  }

  static detectLinks(text) {
    const links = [];
    const seen = new Set();

    for (const { provider, pattern, label } of LINK_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        const url = match[0];
        if (seen.has(url)) continue;
        seen.add(url);

        links.push({
          provider,
          providerLabel: label,
          url,
          fileId: match[1] || null,
          status: 'detected',
          detectedAt: new Date().toISOString(),
        });
      }
    }

    return links;
  }

  static getProviderInfo() {
    return {
      google_drive: {
        name: 'Google Drive',
        preservationMethod: 'Google Vault or Takeout export, or direct API download with Drive API scope',
        forensicConsiderations: [
          'Version history may contain relevant earlier versions',
          'Sharing permissions show who had access',
          'Activity log shows view/edit/download events',
          'Files may be owned by a different user than the email sender',
        ],
      },
      onedrive: {
        name: 'OneDrive / SharePoint',
        preservationMethod: 'Microsoft Purview eDiscovery or Graph API download',
        forensicConsiderations: [
          'Modern attachments in O365 are OneDrive links by default',
          'Version history preserved in SharePoint',
          'Shared links may expire or be revoked',
          'Sensitivity labels may restrict download',
        ],
      },
      dropbox: {
        name: 'Dropbox',
        preservationMethod: 'Dropbox Business admin export or API download',
        forensicConsiderations: [
          'Shared links may have password protection',
          'File may have been deleted after sharing',
          'Event log shows access history',
        ],
      },
      box: {
        name: 'Box',
        preservationMethod: 'Box admin export or Content API download',
        forensicConsiderations: [
          'Box watermarking may be enabled',
          'Access statistics available for shared links',
          'Retention policies may auto-delete content',
        ],
      },
    };
  }
}
