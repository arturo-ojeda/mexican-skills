#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const {
  clickGenerateAndCapturePdf,
  ensureDir,
  finalPdfName,
  locateConstanciaFrame,
  sleep,
} = require('../sat-pdf-tools');

const DEFAULT_CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';
const DEFAULT_PUBLIC_START_URL = process.env.SAT_PUBLIC_START_URL || 'https://wwwmat.sat.gob.mx/aplicacion/53027/genera-tu-constancia-de-situacion-fiscal.';
const DEFAULT_LAUNCHER_URL = process.env.SAT_LAUNCHER_URL || 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?url=/operacion/53027/genera-tu-constancia-de-situacion-fiscal.&tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx';
const DEFAULT_PDF_PATH = process.env.SAT_PDF_PATH || '/PTSC/IdcSiat/IdcGeneraConstancia.jsf';
const DEFAULT_ARTIFACTS_DIR = process.env.SAT_ARTIFACTS_DIR || path.join(SKILL_ROOT, 'artifacts');
const DEFAULT_TIMEOUT = Number(process.env.SAT_TIMEOUT_MS || 30000);
const POST_LOGIN_TIMEOUT = Number(process.env.SAT_POST_LOGIN_TIMEOUT_MS || 60000);

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

function usage() {
  return [
    'Uso: node scripts/sat-flow.js [TEXTO_CAPTCHA] [--captcha=TEXTO] [--auto-solve] [--self-test] [--preflight] [--help]',
    '',
    'Ejemplos:',
    '  node scripts/sat-flow.js --preflight',
    '  node scripts/sat-flow.js --auto-solve',
    '  node scripts/sat-flow.js ABC123',
    '  node scripts/sat-flow.js --captcha=ABC123',
  ].join('\n');
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function summarizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function hasAny(text, needles) {
  const hay = String(text || '').toLowerCase();
  return needles.some((needle) => hay.includes(needle));
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

function loadConfig() {
  const envRfc = process.env.SAT_RFC || '';
  const envPassword = process.env.SAT_PASSWORD || '';
  const envSolverKey = process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY || '';
  const shellRfc = envRfc ? null : readShellVar('SAT_RFC');
  const shellPassword = envPassword ? null : readShellVar('SAT_PASSWORD');
  const shellSolver = envSolverKey
    ? null
    : (readShellVar('TWOCAPTCHA_API_KEY') || readShellVar('CAPTCHA_SOLVER_API_KEY'));

  return {
    cdpUrl: DEFAULT_CDP_URL,
    publicStartUrl: DEFAULT_PUBLIC_START_URL,
    launcherUrl: DEFAULT_LAUNCHER_URL,
    pdfPath: DEFAULT_PDF_PATH,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    rfc: envRfc || shellRfc?.value || '',
    password: envPassword || shellPassword?.value || '',
    solverApiKey: envSolverKey || shellSolver?.value || '',
    credentialSource: envRfc || envPassword
      ? 'environment'
      : (shellRfc?.source || shellPassword?.source || 'missing'),
    solverKeySource: envSolverKey ? 'environment' : (shellSolver?.source || null),
  };
}

function parseArgs(argv) {
  const out = {
    autoSolve: false,
    help: false,
    selfTest: false,
    preflight: false,
    captcha: '',
  };

  for (const arg of argv) {
    if (arg === '--auto-solve') out.autoSolve = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--preflight') out.preflight = true;
    else if (arg.startsWith('--captcha=')) out.captcha = arg.slice('--captcha='.length).trim();
    else if (!arg.startsWith('--') && !out.captcha) out.captcha = String(arg).trim();
  }

  return out;
}

async function urlOk(url) {
  try {
    const response = await fetch(`${url}/json/version`);
    if (!response.ok) return { ok: false, status: response.status };
    const json = await response.json();
    return { ok: true, browser: json.Browser, webSocketDebuggerUrl: json.webSocketDebuggerUrl };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listTargets(url) {
  const response = await fetch(`${url}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}`);
  return response.json();
}

async function closeTarget(url, targetId) {
  const response = await fetch(`${url}/json/close/${targetId}`);
  if (!response.ok) throw new Error(`CDP close target ${targetId} failed with HTTP ${response.status}`);
  return response.text();
}

async function cleanupStaleTargets(url) {
  const targets = await listTargets(url);
  const pageTargets = targets.filter((target) => target.type === 'page');
  const closable = pageTargets.filter((target) => {
    const targetUrl = String(target.url || '');
    return targetUrl && !/^about:blank$/i.test(targetUrl);
  });

  const closed = [];
  for (const target of closable) {
    await closeTarget(url, target.id).catch(() => {});
    closed.push({ id: target.id, title: target.title, url: target.url });
  }

  return { closed, totalPages: pageTargets.length };
}

async function connectBrowserWithRecovery(url) {
  try {
    const browser = await chromium.connectOverCDP(url, { timeout: DEFAULT_TIMEOUT });
    return { browser, recovered: false, cleanup: null };
  } catch (error) {
    const cleanup = await cleanupStaleTargets(url).catch((cleanupError) => ({ error: cleanupError.message, closed: [] }));
    if (!cleanup?.closed?.length) throw new Error(error.message);
    await sleep(1000);
    const browser = await chromium.connectOverCDP(url, { timeout: DEFAULT_TIMEOUT });
    return { browser, recovered: true, cleanup, initialError: error.message };
  }
}

async function solveCaptchaVia2Captcha(imagePath, apiKey) {
  if (!apiKey) {
    return { ok: false, code: 'solver_unavailable', message: 'TWOCAPTCHA_API_KEY no está configurada' };
  }

  const base64Body = fs.readFileSync(imagePath).toString('base64');
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'base64',
    body: base64Body,
    json: '1',
    phrase: '0',
    regsense: '0',
    numeric: '0',
    min_len: '4',
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

  return { ok: false, code: 'solver_failed', message: '2Captcha agotó el tiempo de espera', requestId: id };
}

async function newCleanPage(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await context.setDefaultTimeout(DEFAULT_TIMEOUT);
  await context.clearCookies().catch(() => {});
  const cdpSession = await context.newCDPSession(page).catch(() => null);
  if (cdpSession) {
    await cdpSession.send('Network.clearBrowserCookies').catch(() => {});
    await cdpSession.detach().catch(() => {});
  }
  return { context, page };
}

async function waitForStable(page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT });
  } catch {}
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {}
}

async function takePageScreenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  return filePath;
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

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) return locator;
  }
  return null;
}

