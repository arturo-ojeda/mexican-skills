#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');

const ARG_BYPASS_BROWSER = ['--preflight', '--self-test', '--help', '-h'];
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (error) {
  if (process.argv.some((arg) => ARG_BYPASS_BROWSER.includes(arg))) {
    chromium = null;
  } else {
    console.error('playwright-core no está instalado. Ejecuta:');
    console.error(`  cd ${SKILL_ROOT} && npm install`);
    process.exit(2);
  }
}

const PORTAL_URL = process.env.JALISCO_PORTAL_URL
  || 'https://gobiernoenlinea1.jalisco.gob.mx/serviciosVehiculares/adeudos';
const RECAPTCHA_SITEKEY = process.env.JALISCO_RECAPTCHA_SITEKEY
  || '6LehxCgfAAAAAE_6lvOTiXBtQNZCyc37CLZssnzC';
const CDP_PORT = process.env.JALISCO_CDP_PORT || '18830';
const CDP_URL = process.env.JALISCO_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
const ARTIFACTS = process.env.JALISCO_INFRACCIONES_ARTIFACTS_DIR || process.cwd();
const TIMEOUT = Number(process.env.JALISCO_TIMEOUT_MS || 60000);
const CHROME_PROFILE = process.env.JALISCO_CHROME_PROFILE
  || path.join(os.tmpdir(), 'jalisco-chrome-profile');
const CHROME_LOG = process.env.JALISCO_CHROME_LOG
  || path.join(os.tmpdir(), 'jalisco-chrome.log');
const SPAWN_CHROME = process.env.JALISCO_NO_SPAWN !== '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/google-chrome',
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    for (const dir of (process.env.PATH || '').split(':')) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        const fullPath = path.join(dir, name);
        if (fs.existsSync(fullPath)) return fullPath;
      }
    }
  }
  return '';
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
  return '';
}

function readShellVar(key) {
  for (const name of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) {
    const file = path.join(os.homedir(), name);
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const value = extractQuoted(line, key);
      if (value) return value;
    }
  }
  return '';
}

function parseCliArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(2, eq);
    args[key] = raw.slice(eq + 1);
  }
  return args;
}

function loadConfig({ allowMissing = false } = {}) {
  const cli = parseCliArgs(process.argv);
  const placa = (cli.placa || process.env.JALISCO_PLACA || '').trim().toUpperCase();
  const numeroSerie = (cli.serie || cli['numero-serie'] || process.env.JALISCO_NUMERO_SERIE || '').trim().toUpperCase();
  const propietario = (cli.propietario || process.env.JALISCO_PROPIETARIO || '').trim().toUpperCase();
  const numeroMotor = (cli.motor || cli['numero-motor'] || process.env.JALISCO_NUMERO_MOTOR || '').trim().toUpperCase();
  const solverKey = process.env.TWOCAPTCHA_API_KEY
    || process.env.CAPTCHA_SOLVER_API_KEY
    || readShellVar('TWOCAPTCHA_API_KEY')
    || readShellVar('CAPTCHA_SOLVER_API_KEY');
  const missing = [];
  if (!placa) missing.push('placa (--placa o JALISCO_PLACA)');
  if (!numeroSerie) missing.push('numeroSerie (--serie o JALISCO_NUMERO_SERIE)');
  if (!solverKey) missing.push('TWOCAPTCHA_API_KEY');
  if (missing.length && !allowMissing) {
    throw new Error(`Faltan datos requeridos: ${missing.join(', ')}.`);
  }
  return { placa, numeroSerie, propietario, numeroMotor, solverKey, missing };
}

function preflight() {
  const result = {
    status: 'ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    cdpUrl: CDP_URL,
    artifactsDir: ARTIFACTS,
    chromeBinary: defaultChromeBinary(),
    chromeBinaryExists: false,
    playwrightCoreInstalled: Boolean(chromium),
    portalUrl: PORTAL_URL,
    recaptchaSitekey: RECAPTCHA_SITEKEY,
    env: {},
    issues: [],
  };

  if (result.chromeBinary && fs.existsSync(result.chromeBinary)) {
    result.chromeBinaryExists = true;
  } else {
    result.issues.push('No se encontró Chrome. Define CHROME_BIN o instálalo en la ruta por defecto.');
  }

  if (!result.playwrightCoreInstalled) {
    result.issues.push(`playwright-core no está instalado. Ejecuta: cd ${SKILL_ROOT} && npm install`);
  }

  const config = loadConfig({ allowMissing: true });
  result.env.TWOCAPTCHA_API_KEY = config.solverKey ? 'set' : 'missing';
  result.env.JALISCO_PLACA = config.placa ? 'set' : 'missing';
  result.env.JALISCO_NUMERO_SERIE = config.numeroSerie ? 'set' : 'missing';
  result.env.JALISCO_PROPIETARIO = config.propietario ? 'set' : 'missing';
  result.env.JALISCO_NUMERO_MOTOR = config.numeroMotor ? 'set' : 'missing';
  if (!config.solverKey) {
    result.issues.push('TWOCAPTCHA_API_KEY faltante. Define en process.env o shell rc.');
  }

  result.status = result.issues.length ? 'preflight_failed' : 'preflight_ok';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.issues.length ? 2 : 0;
}

