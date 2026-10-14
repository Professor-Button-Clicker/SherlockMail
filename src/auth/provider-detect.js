import { resolve4, resolveMx } from 'node:dns/promises';

const PROVIDER_PROFILES = {
  gmail: {
    name: 'Gmail / Google Workspace',
    type: 'gmail_api',
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
    supportsOAuth: true,
    mxPatterns: ['google.com', 'googlemail.com', 'gmail-smtp-in.l.google.com']
  },
  outlook: {
    name: 'Microsoft 365 / Outlook.com',
    type: 'graph_api',
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: true },
    ews: { url: 'https://outlook.office365.com/EWS/Exchange.asmx' },
    supportsOAuth: true,
    mxPatterns: ['outlook.com', 'protection.outlook.com', 'microsoft.com']
  },
  yahoo: {
    name: 'Yahoo Mail',
    type: 'imap',
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, tls: true },
    supportsOAuth: true,
    requiresAppPassword: true,
    mxPatterns: ['yahoodns.net', 'yahoo.com', 'am0.yahoodns.net']
  },
  aol: {
    name: 'AOL Mail',
    type: 'imap',
    imap: { host: 'imap.aol.com', port: 993, tls: true },
    smtp: { host: 'smtp.aol.com', port: 465, tls: true },
    supportsOAuth: true,
    requiresAppPassword: true,
    mxPatterns: ['mx-aol.mail.gm0.yahoodns.net', 'aol.com']
  },
  icloud: {
    name: 'iCloud Mail',
    type: 'imap',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: true },
    supportsOAuth: false,
    requiresAppPassword: true,
    mxPatterns: ['icloud.com', 'me.com', 'apple.com']
  },
  protonmail: {
    name: 'ProtonMail (via Bridge)',
    type: 'imap',
    imap: { host: '127.0.0.1', port: 1143, tls: false },
    smtp: { host: '127.0.0.1', port: 1025, tls: false },
    supportsOAuth: false,
    requiresBridge: true,
    mxPatterns: ['protonmail.ch', 'proton.me']
  },
  zoho: {
    name: 'Zoho Mail',
    type: 'imap',
    imap: { host: 'imap.zoho.com', port: 993, tls: true },
    smtp: { host: 'smtp.zoho.com', port: 465, tls: true },
    supportsOAuth: true,
    mxPatterns: ['zoho.com', 'zohomail.com']
  },
  comcast: {
    name: 'Comcast / Xfinity',
    type: 'imap',
    imap: { host: 'imap.comcast.net', port: 993, tls: true },
    smtp: { host: 'smtp.comcast.net', port: 587, tls: true },
    supportsOAuth: false,
    requiresAppPassword: true,
    usernameIsLocalPart: true,
    mxPatterns: ['comcast.net']
  }
};

export async function detectProvider(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const knownDomains = {
    'gmail.com': 'gmail',
    'googlemail.com': 'gmail',
    'outlook.com': 'outlook',
    'hotmail.com': 'outlook',
    'live.com': 'outlook',
    'msn.com': 'outlook',
    'yahoo.com': 'yahoo',
    'ymail.com': 'yahoo',
    'aol.com': 'aol',
    'icloud.com': 'icloud',
    'me.com': 'icloud',
    'mac.com': 'icloud',
    'protonmail.com': 'protonmail',
    'proton.me': 'protonmail',
    'pm.me': 'protonmail',
    'zoho.com': 'zoho',
    'comcast.net': 'comcast',
    'xfinity.com': 'comcast'
  };

  if (knownDomains[domain]) {
    return {
      provider: knownDomains[domain],
      profile: PROVIDER_PROFILES[knownDomains[domain]],
      method: 'domain_match'
    };
  }

  try {
    const mxRecords = await resolveMx(domain);
    const mxHosts = mxRecords.map(r => r.exchange.toLowerCase()).sort((a, b) => a.priority - b.priority);

    for (const [providerKey, profile] of Object.entries(PROVIDER_PROFILES)) {
      for (const mxHost of mxHosts) {
        if (profile.mxPatterns.some(pattern => mxHost.includes(pattern))) {
          return {
            provider: providerKey,
            profile,
            method: 'mx_lookup',
            mxRecords: mxHosts
          };
        }
      }
    }

    return {
      provider: 'generic_imap',
      profile: {
        name: `Generic IMAP (${domain})`,
        type: 'imap',
        imap: { host: `imap.${domain}`, port: 993, tls: true },
        smtp: { host: `smtp.${domain}`, port: 587, tls: true },
        supportsOAuth: false
      },
      method: 'fallback',
      mxRecords: mxHosts
    };

  } catch {
    return {
      provider: 'unknown',
      profile: {
        name: `Unknown Provider (${domain})`,
        type: 'imap',
        imap: { host: `imap.${domain}`, port: 993, tls: true },
        smtp: { host: `smtp.${domain}`, port: 587, tls: true },
        supportsOAuth: false
      },
      method: 'dns_failed'
    };
  }
}

export function getProviderProfile(providerKey) {
  return PROVIDER_PROFILES[providerKey] || null;
}

export function listProviders() {
  return Object.entries(PROVIDER_PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    type: profile.type,
    supportsOAuth: profile.supportsOAuth
  }));
}