async function extractPageState(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const title = await page.title().catch(() => '');
  const url = page.url();

  const blocked = hasAny(bodyText, [
    'problema con tu autenticación',
    'problema con tu autenticacion',
    'acceso bloqueado',
    'demasiados intentos',
    'inténtalo más tarde',
    'intentalo mas tarde',
  ]);

  const failed = hasAny(bodyText, [
    'captcha incorrecto',
    'captcha no válido',
    'captcha no valido',
    'contraseña incorrecta',
    'password incorrect',
    'error',
    'inválido',
    'invalido',
  ]);

  return {
    url,
    title,
    blocked,
    failed,
    bodyPreview: summarizeText(bodyText),
    bodyText,
  };
}

async function fillField(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;

    await locator.click({ timeout: 3000 }).catch(() => {});
    await locator.fill(value, { timeout: 3000 }).catch(async () => {
      await page.evaluate(({ innerSelector, innerValue }) => {
        const element = document.querySelector(innerSelector);
        if (!element) return;
        element.focus();
        element.value = innerValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
      }, { innerSelector: selector, innerValue: value });
    });
    return selector;
  }
  throw new Error(`Campo requerido no encontrado: ${selectors[0]}`);
}

async function fillLoginForm(page, credentials, captchaText) {
  const rfcSelector = await fillField(page, ['#rfc', 'input[name="rfc"]', 'input[id*="rfc" i]'], credentials.rfc);
  const passwordSelector = await fillField(page, ['#password', 'input[name="password"]', 'input[type="password"]'], credentials.password);
  const captchaSelector = await fillField(page, ['#userCaptcha', 'input[name="userCaptcha"]', 'input[id*="captcha" i][type="text"]'], captchaText);
  return { rfcSelector, passwordSelector, captchaSelector };
}

