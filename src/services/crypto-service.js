import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  parseContentInfo, parseSignedData, verifySigner, checkChain, decryptEnveloped, describeEnveloped, SIGNED_DATA_OID,
} from './cms.js';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// The header block of a MIME entity, unfolded and with lower-case names; values stay as written.
function readEntity(buf) {
  const text = buf.toString('latin1');
  const crlf = text.search(/\r?\n\r?\n/);
  const headEnd = crlf < 0 ? text.length : crlf;
  const bodyStart = crlf < 0 ? text.length : crlf + text.slice(crlf).match(/^\r?\n\r?\n/)[0].length;
  const headers = {};
  for (const line of text.slice(0, headEnd).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: buf.subarray(bodyStart) };
}

function headerParam(value, name) {
  const m = (value || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return m ? (m[1] ?? m[2]) : null;
}

function decodeBody(entity) {
  const cte = (entity.headers['content-transfer-encoding'] || '').toLowerCase();
  if (cte === 'base64') return Buffer.from(entity.body.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (cte === 'quoted-printable') {
    return Buffer.from(entity.body.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return entity.body;
}

// The exact bytes of each part. A multipart/signed signature covers the first part byte for byte, from the
// line after the boundary up to (not including) the line break before the next boundary (RFC 1847).
function splitMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let at = body.indexOf(delim);
  while (at >= 0) {
    const after = at + delim.length;
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break;
    const lineEnd = body.indexOf(0x0a, after);
    if (lineEnd < 0) break;
    const start = lineEnd + 1;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    let end = next;
    if (body[end - 1] === 0x0a) end--;
    if (body[end - 1] === 0x0d) end--;
    parts.push(body.subarray(start, end));
    at = next;
  }
  return parts;
}

function toCanonicalCrlf(buf) {
  return Buffer.from(buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}

export function detectProtection(entity) {
  const type = (entity.headers['content-type'] || '').toLowerCase();
  if (/^multipart\/signed/.test(type)) return { kind: /pgp/.test(type) ? 'pgp-signed' : 'smime-detached' };
  if (/^application\/(x-)?pkcs7-mime/.test(type)) {
    const smimeType = (headerParam(entity.headers['content-type'], 'smime-type') || '').toLowerCase();
    if (smimeType === 'signed-data') return { kind: 'smime-opaque' };
    if (smimeType === 'enveloped-data' || smimeType === 'authenveloped-data') return { kind: 'smime-enveloped' };
    return { kind: 'smime-unknown' };
  }
  if (/^multipart\/encrypted/.test(type)) return { kind: 'pgp-encrypted' };
  if (/^application\/pgp-encrypted/.test(type)) return { kind: 'pgp-encrypted' };
  return null;
}

// Fast flags for a raw message, set when it is collected.
export function protectionFlags(raw) {
  const entity = readEntity(raw);
  const kind = detectProtection(entity)?.kind;
  const text = raw.toString('latin1');
  const smimeUnknown = kind === 'smime-unknown';
  const isEncrypted = kind === 'smime-enveloped' || kind === 'pgp-encrypted' || smimeUnknown || /-----BEGIN PGP MESSAGE-----/.test(text);
  const isSigned = kind === 'smime-detached' || kind === 'smime-opaque' || kind === 'pgp-signed' || /-----BEGIN PGP SIGNED MESSAGE-----/.test(text);
  return { isEncrypted, isSigned };
}

export class CryptoService {

  // ── S/MIME Decryption (Feature 32) ──

  // credentials: [{ id, subject, certificatePem, privateKeyPem, passphrase }]. Tries each until one opens the
  // message. The evidence is never changed: the caller gets the decrypted bytes to store as a derived copy.
  static decryptMessage(raw, credentials = []) {
    const result = { id: uuidv4(), decrypted: false, encryptionAlgorithm: null, recipientCount: null, decryptedContent: null, certificateUsed: null, error: null };
    const entity = readEntity(raw);
    const kind = detectProtection(entity)?.kind;
    if (kind === 'pgp-encrypted') { result.error = 'This is an OpenPGP message. SherlockMail decrypts S/MIME only; decrypt it with the holder\'s PGP key in a PGP tool.'; return result; }
    if (kind !== 'smime-enveloped' && kind !== 'smime-unknown') { result.error = 'Message is not S/MIME encrypted'; return result; }
    const cms = decodeBody(entity);
    let described;
    try {
      described = describeEnveloped(cms);
    } catch (err) {
      result.error = `The encrypted part could not be read: ${err.message}`;
      return result;
    }
    if (!described) { result.error = 'Message is not S/MIME encrypted'; return result; }
    result.encryptionAlgorithm = described.algorithm;
    result.recipientCount = described.recipientCount;
    if (!credentials.length) { result.error = 'No private key was supplied. Import the recipient\'s certificate and key first.'; return result; }
    const tried = [];
    for (const cred of credentials) {
      try {
        const { content, algorithm } = decryptEnveloped(cms, cred);
        result.decrypted = true;
        result.decryptedContent = content;
        result.encryptionAlgorithm = algorithm;
        result.certificateUsed = { id: cred.id || null, subject: cred.subject || null };
        return result;
      } catch (err) {
        tried.push(err.message);
      }
    }
    result.error = `None of the ${credentials.length} key(s) could open this message: ${tried[tried.length - 1]}`;
    return result;
  }

  // ── Digital Signature Verification (Feature 33) ──

  static verifySignature(raw, options = {}) {
    const result = {
      id: uuidv4(), signed: false, type: null, signatureValid: null, signerInfo: null, algorithm: null, signingTime: null,
      chainTrusted: null, trustedRoot: null, certificateChain: [], problems: [], note: null,
    };
    const entity = readEntity(raw);
    const kind = detectProtection(entity)?.kind;
    try {
      if (kind === 'smime-detached') {
        const boundary = headerParam(entity.headers['content-type'], 'boundary');
        if (!boundary) throw new Error('multipart/signed without a boundary');
        const parts = splitMultipart(entity.body, boundary);
        if (parts.length < 2) throw new Error('multipart/signed without a signature part');
        result.signed = true;
        result.type = 'S/MIME (detached)';
        const signature = decodeBody(readEntity(parts[1]));
        this._checkSigned(result, signature, parts[0], options);
        return result;
      }
      if (kind === 'smime-opaque') {
        result.signed = true;
        result.type = 'S/MIME (opaque)';
        this._checkSigned(result, decodeBody(entity), null, options);
        return result;
      }
      if (kind === 'pgp-signed' || /-----BEGIN PGP SIGNED MESSAGE-----/.test(raw.toString('latin1'))) {
        result.signed = true;
        result.type = 'OpenPGP';
        result.note = 'OpenPGP signature found. It was not verified: that needs the sender\'s public key and a PGP tool.';
        return result;
      }
    } catch (err) {
      result.signatureValid = false;
      result.problems.push(err.message);
    }
    return result;
  }

  static _checkSigned(result, cmsDer, detachedContent, options) {
    const info = parseContentInfo(cmsDer);
    if (info.contentType !== SIGNED_DATA_OID) throw new Error('The signature is not CMS SignedData');
    const signed = parseSignedData(info.content);
    if (!signed.signerInfos.length) throw new Error('The signature has no signers');
    const content = detachedContent || signed.eContent;
    if (!content) throw new Error('The signature has no content to check');
    const signerInfo = signed.signerInfos[0];
    let check = verifySigner(signed, signerInfo, content);
    // Signatures are made over canonical CRLF text; a copy stored with bare line feeds is checked in that form too.
    if (!check.valid && detachedContent) {
      const canonical = toCanonicalCrlf(detachedContent);
      if (!canonical.equals(detachedContent)) {
        const second = verifySigner(signed, signerInfo, canonical);
        if (second.valid) { check = second; result.note = 'The signature verifies after normalising line endings to CRLF.'; }
      }
    }
    result.signatureValid = check.valid;
    result.signerInfo = check.certificate;
    result.algorithm = check.signatureAlgorithm;
    result.signingTime = check.signingTime;
    result.problems.push(...check.problems);
    if (check.certificate) {
      const leaf = signed.certificates.find(c => c.fingerprint256 === check.certificate.fingerprintSha256);
      const chain = checkChain(leaf, signed.certificates, { extraCaPems: options.extraCaPems, at: check.signingTime || new Date() });
      result.certificateChain = chain.chain;
      result.chainTrusted = chain.trusted;
      result.trustedRoot = chain.root;
      if (!chain.trusted) result.chainProblems = chain.problems;
    }
  }

  // ── Credential Manager (Feature 34) ──

  static encryptCredential(plaintext, masterKey) {
    const iv = crypto.randomBytes(12);
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(masterKey, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      encryptedData: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      salt: salt.toString('base64'),
      algorithm: 'aes-256-gcm',
    };
  }

  static decryptCredential(encryptedData, iv, authTag, masterKey, salt) {
    // Entries saved before keys were salted used an unsalted SHA-256 of the master key.
    const key = salt
      ? crypto.scryptSync(masterKey, Buffer.from(salt, 'base64'), 32, SCRYPT)
      : crypto.createHash('sha256').update(masterKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // ── Custom IMAP Profile Persistence (Feature 35) ──

  static exportProfile(profile) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<imapProfile version="1.0" generator="SherlockMail v0.10.0">
  <name>${this._xmlEscape(profile.name)}</name>
  <host>${this._xmlEscape(profile.host)}</host>
  <port>${profile.port || 993}</port>
  <tls>${profile.tls !== false && profile.tls !== 0}</tls>
  <authMethod>${this._xmlEscape(profile.authMethod || profile.auth_method || 'password')}</authMethod>
  <capabilities>${this._xmlEscape(profile.imapCapabilities || profile.imap_capabilities || '')}</capabilities>
  <specialFolders>${this._xmlEscape(typeof profile.special_folders === 'string' ? profile.special_folders : JSON.stringify(profile.specialFolders || {}))}</specialFolders>
  <notes>${this._xmlEscape(profile.notes || '')}</notes>
  <createdAt>${profile.created_at || profile.createdAt || new Date().toISOString()}</createdAt>
</imapProfile>`;

    return {
      content: xml,
      filename: `imap_profile_${(profile.name || 'unnamed').replace(/[^a-zA-Z0-9]/g, '_')}.xml`,
      hash: crypto.createHash('sha256').update(xml).digest('hex'),
    };
  }

  static importProfile(xmlContent) {
    const extract = (tag) => {
      const match = xmlContent.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return match ? match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;
    };

    return {
      id: uuidv4(),
      name: extract('name') || 'Imported Profile',
      host: extract('host') || '',
      port: parseInt(extract('port')) || 993,
      tls: extract('tls') !== 'false',
      authMethod: extract('authMethod') || 'password',
      imapCapabilities: extract('capabilities') || null,
      specialFolders: JSON.parse(extract('specialFolders') || '{}'),
      notes: extract('notes') || '',
    };
  }

  static _xmlEscape(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
