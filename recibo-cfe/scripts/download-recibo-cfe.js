#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const { execFileSync } = require('child_process');

const SKILL_ROOT = path.dirname(__dirname);
const ARTIFACTS_DIR = process.env.CFE_ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts');
const LOGIN_URL = process.env.CFE_LOGIN_URL || 'https://app.cfe.mx/Aplicaciones/CCFE/MiEspacio/Login.aspx';
const RECEIPTS_URL = process.env.CFE_RECEIPTS_URL || 'https://app.cfe.mx/Aplicaciones/CCFE/MiEspacio/default.aspx';
const NORMALIZE_SCRIPT = path.join(__dirname, 'normalize-recibo-cfe.sh');
const PDF_NAME_PREFIX = process.env.CFE_PDF_NAME_PREFIX || 'Recibo CFE';
const REQUEST_TIMEOUT_MS = Number(process.env.CFE_TIMEOUT_MS || 30000);
const RETRIES = Number(process.env.CFE_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.CFE_RETRY_BASE_DELAY_MS || 2000);
const RETRYABLE_STATUS = new Set([502, 503, 504, 408, 429]);
const USER_AGENT = process.env.CFE_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CREDENTIAL_FILES = [
  path.join(os.homedir(), '.zshrc'),
  path.join(os.homedir(), '.zprofile'),
  path.join(os.homedir(), '.bashrc'),
  path.join(os.homedir(), '.bash_profile'),
  path.join(os.homedir(), '.profile'),
];

