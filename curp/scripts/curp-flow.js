#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');

const {
  ensureDir,
  finalPdfName,
  deliverySafePdfName,
  isPdfBuffer,
  nowStamp,
  savePdfBuffer,
  sleep,
} = require('./curp-pdf-tools');

const DEFAULT_PUBLIC_START_URL = process.env.CURP_PUBLIC_START_URL || 'https://www.gob.mx/curp/';
const DEFAULT_RECAPTCHA_SITEKEY = process.env.CURP_RECAPTCHA_SITEKEY || '6Lfi0jcpAAAAAPfBiQkGzQR3gv8mDRkqPDHAy8hS';
const DEFAULT_ARTIFACTS_DIR = process.env.CURP_ARTIFACTS_DIR || process.cwd();
const DEFAULT_TIMEOUT = Number(process.env.CURP_TIMEOUT_MS || 60000);
const DEFAULT_PDF_TIMEOUT = Number(process.env.CURP_PDF_TIMEOUT_MS || 30000);
const DEFAULT_CHROME_PROFILE = process.env.CURP_CHROME_PROFILE || 'Default';
const DEFAULT_SESSION_NAME = process.env.CURP_SESSION_NAME || 'curp';
const DEFAULT_DOWNLOADS_DIR = process.env.CURP_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');
const AGENT_BROWSER_BIN = process.env.AGENT_BROWSER_BIN || 'agent-browser';

const CREDENTIAL_FILES = [
  path.join(os.homedir(), '.zshrc'),
  path.join(os.homedir(), '.zprofile'),
  path.join(os.homedir(), '.bashrc'),
  path.join(os.homedir(), '.bash_profile'),
  path.join(os.homedir(), '.profile'),
];

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
  const envCurp = process.env.CURP_VALUE || '';
  const envSolverKey = process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_SOLVER_API_KEY || '';
  const shellCurp = envCurp ? null : readShellVar('CURP_VALUE');
  const shellSolver = envSolverKey
    ? null
    : (readShellVar('TWOCAPTCHA_API_KEY') || readShellVar('CAPTCHA_SOLVER_API_KEY'));

  return {
    publicStartUrl: DEFAULT_PUBLIC_START_URL,
    recaptchaSitekey: DEFAULT_RECAPTCHA_SITEKEY,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    timeoutMs: DEFAULT_TIMEOUT,
    pdfTimeoutMs: DEFAULT_PDF_TIMEOUT,
    chromeProfile: DEFAULT_CHROME_PROFILE,
    sessionName: DEFAULT_SESSION_NAME,
    downloadsDir: DEFAULT_DOWNLOADS_DIR,
    curp: (envCurp || shellCurp?.value || '').trim().toUpperCase(),
    solverApiKey: envSolverKey || shellSolver?.value || '',
    curpSource: envCurp ? 'environment' : (shellCurp?.source || 'missing'),
    solverKeySource: envSolverKey ? 'environment' : (shellSolver?.source || null),
  };
}

function parseArgs(argv) {
  const out = {
    help: false,
    selfTest: false,
    preflight: false,
    headless: false,
    forceSolver: false,
    captcha: '',
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--preflight') out.preflight = true;
    else if (arg === '--headless') out.headless = true;
    else if (arg === '--force-solver' || arg === '--auto-solve') out.forceSolver = true;
    else if (arg.startsWith('--captcha=')) out.captcha = arg.slice('--captcha='.length).trim();
    else if (!arg.startsWith('--') && !out.captcha) out.captcha = String(arg).trim();
  }
  return out;
}

