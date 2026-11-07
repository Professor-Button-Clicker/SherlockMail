import crypto from 'crypto';
import tls from 'tls';

// A small DER reader and CMS (RFC 5652) verifier/decryptor. RFC 3161 timestamp tokens and S/MIME are both
// CMS, and Node's crypto does the signature and cipher work, so no external PKI library is needed.

export function readDer(buf, offset = 0, end = buf.length) {
  if (offset + 2 > end) throw new Error('Truncated ASN.1 data');
  const start = offset;
  const first = buf[offset++];
  const tagClass = first >> 6;
  const constructed = !!(first & 0x20);
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    while (buf[offset] & 0x80) tag = (tag << 7) | (buf[offset++] & 0x7f);
    tag = (tag << 7) | buf[offset++];
  }
  let length = buf[offset++];
  if (length === 0x80) throw new Error('Indefinite-length ASN.1 is handled by normalizeBer before parsing');
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n > 6) throw new Error('ASN.1 length too large');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[offset++];
  }
  const valueStart = offset;
  const valueEnd = offset + length;
  if (valueEnd > end) throw new Error('ASN.1 element runs past the end of the data');
  return {
    tagClass, constructed, tag, start, valueStart, valueEnd, end: valueEnd,
    value: buf.subarray(valueStart, valueEnd),
    raw: buf.subarray(start, valueEnd),
    children() {
      const out = [];
      for (let p = valueStart; p < valueEnd;) {
        const el = readDer(buf, p, valueEnd);
        out.push(el);
        p = el.end;
      }
      return out;
    },
  };
}

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function derTag(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const v of parts.slice(2)) {
    const stack = [v % 128];
    for (let r = Math.floor(v / 128); r > 0; r = Math.floor(r / 128)) stack.unshift((r % 128) | 0x80);
    bytes.push(...stack);
  }
  return derTag(0x06, Buffer.from(bytes));
}

export function derInteger(value) {
  let buf = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return derTag(0x02, buf);
}

export function oidString(el) {
  const b = el.value;
  const out = [Math.min(Math.floor(b[0] / 40), 2)];
  out.push(b[0] - out[0] * 40);
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { out.push(v); v = 0; }
  }
  return out.join('.');
}

export function parseGeneralizedTime(el) {
  const m = el.value.toString('latin1').match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?Z$/);
  if (!m) throw new Error(`Unexpected GeneralizedTime: ${el.value.toString('latin1')}`);
  const ms = m[7] ? `.${m[7].padEnd(3, '0').slice(0, 3)}` : '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${ms}Z`;
}

