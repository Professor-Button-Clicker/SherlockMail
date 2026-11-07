import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
  readDer, derTag, derOid, derInteger, oidString, parseGeneralizedTime, normalizeBer, parseSignedData, verifySigner,
  checkChain, hasTimestampingEku, certSummary, DIGEST_OIDS, SIGNED_DATA_OID,
} from './cms.js';

const DEFAULT_TSAS = [
  { name: 'DigiCert', url: 'http://timestamp.digicert.com' },
  { name: 'Sectigo', url: 'http://timestamp.sectigo.com' },
  { name: 'GlobalSign', url: 'http://timestamp.globalsign.com/tsa/r6advanced1' },
  { name: 'FreeTSA', url: 'https://freetsa.org/tsr' },
];

const REQUEST_TIMEOUT_MS = 15000;
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const PKI_STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];

// SHERLOCKMAIL_TSA_URLS overrides the list (comma separated); "off" means no authority is contacted, for
// an examiner working without internet access or under a rule that nothing leaves the machine.
function configuredTsas() {
  const env = process.env.SHERLOCKMAIL_TSA_URLS;
  if (env === 'off') return [];
  if (env) return env.split(',').map(url => url.trim()).filter(Boolean).map(url => ({ name: new URL(url).host, url }));
  return DEFAULT_TSAS;
}

function tsaNameFor(url) {
  return configuredTsas().find(t => t.url === url)?.name || DEFAULT_TSAS.find(t => t.url === url)?.name || new URL(url).host;
}

// Parses a TimeStampToken: the CMS SignedData wrapping a TSTInfo (RFC 3161 section 2.4.2).
function parseToken(tokenDer) {
  const buf = normalizeBer(tokenDer);
  const root = readDer(buf);
  const [typeEl, wrapped] = root.children();
  if (oidString(typeEl) !== SIGNED_DATA_OID) throw new Error('The timestamp token is not CMS SignedData');
  const signed = parseSignedData(wrapped.children()[0]);
  if (signed.eContentType !== OID_TST_INFO || !signed.eContent) throw new Error('The timestamp token does not contain a TSTInfo');
  const f = readDer(signed.eContent).children();
  let i = 1;
  const policy = oidString(f[i++]);
  const imprint = f[i++].children();
  const hashOid = oidString(imprint[0].children()[0]);
  const hashedMessage = Buffer.from(imprint[1].value).toString('hex');
  const serialNumber = Buffer.from(f[i++].value).toString('hex');
  const genTime = parseGeneralizedTime(f[i++]);
  let accuracy = null;
  let nonce = null;
  for (; i < f.length; i++) {
    if (f[i].tag === 0x10 && f[i].tagClass === 0) {
      accuracy = {};
      for (const a of f[i].children()) {
        const v = parseInt(Buffer.from(a.value).toString('hex'), 16);
        if (a.tagClass === 0) accuracy.seconds = v;
        else if (a.tag === 0) accuracy.millis = v;
        else if (a.tag === 1) accuracy.micros = v;
      }
    } else if (f[i].tag === 2 && f[i].tagClass === 0) {
      nonce = Buffer.from(f[i].value).toString('hex').replace(/^0+/, '');
    }
  }
  const hashAlgorithm = Object.entries(DIGEST_OIDS).find(([, oid]) => oid === hashOid)?.[0] || hashOid;
  return { signed, tstInfo: signed.eContent, policy, hashAlgorithm, hashedMessage, serialNumber, genTime, accuracy, nonce };
}

function parseResponse(data) {
  const buf = normalizeBer(data);
  const root = readDer(buf);
  const [statusInfo, token] = root.children();
  const statusFields = statusInfo.children();
  const status = parseInt(Buffer.from(statusFields[0].value).toString('hex'), 16);
  const text = statusFields[1]?.tag === 0x10 ? statusFields[1].children().map(s => s.value.toString('utf8')).join('; ') : '';
  return { status, statusText: text || PKI_STATUS[status] || String(status), token: token ? Buffer.from(token.raw) : null };
}

export class Rfc3161TimestampService {

  static getAvailableTSAs() {
    return configuredTsas();
  }

  static buildRequest(hashHex, hashAlgorithm, nonce) {
    const oid = DIGEST_OIDS[hashAlgorithm];
    if (!oid) throw new Error(`Unsupported hash algorithm: ${hashAlgorithm}`);
    const imprint = derTag(0x30, derTag(0x30, derOid(oid), Buffer.from([0x05, 0x00])), derTag(0x04, Buffer.from(hashHex, 'hex')));
    return derTag(0x30, derInteger(1), imprint, derInteger(nonce), Buffer.from([0x01, 0x01, 0xff]));
  }

