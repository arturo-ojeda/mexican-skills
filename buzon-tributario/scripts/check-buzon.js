#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');

const ARG_BYPASS_BROWSER = ['--preflight', '--help', '-h'];
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

const CDP_PORT = process.env.SAT_CDP_PORT || '18800';
const CDP_URL = process.env.SAT_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
const START_URL = process.env.SAT_BUZON_START_URL || 'https://wwwmat.sat.gob.mx/personas/iniciar-sesion';
const LAUNCHER_URL = process.env.SAT_BUZON_LAUNCHER_URL || 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?url=/buzon&tipoLogeo=c&target=principal';
const ARTIFACTS = process.env.SAT_BUZON_ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts');
const TIMEOUT = Number(process.env.SAT_BUZON_TIMEOUT_MS || 60000);
const CHROME_PROFILE = process.env.SAT_CHROME_PROFILE || path.join(os.tmpdir(), 'sat-buzon-chrome-profile');
const CHROME_LOG = process.env.SAT_CHROME_LOG || path.join(os.tmpdir(), 'sat-buzon-chrome.log');
const SPAWN_CHROME = process.env.SAT_NO_SPAWN !== '1';

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

function profilePath() {
  if (process.env.MEXICAN_SKILLS_PROFILE) return process.env.MEXICAN_SKILLS_PROFILE;
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'mexican-skills', 'profile.json');
}

function readProfileField(key) {
  const file = profilePath();
  if (!fs.existsSync(file)) return '';
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const value = data && typeof data === 'object' ? data[key] : undefined;
    if (value === undefined || value === null || value === '') return '';
    return String(value);
  } catch {
    return '';
  }
}

function loadConfig({ allowMissing = false } = {}) {
  const rfc = process.env.SAT_RFC || readShellVar('SAT_RFC') || readProfileField('rfc');
  const password = process.env.SAT_PASSWORD || readShellVar('SAT_PASSWORD');
  const solverKey = process.env.TWOCAPTCHA_API_KEY
    || process.env.CAPTCHA_SOLVER_API_KEY
    || readShellVar('TWOCAPTCHA_API_KEY')
    || readShellVar('CAPTCHA_SOLVER_API_KEY');
  const rfcSource = process.env.SAT_RFC
    ? 'environment'
    : (readShellVar('SAT_RFC') ? 'shell-rc' : (readProfileField('rfc') ? profilePath() : 'missing'));
  const missing = [];
  if (!rfc) missing.push('SAT_RFC');
  if (!password) missing.push('SAT_PASSWORD');
  if (!solverKey) missing.push('TWOCAPTCHA_API_KEY');
  if (missing.length && !allowMissing) {
    throw new Error(`Faltan credenciales requeridas: ${missing.join(', ')}. SAT_RFC puede vivir en env, shell rc, o el profile (${profilePath()}). SAT_PASSWORD y TWOCAPTCHA_API_KEY siempre en env o shell rc — nunca en el profile.`);
  }
  return { rfc, password, solverKey, missing, rfcSource, profilePath: profilePath() };
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
  result.env.SAT_RFC = config.rfc ? 'set' : 'missing';
  result.env.SAT_PASSWORD = config.password ? 'set' : 'missing';
  result.env.TWOCAPTCHA_API_KEY = config.solverKey ? 'set' : 'missing';
  result.rfcSource = config.rfcSource;
  result.profilePath = config.profilePath;
  if (config.missing.length) {
    result.issues.push(`Variables faltantes: ${config.missing.join(', ')}. SAT_RFC también acepta el profile (${config.profilePath}); password y solver key siempre en env/shell.`);
  }

  result.status = result.issues.length ? 'preflight_failed' : 'preflight_ok';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.issues.length ? 2 : 0;
}

async function waitStable(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
}

async function findCaptchaLocator(page) {
  const selectors = [
    '#captchaImg',
    '#imgCaptcha',
    '#divCaptcha img',
    'label#divCaptcha img',
    'img[alt*="captcha" i]',
    'img[src*="captcha" i]',
    'img[id*="captcha" i]',
    'img[class*="captcha" i]',
    'img[src^="data:image/"]',
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const loc = frame.locator(selector).first();
      if (await loc.count()) return { loc, frame };
    }
  }
  return null;
}

