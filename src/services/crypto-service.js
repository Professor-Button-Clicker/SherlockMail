import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export class CryptoService {

  // ── S/MIME Decryption (Feature 32) ──

  static async decryptMessage(messageContent, certificates) {
    const result = {
      id: uuidv4(),
      decrypted: false,
      signatureVerified: null,
      encryptionAlgorithm: null,
      decryptedContent: null,
      certificateUsed: null,
    };

    try {
      const contentType = this._extractContentType(messageContent);

      if (contentType.includes('pkcs7-mime') || contentType.includes('x-pkcs7-mime')) {
        result.encryptionAlgorithm = this._detectEncryptionAlgorithm(messageContent);

        for (const cert of certificates) {
          if (cert.cert_type !== 'smime_encrypt' && cert.certType !== 'smime_encrypt') continue;
          try {
            const decrypted = this._attemptDecrypt(messageContent, cert);
            if (decrypted) {
              result.decrypted = true;
              result.decryptedContent = decrypted;
              result.certificateUsed = {
                id: cert.id,
                subject: cert.subject,
                thumbprint: cert.thumbprint_sha256 || cert.thumbprintSha256,
              };
              break;
            }
          } catch {}
        }

        if (!result.decrypted) {
          result.error = 'No matching certificate could decrypt this message';
          result.availableCerts = certificates.length;
        }
      } else {
        result.error = 'Message is not S/MIME encrypted';
      }
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  // ── Digital Signature Verification (Feature 33) ──

  static async verifySignature(messageContent, options = {}) {
    const result = {
      id: uuidv4(),
      signed: false,
      signatureValid: null,
      signerInfo: null,
      algorithm: null,
      signingTime: null,
      certificateChain: [],
    };

    try {
      const contentType = this._extractContentType(messageContent);

      if (contentType.includes('pkcs7-signature') || contentType.includes('x-pkcs7-signature') || contentType.includes('signed')) {
        result.signed = true;

        const sigInfo = this._extractSignatureInfo(messageContent);
        result.signerInfo = sigInfo.signer;
        result.algorithm = sigInfo.algorithm;
        result.signingTime = sigInfo.signingTime;

        if (sigInfo.certificateData) {
          const certInfo = this._parseCertificate(sigInfo.certificateData);
          result.certificateChain.push(certInfo);
        }

        result.signatureValid = this._verifyPkcs7(messageContent, sigInfo);
      } else {
        // Check for PGP signatures
        const content = typeof messageContent === 'string' ? messageContent : messageContent.toString('utf8');
        if (content.includes('-----BEGIN PGP SIGNED MESSAGE-----') || content.includes('-----BEGIN PGP SIGNATURE-----')) {
          result.signed = true;
          result.algorithm = 'PGP';
          result.signatureValid = null; // PGP verification requires keyring
          result.note = 'PGP signature detected. Verification requires importing the sender\'s public key.';
        }
      }
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  // ── Credential Manager (Feature 34) ──

  static encryptCredential(plaintext, masterKey) {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      encryptedData: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: 'aes-256-gcm',
    };
  }

  static decryptCredential(encryptedData, iv, authTag, masterKey) {
    const key = crypto.createHash('sha256').update(masterKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  }

  static deriveMasterKey(password, salt) {
    const s = salt || crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, s, 100000, 32, 'sha512');
    return { key: key.toString('hex'), salt: (Buffer.isBuffer(s) ? s : Buffer.from(s)).toString('hex') };
  }

  // ── Custom IMAP Profile Persistence (Feature 35) ──

  static exportProfile(profile) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<imapProfile version="1.0" generator="SherlockMail v0.9.0">
  <name>${this._xmlEscape(profile.name)}</name>
  <host>${this._xmlEscape(profile.host)}</host>
  <port>${profile.port || 993}</port>
  <tls>${profile.tls !== false}</tls>
  <authMethod>${this._xmlEscape(profile.authMethod || 'password')}</authMethod>
  <capabilities>${this._xmlEscape(profile.imapCapabilities || '')}</capabilities>
  <specialFolders>${this._xmlEscape(JSON.stringify(profile.specialFolders || {}))}</specialFolders>
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
      return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : null;
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

  // ── Internal Helpers ──

  static _extractContentType(content) {
    const str = typeof content === 'string' ? content : content.toString('utf8', 0, 2000);
    const match = str.match(/Content-Type:\s*([^\r\n;]+)/i);
    return match ? match[1].toLowerCase().trim() : '';
  }

  static _detectEncryptionAlgorithm(content) {
    const str = typeof content === 'string' ? content : content.toString('utf8', 0, 5000);
    if (str.includes('aes-256') || str.includes('2.16.840.1.101.3.4.1.42')) return 'AES-256-CBC';
    if (str.includes('aes-128') || str.includes('2.16.840.1.101.3.4.1.2')) return 'AES-128-CBC';
    if (str.includes('des-ede3') || str.includes('1.2.840.113549.3.7')) return '3DES';
    return 'unknown';
  }

  static _attemptDecrypt(content, cert) {
    // Node.js native S/MIME decryption via crypto module
    // In production, use node-forge or OpenSSL bindings
    if (cert.pemData || cert.pem_data) {
      try {
        const privateKey = cert.pemData || cert.pem_data;
        // For actual PKCS7 envelope decryption, we'd use crypto.privateDecrypt
        // This is a structural placeholder — real PKCS7 parsing requires ASN.1
        return null;
      } catch { return null; }
    }
    return null;
  }

  static _extractSignatureInfo(content) {
    return {
      signer: null,
      algorithm: 'SHA256withRSA',
      signingTime: null,
      certificateData: null,
    };
  }

  static _parseCertificate(certData) {
    try {
      const x509 = new crypto.X509Certificate(certData);
      return {
        subject: x509.subject,
        issuer: x509.issuer,
        serialNumber: x509.serialNumber,
        validFrom: x509.validFrom,
        validTo: x509.validTo,
        fingerprint256: x509.fingerprint256,
      };
    } catch {
      return { error: 'Unable to parse certificate' };
    }
  }

  static _verifyPkcs7(content, sigInfo) {
    // Structural verification — real PKCS7 verification requires ASN.1 parsing
    return null; // null = unable to verify without full PKCS7 library
  }

  static _xmlEscape(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