async function resolvePublicEntrypoint(page, config) {
  await page.goto(config.publicStartUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
  await waitForStable(page);

  const executeHref = await page.locator('a.actionButton').getAttribute('href').catch(() => null);
  if (executeHref) {
    return {
      publicStartUrl: page.url(),
      launcherUrl: new URL(executeHref, page.url()).toString(),
      source: 'public-page',
    };
  }

  await page.goto(config.launcherUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
  await waitForStable(page);
  return {
    publicStartUrl: config.publicStartUrl,
    launcherUrl: page.url(),
    source: 'direct-launcher-fallback',
  };
}

async function discoverLoginLauncher(page) {
  const iframeSrc = await page.locator('#iframetoload').getAttribute('src').catch(() => null);
  if (iframeSrc) return new URL(iframeSrc, page.url()).toString();
  return page.url();
}

async function submitLogin(page) {
  const beforeUrl = page.url();
  const candidates = ['#submit', 'button[type="submit"]', 'input[type="submit"]'];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;
    await locator.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
    break;
  }

  for (let i = 0; i < 12; i += 1) {
    await sleep(2500);
    if (page.url() !== beforeUrl && page.url().includes('/operacion/53027/')) {
      return { trigger: 'submit', redirected: true };
    }
  }

  return { trigger: 'submit', redirected: page.url() !== beforeUrl };
}

async function waitForOperationalPage(page) {
  const deadline = Date.now() + POST_LOGIN_TIMEOUT;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    await sleep(2000);
    lastUrl = page.url();
    if (lastUrl.includes('/operacion/53027/')) {
      await waitForStable(page);
      return { ok: true, url: lastUrl };
    }
  }

  return { ok: false, url: lastUrl };
}