function selfTest() {
  const config = loadConfig({ allowMissing: true });
  const result = {
    status: 'self_test_ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    cdpUrl: CDP_URL,
    artifactsDir: ARTIFACTS,
    chromeBinary: defaultChromeBinary(),
    portalUrl: PORTAL_URL,
    recaptchaSitekey: RECAPTCHA_SITEKEY,
    chromeProfile: CHROME_PROFILE,
    chromeLog: CHROME_LOG,
    spawnChrome: SPAWN_CHROME,
    timeoutMs: TIMEOUT,
    config: {
      placa: config.placa ? `${config.placa.slice(0, 2)}***` : '',
      numeroSerie: config.numeroSerie ? `${config.numeroSerie.slice(0, 4)}***` : '',
      hasPropietario: Boolean(config.propietario),
      hasNumeroMotor: Boolean(config.numeroMotor),
      solverKey: config.solverKey ? 'set' : 'missing',
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

async function solveRecaptchaV2Invisible(apiKey, sitekey, pageurl, userAgent) {
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'userrecaptcha',
    googlekey: sitekey,
    pageurl,
    invisible: '1',
    json: '1',
  });
  if (userAgent) submitParams.set('userAgent', userAgent);
  const submit = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: submitParams,
  });
  const submitJson = await submit.json();
  if (submitJson.status !== 1) throw new Error(`2Captcha submit failed: ${submitJson.request}`);
  const pollUrl = new URL('https://2captcha.com/res.php');
  pollUrl.searchParams.set('key', apiKey);
  pollUrl.searchParams.set('action', 'get');
  pollUrl.searchParams.set('id', String(submitJson.request));
  pollUrl.searchParams.set('json', '1');
  for (let i = 0; i < 30; i += 1) {
    await sleep(i === 0 ? 15000 : 5000);
    const json = await (await fetch(pollUrl)).json();
    if (json.status === 1) return String(json.request || '').trim();
    if (json.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha poll failed: ${json.request}`);
  }
  throw new Error('2Captcha timed out resolving reCAPTCHA');
}

async function isCdpUp(url) {
  try {
    const response = await fetch(`${url}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureChromeCdp() {
  if (await isCdpUp(CDP_URL)) return { spawned: false, url: CDP_URL };
  if (!SPAWN_CHROME) {
    throw new Error(`Chrome CDP no responde en ${CDP_URL} y JALISCO_NO_SPAWN=1; arranca Chrome manualmente`);
  }
  const chromeBin = defaultChromeBinary();
  if (!chromeBin || !fs.existsSync(chromeBin)) {
    throw new Error('Chrome no encontrado. Define CHROME_BIN o instala Chrome/Chromium.');
  }
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const logFd = fs.openSync(CHROME_LOG, 'a');
  const proc = spawn(chromeBin, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: ['ignore', logFd, logFd] });
  proc.unref();
  for (let i = 0; i < 40; i += 1) {
    if (await isCdpUp(CDP_URL)) return { spawned: true, pid: proc.pid, url: CDP_URL, log: CHROME_LOG };
    await sleep(500);
  }
  throw new Error(`Chrome arrancó (pid ${proc.pid}) pero CDP no responde en ${CDP_URL} tras 20s. Log: ${CHROME_LOG}`);
}

async function fillFormField(page, selector, value) {
  if (!value) return;
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return;
  await loc.click({ timeout: 5000 }).catch(() => {});
  await loc.fill(value, { timeout: 5000 }).catch(async () => {
    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }, { sel: selector, val: value });
  });
}