  // A result is only 'verified' when the authority granted the request, the token's signature checks out,
  // it covers exactly this hash, and it carries the nonce we sent. Anything else is 'failed' with the reason;
  // no time or serial number is ever filled in from anywhere but the signed token.
  static async requestTimestamp(dataHash, tsaUrl, options = {}) {
    const hashAlgorithm = options.hashAlgorithm || 'sha256';
    const nonce = crypto.randomBytes(8);
    nonce[0] &= 0x7f;
    const record = {
      id: uuidv4(), status: 'failed', tsaUrl, tsaName: tsaNameFor(tsaUrl), requestNonce: nonce.toString('hex'), hashAlgorithm, targetHash: dataHash,
    };
    try {
      if (!/^[a-f0-9]+$/i.test(dataHash || '')) throw new Error('The hash to timestamp must be hexadecimal');
      const request = this.buildRequest(dataHash, hashAlgorithm, nonce);
      const response = await this._sendRequest(tsaUrl, request, options.timeout || REQUEST_TIMEOUT_MS);
      const parsed = parseResponse(response);
      if (parsed.status > 1 || !parsed.token) throw new Error(`The timestamp authority refused the request: ${parsed.statusText}`);
      const verification = this.verifyToken(parsed.token, dataHash, { nonce: nonce.toString('hex').replace(/^0+/, ''), hashAlgorithm, extraCaPems: options.extraCaPems });
      record.timestampToken = parsed.token.toString('base64');
      record.tstInfo = verification.tstInfo;
      record.genTime = verification.genTime;
      record.serialNumber = verification.serialNumber;
      record.policy = verification.policy;
      record.verificationResult = JSON.stringify(verification.report);
      record.report = verification.report;
      record.status = verification.report.valid ? 'verified' : 'failed';
      if (!verification.report.valid) record.error = verification.report.problems.join('; ');
    } catch (error) {
      record.error = error.message;
      record.verificationResult = JSON.stringify({ valid: false, problems: [error.message] });
    }
    return record;
  }

  // Tries each configured authority in turn; the first verified token wins. When none can be reached the
  // result says so, and nothing stands in for the missing timestamp.
  static async requestFromAny(dataHash, options = {}) {
    const tsas = options.tsaUrl ? [{ url: options.tsaUrl }] : configuredTsas();
    if (!tsas.length) {
      return { id: uuidv4(), status: 'failed', tsaUrl: 'none', tsaName: null, targetHash: dataHash, hashAlgorithm: options.hashAlgorithm || 'sha256', error: 'Timestamp authorities are turned off (SHERLOCKMAIL_TSA_URLS=off)', attempts: [] };
    }
    const attempts = [];
    let last = null;
    for (const tsa of tsas) {
      last = await this.requestTimestamp(dataHash, tsa.url, options);
      attempts.push({ tsa: tsa.url, status: last.status, error: last.error || null });
      if (last.status === 'verified') break;
    }
    last.attempts = attempts;
    return last;
  }

  static async timestampData(data, tsaUrl, options = {}) {
    const hashAlg = options.hashAlgorithm || 'sha256';
    const hash = crypto.createHash(hashAlg).update(data).digest('hex');
    return this.requestTimestamp(hash, tsaUrl, options);
  }

  static verifyToken(tokenDer, expectedHash, { nonce, hashAlgorithm, extraCaPems } = {}) {
    const parsed = parseToken(tokenDer);
    const problems = [];
    if (expectedHash && parsed.hashedMessage.toLowerCase() !== expectedHash.toLowerCase()) {
      problems.push('The token covers a different hash than the evidence being checked');
    }
    if (hashAlgorithm && parsed.hashAlgorithm !== hashAlgorithm) problems.push(`The token used ${parsed.hashAlgorithm}, not ${hashAlgorithm}`);
    if (nonce && parsed.nonce !== nonce) problems.push('The token does not carry the nonce sent in the request (possible replay)');
    const info = parsed.signed.signerInfos[0];
    const signer = info ? verifySigner(parsed.signed, info, parsed.tstInfo) : { valid: false, problems: ['The token has no signer'] };
    problems.push(...signer.problems);
    let chain = null;
    let certificate = signer.certificate;
    if (signer.certificate) {
      const leaf = parsed.signed.certificates.find(c => c.fingerprint256 === signer.certificate.fingerprintSha256);
      if (!hasTimestampingEku(leaf)) problems.push('The signing certificate is not authorised for timestamping');
      chain = checkChain(leaf, parsed.signed.certificates, { extraCaPems, at: parsed.genTime });
    }
    const report = {
      valid: problems.length === 0,
      signatureValid: signer.valid,
      hashMatch: !expectedHash || parsed.hashedMessage.toLowerCase() === expectedHash.toLowerCase(),
      chainTrusted: chain?.trusted ?? false,
      chainProblems: chain?.problems || [],
      trustedRoot: chain?.root || null,
      signatureAlgorithm: signer.signatureAlgorithm || null,
      certificate,
      problems,
    };
    return {
      report,
      tstInfo: Buffer.from(parsed.tstInfo).toString('base64'),
      genTime: parsed.genTime,
      serialNumber: parsed.serialNumber,
      policy: parsed.policy,
      hashAlgorithm: parsed.hashAlgorithm,
      hashedMessage: parsed.hashedMessage,
      accuracy: parsed.accuracy,
    };
  }

