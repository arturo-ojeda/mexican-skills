#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const SKILL_ROOT = path.resolve(__dirname, '..');

const DEFAULT_ENTRY_URL = process.env.IMSS_ENTRY_URL || 'https://serviciosdigitales.imss.gob.mx/semanascotizadas-web/usuarios/IngresoAsegurado';
const DEFAULT_LOGIN_POST_URL = process.env.IMSS_LOGIN_URL || 'https://serviciosdigitales.imss.gob.mx/semanascotizadas-web/usuarios/LoginAsegurado';
const DEFAULT_CAPTCHA_URL = process.env.IMSS_CAPTCHA_URL || 'https://serviciosdigitales.imss.gob.mx/semanascotizadas-web/servlet/CaptchaServlet';
const DEFAULT_ARTIFACTS_DIR = process.env.IMSS_ARTIFACTS_DIR || process.cwd();
const REQUEST_TIMEOUT_MS = Number(process.env.IMSS_TIMEOUT_MS || 30000);
const RETRIES = Number(process.env.IMSS_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.IMSS_RETRY_BASE_DELAY_MS || 2000);
const RETRYABLE_STATUS = new Set([502, 503, 504, 408, 429]);
const USER_AGENT = process.env.IMSS_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const {
  ensureDir,
  finalPdfName,
  isPdfBuffer,
  savePdfBuffer,
  sleep,
} = require('./imss-pdf-tools');

