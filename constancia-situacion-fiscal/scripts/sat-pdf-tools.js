const fs = require('fs');
const path = require('path');

const DEFAULT_ARTIFACTS_DIR = process.env.SAT_ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts');
const DEFAULT_PDF_PATH = process.env.SAT_PDF_PATH || '/PTSC/IdcSiat/IdcGeneraConstancia.jsf';
const PDF_TIMEOUT = Number(process.env.SAT_PDF_TIMEOUT_MS || 30000);
const PDF_NAME_PREFIX = process.env.SAT_PDF_NAME_PREFIX || 'Constancia';
const PDF_NAME_SLUG = process.env.SAT_PDF_NAME_SLUG || 'constancia-situacion-fiscal';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function currentDateLabel() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return formatter.format(new Date()).replace(/\//g, '-');
}

function finalPdfName() {
  return `${PDF_NAME_PREFIX} ${currentDateLabel()}.pdf`;
}

function deliverySafePdfName() {
  return `${PDF_NAME_SLUG}-${currentDateLabel()}.pdf`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isPdfBuffer(body) {
  return Boolean(body && body.length >= 4 && body.slice(0, 4).toString('latin1') === '%PDF');
}

function savePdfBuffer(body, meta = {}, runDir, artifactsDir = DEFAULT_ARTIFACTS_DIR) {
  if (!isPdfBuffer(body)) return null;
  ensureDir(runDir);
  ensureDir(artifactsDir);

  const capturedPath = path.join(runDir, `constancia-raw-${nowStamp()}.pdf`);
  fs.writeFileSync(capturedPath, body);

  const finalPath = path.join(artifactsDir, finalPdfName());
  fs.copyFileSync(capturedPath, finalPath);

  const deliverySafePath = path.join(artifactsDir, deliverySafePdfName());
  if (deliverySafePath !== finalPath) {
    fs.copyFileSync(capturedPath, deliverySafePath);
  }

  return {
    capturedPath,
    finalPath,
    deliverySafePath,
    fileName: path.basename(finalPath),
    deliverySafeFileName: path.basename(deliverySafePath),
    url: meta.url || null,
    status: meta.status ?? null,
    contentType: String(meta.contentType || ''),
    bytes: body.length,
    magic: body.slice(0, 4).toString('latin1'),
    source: meta.source || 'unknown',
    requestId: meta.requestId || null,
    frameUrl: meta.frameUrl || null,
  };
}

async function capturePdfFromResponse(response, runDir, artifactsDir = DEFAULT_ARTIFACTS_DIR) {
  const url = response.url();
  const headers = await response.allHeaders().catch(() => ({}));
  const body = await response.body().catch(() => null);
  return savePdfBuffer(body, {
    url,
    status: response.status(),
    contentType: headers['content-type'] || '',
    source: 'playwright_response',
  }, runDir, artifactsDir);
}

async function capturePdfFromUrl(url, context, runDir, artifactsDir = DEFAULT_ARTIFACTS_DIR) {
  try {
    const response = await context.request.get(url, { timeout: PDF_TIMEOUT });
    const headers = await response.allHeaders().catch(() => ({}));
    const body = await response.body().catch(() => null);
    return savePdfBuffer(body, {
      url,
      status: response.status(),
      contentType: headers['content-type'] || '',
      source: 'context_request',
    }, runDir, artifactsDir);
  } catch {
    return null;
  }
}

async function attachNetworkPdfCapture(context, page, { pdfPath = DEFAULT_PDF_PATH, runDir, artifactsDir = DEFAULT_ARTIFACTS_DIR, timeout = PDF_TIMEOUT } = {}) {
  const pending = new Map();
  const settled = { done: false };
  let cleanup = () => {};

  const resultPromise = new Promise(async (resolve) => {
    const timer = setTimeout(async () => {
      if (!settled.done) {
        settled.done = true;
        cleanup();
        resolve(null);
      }
    }, timeout);

    const finish = async (saved) => {
      if (settled.done || !saved) return;
      settled.done = true;
      clearTimeout(timer);
      cleanup();
      resolve(saved);
    };

    const sessions = new Set();
    const pageToSession = new Map();

    const wireSession = async (targetPage) => {
      if (!targetPage || pageToSession.has(targetPage)) return;
      const session = await context.newCDPSession(targetPage).catch(() => null);
      if (!session) return;
      sessions.add(session);
      pageToSession.set(targetPage, session);

      await session.send('Network.enable').catch(() => {});

      session.on('Network.responseReceived', (event) => {
        const responseUrl = String(event.response?.url || '');
        if (!responseUrl.includes(pdfPath)) return;
        pending.set(event.requestId, {
          url: responseUrl,
          status: event.response?.status || null,
          contentType: event.response?.mimeType || event.response?.headers?.['content-type'] || '',
          frameUrl: targetPage.url(),
        });
      });

      session.on('Network.loadingFinished', async (event) => {
        if (!pending.has(event.requestId)) return;
        const meta = pending.get(event.requestId);
        pending.delete(event.requestId);
        try {
          const bodyResult = await session.send('Network.getResponseBody', { requestId: event.requestId });
          const body = bodyResult.base64Encoded ? Buffer.from(bodyResult.body, 'base64') : Buffer.from(bodyResult.body, 'utf8');
          const saved = savePdfBuffer(body, {
            ...meta,
            source: 'cdp_network',
            requestId: event.requestId,
          }, runDir, artifactsDir);
          await finish(saved);
        } catch {}
      });
    };

    await wireSession(page);
    context.on('page', wireSession);

    cleanup = () => {
      context.off('page', wireSession);
      for (const session of sessions) session.detach().catch(() => {});
    };
  });

  return {
    resultPromise,
    cleanup: () => cleanup(),
  };
}

async function locateConstanciaFrame(page, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const namedFrame = page.frame({ name: 'iframetoload' });
    if (namedFrame && /ConsultaTramite|IdcSiat|53027/i.test(namedFrame.url())) return namedFrame;

    const frames = page.frames();
    const matched = frames.find((frame) => /ConsultaTramite|IdcSiat|53027/i.test(frame.url()));
    if (matched) return matched;

    await sleep(1500);
  }

  return null;
}