function parseUtcTime(el) {
  const s = el.value.toString('latin1');
  const m = s.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/);
  if (!m) return null;
  const year = +m[1] < 50 ? `20${m[1]}` : `19${m[1]}`;
  return `${year}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// Some signers (OpenSSL streaming, Outlook) emit BER with indefinite lengths and constructed OCTET STRINGs.
// They are rewritten to definite lengths so the DER reader can walk them; signed attributes keep their
// exact bytes because RFC 5652 requires those to be DER already.
export function normalizeBer(buf) {
  const walk = (offset, end) => {
    const parts = [];
    let p = offset;
    while (p < end) {
      if (buf[p] === 0 && buf[p + 1] === 0) { p += 2; return { parts, next: p }; }
      const tagStart = p;
      const first = buf[p++];
      if ((first & 0x1f) === 0x1f) { while (buf[p] & 0x80) p++; p++; }
      const tagBytes = buf.subarray(tagStart, p);
      let len = buf[p++];
      if (len === 0x80) {
        const inner = walk(p, end);
        parts.push(Buffer.concat([tagBytes, encodeLength(inner.parts.reduce((s, b) => s + b.length, 0)), ...inner.parts]));
        p = inner.next;
        continue;
      }
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
      }
      const valueEnd = p + len;
      if (first & 0x20) {
        const inner = walk(p, valueEnd);
        parts.push(Buffer.concat([tagBytes, encodeLength(inner.parts.reduce((s, b) => s + b.length, 0)), ...inner.parts]));
      } else {
        parts.push(Buffer.concat([tagBytes, encodeLength(len), buf.subarray(p, valueEnd)]));
      }
      p = valueEnd;
    }
    return { parts, next: p };
  };
  return Buffer.concat(walk(0, buf.length).parts);
}

// An OCTET STRING may be split into constructed segments in BER.
function octets(el) {
  return el.constructed ? Buffer.concat(el.children().map(octets)) : Buffer.from(el.value);
}

const DIGESTS = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '1.2.840.113549.2.5': 'md5',
};
export const DIGEST_OIDS = Object.fromEntries(Object.entries(DIGESTS).map(([k, v]) => [v, k]));

const SIG_DIGESTS = {
  '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.113549.1.1.14': 'sha224', '1.2.840.113549.1.1.4': 'md5', '1.2.840.10045.4.1': 'sha1', '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512', '1.2.840.10045.4.3.1': 'sha224',
};
const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const RSA_PSS = '1.2.840.113549.1.1.10';
const ATTR_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const ATTR_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23';
const OID_TIMESTAMPING_EKU = '1.3.6.1.5.5.7.3.8';

const CIPHERS = {
  '2.16.840.1.101.3.4.1.2': { name: 'aes-128-cbc', label: 'AES-128-CBC', keyLen: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'aes-192-cbc', label: 'AES-192-CBC', keyLen: 24 },
  '2.16.840.1.101.3.4.1.42': { name: 'aes-256-cbc', label: 'AES-256-CBC', keyLen: 32 },
  '1.2.840.113549.3.7': { name: 'des-ede3-cbc', label: '3DES-CBC', keyLen: 24 },
  '2.16.840.1.101.3.4.1.6': { name: 'aes-128-gcm', label: 'AES-128-GCM', keyLen: 16, aead: true },
  '2.16.840.1.101.3.4.1.26': { name: 'aes-192-gcm', label: 'AES-192-GCM', keyLen: 24, aead: true },
  '2.16.840.1.101.3.4.1.46': { name: 'aes-256-gcm', label: 'AES-256-GCM', keyLen: 32, aead: true },
};

export function parseContentInfo(input) {
  const buf = normalizeBer(input);
  const root = readDer(buf);
  const [typeEl, wrapped] = root.children();
  return { contentType: oidString(typeEl), content: wrapped ? wrapped.children()[0] : null };
}

function certFromDer(der) {
  return new crypto.X509Certificate(der);
}

function parseSignerInfo(el) {
  const c = el.children();
  let i = 1;
  const sid = c[i++];
  const signer = sid.tagClass === 2
    ? { subjectKeyId: Buffer.from(sid.value).toString('hex') }
    : { issuer: sid.children()[0].raw, serial: Buffer.from(sid.children()[1].value).toString('hex').replace(/^0+/, '').toUpperCase() };
  const digestAlg = oidString(c[i++].children()[0]);
  let signedAttrs = null;
  if (c[i].tagClass === 2 && c[i].tag === 0) signedAttrs = c[i++];
  const sigAlgEl = c[i++];
  const sigAlg = oidString(sigAlgEl.children()[0]);
  return { signer, digestAlg, signedAttrs, sigAlg, sigAlgParams: sigAlgEl.children()[1] || null, signature: Buffer.from(c[i].value) };
}

export function parseSignedData(content) {
  const fields = content.children();
  let i = 1; // version
  const digestAlgorithms = fields[i++].children().map(a => oidString(a.children()[0]));
  const encap = fields[i++].children();
  const eContentType = oidString(encap[0]);
  const eContent = encap[1] ? octets(encap[1].children()[0]) : null;
  const certificates = [];
  if (fields[i]?.tagClass === 2 && fields[i].tag === 0) {
    for (const certEl of fields[i++].children()) {
      if (certEl.tagClass !== 0) continue; // attribute or other certificate forms
      try { certificates.push(certFromDer(certEl.raw)); } catch { /* an unreadable certificate cannot match a signer */ }
    }
  }
  if (fields[i]?.tagClass === 2 && fields[i].tag === 1) i++; // CRLs
  const signerInfos = fields[i].children().map(parseSignerInfo);
  return { digestAlgorithms, eContentType, eContent, certificates, signerInfos };
}

function serialHex(cert) {
  return cert.serialNumber.replace(/^0+/, '').toUpperCase();
}

function findSignerCert(certs, signer) {
  if (signer.serial) return certs.find(c => serialHex(c) === signer.serial) || null;
  if (signer.subjectKeyId) {
    return certs.find(c => {
      const der = readDer(c.raw);
      const spki = der.children()[0].children().find(el => el.tagClass === 0 && el.constructed && el.children()[0]?.tag === 0x10 && el.children()[1]?.tag === 3);
      if (!spki) return false;
      const key = spki.children()[1].value.subarray(1);
      return crypto.createHash('sha1').update(key).digest('hex') === signer.subjectKeyId;
    }) || null;
  }
  return null;
}

function readAttrs(signedAttrs) {
  const out = {};
  if (!signedAttrs) return out;
  for (const attr of signedAttrs.children()) {
    const [oid, values] = attr.children();
    out[oidString(oid)] = values.children()[0];
  }
  return out;
}

function verifySignatureBytes(cert, info, data) {
  const key = cert.publicKey;
  let digest = SIG_DIGESTS[info.sigAlg] || null;
  if (info.sigAlg === RSA_ENCRYPTION || info.sigAlg === RSA_PSS || !digest) digest = DIGESTS[info.digestAlg] || digest;
  if (!digest) throw new Error(`Unsupported signature algorithm ${info.sigAlg}`);
  if (info.sigAlg === RSA_PSS) {
    const saltLength = crypto.constants.RSA_PSS_SALTLEN_AUTO;
    return { valid: crypto.verify(digest, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength }, info.signature), algorithm: `RSASSA-PSS with ${digest.toUpperCase()}` };
  }
  const kind = key.asymmetricKeyType.toUpperCase();
  return { valid: crypto.verify(digest, data, key, info.signature), algorithm: `${digest.toUpperCase()} with ${kind}` };
}

function certSummary(cert) {
  return {
    subject: cert.subject, issuer: cert.issuer, serialNumber: cert.serialNumber,
    validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString(),
    fingerprintSha256: cert.fingerprint256,
  };
}

function trustedRoots(extraCaPems = []) {
  const roots = [];
  for (const pem of [...tls.rootCertificates, ...extraCaPems]) {
    try { roots.push(new crypto.X509Certificate(pem)); } catch { /* not a certificate */ }
  }
  return roots;
}

// Walks signer certificate -> embedded intermediates -> a trusted root, checking every signature and that
// each certificate was valid at `at` (the signing or timestamp time).
export function checkChain(leaf, embedded, { extraCaPems = [], at = new Date() } = {}) {
  const roots = trustedRoots(extraCaPems);
  const chain = [certSummary(leaf)];
  const problems = [];
  const when = new Date(at);
  const validAt = c => when >= new Date(c.validFrom) && when <= new Date(c.validTo);
  if (!validAt(leaf)) problems.push(`Signer certificate was not valid on ${when.toISOString()}`);
  let current = leaf;
  for (let depth = 0; depth < 8; depth++) {
    const root = roots.find(r => current.checkIssued(r) && current.verify(r.publicKey));
    if (root) {
      if (root.fingerprint256 !== current.fingerprint256) chain.push(certSummary(root));
      if (!validAt(root)) problems.push(`Root certificate ${root.subject} was not valid on ${when.toISOString()}`);
      return { trusted: problems.length === 0, chain, problems, root: root.subject };
    }
    const issuer = embedded.find(c => c.fingerprint256 !== current.fingerprint256 && current.checkIssued(c) && current.verify(c.publicKey));
    if (!issuer) {
      problems.push(`No trusted root found for ${current.subject.replace(/\n/g, ', ')}`);
      return { trusted: false, chain, problems, root: null };
    }
    if (!validAt(issuer)) problems.push(`Certificate ${issuer.subject.replace(/\n/g, ', ')} was not valid on ${when.toISOString()}`);
    chain.push(certSummary(issuer));
    current = issuer;
  }
  problems.push('Certificate chain is too long');
  return { trusted: false, chain, problems, root: null };
}

// Checks one signer: the digest of the content against the messageDigest attribute, and the signature
// over the signed attributes (re-tagged as a SET, per RFC 5652 5.4) or the content itself.
export function verifySigner(signed, info, content) {
  const cert = findSignerCert(signed.certificates, info.signer);
  const result = {
    valid: false, certificate: cert ? certSummary(cert) : null, signingTime: null,
    digestAlgorithm: DIGESTS[info.digestAlg] || info.digestAlg, signatureAlgorithm: null, problems: [],
  };
  if (!cert) { result.problems.push('The signer certificate is not included in the message'); return result; }
  const digestName = DIGESTS[info.digestAlg];
  if (!digestName) { result.problems.push(`Unsupported digest algorithm ${info.digestAlg}`); return result; }
  let toVerify;
  if (info.signedAttrs) {
    const attrs = readAttrs(info.signedAttrs);
    if (attrs[ATTR_SIGNING_TIME]) {
      const t = attrs[ATTR_SIGNING_TIME];
      result.signingTime = t.tag === 23 ? parseUtcTime(t) : parseGeneralizedTime(t);
    }
    const wanted = attrs[ATTR_MESSAGE_DIGEST] ? Buffer.from(attrs[ATTR_MESSAGE_DIGEST].value) : null;
    if (!wanted) { result.problems.push('The signed attributes have no message digest'); return result; }
    const actual = crypto.createHash(digestName).update(content).digest();
    if (!actual.equals(wanted)) { result.problems.push('The content does not match the digest in the signature: it was altered after signing'); return result; }
    toVerify = Buffer.concat([Buffer.from([0x31]), info.signedAttrs.raw.subarray(1)]);
  } else {
    toVerify = content;
  }
  try {
    const { valid, algorithm } = verifySignatureBytes(cert, info, toVerify);
    result.signatureAlgorithm = algorithm;
    if (!valid) result.problems.push('The signature does not verify with the signer certificate');
    result.valid = valid;
  } catch (err) {
    result.problems.push(`The signature could not be checked: ${err.message}`);
  }
  return result;
}

export const SIGNED_DATA_OID = OID_SIGNED_DATA;

export function hasTimestampingEku(cert) {
  return /1\.3\.6\.1\.5\.5\.7\.3\.8/.test(cert.keyUsage?.join(' ') || '') || (cert.keyUsage || []).includes(OID_TIMESTAMPING_EKU);
}

// ── EnvelopedData ──

function decryptContentKey(recipient, privateKey) {
  const fields = recipient.children();
  const alg = oidString(fields[2].children()[0]);
  const wrapped = Buffer.from(fields[3].value);
  if (alg === RSA_ENCRYPTION) {
    return crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, wrapped);
  }
  if (alg === '1.2.840.113549.1.1.7') {
    const params = fields[2].children()[1]?.children() || [];
    const hashEl = params.find(p => p.tagClass === 2 && p.tag === 0);
    const oaepHash = hashEl ? DIGESTS[oidString(hashEl.children()[0].children()[0])] || 'sha1' : 'sha1';
    return crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, wrapped);
  }
  throw new Error(`Unsupported key transport algorithm ${alg}`);
}

function recipientMatches(recipient, cert) {
  const rid = recipient.children()[1];
  if (rid.tagClass === 2) return null; // subject key identifier: try the key
  const serial = Buffer.from(rid.children()[1].value).toString('hex').replace(/^0+/, '').toUpperCase();
  return serial === serialHex(cert);
}

// Returns the decrypted content. Only key-transport recipients exist in practice with RSA S/MIME keys;
// key-agreement recipients (ECDH) are reported, not skipped silently.
export function decryptEnveloped(input, { certificatePem, privateKeyPem, passphrase }) {
  const { contentType, content } = parseContentInfo(input);
  if (contentType !== OID_ENVELOPED_DATA && contentType !== OID_AUTH_ENVELOPED_DATA) {
    throw new Error('The data is not CMS EnvelopedData');
  }
  const privateKey = crypto.createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem);
  const cert = certificatePem ? new crypto.X509Certificate(certificatePem) : null;
  const fields = content.children();
  let i = 1;
  if (fields[i].tagClass === 2 && fields[i].tag === 0) i++; // originatorInfo
  const recipients = fields[i++].children();
  const encrypted = fields[i++].children();
  const algEl = encrypted[1];
  const cipherOid = oidString(algEl.children()[0]);
  const cipher = CIPHERS[cipherOid];
  if (!cipher) throw new Error(`Unsupported content cipher ${cipherOid}`);
  const body = encrypted[2] ? octets(encrypted[2]) : Buffer.alloc(0);

  const transports = recipients.filter(r => r.tagClass === 0);
  if (!transports.length) throw new Error('The message only has key-agreement or other recipient types, which this key cannot open');
  const ordered = cert ? [...transports].sort((a, b) => Number(recipientMatches(b, cert) === true) - Number(recipientMatches(a, cert) === true)) : transports;
  let key = null;
  let lastError = null;
  for (const r of ordered) {
    if (cert && recipientMatches(r, cert) === false) continue;
    try {
      key = decryptContentKey(r, privateKey);
      if (key.length === cipher.keyLen) break;
      key = null;
    } catch (err) { lastError = err; }
  }
  if (!key) throw new Error(`This certificate's key is not a recipient of the message${lastError ? ` (${lastError.message})` : ''}`);

  const params = algEl.children()[1];
  let decipher;
  if (cipher.aead) {
    const gcm = params.children();
    decipher = crypto.createDecipheriv(cipher.name, key, Buffer.from(gcm[0].value));
    const mac = fields[fields.length - 1];
    decipher.setAuthTag(Buffer.from(mac.value));
    const aad = fields.find(f => f.tagClass === 2 && f.tag === 1);
    if (aad) decipher.setAAD(Buffer.concat([Buffer.from([0x31]), aad.raw.subarray(1)]));
  } else {
    decipher = crypto.createDecipheriv(cipher.name, key, Buffer.from(params.value));
  }
  return { content: Buffer.concat([decipher.update(body), decipher.final()]), algorithm: cipher.label };
}

export function describeEnveloped(input) {
  const { contentType, content } = parseContentInfo(input);
  if (contentType !== OID_ENVELOPED_DATA && contentType !== OID_AUTH_ENVELOPED_DATA) return null;
  const fields = content.children();
  let i = 1;
  if (fields[i].tagClass === 2 && fields[i].tag === 0) i++;
  const recipients = fields[i++].children();
  const encrypted = fields[i].children();
  const oid = oidString(encrypted[1].children()[0]);
  return { algorithm: CIPHERS[oid]?.label || oid, recipientCount: recipients.length };
}

export { certSummary };