function usage() {
  return [
    'Uso: node scripts/curp-flow.js [TOKEN_RECAPTCHA] [--captcha=TOKEN] [--headless] [--force-solver] [--self-test] [--preflight] [--help]',
    '',
    'Modo default: Chrome headed con tu perfil real (--profile Default), captcha invisible resuelto por Google sin solver.',
    'Requiere que tu Chrome esté CERRADO durante el run (mismo user-data-dir).',
    '',
    'Modos alternativos:',
    '  --headless        Lanza Chrome headless. Implica usar 2Captcha.',
    '  --force-solver    Usa 2Captcha aunque corras headed (útil para testing).',
    '  TOKEN o --captcha=TOKEN  Usa un token Enterprise resuelto por fuera.',
    '',
    'Ejemplos:',
    '  node scripts/curp-flow.js --preflight',
    '  node scripts/curp-flow.js                  # default: headed + perfil real',
    '  node scripts/curp-flow.js --headless       # CI/no-UI: requiere 2Captcha',
  ].join('\n');
}

function isValidCurp(value) {
  return /^[A-ZÑ&]{4}\d{6}[HM][A-Z]{5}[0-9A-Z]\d$/i.test(String(value || '').trim());
}

function agentBrowserAvailable() {
  const probe = spawnSync(AGENT_BROWSER_BIN, ['--help'], { encoding: 'utf8' });
  return probe.status === 0 || probe.status === null
    ? Boolean((probe.stdout || '') + (probe.stderr || ''))
    : false;
}

function chromeProfileRoots() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'chromium'),
    ];
  }
  return [];
}

function chromeRunningWithProfile(_profileName) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const ps = spawnSync('pgrep', ['-fl', '(Google Chrome|google-chrome|chromium|chromium-browser).*--user-data-dir'], { encoding: 'utf8' });
  if (ps.error) return null;
  const text = ps.stdout || '';
  const roots = chromeProfileRoots();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const root of roots) {
      if (line.includes(`--user-data-dir=${root}`) || line.includes(`--user-data-dir="${root}`) || line.includes(`--user-data-dir='${root}`)) {
        return true;
      }
    }
  }
  return false;
}

function runAgentBrowser(args, { input, timeout, sessionFlags = [] } = {}) {
  const fullArgs = [...sessionFlags, ...args];
  const result = spawnSync(AGENT_BROWSER_BIN, fullArgs, {
    encoding: 'utf8',
    timeout: timeout || DEFAULT_TIMEOUT,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function makeAb(sessionFlags) {
  const call = (args, opts = {}) => {
    const result = runAgentBrowser(args, { ...opts, sessionFlags });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || result.error || '').toString().trim().slice(0, 500);
      throw new Error(`agent-browser ${args[0]} falló (status ${result.status}): ${detail}`);
    }
    return result.stdout;
  };
  return call;
}

function evalJsWith(ab) {
  return (expression, opts) => ab(['eval', expression], opts);
}

function evalJsonWith(ab) {
  const evalJs = evalJsWith(ab);
  return (expression, opts) => {
    const raw = evalJs(expression, opts).trim();
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { try { return JSON.parse(JSON.parse(raw)); } catch { return raw; } }
  };
}

async function solveRecaptchaEnterprise(sitekey, pageurl, apiKey) {
  if (!apiKey) {
    return { ok: false, code: 'solver_unavailable', message: 'TWOCAPTCHA_API_KEY no está configurada' };
  }

  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'userrecaptcha',
    googlekey: sitekey,
    pageurl,
    enterprise: '1',
    action: process.env.CURP_RECAPTCHA_ACTION || 'CONSULTA',
    min_score: process.env.CURP_RECAPTCHA_MIN_SCORE || '0.7',
    json: '1',
  });

  const submitResponse = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: submitParams,
  });
  const submitJson = await submitResponse.json();
  if (submitJson.status !== 1) {
    return { ok: false, code: 'solver_failed', message: `2Captcha submit falló: ${submitJson.request}` };
  }

  const id = String(submitJson.request);
  const pollUrl = new URL('https://2captcha.com/res.php');
  pollUrl.searchParams.set('key', apiKey);
  pollUrl.searchParams.set('action', 'get');
  pollUrl.searchParams.set('id', id);
  pollUrl.searchParams.set('json', '1');

  for (let attempt = 1; attempt <= 24; attempt += 1) {
    await sleep(attempt === 1 ? 15000 : 5000);
    const response = await fetch(pollUrl);
    const json = await response.json();
    if (json.status === 1) {
      return { ok: true, token: String(json.request || '').trim(), provider: '2captcha', requestId: id };
    }
    if (json.request !== 'CAPCHA_NOT_READY') {
      return { ok: false, code: 'solver_failed', message: `2Captcha poll falló: ${json.request}`, requestId: id };
    }
  }
  return { ok: false, code: 'solver_failed', message: '2Captcha agotó el tiempo de espera', requestId: id };
}

