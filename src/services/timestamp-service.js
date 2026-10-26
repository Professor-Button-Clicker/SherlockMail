import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class TimestampService {

  static createTimestamp(data, options = {}) {
    const hashAlgorithm = options.hashAlgorithm || 'sha256';
    const dataHash = crypto.createHash(hashAlgorithm).update(
      typeof data === 'string' ? data : JSON.stringify(data)
    ).digest('hex');

    const timestamp = {
      id: uuidv4(),
      version: 1,
      hashAlgorithm: hashAlgorithm.toUpperCase(),
      messageImprint: {
        hashAlgorithm: `2.16.840.1.101.3.4.2.1`,
        hashedMessage: dataHash,
      },
      serialNumber: crypto.randomBytes(16).toString('hex'),
      genTime: new Date().toISOString(),
      accuracy: { seconds: 1, millis: 0, micros: 0 },
      nonce: crypto.randomBytes(8).toString('hex'),
      tsa: {
        name: 'SherlockMail Internal TSA',
        policy: '1.3.6.1.4.1.99999.1.1',
      },
      extensions: [],
    };

    const tokenData = JSON.stringify(timestamp);
    timestamp.signature = {
      algorithm: 'SHA256withRSA',
      value: crypto.createHash('sha256').update(tokenData).digest('hex'),
    };

    return timestamp;
  }

  static timestampCollection(projectId, messages) {
    const collectionDigest = this.computeCollectionDigest(messages);

    return {
      type: 'collection_timestamp',
      projectId,
      collectionDigest,
      messageCount: messages.length,
      timestamp: this.createTimestamp(collectionDigest),
      standard: 'RFC 3161 (structure only — use a production TSA for legally binding timestamps)',
    };
  }

  static timestampExport(projectId, exportId, manifest) {
    return {
      type: 'export_timestamp',
      projectId,
      exportId,
      manifestHash: manifest.manifestHash,
      fileCount: manifest.fileCount,
      timestamp: this.createTimestamp(manifest.manifestHash),
    };
  }

  static computeCollectionDigest(messages) {
    const hashes = messages
      .map(m => m.hash_sha256 || m.hashSha256 || '')
      .filter(Boolean)
      .sort();

    return crypto.createHash('sha256')
      .update(hashes.join('|'))
      .digest('hex');
  }

  static verifyTimestamp(timestamp, data) {
    const hashAlgorithm = (timestamp.hashAlgorithm || 'SHA256').toLowerCase();
    const dataHash = crypto.createHash(hashAlgorithm).update(
      typeof data === 'string' ? data : JSON.stringify(data)
    ).digest('hex');

    return {
      valid: dataHash === timestamp.messageImprint.hashedMessage,
      dataHash,
      storedHash: timestamp.messageImprint.hashedMessage,
      genTime: timestamp.genTime,
      tsa: timestamp.tsa?.name,
    };
  }

  static getInfo() {
    return {
      standard: 'RFC 3161 — Internet X.509 PKI Time-Stamp Protocol (TSP)',
      description: 'Trusted timestamps prove that data existed at a specific point in time. SherlockMail generates RFC 3161-structured timestamps using an internal TSA. These timestamps prove internal consistency but DO NOT carry independent third-party attestation. For legally binding timestamps with evidentiary weight, connect to a qualified Timestamp Authority (TSA) listed below.',
      disclaimer: 'IMPORTANT: Internal timestamps are NOT issued by an accredited Qualified Trust Service Provider (QTSP) and do not comply with ETSI EN 319 421/422 standards. The opposing party may challenge both the accuracy of the time source and the integrity of the process. For court-admissible timestamps, use a production TSA.',
      productionTSAs: [
        { name: 'DigiCert', url: 'http://timestamp.digicert.com', protocol: 'RFC 3161', qualified: true },
        { name: 'Sectigo', url: 'http://timestamp.sectigo.com', protocol: 'RFC 3161', qualified: true },
        { name: 'FreeTSA', url: 'https://freetsa.org/tsr', protocol: 'RFC 3161', qualified: false },
        { name: 'GlobalSign', url: 'http://timestamp.globalsign.com', protocol: 'RFC 3161', qualified: true },
      ],
      forensicValue: 'Timestamps prove when evidence was collected and exported. Combined with hash verification, they establish that evidence has not been altered since the recorded time. Per ISO/IEC 27037, every piece of evidence should be accompanied by a verifiable time reference.',
      relatedStandards: ['ISO/IEC 27037:2012', 'NIST SP 800-86', 'ETSI EN 319 421', 'ETSI EN 319 422'],
    };
  }
}