function decodeHtml(value = '') {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripTags(html = '') {
  return decodeHtml(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractQuoted(line, key) {
  const patterns = [
    new RegExp(`(?:export\\s+)?${key}=\\"([^\\"]*)\\"`),
    new RegExp(`(?:export\\s+)?${key}='([^']*)'`),
    new RegExp(`(?:export\\s+)?${key}=([^\\s#]+)`),
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function readShellVar(key) {
  for (const file of CREDENTIAL_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const value = extractQuoted(line, key);
      if (value != null && value !== '') return { value, source: file };
    }
  }
  return null;
}

function profilePath() {
  if (process.env.MEXICAN_SKILLS_PROFILE) return process.env.MEXICAN_SKILLS_PROFILE;
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'mexican-skills', 'profile.json');
}

function readProfileField(key) {
  const file = profilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const value = data && typeof data === 'object' ? data[key] : undefined;
    if (value === undefined || value === null || value === '') return null;
    return { value: String(value), source: file };
  } catch {
    return null;
  }
}

function loadCredentials({ allowMissing = false } = {}) {
  const envUsername = process.env.CFE_USERNAME || '';
  const envPassword = process.env.CFE_PASSWORD || '';
  const shellUsername = envUsername ? null : readShellVar('CFE_USERNAME');
  const shellPassword = envPassword ? null : readShellVar('CFE_PASSWORD');
  const profileUsername = (envUsername || shellUsername) ? null : readProfileField('cfeUsername');
  const username = envUsername || shellUsername?.value || profileUsername?.value || '';
  const password = envPassword || shellPassword?.value || '';

  let usernameSource;
  if (envUsername) usernameSource = 'environment';
  else if (shellUsername) usernameSource = shellUsername.source;
  else if (profileUsername) usernameSource = profileUsername.source;
  else usernameSource = 'missing';

  const passwordSource = envPassword
    ? 'environment'
    : (shellPassword?.source || 'missing');

  const source = envUsername || envPassword
    ? 'environment'
    : (shellUsername?.source || shellPassword?.source || profileUsername?.source || 'missing');

  const missing = [];
  if (!username) missing.push('CFE_USERNAME');
  if (!password) missing.push('CFE_PASSWORD');
  if (missing.length && !allowMissing) {
    throw new Error(`Faltan credenciales CFE: ${missing.join(' y ')}. CFE_USERNAME puede vivir en env, shell rc, o el profile (${profilePath()}). CFE_PASSWORD siempre en env o shell rc — nunca en el profile.`);
  }
  return { username, password, source, usernameSource, passwordSource, profilePath: profilePath(), missing };
}

class SessionClient {
  constructor() {
    this.cookies = new Map();
  }

  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const first = String(header).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      this.cookies.set(first.slice(0, idx), first.slice(idx + 1));
    }
  }

  async _doRequest(url, options) {
    const { method = 'GET', headers = {}, body = null, referer = null, responseType = 'buffer' } = options;
    const target = new URL(url);
    const finalHeaders = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      ...headers,
    };

    const cookie = this.cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;
    if (referer) finalHeaders.Referer = referer;

    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : null;
    if (payload != null && !finalHeaders['Content-Length']) {
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const response = await new Promise((resolve, reject) => {
      const req = https.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: finalHeaders,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms: ${url}`)));
      if (payload != null) req.write(payload);
      req.end();
    });

    this.storeCookies(response.res.headers['set-cookie'] || []);

    if ([301, 302, 303, 307, 308].includes(response.res.statusCode || 0) && response.res.headers.location) {
      const nextUrl = new URL(response.res.headers.location, target).toString();
      const shouldSwitchToGet = [301, 302, 303].includes(response.res.statusCode || 0);
      return this._doRequest(nextUrl, {
        method: shouldSwitchToGet ? 'GET' : method,
        headers,
        body: shouldSwitchToGet ? null : body,
        referer: url,
        responseType,
      });
    }

    const text = responseType === 'text' ? response.body.toString('utf8') : null;
    return {
      statusCode: response.res.statusCode || 0,
      headers: response.res.headers,
      url,
      body: response.body,
      text,
    };
  }

  async request(url, options = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, RETRIES); attempt += 1) {
      try {
        const response = await this._doRequest(url, options);
        if (RETRYABLE_STATUS.has(response.statusCode) && attempt < RETRIES) {
          lastError = new Error(`HTTP ${response.statusCode} on ${url}`);
          const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          process.stderr.write(`[retry ${attempt}/${RETRIES}] ${response.statusCode} on ${url}, esperando ${delay}ms…\n`);
          await sleep(delay);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= RETRIES) throw error;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        process.stderr.write(`[retry ${attempt}/${RETRIES}] ${error.message}, esperando ${delay}ms…\n`);
        await sleep(delay);
      }
    }
    throw lastError || new Error(`Request failed: ${url}`);
  }
}

function parseForm(html) {
  const fields = {};

  for (const match of html.matchAll(/<input\b([^>]*)>/gis)) {
    const attrs = match[1] || '';
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const value = attrs.match(/\bvalue="([^"]*)"/i)?.[1] || '';
    fields[name] = decodeHtml(value);
  }

  for (const match of html.matchAll(/<select\b([^>]*)>(.*?)<\/select>/gis)) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    let option = inner.match(/<option[^>]*selected="selected"[^>]*value="([^"]*)"/i)?.[1];
    if (option == null) option = inner.match(/<option[^>]*value="([^"]*)"/i)?.[1] || '';
    fields[name] = decodeHtml(option);
  }

  return fields;
}

function extractLatestReceipt(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    const rowHtml = match[1] || '';
    if (!rowHtml.includes('DescargaPDF')) continue;
    const cells = Array.from(rowHtml.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)).map((item) => stripTags(item[1] || ''));
    const eventTarget = rowHtml.match(/__doPostBack\(&#39;([^&#]+DescargaPDF)&#39;,&#39;&#39;\)/i)?.[1] || null;
    if (!eventTarget) continue;
    rows.push({ label: cells[0] || 'Recibo más reciente', eventTarget, cells });
  }
  return rows[0] || null;
}

function preflight() {
  const credentials = loadCredentials({ allowMissing: true });
  const issues = [];
  const notes = [];

  if (!credentials.username) issues.push(`CFE_USERNAME no está definida (env, shell rc, ni profile ${credentials.profilePath}).`);
  if (!credentials.password) issues.push('CFE_PASSWORD no está definida (debe ir en env o shell rc; nunca en profile).');
  if (!fs.existsSync(NORMALIZE_SCRIPT)) issues.push(`Falta el script de normalización: ${NORMALIZE_SCRIPT}`);
  else {
    try {
      fs.accessSync(NORMALIZE_SCRIPT, fs.constants.X_OK);
    } catch {
      issues.push(`El script de normalización no es ejecutable: chmod +x ${NORMALIZE_SCRIPT}`);
    }
  }

  if (process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY) {
    notes.push('TWOCAPTCHA_API_KEY detectada. El flujo HTTP actual no la usa, pero queda disponible si en el futuro CFE introduce CAPTCHA.');
  }

  const result = {
    status: issues.length ? 'preflight_failed' : 'preflight_ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    artifactsDir: ARTIFACTS_DIR,
    loginUrl: LOGIN_URL,
    receiptsUrl: RECEIPTS_URL,
    pdfNamePrefix: PDF_NAME_PREFIX,
    normalizeScript: NORMALIZE_SCRIPT,
    env: {
      CFE_USERNAME: credentials.username ? 'set' : 'missing',
      CFE_PASSWORD: credentials.password ? 'set' : 'missing',
      TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY ? 'set' : 'optional_missing',
    },
    credentialSource: credentials.source,
    usernameSource: credentials.usernameSource,
    passwordSource: credentials.passwordSource,
    profilePath: credentials.profilePath,
    issues,
    notes,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = issues.length ? 2 : 0;
}

function selfTest() {
  const credentials = loadCredentials({ allowMissing: true });
  console.log(JSON.stringify({
    status: 'self_test_ok',
    skillRoot: SKILL_ROOT,
    artifactsDir: ARTIFACTS_DIR,
    loginUrl: LOGIN_URL,
    receiptsUrl: RECEIPTS_URL,
    pdfNamePrefix: PDF_NAME_PREFIX,
    finalPdfName: `${PDF_NAME_PREFIX} <DD-MM-YYYY>.pdf`,
    credentialsAvailable: Boolean(credentials.username && credentials.password),
    credentialSource: credentials.source,
    usernameSource: credentials.usernameSource,
    passwordSource: credentials.passwordSource,
    profilePath: credentials.profilePath,
  }, null, 2));
}

function usage() {
  return [
    'Uso: node scripts/download-recibo-cfe.js [--preflight] [--self-test] [--help]',
    '',
    'Variables de entorno:',
    '  CFE_USERNAME, CFE_PASSWORD (requeridas)',
    '  CFE_ARTIFACTS_DIR (default: <skill-root>/artifacts)',
    '  CFE_LOGIN_URL, CFE_RECEIPTS_URL (overrides)',
    '  CFE_PDF_NAME_PREFIX (default: "Recibo CFE")',
    '  CFE_TIMEOUT_MS (default: 30000)',
    '  CFE_USER_AGENT (default: UA de Chrome estándar)',
    '',
  ].join('\n');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.argv.includes('--preflight')) {
    preflight();
    return;
  }
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
  const credentials = loadCredentials();
  const client = new SessionClient();

  const loginPage = await client.request(LOGIN_URL, { responseType: 'text' });
  if (loginPage.statusCode !== 200) {
    throw new Error(`No se pudo abrir la página de login de CFE: HTTP ${loginPage.statusCode}`);
  }

  const loginFields = parseForm(loginPage.text);
  loginFields['ctl00$MainContent$txtUsuario'] = credentials.username;
  loginFields['ctl00$MainContent$txtPassword'] = credentials.password;
  loginFields['ctl00$MainContent$btnIngresar'] = 'Ingresar';

  const loginBody = new URLSearchParams(loginFields).toString();
  const authPage = await client.request(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginBody,
    referer: LOGIN_URL,
    responseType: 'text',
  });

  if (authPage.statusCode !== 200) {
    throw new Error(`Login en CFE falló con HTTP ${authPage.statusCode}`);
  }
  if (!/GVHistorial|DescargaPDF/i.test(authPage.text)) {
    const preview = stripTags(authPage.text).slice(0, 300);
    throw new Error(`Login en CFE no llegó a la página de recibos. Preview: ${preview}`);
  }

  const latestReceipt = extractLatestReceipt(authPage.text);
  if (!latestReceipt) {
    throw new Error('No se encontraron filas de recibos con acción de descarga PDF.');
  }

  const downloadFields = parseForm(authPage.text);
  downloadFields.__EVENTTARGET = latestReceipt.eventTarget;
  downloadFields.__EVENTARGUMENT = '';

  const downloadResponse = await client.request(RECEIPTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(downloadFields).toString(),
    referer: RECEIPTS_URL,
    responseType: 'buffer',
  });

  const contentDisposition = String(downloadResponse.headers['content-disposition'] || '');
  const contentType = String(downloadResponse.headers['content-type'] || '');
  if (!/attachment|pdf|octet/i.test(`${contentDisposition} ${contentType}`)) {
    const preview = downloadResponse.body.toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`CFE no devolvió un PDF descargable. HTTP ${downloadResponse.statusCode}. Preview: ${preview}`);
  }

  const tempName = `recibo-cfe-${Date.now()}.pdf`;
  const tempPath = path.join(ARTIFACTS_DIR, tempName);
  await fsp.writeFile(tempPath, downloadResponse.body);

  const finalPath = execFileSync(NORMALIZE_SCRIPT, [tempPath, ARTIFACTS_DIR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CFE_PDF_NAME_PREFIX: PDF_NAME_PREFIX },
  }).trim();

  console.log(JSON.stringify({
    ok: true,
    credentialSource: credentials.source,
    latestReceiptLabel: latestReceipt.label,
    latestReceiptCells: latestReceipt.cells,
    downloadBytes: downloadResponse.body.length,
    contentDisposition,
    contentType,
    finalPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
