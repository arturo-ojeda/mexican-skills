const fs = require('fs');
const path = require('path');

const DEFAULT_ARTIFACTS_DIR = process.env.IMSS_ARTIFACTS_DIR || process.cwd();
const PDF_NAME_PREFIX = process.env.IMSS_PDF_NAME_PREFIX || 'Semanas cotizadas IMSS';
const PDF_NAME_SLUG = process.env.IMSS_PDF_NAME_SLUG || 'semanas-cotizadas-imss';

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

  const capturedPath = path.join(runDir, `semanas-raw-${nowStamp()}.pdf`);
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
  };
}

module.exports = {
  DEFAULT_ARTIFACTS_DIR,
  currentDateLabel,
  deliverySafePdfName,
  ensureDir,
  finalPdfName,
  isPdfBuffer,
  nowStamp,
  savePdfBuffer,
  sleep,
};