async function extractResultadosFromHTML(page, rawHTML) {
  const evaluated = await page.evaluate(() => {
    const result = { rawTitle: document.title };
    const error = document.getElementById('error');
    if (error && error.textContent.trim()) result.errorBanner = error.textContent.trim();
    const msg = document.getElementById('msg-text');
    if (msg && msg.textContent.trim()) result.toast = msg.textContent.trim();

    const adeudos = [];
    document.querySelectorAll('table tbody tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim());
      if (cells.length) adeudos.push(cells);
    });
    if (adeudos.length) result.tableRows = adeudos;

    const anyText = document.body.innerText.replace(/\s+/g, ' ').trim();
    result.bodyDigest = anyText.slice(0, 4000);
    result.bodyLength = anyText.length;

    const pagar = Array.from(document.querySelectorAll('a, button')).filter((el) => /pagar|pago/i.test(el.innerText || el.value || ''));
    result.pagarLinks = pagar.slice(0, 10).map((el) => ({
      tag: el.tagName,
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim(),
      href: el.href || el.getAttribute('href') || '',
      onclick: el.getAttribute('onclick') || '',
      formAction: el.closest('form')?.action || '',
    }));

    const hasFrmAdeudos = Boolean(document.getElementById('frmAdeudos'));
    const hasFrmError = Boolean(document.getElementById('frmError'));
    const hasFrmPagos = Boolean(document.getElementById('frmPagos'));
    result.formsPresent = { frmAdeudos: hasFrmAdeudos, frmError: hasFrmError, frmPagos: hasFrmPagos };

    const recaptchaPresent = Boolean(document.querySelector('.g-recaptcha, [data-sitekey]'));
    result.recaptchaPresentOnResult = recaptchaPresent;

    return result;
  });

  // El portal renderiza distintos templates según el caso. Inferimos del DOM
  // y del HTML crudo (porque el body sólo trae innerText, no comentarios HTML).
  const rows = evaluated.tableRows || [];
  const txt = evaluated.bodyDigest || '';
  const html = rawHTML || '';
  const noAdeudosText = /no\s+tiene\s+adeudos/i.test(txt);
  const pendientesText = /pagos\s+pendientes\s+de\s+aplicar/i.test(txt);
  const isFrmAdeudosForm = evaluated.formsPresent.frmAdeudos && !evaluated.formsPresent.frmError && !rows.length;
  // Quirk del portal: el template "frmError" envuelve un alert "Información"
  // con el cuerpo `<div th:text="${msg}">` comentado en HTML, así que no
  // podemos leer el texto del mensaje. Cuando llegamos a esta página después
  // de un POST con captcha válido y los datos coinciden con un vehículo real,
  // la lectura más probable es "sin adeudos" (no hay tabla, no hay pagos
  // pendientes, no hay error banner).
  const isFrmErrorInfoEmpty = evaluated.formsPresent.frmError
    && /alert-info/.test(html)
    && /<strong>\s*Informaci[óo]n\s*<\/strong>/i.test(html)
    && !rows.length;

  if (rows.length) {
    evaluated.summaryHint = 'lista_adeudos';
  } else if (pendientesText) {
    evaluated.summaryHint = 'pagos_pendientes_de_aplicar';
  } else if (noAdeudosText) {
    evaluated.summaryHint = 'no_tiene_adeudos';
  } else if (isFrmErrorInfoEmpty) {
    evaluated.summaryHint = 'no_tiene_adeudos_probable';
    evaluated.summaryNote = 'El portal renderiza la plantilla `frmError` con alert "Información" y el body del mensaje comentado en HTML. Lectura más probable: el vehículo no tiene adeudos.';
  } else if (isFrmAdeudosForm) {
    evaluated.summaryHint = 'captcha_o_datos_rechazados';
    evaluated.summaryNote = 'El portal devolvió el formulario inicial. Probablemente el captcha falló o los datos no coincidieron con un vehículo registrado.';
  } else {
    evaluated.summaryHint = 'unknown';
  }

  return evaluated;
}

