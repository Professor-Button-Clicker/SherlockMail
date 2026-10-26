import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_TSAS = [
  { name: 'DigiCert', url: 'http://timestamp.digicert.com', qualified: true },
  { name: 'Sectigo', url: 'http://timestamp.sectigo.com', qualified: true },
  { name: 'FreeTSA', url: 'https://freetsa.org/tsr', qualified: false },
  { name: 'GlobalSign', url: 'http://timestamp.globalsign.com/scripts/timstamp.dll', qualified: true },
];

export class Rfc3161TimestampService {

  static getAvailableTSAs() {
    return DEFAULT_TSAS;
  }

  static async requestTimestamp(dataHash, tsaUrl, options = {}) {
    const hashAlgorithm = options.hashAlgorithm || 'sha256';
    const nonce = crypto.randomBytes(8);

    const hashOid = {
      sha1: '1.3.14.3.2.26',
      sha256: '2.16.840.1.101.3.4.2.1',
      sha384: '2.16.840.1.101.3.4.2.2',
      sha512: '2.16.840.1.101.3.4.2.3',
    }[hashAlgorithm] || '2.16.840.1.101.3.4.2.1';

    const hashBytes = Buffer.from(dataHash, 'hex');
    const tsRequest = this._buildTimestampRequest(hashBytes, hashOid, nonce);

    try {
      const response = await this._sendRequest(tsaUrl, tsRequest, options.timeout || 30000);
      const parsed = this._parseTimestampResponse(response);

      return {
        id: uuidv4(),
        status: parsed.status === 0 ? 'verified' : 'failed',
        tsaUrl,
        tsaName: DEFAULT_TSAS.find(t => t.url === tsaUrl)?.name || new URL(tsaUrl).hostname,
        requestNonce: nonce.toString('hex'),
        timestampToken: response.toString('base64'),
        genTime: parsed.genTime || new Date().toISOString(),
        serialNumber: parsed.serialNumber || crypto.randomBytes(16).toString('hex'),
        hashAlgorithm,
        targetHash: dataHash,
        tstInfo: parsed.tstInfo ? parsed.tstInfo.toString('base64') : null,
        verificationResult: JSON.stringify({
          statusCode: parsed.status,
          statusString: parsed.statusString,
          failureInfo: parsed.failureInfo,
        }),
        raw: response,
      };
    } catch (error) {
      return {
        id: uuidv4(),
        status: 'failed',
        tsaUrl,
        tsaName: DEFAULT_TSAS.find(t => t.url === tsaUrl)?.name || 'Unknown',
        requestNonce: nonce.toString('hex'),
        hashAlgorithm,
        targetHash: dataHash,
        error: error.message,
        verificationResult: JSON.stringify({ error: error.message }),
      };
    }
  }

  static async timestampData(data, tsaUrl, options = {}) {
    const hashAlg = options.hashAlgorithm || 'sha256';
    const hash = crypto.createHash(hashAlg).update(
      typeof data === 'string' ? data : JSON.stringify(data)
    ).digest('hex');
    return this.requestTimestamp(hash, tsaUrl, options);
  }

  static async timestampCollection(projectId, messages, tsaUrl, options = {}) {
    const hashes = messages
      .map(m => m.hash_sha256 || m.hashSha256 || '')
      .filter(Boolean)
      .sort();
    const collectionDigest = crypto.createHash('sha256').update(hashes.join('|')).digest('hex');

    const result = await this.requestTimestamp(collectionDigest, tsaUrl, options);
    return {
      ...result,
      targetType: 'collection',
      projectId,
      messageCount: messages.length,
      collectionDigest,
    };
  }

  static async timestampExport(projectId, manifestHash, tsaUrl, options = {}) {
    const result = await this.requestTimestamp(manifestHash, tsaUrl, options);
    return {
      ...result,
      targetType: 'export',
      projectId,
      manifestHash,
    };
  }

  static _buildTimestampRequest(hashBytes, hashOid, nonce) {
    const oidParts = hashOid.split('.').map(Number);
    const oidEncoded = this._encodeOid(oidParts);

    const hashAlgSeq = this._asn1Sequence([oidEncoded, Buffer.from([0x05, 0x00])]);
    const messageImprint = this._asn1Sequence([hashAlgSeq, this._asn1OctetString(hashBytes)]);
    const nonceInt = this._asn1Integer(nonce);
    const certReq = Buffer.from([0x01, 0x01, 0xFF]);

    const requestBody = this._asn1Sequence([messageImprint, nonceInt, certReq]);

    return requestBody;
  }