function preflightReport() {
  const config = loadConfig();
  const chromeBin = defaultChromeBinary();
  const issues = [];

  if (!chromium) issues.push(`playwright-core no está instalado. Ejecuta: cd ${SKILL_ROOT} && npm install`);
  if (!chromeBin) issues.push('No se encontró Chrome. Define CHROME_BIN o instálalo.');
  else if (!fs.existsSync(chromeBin)) issues.push(`CHROME_BIN apunta a una ruta inexistente: ${chromeBin}`);
  if (!config.rfc) issues.push('SAT_RFC no está definida.');
  if (!config.password) issues.push('SAT_PASSWORD no está definida.');
  if (!config.solverApiKey) issues.push('TWOCAPTCHA_API_KEY no está definida (se requiere para --auto-solve).');

  return {
    status: issues.length ? 'preflight_failed' : 'preflight_ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    cdpUrl: config.cdpUrl,
    artifactsDir: config.artifactsDir,
    chromeBinary: chromeBin,
    chromeBinaryExists: Boolean(chromeBin && fs.existsSync(chromeBin)),
    playwrightCoreInstalled: Boolean(chromium),
    env: {
      SAT_RFC: config.rfc ? 'set' : 'missing',
      SAT_PASSWORD: config.password ? 'set' : 'missing',
      TWOCAPTCHA_API_KEY: config.solverApiKey ? 'set' : 'missing',
    },
    credentialSource: config.credentialSource,
    solverKeySource: config.solverKeySource,
    issues,
  };
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
      cdpUrl: config.cdpUrl,
      publicStartUrl: config.publicStartUrl,
      launcherUrl: config.launcherUrl,
      pdfPath: config.pdfPath,
      autoSolveAvailable: Boolean(config.solverApiKey),
      artifactsDir: config.artifactsDir,
      finalPdfName: finalPdfName(),
      credentialSource: config.credentialSource,
      solverKeySource: config.solverKeySource,
    });
    return;
  }

  if (!config.rfc || !config.password) {
    printJson({
      status: 'config_missing',
      message: 'Faltan credenciales SAT. Define SAT_RFC y SAT_PASSWORD en el entorno o en un archivo shell del usuario.',
      env: {
        SAT_RFC: config.rfc ? 'set' : 'missing',
        SAT_PASSWORD: config.password ? 'set' : 'missing',
        TWOCAPTCHA_API_KEY: config.solverApiKey ? 'set' : 'missing',
      },
    });
    process.exitCode = 2;
    return;
  }

  ensureDir(config.artifactsDir);

  const cdp = await urlOk(config.cdpUrl);
  if (!cdp.ok) {
    printJson({
      status: 'cdp_unavailable',
      cdpUrl: config.cdpUrl,
      message: 'Chrome CDP no está respondiendo en el endpoint configurado',
      details: cdp,
    });
    process.exitCode = 2;
    return;
  }

  const runDir = ensureDir(path.join(config.artifactsDir, `constancia-run-${nowStamp()}`));
  const pageShot = path.join(runDir, '01-public-start.png');
  const loginShot = path.join(runDir, '02-login.png');
  const captchaShot = path.join(runDir, 'captcha.png');
  const afterSubmitShot = path.join(runDir, '03-after-submit.png');
  const frameShot = path.join(runDir, '04-frame.png');

  let browser;
  let context;
  let page;
  let connectionMeta = { recovered: false, cleanup: null };

  try {
    try {
      const connected = await connectBrowserWithRecovery(config.cdpUrl);
      browser = connected.browser;
      connectionMeta = connected;
    } catch (error) {
      printJson({
        status: 'cdp_unavailable',
        message: 'Chrome CDP respondió al probe HTTP pero no aceptó una sesión usable de Playwright.',
        cdpUrl: config.cdpUrl,
        details: error.message,
      });
      process.exitCode = 2;
      return;
    }

    ({ context, page } = await newCleanPage(browser));

    const entry = await resolvePublicEntrypoint(page, config);
    await takePageScreenshot(page, pageShot);

    await page.goto(entry.launcherUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
    await waitForStable(page);
    const loginLauncherUrl = await discoverLoginLauncher(page);

    await page.goto(loginLauncherUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
    await waitForStable(page);
    await takePageScreenshot(page, loginShot);

    const captchaLocator = await findCaptchaLocator(page);
    if (!captchaLocator) {
      const state = await extractPageState(page);
      printJson({
        status: 'submitted_unknown',
        message: 'Cargó la página de login pero no se encontró la imagen del CAPTCHA',
        artifacts: { runDir, pageScreenshot: pageShot, loginScreenshot: loginShot },
        entry,
        loginLauncherUrl,
        page: { url: state.url, title: state.title, bodyPreview: state.bodyPreview },
      });
      return;
    }

    await captchaLocator.screenshot({ path: captchaShot });

    let captchaText = args.captcha;
    let solver = null;

    if (!captchaText && args.autoSolve) {
      solver = await solveCaptchaVia2Captcha(captchaShot, config.solverApiKey);
      if (solver.ok) {
        captchaText = solver.text;
      } else if (solver.code === 'solver_unavailable') {
        printJson({
          status: 'solver_unavailable',
          message: solver.message,
          captchaFile: captchaShot,
          artifacts: { runDir, pageScreenshot: pageShot, loginScreenshot: loginShot },
          entry,
          loginLauncherUrl,
        });
        return;
      } else {
        printJson({
          status: 'solver_failed',
          message: solver.message,
          captchaFile: captchaShot,
          artifacts: { runDir, pageScreenshot: pageShot, loginScreenshot: loginShot },
          solver,
          entry,
          loginLauncherUrl,
        });
        return;
      }
    }

    if (!captchaText) {
      printJson({
        status: 'awaiting_captcha',
        message: 'CAPTCHA requerido. Vuelve a ejecutar agregando el texto como argumento o usa --auto-solve.',
        captchaFile: captchaShot,
        artifacts: { runDir, pageScreenshot: pageShot, loginScreenshot: loginShot },
        entry,
        loginLauncherUrl,
      });
      return;
    }

    const filled = await fillLoginForm(page, config, captchaText);
    const submitMeta = await submitLogin(page);
    const opResult = await waitForOperationalPage(page);
    await takePageScreenshot(page, afterSubmitShot);

    const state = await extractPageState(page);
    const basePayload = {
      captchaFile: captchaShot,
      captchaSource: solver?.ok ? '2captcha' : 'manual',
      solver,
      credentialSource: config.credentialSource,
      filled,
      entry,
      loginLauncherUrl,
      submitMeta,
      artifacts: {
        runDir,
        pageScreenshot: pageShot,
        loginScreenshot: loginShot,
        afterSubmitScreenshot: afterSubmitShot,
      },
      cdpRecovery: connectionMeta.recovered ? connectionMeta.cleanup : null,
      page: {
        url: state.url,
        title: state.title,
        bodyPreview: state.bodyPreview,
      },
    };

    if (state.blocked) {
      printJson({ status: 'blocked', message: 'SAT bloqueó o frenó el acceso tras el intento.', ...basePayload });
      return;
    }

    if (!opResult.ok && state.failed) {
      printJson({ status: 'submitted_failed', message: 'El envío ocurrió pero SAT mostró error o rechazo.', ...basePayload });
      return;
    }

    if (!opResult.ok) {
      printJson({ status: 'submitted_unknown', message: 'Se envió el formulario, pero no se alcanzó el trámite operativo esperado.', ...basePayload });
      return;
    }

    const frame = await locateConstanciaFrame(page);
    if (!frame) {
      printJson({
        status: 'pdf_unavailable',
        message: 'Login exitoso, pero no se encontró el frame del trámite de constancia.',
        ...basePayload,
      });
      return;
    }

    await frame.locator('body').screenshot({ path: frameShot }).catch(() => {});
    basePayload.artifacts.frameScreenshot = frameShot;
    basePayload.frame = { url: frame.url(), name: frame.name() || 'iframetoload' };

    const pdfResult = await clickGenerateAndCapturePdf(page, frame, runDir, config);
    if (pdfResult.ok) {
      printJson({
        status: 'pdf_downloaded',
        message: 'Login exitoso, se volvió al trámite correcto, se entró al frame correcto y se descargó el PDF real.',
        pdfPath: pdfResult.response.finalPath,
        pdfDeliverySafePath: pdfResult.response.deliverySafePath,
        recommendedDeliveryPath: pdfResult.response.deliverySafePath || pdfResult.response.finalPath,
        pdfCapturedPath: pdfResult.response.capturedPath,
        pdfTrigger: pdfResult.trigger,
        pdfMeta: pdfResult.response,
        popupUrl: pdfResult.popupUrl,
        delivery: {
          preferredPath: pdfResult.response.deliverySafePath || pdfResult.response.finalPath,
          fallbackPath: pdfResult.response.finalPath,
          bytes: pdfResult.response.bytes,
        },
        ...basePayload,
      });
      return;
    }

    printJson({
      status: 'pdf_unavailable',
      message: 'Login exitoso y frame localizado, pero no se pudo capturar la respuesta PDF en este intento.',
      pdfReason: pdfResult.reason,
      pdfTrigger: pdfResult.trigger || null,
      popupUrl: pdfResult.popupUrl || null,
      pdfDiagnostics: pdfResult.diagnostics || null,
      ...basePayload,
    });
  } catch (error) {
    printJson({
      status: 'error',
      message: error.message,
      cdpUrl: config.cdpUrl,
      publicStartUrl: config.publicStartUrl,
      launcherUrl: config.launcherUrl,
      artifacts: { runDir },
    });
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main();