const CREDENTIAL_FILES = [
  path.join(os.homedir(), '.zshrc'),
  path.join(os.homedir(), '.zprofile'),
  path.join(os.homedir(), '.bashrc'),
  path.join(os.homedir(), '.bash_profile'),
  path.join(os.homedir(), '.profile'),
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripTags(html = '') {
  return decodeHtml(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function summarizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
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

function resolveSecret(envValue, key) {
  if (envValue) return { value: envValue, source: 'environment' };
  const shell = readShellVar(key);
  if (shell) return { value: shell.value, source: shell.source };
  return { value: '', source: 'missing' };
}

function loadConfig() {
  const nss = resolveSecret(process.env.IMSS_NSS, 'IMSS_NSS');
  const curp = resolveSecret(process.env.IMSS_CURP, 'IMSS_CURP');
  const email = resolveSecret(process.env.IMSS_EMAIL, 'IMSS_EMAIL');
  const phone = resolveSecret(process.env.IMSS_PHONE, 'IMSS_PHONE');
  const solverEnv = process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY || '';
  const solver = solverEnv
    ? { value: solverEnv, source: 'environment' }
    : (() => {
        const a = readShellVar('TWOCAPTCHA_API_KEY');
        if (a) return { value: a.value, source: a.source };
        const b = readShellVar('CAPTCHA_SOLVER_API_KEY');
        if (b) return { value: b.value, source: b.source };
        return { value: '', source: 'missing' };
      })();

  return {
    entryUrl: DEFAULT_ENTRY_URL,
    loginUrl: DEFAULT_LOGIN_POST_URL,
    captchaUrl: DEFAULT_CAPTCHA_URL,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    nss: nss.value,
    curp: curp.value.toUpperCase(),
    email: email.value,
    phone: phone.value,
    solverApiKey: solver.value,
    nssSource: nss.source,
    curpSource: curp.source,
    emailSource: email.source,
    phoneSource: phone.source,
    solverKeySource: solver.value ? solver.source : null,
  };
}

function parseArgs(argv) {
  const out = {
    autoSolve: false,
    help: false,
    selfTest: false,
    preflight: false,
    captcha: '',
    smsToken: process.env.IMSS_SMS_TOKEN || '',
    stateFile: process.env.IMSS_STATE_FILE || '',
  };

  for (const arg of argv) {
    if (arg === '--auto-solve') out.autoSolve = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--preflight') out.preflight = true;
    else if (arg.startsWith('--captcha=')) out.captcha = arg.slice('--captcha='.length).trim();
    else if (arg.startsWith('--sms-token=')) out.smsToken = arg.slice('--sms-token='.length).trim();
    else if (arg.startsWith('--state-file=')) out.stateFile = arg.slice('--state-file='.length).trim();
    else if (!arg.startsWith('--') && !out.captcha) out.captcha = String(arg).trim();
  }

  return out;
}

function usage() {
  return [
    'Uso: node scripts/imss-flow.js [TEXTO_CAPTCHA] [--captcha=TEXTO] [--auto-solve]',
    '                              [--sms-token=CODIGO] [--state-file=PATH]',
    '                              [--self-test] [--preflight] [--help]',
    '',
    'Ejemplos:',
    '  node scripts/imss-flow.js --preflight',
    '  node scripts/imss-flow.js --auto-solve                       # fase 1: login + captcha; espera SMS',
    '  IMSS_SMS_TOKEN=ABC123 node scripts/imss-flow.js --auto-solve # fase 2: token + descarga PDF',
    '',
    'Variables: IMSS_NSS, IMSS_CURP, IMSS_EMAIL, IMSS_PHONE, TWOCAPTCHA_API_KEY,',
    '           IMSS_STATE_FILE (override del state.json), IMSS_USER_AGENT.',
  ].join('\n');
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

class SessionClient {
  constructor() {
    this.cookies = new Map();
    this.lastUrl = null;
  }

  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  exportCookies() {
    return Array.from(this.cookies.entries()).map(([name, value]) => ({ name, value }));
  }

  importCookies(cookieList) {
    for (const c of cookieList || []) {
      if (c && c.name) this.cookies.set(c.name, c.value || '');
    }
  }

  storeCookies(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const first = String(header).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx);
      const value = first.slice(idx + 1);
      // delete jar entry on max-age=0 / expires past
      if (/expires=Thu, 01 Jan 1970/i.test(header) || /max-age=0/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  async _doRequest(url, options) {
    const { method = 'GET', headers = {}, body = null, referer = null, redirectsLeft = 5 } = options;
    const target = new URL(url);
    const finalHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-cache',
      ...headers,
    };

    const cookie = this.cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;
    if (referer) finalHeaders.Referer = referer;
    else if (this.lastUrl) finalHeaders.Referer = this.lastUrl;

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
    this.lastUrl = url;

    const status = response.res.statusCode || 0;
    const location = response.res.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
      const nextUrl = new URL(location, target).toString();
      const shouldSwitchToGet = [301, 302, 303].includes(status);
      return this._doRequest(nextUrl, {
        method: shouldSwitchToGet ? 'GET' : method,
        headers,
        body: shouldSwitchToGet ? null : body,
        referer: url,
        redirectsLeft: redirectsLeft - 1,
      });
    }

    return {
      statusCode: status,
      headers: response.res.headers,
      url,
      body: response.body,
      text: response.body.toString('utf8'),
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
          process.stderr.write(`[retry ${attempt}/${RETRIES}] ${response.statusCode} on ${url}, esperando ${delay}ms\n`);
          await sleep(delay);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= RETRIES) throw error;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        process.stderr.write(`[retry ${attempt}/${RETRIES}] ${error.message}, esperando ${delay}ms\n`);
        await sleep(delay);
      }
    }
    throw lastError || new Error(`Request failed: ${url}`);
  }
}

function parseHiddenFields(html, formMatcher) {
  const fields = {};
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let formInner = '';
  let m;
  while ((m = formRe.exec(html)) !== null) {
    if (formMatcher(m[0])) { formInner = m[1]; break; }
  }
  if (!formInner) return null;

  for (const inputMatch of formInner.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = inputMatch[1] || '';
    const type = (attrs.match(/\btype="([^"]*)"/i)?.[1] || 'text').toLowerCase();
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    if (type !== 'hidden') continue;
    const value = decodeHtml(attrs.match(/\bvalue="([^"]*)"/i)?.[1] || '');
    fields[name] = value;
  }
  return fields;
}

function findFormByInputName(html, inputName) {
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  const inputRe = new RegExp(`<input\\b[^>]*\\bname="${inputName}"`, 'i');
  while ((m = formRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    if (!inputRe.test(inner)) continue;
    const action = decodeHtml(attrs.match(/\baction="([^"]+)"/i)?.[1] || '');
    const method = (attrs.match(/\bmethod="([^"]+)"/i)?.[1] || 'POST').toUpperCase();
    const id = attrs.match(/\bid="([^"]+)"/i)?.[1] || '';
    const hiddens = {};
    for (const im of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const inAttrs = im[1] || '';
      const inType = (inAttrs.match(/\btype="([^"]*)"/i)?.[1] || 'text').toLowerCase();
      if (inType !== 'hidden') continue;
      const n = inAttrs.match(/\bname="([^"]+)"/i)?.[1];
      const v = decodeHtml(inAttrs.match(/\bvalue="([^"]*)"/i)?.[1] || '');
      if (n) hiddens[n] = v;
    }
    return { action, method, id, hiddenFields: hiddens };
  }
  return null;
}