function patchGrecaptchaScript(token) {
  return `(() => {
    const TOKEN = ${JSON.stringify(token)};
    const fakeExecute = () => Promise.resolve(TOKEN);
    const ensure = () => {
      if (!window.grecaptcha) window.grecaptcha = {};
      if (!window.grecaptcha.enterprise) window.grecaptcha.enterprise = {};
      window.grecaptcha.enterprise.execute = fakeExecute;
      window.grecaptcha.enterprise.ready = (cb) => { try { cb && cb(); } catch (_) {} };
      window.grecaptcha.execute = fakeExecute;
      window.grecaptcha.ready = (cb) => { try { cb && cb(); } catch (_) {} };
    };
    ensure();
    setInterval(ensure, 250);
    return 'patched';
  })()`;
}

async function waitForSelector(evalJson, selector, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT);
  while (Date.now() < deadline) {
    const visible = evalJson(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const rect = el.getBoundingClientRect(); const style = window.getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; })()`);
    if (visible === true || visible === 'true') return true;
    await sleep(750);
  }
  return false;
}

async function pollDownloadHrefBase64(evalJson, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || DEFAULT_PDF_TIMEOUT);
  while (Date.now() < deadline) {
    const href = evalJson(`(() => { const el = document.getElementById('dwnldLnk'); return el ? (el.getAttribute('href') || '') : ''; })()`);
    if (typeof href === 'string' && href.startsWith('data:application/pdf;base64,')) {
      return href.slice('data:application/pdf;base64,'.length);
    }
    await sleep(200);
  }
  return null;
}

function readDownloadedFileBuffer(downloadsDir, since) {
  const candidates = ['curp.pdf', 'CURP.pdf'];
  for (const name of candidates) {
    const fullPath = path.join(downloadsDir, name);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (since && stat.mtimeMs < since - 2000) continue;
    return { buffer: fs.readFileSync(fullPath), source: 'downloads_filesystem', path: fullPath };
  }
  return null;
}

function readDiagnostics(evalJson) {
  return evalJson(`(() => {
    const out = {};
    out.url = location.href;
    out.title = document.title;
    out.bodyText = ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').trim().slice(0, 1200);
    const dl = document.getElementById('download');
    out.downloadButton = dl ? { exists: true, disabled: dl.disabled } : { exists: false };
    const lnk = document.getElementById('dwnldLnk');
    out.dwnldLnk = lnk ? { exists: true, hrefStart: (lnk.getAttribute('href')||'').slice(0,80) } : { exists: false };
    return out;
  })()`);
}

function preflightReport(args) {
  const config = loadConfig();
  const issues = [];
  const warnings = [];

  const browserOk = agentBrowserAvailable();
  if (!browserOk) {
    issues.push('agent-browser no está disponible en PATH. Instálalo o define AGENT_BROWSER_BIN.');
  }

  if (!config.curp) {
    issues.push('CURP_VALUE no está definida (env o shell rc).');
  } else if (!isValidCurp(config.curp)) {
    issues.push(`CURP_VALUE no respeta el formato esperado de 18 caracteres: "${config.curp}".`);
  }

  const willUseHeaded = !args.headless && !args.forceSolver && !args.captcha;
  const willUseSolver = args.headless || args.forceSolver;

  if (willUseHeaded) {
    const chromeBlocked = chromeRunningWithProfile(config.chromeProfile);
    if (chromeBlocked === true) {
      issues.push(`Chrome está corriendo con tu perfil "${config.chromeProfile}". Ciérralo antes de ejecutar el skill (chocan dos instancias del mismo user-data-dir).`);
    } else if (chromeBlocked === null) {
      warnings.push('No pude verificar si Chrome está corriendo con tu perfil; si el run falla al abrir, ciérralo y reintenta.');
    }
  }

  if (willUseSolver && !config.solverApiKey) {
    issues.push('TWOCAPTCHA_API_KEY no está definida (env o shell rc; requerida para --headless / --force-solver).');
  }

  return {
    status: issues.length ? 'preflight_failed' : 'preflight_ok',
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    platform: process.platform,
    publicStartUrl: config.publicStartUrl,
    recaptchaSitekey: config.recaptchaSitekey,
    artifactsDir: config.artifactsDir,
    chromeProfile: config.chromeProfile,
    sessionName: config.sessionName,
    downloadsDir: config.downloadsDir,
    agentBrowserBin: AGENT_BROWSER_BIN,
    agentBrowserAvailable: browserOk,
    mode: willUseHeaded ? 'headed_real_profile' : (willUseSolver ? 'headless_solver' : 'manual_token'),
    env: {
      CURP_VALUE: config.curp ? 'set' : 'missing',
      TWOCAPTCHA_API_KEY: config.solverApiKey ? 'set' : 'missing',
    },
    curpSource: config.curpSource,
    solverKeySource: config.solverKeySource,
    issues,
    warnings,
  };
}

async function runHeadedRealProfileFlow(config, args, runDir, basePayload) {
  const sessionFlags = ['--headed', '--profile', config.chromeProfile, '--session', config.sessionName];
  const ab = makeAb(sessionFlags);
  const evalJs = evalJsWith(ab);
  const evalJson = evalJsonWith(ab);

  const beforeShot = path.join(runDir, '01-form.png');
  const afterShot = path.join(runDir, '02-results.png');
  const downloadShot = path.join(runDir, '03-after-download.png');
  basePayload.mode = 'headed_real_profile';

  ab(['open', config.publicStartUrl], { timeout: Math.max(config.timeoutMs, 90000) });
  ab(['wait', '#curpinput'], { timeout: Math.max(config.timeoutMs, 120000) });
  ab(['fill', '#curpinput', config.curp]);
  try { ab(['screenshot', '--full', beforeShot]); } catch (_) {}
  basePayload.artifacts.formScreenshot = beforeShot;

  evalJs(`document.getElementById('searchButton').click(); 'submitted'`);

  const downloadVisible = await waitForSelector(evalJson, '#download', Math.max(config.timeoutMs, 60000));
  try { ab(['screenshot', '--full', afterShot]); } catch (_) {}
  basePayload.artifacts.resultsScreenshot = afterShot;

  if (!downloadVisible) {
    const diag = readDiagnostics(evalJson);
    return {
      ok: false,
      payload: {
        status: 'submitted_failed',
        message: 'Submit ejecutado pero no apareció el botón de descarga. Posible CURP inválida, score Enterprise bajo, o cambio en el sitio.',
        captchaSource: 'invisible_real_profile',
        diagnostics: diag,
      },
    };
  }

  const downloadStart = Date.now();
  evalJs(`document.getElementById('download').click(); 'download-clicked'`);

  const base64 = await pollDownloadHrefBase64(evalJson, config.pdfTimeoutMs);
  try { ab(['screenshot', '--full', downloadShot]); } catch (_) {}
  basePayload.artifacts.downloadScreenshot = downloadShot;

  if (base64) {
    const buffer = Buffer.from(base64, 'base64');
    if (isPdfBuffer(buffer)) {
      return { ok: true, buffer, source: 'dwnldlnk_href' };
    }
  }

  const fallback = readDownloadedFileBuffer(config.downloadsDir, downloadStart);
  if (fallback && isPdfBuffer(fallback.buffer)) {
    return { ok: true, buffer: fallback.buffer, source: fallback.source, fallbackPath: fallback.path };
  }

  const diag = readDiagnostics(evalJson);
  return {
    ok: false,
    payload: {
      status: 'pdf_unavailable',
      message: 'Click en descarga ejecutado pero no se capturó el PDF (ni del data URL ni del filesystem).',
      captchaSource: 'invisible_real_profile',
      diagnostics: diag,
    },
  };
}

async function runHeadlessSolverFlow(config, args, runDir, basePayload) {
  const sessionFlags = ['--session', config.sessionName];
  const ab = makeAb(sessionFlags);
  const evalJs = evalJsWith(ab);
  const evalJson = evalJsonWith(ab);

  const beforeShot = path.join(runDir, '01-form.png');
  const afterShot = path.join(runDir, '02-results.png');
  const downloadShot = path.join(runDir, '03-after-download.png');
  basePayload.mode = 'headless_solver';

  ab(['open', config.publicStartUrl], { timeout: Math.max(config.timeoutMs, 90000) });
  ab(['wait', '#curpinput'], { timeout: Math.max(config.timeoutMs, 120000) });
  ab(['fill', '#curpinput', config.curp]);
  try { ab(['screenshot', '--full', beforeShot]); } catch (_) {}
  basePayload.artifacts.formScreenshot = beforeShot;

  let captchaToken = args.captcha;
  let solver = null;
  if (!captchaToken) {
    solver = await solveRecaptchaEnterprise(config.recaptchaSitekey, config.publicStartUrl, config.solverApiKey);
    if (solver.ok) captchaToken = solver.token;
    else return { ok: false, payload: { status: solver.code === 'solver_unavailable' ? 'solver_unavailable' : 'solver_failed', message: solver.message, solver } };
  }

  evalJs(patchGrecaptchaScript(captchaToken));
  evalJs(`document.getElementById('searchButton').click(); 'submitted'`);

  const downloadVisible = await waitForSelector(evalJson, '#download', Math.max(config.timeoutMs, 60000));
  try { ab(['screenshot', '--full', afterShot]); } catch (_) {}
  basePayload.artifacts.resultsScreenshot = afterShot;

  if (!downloadVisible) {
    const diag = readDiagnostics(evalJson);
    return {
      ok: false,
      payload: {
        status: 'submitted_failed',
        message: 'Submit ejecutado pero no apareció el botón de descarga. Posible CURP inválida, score 2Captcha bajo, o cambio en el sitio.',
        captchaSource: solver?.ok ? '2captcha' : 'manual',
        solver,
        diagnostics: diag,
      },
    };
  }

  evalJs(`document.getElementById('download').click(); 'download-clicked'`);

  const base64 = await pollDownloadHrefBase64(evalJson, config.pdfTimeoutMs);
  try { ab(['screenshot', '--full', downloadShot]); } catch (_) {}
  basePayload.artifacts.downloadScreenshot = downloadShot;

  if (base64) {
    const buffer = Buffer.from(base64, 'base64');
    if (isPdfBuffer(buffer)) {
      return { ok: true, buffer, source: 'dwnldlnk_href', solver };
    }
  }

  const diag = readDiagnostics(evalJson);
  return {
    ok: false,
    payload: {
      status: 'pdf_unavailable',
      message: 'Click en descarga ejecutado pero el data URL del PDF no se materializó (típico cuando el score Enterprise del backend es muy bajo).',
      captchaSource: solver?.ok ? '2captcha' : 'manual',
      solver,
      diagnostics: diag,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (args.preflight) {
    const report = preflightReport(args);
    printJson(report);
    process.exitCode = report.issues.length ? 2 : 0;
    return;
  }

  const config = loadConfig();

  if (args.selfTest) {
    printJson({
      status: 'self_test_ok',
      publicStartUrl: config.publicStartUrl,
      recaptchaSitekey: config.recaptchaSitekey,
      artifactsDir: config.artifactsDir,
      chromeProfile: config.chromeProfile,
      sessionName: config.sessionName,
      downloadsDir: config.downloadsDir,
      finalPdfName: finalPdfName(),
      deliverySafePdfName: deliverySafePdfName(),
      mode: (!args.headless && !args.forceSolver && !args.captcha) ? 'headed_real_profile' : (args.headless || args.forceSolver ? 'headless_solver' : 'manual_token'),
      autoSolveAvailable: Boolean(config.solverApiKey),
      curpSource: config.curpSource,
      solverKeySource: config.solverKeySource,
    });
    return;
  }

  if (!config.curp || !isValidCurp(config.curp)) {
    printJson({
      status: 'config_missing',
      message: 'Falta CURP_VALUE válida (18 chars). Defínela en el entorno o en un archivo shell del usuario.',
      env: { CURP_VALUE: config.curp ? 'set' : 'missing' },
      curpSource: config.curpSource,
    });
    process.exitCode = 2;
    return;
  }

  if (!agentBrowserAvailable()) {
    printJson({
      status: 'agent_browser_unavailable',
      message: 'agent-browser no está disponible. Instálalo o define AGENT_BROWSER_BIN.',
      agentBrowserBin: AGENT_BROWSER_BIN,
    });
    process.exitCode = 2;
    return;
  }

  ensureDir(config.artifactsDir);
  const runDir = ensureDir(path.join(config.artifactsDir, `curp-run-${nowStamp()}`));

  const useHeaded = !args.headless && !args.forceSolver && !args.captcha;
  if (useHeaded) {
    const chromeBlocked = chromeRunningWithProfile(config.chromeProfile);
    if (chromeBlocked === true) {
      printJson({
        status: 'chrome_running_conflict',
        message: `Chrome ya está corriendo con tu perfil "${config.chromeProfile}". Ciérralo y reintenta, o usa --headless.`,
        chromeProfile: config.chromeProfile,
      });
      process.exitCode = 2;
      return;
    }
  }

  const basePayload = {
    publicStartUrl: config.publicStartUrl,
    recaptchaSitekey: config.recaptchaSitekey,
    chromeProfile: config.chromeProfile,
    sessionName: config.sessionName,
    curpSource: config.curpSource,
    solverKeySource: config.solverKeySource,
    artifacts: { runDir },
  };

  const closeSession = () => {
    runAgentBrowser(['close', '--all'], { sessionFlags: ['--session', config.sessionName] });
  };

  try {
    const result = useHeaded
      ? await runHeadedRealProfileFlow(config, args, runDir, basePayload)
      : await runHeadlessSolverFlow(config, args, runDir, basePayload);

    if (!result.ok) {
      printJson({ ...result.payload, ...basePayload });
      process.exitCode = 1;
      return;
    }

    const saved = savePdfBuffer(result.buffer, { source: result.source }, runDir, config.artifactsDir);
    printJson({
      status: 'pdf_downloaded',
      message: 'CURP descargada y validada (%PDF) correctamente.',
      pdfPath: saved.finalPath,
      pdfDeliverySafePath: saved.deliverySafePath,
      recommendedDeliveryPath: saved.deliverySafePath || saved.finalPath,
      pdfCapturedPath: saved.capturedPath,
      pdfMeta: saved,
      delivery: {
        preferredPath: saved.deliverySafePath || saved.finalPath,
        fallbackPath: saved.finalPath,
        bytes: saved.bytes,
      },
      captchaSource: basePayload.mode === 'headed_real_profile' ? 'invisible_real_profile' : (result.solver?.ok ? '2captcha' : 'manual'),
      solver: result.solver || null,
      ...basePayload,
    });
  } catch (error) {
    printJson({
      status: 'error',
      message: error.message,
      ...basePayload,
    });
    process.exitCode = 1;
  } finally {
    closeSession();
  }
}

main();