async function main() {
  if (process.argv.includes('--preflight')) {
    preflight();
    return;
  }
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const config = loadConfig();
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const runDir = path.join(ARTIFACTS, `jalisco-run-${nowStamp()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const cdpInfo = await ensureChromeCdp();
  if (cdpInfo.spawned) {
    process.stderr.write(`[chrome] arrancado en ${CDP_URL} (pid ${cdpInfo.pid}, log ${cdpInfo.log})\n`);
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: TIMEOUT });
  const context = await browser.newContext({ acceptDownloads: false });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();

  const investigation = { steps: [] };
  const cookiesLog = [];

  try {
    process.stderr.write('[1/5] Abriendo portal…\n');
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
    cookiesLog.push({ phase: 'after-initial-get', cookies: await context.cookies(PORTAL_URL) });
    await page.screenshot({ path: path.join(runDir, '01-form.png'), fullPage: true }).catch(() => {});

    process.stderr.write('[2/5] Llenando formulario…\n');
    await fillFormField(page, '#placa', config.placa);
    await fillFormField(page, '#numeroSerie', config.numeroSerie);
    if (config.propietario) await fillFormField(page, '#nombrePropietario', config.propietario);
    if (config.numeroMotor) await fillFormField(page, '#numeroMotor', config.numeroMotor);

    process.stderr.write('[3/5] Resolviendo reCAPTCHA v2 invisible vía 2Captcha (puede tardar 15-60s)…\n');
    const ua = await page.evaluate(() => navigator.userAgent);
    const startSolve = Date.now();
    let token = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        token = await solveRecaptchaV2Invisible(config.solverKey, RECAPTCHA_SITEKEY, PORTAL_URL, ua);
        break;
      } catch (err) {
        lastErr = err;
        process.stderr.write(`[3/5] Intento ${attempt} falló: ${err.message}. Reintentando…\n`);
        await sleep(2000);
      }
    }
    if (!token) throw lastErr || new Error('No se pudo resolver reCAPTCHA tras 3 intentos');
    const solveMs = Date.now() - startSolve;
    process.stderr.write(`[3/5] Token obtenido (${solveMs} ms, ${token.length} chars).\n`);

    process.stderr.write('[4/5] Inyectando token y enviando consulta…\n');
    await page.evaluate((t) => {
      let textarea = document.getElementById('g-recaptcha-response');
      if (!textarea) {
        textarea = document.createElement('textarea');
        textarea.id = 'g-recaptcha-response';
        textarea.name = 'g-recaptcha-response';
        textarea.style.display = 'none';
        document.body.appendChild(textarea);
      }
      textarea.value = t;
      if (typeof onSubmit === 'function') {
        onSubmit(t);
      } else {
        document.getElementById('frmAdeudos').submit();
      }
    }, token);

    await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.screenshot({ path: path.join(runDir, '02-resultado.png'), fullPage: true }).catch(() => {});
    cookiesLog.push({ phase: 'after-consulta-post', cookies: await context.cookies(PORTAL_URL) });

    process.stderr.write('[5/5] Parseando resultado…\n');
    const resultadoUrl = page.url();
    const resultadoHTML = await page.content();
    fs.writeFileSync(path.join(runDir, '02-resultado.html'), resultadoHTML);
    const resultado = await extractResultadosFromHTML(page, resultadoHTML);

    investigation.steps.push({
      step: 'consulta-con-captcha',
      url: resultadoUrl,
      summary: resultado.summaryHint,
      recaptchaPresentOnResult: resultado.recaptchaPresentOnResult,
      pagarLinksCount: resultado.pagarLinks.length,
    });

    let secondConsulta = null;
    try {
      process.stderr.write('[investigación] Probando segunda consulta sin captcha (mismo contexto)…\n');
      const secondHTML = await page.evaluate(async () => {
        const body = new URLSearchParams({
          origen: 'normal',
          accion: 'getAdeudos',
          placa: document.getElementById('placa')?.value || '',
          numeroSerie: document.getElementById('numeroSerie')?.value || '',
          nombrePropietario: document.getElementById('nombrePropietario')?.value || '',
          numeroMotor: document.getElementById('numeroMotor')?.value || '',
          'g-recaptcha-response': '',
        }).toString();
        const r = await fetch('/serviciosVehiculares/adeudos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          credentials: 'include',
        });
        return { status: r.status, contentType: r.headers.get('content-type'), body: (await r.text()).slice(0, 8000) };
      });
      secondConsulta = secondHTML;
      const looksLikeError = /captcha|recaptcha|valid[ae]r|robot/i.test(secondHTML.body);
      const looksLikeResult = /adeudos|infracci|placa|<table/i.test(secondHTML.body);
      investigation.steps.push({
        step: 'segunda-consulta-sin-captcha',
        httpStatus: secondHTML.status,
        contentType: secondHTML.contentType,
        looksLikeCaptchaBlock: looksLikeError,
        looksLikeResult,
        bodyPreview: secondHTML.body.slice(0, 500),
      });
    } catch (err) {
      investigation.steps.push({
        step: 'segunda-consulta-sin-captcha',
        error: err.message,
      });
    }

    cookiesLog.push({ phase: 'final', cookies: await context.cookies(PORTAL_URL) });
    fs.writeFileSync(path.join(runDir, 'cookies.json'), JSON.stringify(cookiesLog, null, 2));
    fs.writeFileSync(path.join(runDir, 'investigation.json'), JSON.stringify(investigation, null, 2));
    fs.writeFileSync(path.join(runDir, 'resultado.json'), JSON.stringify(resultado, null, 2));

    const finalOut = {
      status: 'ok',
      runDir,
      portal: resultadoUrl,
      summary: resultado.summaryHint,
      summaryNote: resultado.summaryNote || null,
      tableRows: resultado.tableRows || [],
      toast: resultado.toast || null,
      errorBanner: resultado.errorBanner || null,
      pagarLinks: resultado.pagarLinks,
      bodyDigest: resultado.bodyDigest,
      formsPresent: resultado.formsPresent,
      investigation,
      solveMs,
    };
    console.log(JSON.stringify(finalOut, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(runDir, 'error.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(runDir, 'error.json'), JSON.stringify({
      message: error.message,
      stack: error.stack,
    }, null, 2));
    console.log(JSON.stringify({ status: 'error', message: error.message, runDir }, null, 2));
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