function extractAlertMessages(html) {
  const messages = [];
  // Capture rendered alert-danger / alert-warning blocks (server-side errors)
  const re = /<div[^>]*class="[^"]*\balert(?:-danger|-warning)?\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1] || '';
    // skip the "alert-info" / privacy notice blocks that include big legal text
    if (/aviso de privacidad/i.test(inner)) continue;
    const text = stripTags(inner);
    if (!text) continue;
    // skip if it's clearly the JS template (uses backticks / quotes around `+` operators)
    if (/html\s*\+=|document\.|function\b|errorFormulario/i.test(inner) && text.length < 80 && !/intentos|limite|token|captcha|correo|curp|nss/i.test(text)) {
      continue;
    }
    messages.push(text);
  }
  return messages;
}

function detectPageState(html, finalUrl) {
  const text = stripTags(html);
  const alerts = extractAlertMessages(html);
  const alertText = normalize(alerts.join(' \n '));
  const lowered = normalize(text);

  return {
    impervaBlocked: /access denied|error 15|incident id|powered by\s*imperva/i.test(html),
    alerts,
    captchaError: hasAny(alertText, [
      'captcha incorrecto',
      'captcha no valido',
      'caracteres de la imagen son incorrectos',
      'informacion del captcha no coincide',
      'captcha no coincide',
    ]),
    credentialError: hasAny(alertText, [
      'correo que esta intentando ingresar no es valido',
      'correo electronico que capturo ya se encuentra registrado',
      'curp incorrecto',
      'curp incorrecta',
      'nss incorrecto',
      'nss incorrecta',
      'datos no coinciden',
      'no se encuentra registrado',
    ]),
    dailyLimitExceeded: hasAny(alertText, [
      'numero de intentos alcanzado por el dia',
      'limite de tokens diario',
      'numero de intentos excedido',
    ]),
    blocked: hasAny(alertText, [
      'demasiados intentos',
      'intentalo mas tarde',
      'acceso bloqueado',
    ]),
    tokenRequired: hasAny(lowered, [
      'ingresa el token',
      'token que se envio',
      'codigo de verificacion',
    ]),
    tokenInvalid: hasAny(alertText, [
      'token incorrecto',
      'token invalido',
      'token expirado',
      'codigo incorrecto',
      'token capturado no es valido',
    ]),
    bodyPreview: summarizeText(text),
    alertPreview: summarizeText(alerts.join(' | ')),
    finalUrl,
    rawTextLength: text.length,
  };
}

function hasAny(lowered, needles) {
  return needles.some((n) => lowered.includes(normalize(n)));
}

