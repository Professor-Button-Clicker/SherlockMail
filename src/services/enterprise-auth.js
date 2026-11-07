import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Sessions live in memory only: a client secret or token is never written to disk.
const sessions = new Map();
const TOKEN_MARGIN_MS = 60000;

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

  static getSession(id) {
    const session = sessions.get(id);
    if (!session) throw new Error('This enterprise sign-in is no longer active: sign in again');
    return session;
  }

  // Signs in now, so wrong details fail here, and returns a session a collection can use by its id.
  static async authenticateAppOnly(config) {
    if (!config.tenantId || !config.clientId || !config.clientSecret) {
      throw new Error('App-only authentication requires tenantId, clientId, and clientSecret');
    }
    return this._openSession(config, 'app_only', () => ({
      client_secret: config.clientSecret,
    }));
  }

  static async authenticateWithCertificate(config) {
    if (!config.tenantId || !config.clientId || !config.certificate || !config.privateKey) {
      throw new Error('Certificate authentication requires tenantId, clientId, certificate and privateKey');
    }
    const envName = config.azureEnvironment || 'commercial';
    const env = this.getEnvironment(envName);
    return this._openSession(config, 'certificate', () => ({
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: this._buildClientAssertion(config.clientId, config.tenantId, config.certificate, config.privateKey, env.authority),
    }));
  }

  static async _openSession(config, authMethod, credentialFields) {
    const envName = config.azureEnvironment || 'commercial';
    const env = this.getEnvironment(envName);
    const authority = process.env.SHERLOCKMAIL_AZURE_AUTHORITY || env.authority;
    const tokens = new Map();
    const tokenFor = async (resource, { force } = {}) => {
      const cached = tokens.get(resource);
      if (cached && !force && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;
      const res = await fetch(`${authority}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, scope: `${resource}/.default`, ...credentialFields() }).toString(),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error || !body.access_token) throw new Error(`Sign-in failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
      tokens.set(resource, { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 });
      return body.access_token;
    };
    const graphEndpoint = process.env.SHERLOCKMAIL_GRAPH_URL ? process.env.SHERLOCKMAIL_GRAPH_URL.replace(/\/v1\.0$/, '') : env.graphEndpoint;
    await tokenFor(graphEndpoint);
    const id = uuidv4();
    sessions.set(id, { id, authMethod, environment: envName, graphEndpoint, graphBase: `${graphEndpoint}/v1.0`, ewsEndpoint: env.ewsEndpoint, tokenFor });
    return { sessionId: id, authMethod, environment: envName, environmentName: env.name, graphEndpoint, ewsEndpoint: env.ewsEndpoint, expiresAt: new Date(tokens.get(graphEndpoint).expiresAt).toISOString() };
  }

  static _buildClientAssertion(clientId, tenantId, certificate, privateKey, authority) {
    const now = Math.floor(Date.now() / 1000);
    const thumbprint = crypto.createHash('sha1').update(new crypto.X509Certificate(certificate).raw).digest('base64url');

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

  // A Microsoft token obtained elsewhere (for example on the custodian's own device), usable until it expires.
  static importToken(tokenData) {
    const token = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
    if (!token.access_token) throw new Error('Missing required field: access_token');
    const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : (token.expires_in ? Date.now() + token.expires_in * 1000 : null);
    if (expiresAt && expiresAt <= Date.now()) throw new Error('This token has already expired');
    const envName = token.azureEnvironment || 'commercial';
    const env = this.getEnvironment(envName);
    const graphEndpoint = process.env.SHERLOCKMAIL_GRAPH_URL ? process.env.SHERLOCKMAIL_GRAPH_URL.replace(/\/v1\.0$/, '') : env.graphEndpoint;
    const id = uuidv4();
    const tokenFor = async () => {
      if (expiresAt && expiresAt <= Date.now()) throw new Error('The imported token has expired: import a new one');
      return token.access_token;
    };
    sessions.set(id, { id, authMethod: 'imported', environment: envName, graphEndpoint, graphBase: `${graphEndpoint}/v1.0`, ewsEndpoint: env.ewsEndpoint, tokenFor });
    return { sessionId: id, authMethod: 'imported', environment: envName, scope: token.scope || null, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, importedAt: new Date().toISOString() };
  }
}
