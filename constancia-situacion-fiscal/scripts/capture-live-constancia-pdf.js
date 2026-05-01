#!/usr/bin/env node

const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (error) {
  console.error('playwright-core no está instalado. Ejecuta:');
  console.error(`  cd ${SKILL_ROOT} && npm install`);
  process.exit(2);
}

const {
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PDF_PATH,
  PDF_TIMEOUT,
  clickGenerateAndCapturePdf,
  ensureDir,
  locateConstanciaFrame,
  nowStamp,
} = require('../sat-pdf-tools');

const DEFAULT_CDP_URL = process.env.SAT_CDP_URL || 'http://127.0.0.1:18800';
const DEFAULT_OPERATION_HINT = '/operacion/53027/';

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = {
    cdpUrl: DEFAULT_CDP_URL,
    pdfPath: DEFAULT_PDF_PATH,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    operationHint: DEFAULT_OPERATION_HINT,
    selfTest: false,
  };

  for (const arg of argv) {
    if (arg === '--self-test') out.selfTest = true;
    else if (arg.startsWith('--cdp-url=')) out.cdpUrl = arg.slice('--cdp-url='.length);
    else if (arg.startsWith('--pdf-path=')) out.pdfPath = arg.slice('--pdf-path='.length);
    else if (arg.startsWith('--artifacts-dir=')) out.artifactsDir = arg.slice('--artifacts-dir='.length);
    else if (arg.startsWith('--operation-hint=')) out.operationHint = arg.slice('--operation-hint='.length);
  }

  return out;
}

async function findOperationalPage(browser, operationHint) {
  const candidates = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      const score = Number(url.includes(operationHint)) + Number(/53027|ConsultaTramite|IdcSiat/i.test(url));
      candidates.push({ context, page, url, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.find((candidate) => candidate.score > 0) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    printJson({
      status: 'self_test_ok',
      cdpUrl: args.cdpUrl,
      pdfPath: args.pdfPath,
      artifactsDir: args.artifactsDir,
      operationHint: args.operationHint,
      pdfTimeoutMs: PDF_TIMEOUT,
    });
    return;
  }

  const runDir = ensureDir(path.join(args.artifactsDir, `constancia-live-capture-${nowStamp()}`));
  let browser;

  try {
    browser = await chromium.connectOverCDP(args.cdpUrl, { timeout: 30000 });
    const located = await findOperationalPage(browser, args.operationHint);
    if (!located) {
      printJson({
        status: 'operational_page_not_found',
        message: 'No encontré una página viva del trámite 53027 en la sesión CDP actual.',
        cdpUrl: args.cdpUrl,
        runDir,
      });
      process.exitCode = 3;
      return;
    }

    const { page } = located;
    const frame = await locateConstanciaFrame(page, 2);
    if (!frame) {
      printJson({
        status: 'frame_not_found',
        message: 'Sí encontré una página candidata, pero no apareció el frame del trámite.',
        cdpUrl: args.cdpUrl,
        runDir,
        pageUrl: page.url(),
      });
      process.exitCode = 4;
      return;
    }

    const pdf = await clickGenerateAndCapturePdf(page, frame, runDir, {
      pdfPath: args.pdfPath,
      artifactsDir: args.artifactsDir,
      pdfTimeout: PDF_TIMEOUT,
    });

    if (!pdf.ok) {
      printJson({
        status: 'pdf_not_captured',
        message: 'Se intentó disparar la generación desde una sesión viva, pero no cayó un PDF válido.',
        reason: pdf.reason,
        trigger: pdf.trigger || null,
        popupUrl: pdf.popupUrl || null,
        diagnostics: pdf.diagnostics || null,
        runDir,
        pageUrl: page.url(),
        frameUrl: frame.url(),
      });
      process.exitCode = 5;
      return;
    }

    printJson({
      status: 'pdf_downloaded',
      message: 'PDF real capturado desde una sesión CDP viva.',
      runDir,
      pageUrl: page.url(),
      frameUrl: frame.url(),
      pdfPath: pdf.response.finalPath,
      pdfCapturedPath: pdf.response.capturedPath,
      pdfMeta: pdf.response,
      trigger: pdf.trigger,
      popupUrl: pdf.popupUrl || null,
    });
  } catch (error) {
    printJson({
      status: 'error',
      message: error.message,
      cdpUrl: args.cdpUrl,
      runDir,
    });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main();