async function waitForGenerateButton(frame) {
  const selectors = [
    '#formReimpAcuse\\:j_idt50',
    'button[id*="j_idt50"]',
    'input[id*="j_idt50"]',
    'text=/generar constancia/i',
  ];

  try {
    await frame.locator('#formReimpAcuse\\:j_idt70_modal').waitFor({ state: 'hidden', timeout: 10000 });
  } catch {}

  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    if (await locator.count()) return { selector, locator };
  }

  return null;
}

async function extractWindowOpenPdfUrl(frame, pdfPath = DEFAULT_PDF_PATH) {
  try {
    const result = await frame.evaluate(({ pdfPath }) => {
      const btn = document.querySelector('#formReimpAcuse\\:j_idt50') || document.querySelector('[id*="j_idt50"]');
      const onclick = btn?.getAttribute('onclick') || '';
      const match = onclick.match(/window\.open\(['\"]([^'\"]+IdcGeneraConstancia\.jsf[^'\"]*)['\"]/i);
      const raw = match?.[1] || pdfPath;
      return new URL(raw, window.location.href).toString();
    }, { pdfPath });
    return result || null;
  } catch {
    return null;
  }
}

async function capturePdfViaFrameFetch(frame, pdfPath, runDir, artifactsDir = DEFAULT_ARTIFACTS_DIR) {
  try {
    const result = await frame.evaluate(async ({ pdfPath }) => {
      const targetUrl = new URL(pdfPath, window.location.href).toString();
      const response = await fetch(targetUrl, {
        credentials: 'include',
        redirect: 'follow',
      });
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
      }
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        contentType: response.headers.get('content-type') || '',
        base64: btoa(binary),
      };
    }, { pdfPath });

    const body = Buffer.from(result.base64 || '', 'base64');
    return savePdfBuffer(body, {
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      source: 'frame_fetch',
      frameUrl: frame.url(),
    }, runDir, artifactsDir);
  } catch {
    return null;
  }
}

async function diagnoseManualPdfOpen(page, frame, pdfPath, timeout = PDF_TIMEOUT) {
  const manualUrl = await extractWindowOpenPdfUrl(frame, pdfPath);
  if (!manualUrl) return null;

  const probePage = await page.context().newPage().catch(() => null);
  if (!probePage) return { manualUrl, error: 'manual_probe_page_unavailable' };

  try {
    const responsePromise = probePage.waitForResponse(
      (response) => response.url().includes(pdfPath),
      { timeout },
    ).catch(() => null);
    await probePage.goto(manualUrl, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    const response = await responsePromise;
    const headers = response ? await response.allHeaders().catch(() => ({})) : {};
    const body = response ? await response.body().catch(() => null) : null;
    const bodyPreview = body ? body.toString('utf8').replace(/\s+/g, ' ').slice(0, 500) : '';
    return {
      manualUrl,
      finalUrl: probePage.url(),
      status: response?.status?.() ?? null,
      contentType: headers['content-type'] || '',
      magic: body?.slice?.(0, 4)?.toString('latin1') || null,
      bytes: body?.length || 0,
      bodyPreview,
    };
  } finally {
    await probePage.close().catch(() => {});
  }
}

async function clickGenerateAndCapturePdf(page, frame, runDir, config = {}) {
  const pdfPath = config.pdfPath || DEFAULT_PDF_PATH;
  const artifactsDir = config.artifactsDir || DEFAULT_ARTIFACTS_DIR;
  const timeout = config.pdfTimeout || PDF_TIMEOUT;
  const generate = await waitForGenerateButton(frame);
  if (!generate) {
    return { ok: false, reason: 'generate_button_not_found' };
  }

  const cdpCapture = await attachNetworkPdfCapture(page.context(), page, { pdfPath, runDir, artifactsDir, timeout });
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(pdfPath),
    { timeout },
  ).catch(() => null);
  const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

  await generate.locator.click({ force: true, timeout: 10000 }).catch(async () => {
    await frame.evaluate(() => {
      const candidates = [
        document.querySelector('#formReimpAcuse\\:j_idt50'),
        document.querySelector('[id*="j_idt50"]'),
      ].filter(Boolean);
      const node = candidates[0];
      if (node) node.click();
    }).catch(() => {});
  });

  const cdpSaved = await cdpCapture.resultPromise;
  cdpCapture.cleanup();
  if (cdpSaved) {
    return { ok: true, trigger: generate.selector, response: cdpSaved, popupUrl: null };
  }

  const response = await responsePromise;
  if (response) {
    const saved = await capturePdfFromResponse(response, runDir, artifactsDir);
    if (saved) {
      return { ok: true, trigger: generate.selector, response: saved, popupUrl: null };
    }
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const popupResponse = await popup.waitForResponse(
      (resp) => resp.url().includes(pdfPath),
      { timeout: 10000 },
    ).catch(() => null);
    if (popupResponse) {
      const saved = await capturePdfFromResponse(popupResponse, runDir, artifactsDir);
      if (saved) {
        return { ok: true, trigger: generate.selector, response: saved, popupUrl: popup.url() };
      }
    }

    if (popup.url().includes(pdfPath)) {
      const saved = await capturePdfFromUrl(popup.url(), page.context(), runDir, artifactsDir);
      if (saved) {
        return { ok: true, trigger: generate.selector, response: saved, popupUrl: popup.url() };
      }
    }
  }

  const download = await downloadPromise;
  if (download) {
    const tempPath = path.join(runDir, `download-${nowStamp()}.pdf`);
    await download.saveAs(tempPath).catch(() => {});
    if (fs.existsSync(tempPath)) {
      const body = fs.readFileSync(tempPath);
      const saved = savePdfBuffer(body, {
        url: download.url(),
        status: 200,
        contentType: 'application/pdf',
        source: 'playwright_download',
      }, runDir, artifactsDir);
      if (saved) {
        return { ok: true, trigger: generate.selector, response: saved, popupUrl: popup?.url?.() || null };
      }
    }
  }

  const fetched = await capturePdfViaFrameFetch(frame, pdfPath, runDir, artifactsDir);
  if (fetched) {
    return { ok: true, trigger: generate.selector, response: fetched, popupUrl: popup?.url?.() || null };
  }

  const diagnostics = await diagnoseManualPdfOpen(page, frame, pdfPath, timeout);
  const reason = diagnostics?.contentType?.includes('text/html')
    ? 'manual_pdf_url_returns_html_not_pdf'
    : (diagnostics?.bodyPreview?.toUpperCase?.().includes('NO SE OBTUVIERON TODOS LOS DATOS DE SESION')
      ? 'manual_pdf_url_missing_session_state'
      : 'pdf_response_not_captured');

  return {
    ok: false,
    reason,
    trigger: generate.selector,
    popupUrl: popup?.url?.() || null,
    diagnostics: diagnostics || null,
  };
}

module.exports = {
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PDF_PATH,
  PDF_TIMEOUT,
  attachNetworkPdfCapture,
  capturePdfFromResponse,
  capturePdfFromUrl,
  clickGenerateAndCapturePdf,
  capturePdfViaFrameFetch,
  diagnoseManualPdfOpen,
  extractWindowOpenPdfUrl,
  currentDateLabel,
  ensureDir,
  deliverySafePdfName,
  finalPdfName,
  isPdfBuffer,
  locateConstanciaFrame,
  nowStamp,
  savePdfBuffer,
  sleep,
  waitForGenerateButton,
};
