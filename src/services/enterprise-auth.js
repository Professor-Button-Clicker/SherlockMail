import crypto from 'crypto';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';

const AZURE_ENVIRONMENTS = {
  commercial: {
    name: 'Azure Commercial',
    authority: 'https://login.microsoftonline.com',
    graphEndpoint: 'https://graph.microsoft.com',
    ewsEndpoint: 'https://outlook.office365.com',
    resourceId: 'https://graph.microsoft.com',
  },
  usgov: {
    name: 'Azure US Government',
    authority: 'https://login.microsoftonline.us',
    graphEndpoint: 'https://graph.microsoft.us',
    ewsEndpoint: 'https://outlook.office365.us',
    resourceId: 'https://graph.microsoft.us',
  },
  usgov_dod: {
    name: 'Azure US DoD',
    authority: 'https://login.microsoftonline.us',
    graphEndpoint: 'https://dod-graph.microsoft.us',
    ewsEndpoint: 'https://outlook.office365.us',
    resourceId: 'https://dod-graph.microsoft.us',
  },
  china: {
    name: 'Azure China (21Vianet)',
    authority: 'https://login.chinacloudapi.cn',
    graphEndpoint: 'https://microsoftgraph.chinacloudapi.cn',
    ewsEndpoint: 'https://partner.outlook.cn',
    resourceId: 'https://microsoftgraph.chinacloudapi.cn',
  },
  germany: {
    name: 'Azure Germany',
    authority: 'https://login.microsoftonline.de',
    graphEndpoint: 'https://graph.microsoft.de',
    ewsEndpoint: 'https://outlook.office.de',
    resourceId: 'https://graph.microsoft.de',
  },
};

export class EnterpriseAuthService {

  static getAzureEnvironments() {
    return AZURE_ENVIRONMENTS;
  }

  static getEnvironment(env) {
    return AZURE_ENVIRONMENTS[env] || AZURE_ENVIRONMENTS.commercial;
  }

  static async authenticateAppOnly(config) {
    const env = this.getEnvironment(config.azureEnvironment || 'commercial');
    const tenantId = config.tenantId;
    const clientId = config.clientId;
    const clientSecret = config.clientSecret;

    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('App-only authentication requires tenantId, clientId, and clientSecret');
    }

    const tokenUrl = `${env.authority}/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: `${env.resourceId}/.default`,
    });

    const response = await this._httpsPost(tokenUrl, body.toString());
    const tokens = JSON.parse(response);

    if (tokens.error) throw new Error(`Auth failed: ${tokens.error_description || tokens.error}`);

    return {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type,
      expiresIn: tokens.expires_in,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      environment: config.azureEnvironment || 'commercial',
      graphEndpoint: env.graphEndpoint,
      ewsEndpoint: env.ewsEndpoint,
      authMethod: 'app_only',
    };
  }

  static async authenticateWithCertificate(config) {
    const env = this.getEnvironment(config.azureEnvironment || 'commercial');
    const tenantId = config.tenantId;
    const clientId = config.clientId;

    const assertion = this._buildClientAssertion(clientId, tenantId, config.certificate, config.privateKey, env.authority);

    const tokenUrl = `${env.authority}/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope: `${env.resourceId}/.default`,
    });

    const response = await this._httpsPost(tokenUrl, body.toString());
    const tokens = JSON.parse(response);

    if (tokens.error) throw new Error(`Certificate auth failed: ${tokens.error_description || tokens.error}`);

    return {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type,
      expiresIn: tokens.expires_in,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      environment: config.azureEnvironment || 'commercial',
      graphEndpoint: env.graphEndpoint,
      ewsEndpoint: env.ewsEndpoint,
      authMethod: 'certificate',
    };
  }

  static _buildClientAssertion(clientId, tenantId, certificate, privateKey, authority) {
    const now = Math.floor(Date.now() / 1000);
    const thumbprint = crypto.createHash('sha1').update(Buffer.from(certificate.replace(/-----.*-----/g, '').replace(/\s/g, ''), 'base64')).digest('base64url');

    const header = Buffer.from(JSON.stringify({
      alg: 'RS256', typ: 'JWT',
      x5t: thumbprint,
    })).toString('base64url');

    const payload = Buffer.from(JSON.stringify({
      aud: `${authority}/${tenantId}/oauth2/v2.0/token`,
      iss: clientId, sub: clientId,
      jti: uuidv4(),
      nbf: now, exp: now + 600,
    })).toString('base64url');

    const signable = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signable);
    const signature = sign.sign(privateKey, 'base64url');

    return `${signable}.${signature}`;
  }

  static async importToken(tokenData) {
    const token = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
    const required = ['access_token'];
    for (const field of required) {
      if (!token[field]) throw new Error(`Missing required field: ${field}`);
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tokenType: token.token_type || 'Bearer',
      expiresAt: token.expires_at || (token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null),
      scope: token.scope || null,
      imported: true,
      importedAt: new Date().toISOString(),
    };
  }

  static _httpsPost(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname, port: 443, path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }
}