async function solveCaptchaVia2Captcha(imagePath, apiKey) {
  if (!apiKey) {
    return { ok: false, code: 'solver_unavailable', message: 'TWOCAPTCHA_API_KEY no esta configurada' };
  }

  const base64Body = fs.readFileSync(imagePath).toString('base64');
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'base64',
    body: base64Body,
    json: '1',
    phrase: '0',
    regsense: '1',
    numeric: '0',
    min_len: '5',
    max_len: '10',
    language: '2',
  });

  const submitResponse = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: submitParams,
  });
  const submitJson = await submitResponse.json();
  if (submitJson.status !== 1) {
    return { ok: false, code: 'solver_failed', message: `2Captcha submit failed: ${submitJson.request}` };
  }

  const id = String(submitJson.request);
  const pollUrl = new URL('https://2captcha.com/res.php');
  pollUrl.searchParams.set('key', apiKey);
  pollUrl.searchParams.set('action', 'get');
  pollUrl.searchParams.set('id', id);
  pollUrl.searchParams.set('json', '1');

  for (let attempt = 1; attempt <= 14; attempt += 1) {
    await sleep(attempt === 1 ? 7000 : 5000);
    const response = await fetch(pollUrl);
    const json = await response.json();

    if (json.status === 1) {
      return { ok: true, text: String(json.request || '').trim(), provider: '2captcha', requestId: id };
    }
    if (json.request !== 'CAPCHA_NOT_READY') {
      return { ok: false, code: 'solver_failed', message: `2Captcha poll failed: ${json.request}`, requestId: id };
    }
  }

  return { ok: false, code: 'solver_failed', message: '2Captcha agoto el tiempo de espera', requestId: id };
}

function isJpegBuffer(body) {
  return Boolean(body && body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff);
}

function isPngBuffer(body) {
  return Boolean(body && body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47);
}

function isImageBuffer(body) {
  return isJpegBuffer(body) || isPngBuffer(body);
}