async function fillField(scope, selectors, value) {
  for (const selector of selectors) {
    const loc = scope.locator(selector).first();
    if (!(await loc.count())) continue;
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill(value, { timeout: 3000 }).catch(async () => {
      await scope.evaluate(({ selector: sel, value: val }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, { selector, value });
    });
    return selector;
  }
  throw new Error(`Campo no encontrado: ${selectors[0]}`);
}

async function solveCaptchaVia2Captcha(imagePath, apiKey) {
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'base64',
    body: fs.readFileSync(imagePath).toString('base64'),
    json: '1',
    phrase: '0',
    regsense: '0',
    numeric: '0',
    min_len: '4',
    max_len: '10',
    language: '2',
  });
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
  for (let i = 0; i < 14; i += 1) {
    await sleep(i === 0 ? 7000 : 5000);
    const json = await (await fetch(pollUrl)).json();
    if (json.status === 1) return String(json.request || '').trim();
    if (json.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha poll failed: ${json.request}`);
  }
  throw new Error('2Captcha timed out');
}

async function discoverLoginUrl(page, runDir) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await waitStable(page);
  await page.screenshot({ path: path.join(runDir, '01-start.png'), fullPage: true }).catch(() => {});
  const startFrameSrc = await page.locator('#iframetoload').getAttribute('src').catch(() => null);
  const launcher = startFrameSrc ? new URL(startFrameSrc, page.url()).toString() : LAUNCHER_URL;
  await page.goto(launcher, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await waitStable(page);
  await page.screenshot({ path: path.join(runDir, '02-launcher.png'), fullPage: true }).catch(() => {});
}

async function collectState(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const items = await frame.evaluate(() => Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'))
      .slice(0, 250)
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        href: el.href || el.getAttribute('href') || '',
        id: el.id || '',
        cls: el.className || '',
      }))
      .filter((x) => x.text || x.href || x.id)
      .slice(0, 120)).catch(() => []);
    frames.push({ url: frame.url(), name: frame.name(), text: clean(text).slice(0, 6000), items });
  }
  return { url: page.url(), title: await page.title().catch(() => ''), frames };
}

function summarizeSection(section) {
  const frameText = section.state.frames.map((f) => f.text).filter(Boolean).join(' | ');
  let summary = clean(frameText);
  if (summary.length > 1500) summary = `${summary.slice(0, 1500)}…`;
  return { name: section.name, url: section.url, summary };
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
    throw new Error(`Chrome CDP no responde en ${CDP_URL} y SAT_NO_SPAWN=1; arranca Chrome manualmente`);
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

async function main() {
  if (process.argv.includes('--preflight')) {
    preflight();
    return;
  }

  const config = loadConfig();
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const runDir = path.join(ARTIFACTS, `sat-buzon-${nowStamp()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const cdpInfo = await ensureChromeCdp();
  if (cdpInfo.spawned) {
    process.stderr.write(`[chrome] arrancado en ${CDP_URL} (pid ${cdpInfo.pid}, log ${cdpInfo.log})\n`);
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: TIMEOUT });
  const context = await browser.newContext({ acceptDownloads: false });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();
  try {
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await discoverLoginUrl(page, runDir);
      await page.screenshot({ path: path.join(runDir, `03-login-${attempt}.png`), fullPage: true }).catch(() => {});
      const cap = await findCaptchaLocator(page);
      if (!cap) throw new Error('No se encontró imagen de CAPTCHA');
      const capPath = path.join(runDir, `captcha-${attempt}.png`);
      await cap.loc.screenshot({ path: capPath });
      const captcha = await solveCaptchaVia2Captcha(capPath, config.solverKey);
      await fillField(cap.frame, ['#rfc', 'input[name="rfc"]', 'input[id*="rfc" i]'], config.rfc);
      await fillField(cap.frame, ['#password', 'input[name="password"]', 'input[type="password"]'], config.password);
      await fillField(cap.frame, ['#userCaptcha', 'input[name="userCaptcha"]', 'input[id*="captcha" i][type="text"]'], captcha);
      await cap.frame.locator('#submit, button[type="submit"], input[type="submit"]').first().click({ timeout: 5000, noWaitAfter: true });
      await sleep(16000);
      await waitStable(page);
      await page.screenshot({ path: path.join(runDir, `04-after-submit-${attempt}.png`), fullPage: true }).catch(() => {});
      const snapshot = await collectState(page).catch(() => null);
      const text = snapshot?.frames?.map((f) => f.text).join(' ') || '';
      attempts.push({ attempt, url: page.url(), title: snapshot?.title || '', textPreview: clean(text).slice(0, 800) });
      if (!/Acceso por contraseña|RFC:|Captcha:/i.test(text)) break;
    }

    if (!page.url().includes('/buzon')) {
      await page.goto(LAUNCHER_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {});
      await waitStable(page);
      const src = await page.locator('#iframetoload').getAttribute('src').catch(() => null);
      if (src) {
        await page.goto(new URL(src, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {});
        await waitStable(page);
      }
    }
    await page.screenshot({ path: path.join(runDir, '04-after-login.png'), fullPage: true }).catch(() => {});
    const initial = await collectState(page);
    const sections = [];
    const sectionUrls = [
      ['mis-notificaciones', 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/'],
      ['mis-comunicados', 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/'],
      ['mis-documentos', 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-documentos/'],
    ];
    for (const [name, url] of sectionUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {});
      await waitStable(page);
      await sleep(3000);
      await page.screenshot({ path: path.join(runDir, `05-${name}.png`), fullPage: true }).catch(() => {});
      sections.push({ name, url: page.url(), state: await collectState(page) });
    }
    const result = {
      status: 'ok',
      runDir,
      attempts,
      initial,
      sections,
      summaries: sections.map(summarizeSection),
    };
    const stateFile = path.join(runDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ status: 'ok', runDir, stateFile, summaries: result.summaries }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(runDir, 'error.png'), fullPage: true }).catch(() => {});
    const state = await collectState(page).catch(() => null);
    const errorState = path.join(runDir, 'error-state.json');
    fs.writeFileSync(errorState, JSON.stringify({ error: error.message, state }, null, 2));
    console.log(JSON.stringify({ status: 'error', message: error.message, runDir, errorState }, null, 2));
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