  static _sendRequest(url, body, timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply', 'Content-Length': body.length },
        timeout,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`The timestamp authority returned HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('The timestamp authority did not answer in time')); });
      req.write(body);
      req.end();
    });
  }

  static async verifyTimestamp(timestampToken, originalHash, options = {}) {
    try {
      const tokenBuf = Buffer.isBuffer(timestampToken) ? timestampToken : Buffer.from(timestampToken, 'base64');
      const v = this.verifyToken(tokenBuf, originalHash, options);
      return {
        valid: v.report.valid, genTime: v.genTime, serialNumber: v.serialNumber, policy: v.policy, hashAlgorithm: v.hashAlgorithm, accuracy: v.accuracy,
        hashMatch: v.report.hashMatch, signatureValid: v.report.signatureValid, chainTrusted: v.report.chainTrusted, chainProblems: v.report.chainProblems,
        trustedRoot: v.report.trustedRoot, signatureAlgorithm: v.report.signatureAlgorithm, certificateInfo: v.report.certificate,
        tsaName: options.tsaUrl ? tsaNameFor(options.tsaUrl) : null, errors: v.report.problems,
      };
    } catch (err) {
      return { valid: false, genTime: null, hashMatch: false, signatureValid: false, chainTrusted: false, errors: [err.message] };
    }
  }

  static async verifyTimestampChain(timestamps) {
    const results = [];
    // Records of refused or unreachable requests have no token; they are listed, not counted as failures.
    const issued = timestamps.filter(ts => ts.timestampToken || ts.timestamp_token);
    for (const ts of [...issued].sort((a, b) => String(a.gen_time || '').localeCompare(String(b.gen_time || '')))) {
      const v = await this.verifyTimestamp(ts.timestampToken || ts.timestamp_token, ts.targetHash || ts.target_hash, { tsaUrl: ts.tsaUrl || ts.tsa_url });
      results.push({
        id: ts.id, targetType: ts.targetType || ts.target_type, tsa: ts.tsa_name, genTime: v.genTime, valid: v.valid, hashMatch: v.hashMatch,
        signatureValid: v.signatureValid, chainTrusted: v.chainTrusted, errors: v.errors,
      });
    }
    let chronological = true;
    for (let i = 1; i < results.length; i++) {
      if (results[i].genTime && results[i - 1].genTime && new Date(results[i].genTime) < new Date(results[i - 1].genTime)) chronological = false;
    }
    return {
      totalTimestamps: issued.length,
      requestsWithoutToken: timestamps.length - issued.length,
      allValid: results.every(r => r.valid),
      chronologicalOrder: chronological,
      results,
    };
  }

  static summarize(record) {
    let report = {};
    try { report = JSON.parse(record.verificationResult || record.verification_result || '{}'); } catch { /* shown without details */ }
    return {
      id: record.id,
      status: record.status,
      targetType: record.targetType || record.target_type,
      targetHash: record.targetHash || record.target_hash,
      hashAlgorithm: record.hashAlgorithm || record.hash_algorithm,
      tsaName: record.tsaName || record.tsa_name,
      tsaUrl: record.tsaUrl || record.tsa_url,
      genTime: record.genTime || record.gen_time || null,
      serialNumber: record.serialNumber || record.serial_number || null,
      chainTrusted: report.chainTrusted ?? null,
      trustedRoot: report.trustedRoot || null,
      certificate: report.certificate || null,
      error: record.error || (record.status === 'verified' ? null : report.problems?.join('; ')) || null,
      attempts: record.attempts || undefined,
    };
  }

  static getInfo() {
    return {
      standard: 'RFC 3161: Internet X.509 PKI Time-Stamp Protocol (TSP)',
      description: 'Sends only a SHA-256 hash to an external Timestamp Authority (TSA) and stores the signed token it returns, which proves the hashed data existed at that time. No message content leaves the computer. Each token is verified on receipt: the signature, the hash, the nonce and the timestamping certificate.',
      availableTSAs: configuredTsas(),
      capabilities: ['request', 'verify', 'chain-validation', 'collection-timestamp', 'export-timestamp'],
      independentCheck: 'openssl ts -verify -data <file> -in <file>.tsr -CAfile <TSA root certificate>',
      relatedStandards: ['RFC 3161', 'RFC 5816', 'RFC 5652', 'ISO/IEC 27037:2012'],
    };
  }
}

export { certSummary };