async function fetchCaptcha(client, captchaUrl, runDir, captchaUrlReferer) {
  const url = `${captchaUrl}?${Date.now()}`;
  const response = await client.request(url, {
    headers: { 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    referer: captchaUrlReferer,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Captcha HTTP ${response.statusCode}`);
  }
  if (!isImageBuffer(response.body)) {
    throw new Error(`Captcha no es imagen valida (${response.body.slice(0, 16).toString('hex')}...)`);
  }
  const ext = isPngBuffer(response.body) ? 'png' : 'jpg';
  const outPath = path.join(runDir, `captcha.${ext}`);
  fs.writeFileSync(outPath, response.body);
  return { path: outPath, url };
}

function buildLoginBody(config, captchaText) {
  return new URLSearchParams({
    curp: config.curp,
    nss: config.nss,
    correo: config.email,
    correoConfirma: config.email,
    telefono: config.phone,
    telefonoConfirma: config.phone,
    captcha: captchaText,
  }).toString();
}

function buildTokenBody(hiddenFields, tokenFieldName, tokenValue) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(hiddenFields || {})) params.append(k, v);
  params.append(tokenFieldName, tokenValue);
  return params.toString();
}

function detectTokenFieldName(html) {
  for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1] || '';
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    if (/^token$/i.test(name)) return 'token';
    if (/token/i.test(name)) return name;
  }
  return null;
}

function findPdfDownloadUrl(html, baseUrl) {
  const candidates = [];
  // 1. Anchor href containing pdf
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = decodeHtml(m[1] || '');
    if (/\.pdf(\?|$)/i.test(href) || /pdf|reporte|constancia|historia.?laboral|imprimir|descarga/i.test(href)) {
      candidates.push({ source: 'href', url: href });
    }
  }
  // 2. window.open(...)
  for (const m of html.matchAll(/window\.open\(['\"]([^'\"]+)['\"]/gi)) {
    candidates.push({ source: 'window_open', url: decodeHtml(m[1] || '') });
  }
  // 3. form action
  for (const m of html.matchAll(/<form\b[^>]*\baction="([^"]+)"/gi)) {
    const action = decodeHtml(m[1] || '');
    if (/pdf|reporte|constancia|historia.?laboral|descarga/i.test(action)) {
      candidates.push({ source: 'form_action', url: action });
    }
  }
  // Resolve and deduplicate
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.url) continue;
    if (/^javascript:/i.test(c.url)) continue;
    let resolved;
    try { resolved = new URL(c.url, baseUrl).toString(); } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ ...c, url: resolved });
  }
  return out;
}

function preflightReport() {
  const config = loadConfig();
  const issues = [];

  if (!config.nss) issues.push('IMSS_NSS no esta definida (env o shell rc).');
  if (!config.curp) issues.push('IMSS_CURP no esta definida (env o shell rc).');
  if (!config.email) issues.push('IMSS_EMAIL no esta definida (env o shell rc).');
  if (!config.phone) issues.push('IMSS_PHONE no esta definida (env o shell rc).');
  if (!config.solverApiKey) issues.push('TWOCAPTCHA_API_KEY no esta definida (env o shell rc; requerida para --auto-solve).');

  if (config.curp && !/^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(config.curp)) {
    issues.push(`IMSS_CURP no cumple el formato CURP esperado: ${config.curp}`);
  }
  if (config.nss && !/^\d{11}$/.test(config.nss)) {
    issues.push(`IMSS_NSS debe ser exactamente 11 digitos numericos.`);
  }
  if (config.phone && !/^\d{10}$/.test(config.phone)) {
    issues.push(`IMSS_PHONE debe ser exactamente 10 digitos numericos.`);
  }

  return {
    status: issues.length ? 'preflight_failed' : 'preflight_ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    artifactsDir: config.artifactsDir,
    entryUrl: config.entryUrl,
    loginUrl: config.loginUrl,
    captchaUrl: config.captchaUrl,
    transport: 'http-only',
    env: {
      IMSS_NSS: config.nss ? 'set' : 'missing',
      IMSS_CURP: config.curp ? 'set' : 'missing',
      IMSS_EMAIL: config.email ? 'set' : 'missing',
      IMSS_PHONE: config.phone ? 'set' : 'missing',
      TWOCAPTCHA_API_KEY: config.solverApiKey ? 'set' : 'missing',
    },
    nssSource: config.nssSource,
    curpSource: config.curpSource,
    emailSource: config.emailSource,
    phoneSource: config.phoneSource,
    solverKeySource: config.solverKeySource,
    issues,
  };
}

function findLatestStateFile(artifactsDir) {
  if (!fs.existsSync(artifactsDir)) return null;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^imss-semanas-run-/.test(entry.name)) continue;
    const candidate = path.join(artifactsDir, entry.name, 'state.json');
    if (!fs.existsSync(candidate)) continue;
    const mtime = fs.statSync(candidate).mtimeMs;
    if (mtime > bestMtime) { bestMtime = mtime; best = candidate; }
  }
  return best;
}

function saveState(stateFile, payload) {
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
}

function loadState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

async function postLogin(client, config, captchaText) {
  const body = buildLoginBody(config, captchaText);
  const response = await client.request(config.loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': new URL(config.entryUrl).origin,
    },
    body,
    referer: config.entryUrl,
  });
  return response;
}

async function attemptCaptchaPhase(client, config, runDir, args) {
  const maxAttempts = args.autoSolve ? 3 : 1;
  let lastSolver = null;
  let lastResponse = null;
  let lastCaptchaPath = null;
  let lastState = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const captcha = await fetchCaptcha(client, config.captchaUrl, runDir, config.entryUrl);
    lastCaptchaPath = captcha.path;

    let captchaText = args.captcha;
    if (!captchaText && args.autoSolve) {
      lastSolver = await solveCaptchaVia2Captcha(captcha.path, config.solverApiKey);
      if (!lastSolver.ok) {
        return { ok: false, status: lastSolver.code, message: lastSolver.message, captchaPath: captcha.path, solver: lastSolver };
      }
      captchaText = lastSolver.text;
    }
    if (!captchaText) {
      return { ok: false, status: 'awaiting_captcha', message: 'CAPTCHA requerido (usa --auto-solve o pasa el texto).', captchaPath: captcha.path };
    }

    lastResponse = await postLogin(client, config, captchaText);
    lastState = detectPageState(lastResponse.text, lastResponse.url);

    if (lastState.impervaBlocked) {
      return { ok: false, status: 'imperva_blocked', message: 'Imperva bloqueo el POST de login.', captchaPath: captcha.path, page: lastState };
    }
    if (!lastState.captchaError) {
      return { ok: true, captchaPath: captcha.path, solver: lastSolver, response: lastResponse, state: lastState, attempts: attempt };
    }

    process.stderr.write(`[captcha] intento ${attempt}/${maxAttempts} fallo segun IMSS, recargando captcha\n`);
    if (attempt < maxAttempts && args.autoSolve) {
      await sleep(1500);
    } else if (!args.autoSolve) {
      break;
    }
  }

  return {
    ok: false,
    status: 'captcha_failed',
    message: `IMSS rechazo el CAPTCHA tras ${maxAttempts} intento(s).`,
    captchaPath: lastCaptchaPath,
    solver: lastSolver,
    response: lastResponse,
    state: lastState,
  };
}

async function postToken(client, tokenPageHtml, tokenPageUrl, smsToken) {
  const tokenFieldName = detectTokenFieldName(tokenPageHtml) || 'token';
  const form = findFormByInputName(tokenPageHtml, tokenFieldName);
  if (!form) {
    return { ok: false, status: 'token_field_not_found', message: `No se encontro el form que contiene el input "${tokenFieldName}".` };
  }
  const action = form.action ? new URL(form.action, tokenPageUrl).toString() : tokenPageUrl;
  const body = buildTokenBody(form.hiddenFields, tokenFieldName, smsToken);
  const response = await client.request(action, {
    method: form.method === 'GET' ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': new URL(tokenPageUrl).origin,
    },
    body,
    referer: tokenPageUrl,
  });
  return { ok: true, response, formInfo: { action, method: form.method, id: form.id, tokenFieldName } };
}

async function tryDownloadPdf(client, baseHtml, baseUrl, runDir, artifactsDir) {
  const candidates = findPdfDownloadUrl(baseHtml, baseUrl);
  const tried = [];
  for (const candidate of candidates) {
    let response;
    try {
      response = await client.request(candidate.url, {
        method: 'GET',
        headers: { 'Accept': 'application/pdf,*/*;q=0.8' },
        referer: baseUrl,
      });
    } catch (error) {
      tried.push({ ...candidate, error: error.message });
      continue;
    }
    const contentType = String(response.headers['content-type'] || '');
    const isPdf = isPdfBuffer(response.body);
    tried.push({
      ...candidate,
      statusCode: response.statusCode,
      contentType,
      bytes: response.body.length,
      magic: response.body.slice(0, 4).toString('latin1'),
      isPdf,
    });
    if (response.statusCode === 200 && isPdf) {
      const saved = savePdfBuffer(response.body, {
        url: candidate.url,
        status: 200,
        contentType,
        source: 'http_get',
      }, runDir, artifactsDir);
      return { ok: true, candidate, saved, tried };
    }
  }
  return { ok: false, tried };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (args.preflight) {
    const report = preflightReport();
    printJson(report);
    process.exitCode = report.issues.length ? 2 : 0;
    return;
  }

  const config = loadConfig();

  if (args.selfTest) {
    printJson({
      status: 'self_test_ok',
      transport: 'http-only',
      entryUrl: config.entryUrl,
      loginUrl: config.loginUrl,
      captchaUrl: config.captchaUrl,
      artifactsDir: config.artifactsDir,
      finalPdfName: finalPdfName(),
      autoSolveAvailable: Boolean(config.solverApiKey),
      nssSource: config.nssSource,
      curpSource: config.curpSource,
      emailSource: config.emailSource,
      phoneSource: config.phoneSource,
      solverKeySource: config.solverKeySource,
    });
    return;
  }

  if (!config.nss || !config.curp || !config.email || !config.phone) {
    printJson({
      status: 'config_missing',
      message: 'Faltan credenciales IMSS. Define IMSS_NSS, IMSS_CURP, IMSS_EMAIL e IMSS_PHONE.',
      env: {
        IMSS_NSS: config.nss ? 'set' : 'missing',
        IMSS_CURP: config.curp ? 'set' : 'missing',
        IMSS_EMAIL: config.email ? 'set' : 'missing',
        IMSS_PHONE: config.phone ? 'set' : 'missing',
        TWOCAPTCHA_API_KEY: config.solverApiKey ? 'set' : 'missing',
      },
    });
    process.exitCode = 2;
    return;
  }

  ensureDir(config.artifactsDir);
  const runDir = ensureDir(path.join(config.artifactsDir, `imss-semanas-run-${nowStamp()}`));

  // Phase 2 (token submission with persisted state) ---------------------------
  if (args.smsToken) {
    const stateFile = args.stateFile || findLatestStateFile(config.artifactsDir);
    if (!stateFile || !fs.existsSync(stateFile)) {
      printJson({
        status: 'state_missing',
        message: 'IMSS_SMS_TOKEN definido pero no se encontro el state.json de la fase 1. Vuelve a correr la fase 1 (sin token) primero.',
        artifactsDir: config.artifactsDir,
      });
      process.exitCode = 2;
      return;
    }
    let prevState;
    try { prevState = loadState(stateFile); } catch (error) {
      printJson({ status: 'state_corrupt', message: `No se pudo leer el state ${stateFile}: ${error.message}` });
      process.exitCode = 2;
      return;
    }

    const client = new SessionClient();
    client.importCookies(prevState.cookies || []);
    client.lastUrl = prevState.tokenPageUrl || config.loginUrl;

    // We may not have HTML anymore; fetch the LoginAsegurado page (it'll re-render the token form)
    let tokenPageHtml = prevState.tokenPageHtml || '';
    let tokenPageUrl = prevState.tokenPageUrl || config.loginUrl;
    if (!tokenPageHtml) {
      printJson({
        status: 'state_corrupt',
        message: 'state.json no contiene tokenPageHtml; reintenta la fase 1.',
        stateFile,
      });
      process.exitCode = 2;
      return;
    }

    const tokenSubmit = await postToken(client, tokenPageHtml, tokenPageUrl, args.smsToken);
    if (!tokenSubmit.ok) {
      printJson({ ...tokenSubmit, stateFile, runDir });
      process.exitCode = 1;
      return;
    }

    const reportResp = tokenSubmit.response;
    const reportState = detectPageState(reportResp.text, reportResp.url);
    const reportHtmlPath = path.join(runDir, 'after-token.html');
    fs.writeFileSync(reportHtmlPath, reportResp.body);

    if (reportState.tokenInvalid || reportState.tokenRequired) {
      printJson({
        status: 'token_invalid',
        message: 'IMSS rechazo el token SMS o sigue pidiendolo. Solicita un nuevo codigo.',
        stateFile,
        page: reportState,
        formInfo: tokenSubmit.formInfo,
        artifacts: { runDir, reportHtmlPath },
      });
      process.exitCode = 1;
      return;
    }

    const pdfAttempt = await tryDownloadPdf(client, reportResp.text, reportResp.url, runDir, config.artifactsDir);
    if (pdfAttempt.ok) {
      printJson({
        status: 'pdf_downloaded',
        message: 'Login + token + descarga exitosos.',
        pdfPath: pdfAttempt.saved.finalPath,
        pdfDeliverySafePath: pdfAttempt.saved.deliverySafePath,
        recommendedDeliveryPath: pdfAttempt.saved.deliverySafePath || pdfAttempt.saved.finalPath,
        pdfMeta: pdfAttempt.saved,
        candidate: pdfAttempt.candidate,
        triedCandidates: pdfAttempt.tried,
        formInfo: tokenSubmit.formInfo,
        page: reportState,
        artifacts: { runDir, reportHtmlPath, captchaPath: null },
        stateFile,
      });
      return;
    }

    printJson({
      status: 'pdf_unavailable',
      message: 'Token aceptado pero no se localizo el endpoint del PDF en el HTML resultante.',
      page: reportState,
      formInfo: tokenSubmit.formInfo,
      triedCandidates: pdfAttempt.tried,
      artifacts: { runDir, reportHtmlPath },
      stateFile,
    });
    process.exitCode = 1;
    return;
  }

  // Phase 1 (login + captcha) -------------------------------------------------
  const client = new SessionClient();

  // 1. Hit entry to receive cookies (Imperva + WebLogic)
  const entryResp = await client.request(config.entryUrl, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  if (entryResp.statusCode !== 200) {
    printJson({ status: 'entry_failed', message: `GET entry HTTP ${entryResp.statusCode}`, url: entryResp.url });
    process.exitCode = 1;
    return;
  }
  const entryState = detectPageState(entryResp.text, entryResp.url);
  if (entryState.impervaBlocked) {
    printJson({ status: 'imperva_blocked', message: 'Imperva bloqueo el GET inicial. Reintenta con otra IP / User-Agent.', page: entryState });
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.join(runDir, 'entry.html'), entryResp.body);

  // 2. Captcha + login (with retry on captcha errors)
  const captchaPhase = await attemptCaptchaPhase(client, config, runDir, args);
  if (!captchaPhase.ok) {
    printJson({
      status: captchaPhase.status,
      message: captchaPhase.message,
      captchaFile: captchaPhase.captchaPath,
      solver: captchaPhase.solver,
      page: captchaPhase.state,
      artifacts: { runDir },
    });
    process.exitCode = 1;
    return;
  }

  const loginResp = captchaPhase.response;
  const loginState = captchaPhase.state;
  fs.writeFileSync(path.join(runDir, 'after-login.html'), loginResp.body);

  if (loginState.blocked) {
    printJson({ status: 'blocked', message: 'IMSS bloqueo el acceso por intentos repetidos.', page: loginState, artifacts: { runDir } });
    process.exitCode = 1;
    return;
  }
  if (loginState.dailyLimitExceeded) {
    printJson({
      status: 'daily_limit_exceeded',
      message: `IMSS reporta: "${loginState.alertPreview}". Espera al dia siguiente para intentar de nuevo.`,
      page: loginState,
      artifacts: { runDir },
    });
    process.exitCode = 1;
    return;
  }
  if (loginState.credentialError) {
    printJson({
      status: 'credentials_rejected',
      message: 'IMSS rechazo CURP / NSS / correo. Verifica que IMSS_EMAIL coincida con el correo registrado para esa CURP.',
      page: loginState,
      artifacts: { runDir },
    });
    process.exitCode = 1;
    return;
  }

  if (loginState.tokenRequired) {
    // Save state for phase 2
    const stateFile = path.join(runDir, 'state.json');
    saveState(stateFile, {
      version: 1,
      createdAt: new Date().toISOString(),
      cookies: client.exportCookies(),
      tokenPageUrl: loginResp.url,
      tokenPageHtml: loginResp.text,
      phone: config.phone,
      curp: config.curp,
    });

    printJson({
      status: 'awaiting_sms_token',
      message: `IMSS envio un token por SMS al telefono ${config.phone}. Vuelve a correr con IMSS_SMS_TOKEN=<codigo> (o --sms-token=<codigo>).`,
      phone: config.phone,
      tokenPageUrl: loginResp.url,
      stateFile,
      captchaAttempts: captchaPhase.attempts,
      captchaSolver: captchaPhase.solver?.ok ? '2captcha' : 'manual',
      page: loginState,
      artifacts: { runDir },
    });
    return;
  }

  // No token required (rare? maybe already verified). Try to download PDF directly.
  const pdfAttempt = await tryDownloadPdf(client, loginResp.text, loginResp.url, runDir, config.artifactsDir);
  if (pdfAttempt.ok) {
    printJson({
      status: 'pdf_downloaded',
      message: 'Login exitoso sin paso de token; PDF descargado.',
      pdfPath: pdfAttempt.saved.finalPath,
      pdfDeliverySafePath: pdfAttempt.saved.deliverySafePath,
      recommendedDeliveryPath: pdfAttempt.saved.deliverySafePath || pdfAttempt.saved.finalPath,
      pdfMeta: pdfAttempt.saved,
      candidate: pdfAttempt.candidate,
      triedCandidates: pdfAttempt.tried,
      page: loginState,
      artifacts: { runDir },
    });
    return;
  }

  printJson({
    status: 'pdf_unavailable',
    message: 'Login exitoso, pero no se localizo el endpoint del PDF en el HTML resultante.',
    page: loginState,
    triedCandidates: pdfAttempt.tried,
    artifacts: { runDir },
  });
  process.exitCode = 1;
}

main().catch((error) => {
  printJson({ status: 'error', message: error.message, stack: error.stack });
  process.exitCode = 1;
});