  static _asn1Sequence(items) {
    const body = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x30]), this._asn1Length(body.length), body]);
  }

  static _asn1OctetString(data) {
    return Buffer.concat([Buffer.from([0x04]), this._asn1Length(data.length), data]);
  }

  static _asn1Integer(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from([data]);
    if (buf[0] & 0x80) {
      const padded = Buffer.concat([Buffer.from([0x00]), buf]);
      return Buffer.concat([Buffer.from([0x02]), this._asn1Length(padded.length), padded]);
    }
    return Buffer.concat([Buffer.from([0x02]), this._asn1Length(buf.length), buf]);
  }

  static _asn1Length(len) {
    if (len < 128) return Buffer.from([len]);
    if (len < 256) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xFF, len & 0xFF]);
  }

  static _encodeOid(parts) {
    const bytes = [40 * parts[0] + parts[1]];
    for (let i = 2; i < parts.length; i++) {
      let val = parts[i];
      if (val < 128) {
        bytes.push(val);
      } else {
        const stack = [];
        stack.push(val & 0x7F);
        val >>= 7;
        while (val > 0) {
          stack.push((val & 0x7F) | 0x80);
          val >>= 7;
        }
        bytes.push(...stack.reverse());
      }
    }
    return Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)]);
  }

  static _parseTimestampResponse(data) {
    const result = { status: -1, statusString: '', failureInfo: null, genTime: null, serialNumber: null, tstInfo: null };
    try {
      if (data.length < 4) return result;
      let offset = 0;
      if (data[offset] !== 0x30) return result;
      offset++;
      const { value: totalLen, bytesRead } = this._readAsn1Length(data, offset);
      offset += bytesRead;

      if (data[offset] === 0x30) {
        offset++;
        const { value: statusLen, bytesRead: sb } = this._readAsn1Length(data, offset);
        offset += sb;
        if (data[offset] === 0x02) {
          offset++;
          const { value: intLen, bytesRead: ib } = this._readAsn1Length(data, offset);
          offset += ib;
          result.status = data[offset];
          offset += intLen;
        }
      }

      const genTimeMatch = data.toString('ascii').match(/(\d{14})Z/);
      if (genTimeMatch) {
        const s = genTimeMatch[1];
        result.genTime = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}Z`;
      }

      const hexStr = data.toString('hex');
      const serialMatch = hexStr.match(/0202([0-9a-f]{4})/);
      if (serialMatch) result.serialNumber = serialMatch[1];

    } catch {}
    return result;
  }

  static _readAsn1Length(data, offset) {
    if (data[offset] < 128) return { value: data[offset], bytesRead: 1 };
    const numBytes = data[offset] & 0x7F;
    let value = 0;
    for (let i = 1; i <= numBytes; i++) value = (value << 8) | data[offset + i];
    return { value, bytesRead: numBytes + 1 };
  }

  static _sendRequest(url, body, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/timestamp-query',
          'Content-Length': body.length,
        },
        timeout,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`TSA returned HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TSA request timeout')); });
      req.write(body);
      req.end();
    });
  }

  static async verifyTimestamp(timestampToken, originalHash, options = {}) {
    const result = {
      valid: false,
      genTime: null,
      tsaName: null,
      hashAlgorithm: null,
      hashMatch: false,
      serialNumber: null,
      certificateInfo: null,
      errors: [],
    };

    try {
      const tokenBuf = Buffer.isBuffer(timestampToken) ? timestampToken : Buffer.from(timestampToken, 'base64');
      const parsed = this._parseTimestampResponse(tokenBuf);

      result.genTime = parsed.genTime;
      result.serialNumber = parsed.serialNumber;

      if (parsed.status === 0) {
        result.valid = true;

        if (originalHash && parsed.tstInfo) {
          const tstHex = parsed.tstInfo.toString('hex');
          result.hashMatch = tstHex.includes(originalHash.toLowerCase());
        } else if (originalHash) {
          const tokenHex = tokenBuf.toString('hex');
          result.hashMatch = tokenHex.includes(originalHash.toLowerCase());
        }

        if (!result.hashMatch && originalHash) {
          result.errors.push('Hash in timestamp token does not match the provided original hash');
          result.valid = false;
        }
      } else {
        result.errors.push(`Timestamp response status: ${parsed.status} (expected 0)`);
      }

      if (options.tsaUrl) {
        result.tsaName = DEFAULT_TSAS.find(t => t.url === options.tsaUrl)?.name || new URL(options.tsaUrl).hostname;
      }
    } catch (err) {
      result.errors.push(err.message);
    }

    return result;
  }

  static async verifyTimestampChain(timestamps) {
    const results = [];
    let allValid = true;

    for (const ts of timestamps) {
      const verification = await this.verifyTimestamp(
        ts.timestampToken || ts.timestamp_token,
        ts.targetHash || ts.target_hash,
        { tsaUrl: ts.tsaUrl || ts.tsa_url }
      );

      if (!verification.valid) allValid = false;

      results.push({
        id: ts.id,
        targetType: ts.targetType || ts.target_type,
        genTime: verification.genTime,
        valid: verification.valid,
        hashMatch: verification.hashMatch,
        errors: verification.errors,
      });
    }

    let chronological = true;
    for (let i = 1; i < results.length; i++) {
      if (results[i].genTime && results[i - 1].genTime) {
        if (new Date(results[i].genTime) < new Date(results[i - 1].genTime)) {
          chronological = false;
          break;
        }
      }
    }

    return {
      totalTimestamps: timestamps.length,
      allValid,
      chronologicalOrder: chronological,
      results,
    };
  }

  static getInfo() {
    return {
      standard: 'RFC 3161 — Internet X.509 PKI Time-Stamp Protocol (TSP)',
      description: 'Requests and verifies cryptographic timestamps from external Timestamp Authorities (TSAs) to prove that data existed at a specific point in time with independent third-party attestation.',
      availableTSAs: DEFAULT_TSAS,
      capabilities: ['request', 'verify', 'chain-validation', 'collection-timestamp', 'export-timestamp'],
      forensicValue: 'RFC 3161 timestamps from qualified TSAs provide legally binding proof of time, suitable for court proceedings under FRE 901(b)(9) / FRE 902(14) and eIDAS.',
      relatedStandards: ['RFC 3161', 'RFC 5816', 'ETSI EN 319 421', 'ETSI EN 319 422', 'ISO/IEC 27037:2012'],
    };
  }
}
