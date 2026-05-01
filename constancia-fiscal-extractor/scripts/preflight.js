#!/usr/bin/env node
/**
 * Pre-flight check for a Constancia de Situación Fiscal PDF.
 *
 * Verifica que el archivo apuntado sea un PDF válido y no encriptado antes de
 * intentar cualquier extracción. Sólo stdlib de Node — corre en macOS y Linux
 * con Node ≥ 18.
 *
 * Uso:
 *   node scripts/preflight.js <PDF_PATH>
 *
 * Códigos de salida:
 *   0 — OK, el archivo es un PDF utilizable.
 *   1 — Validación falló (razón en `issues` del JSON impreso).
 *   2 — Invocación incorrecta.
 *
 * Output (stdout, JSON):
 *   {
 *     "status": "preflight_ok" | "preflight_failed",
 *     "path": "...",
 *     "bytes": 123456,
 *     "magicHeader": "%PDF-1.7",
 *     "encrypted": false,
 *     "issues": []
 *   }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function main(argv) {
  if (argv.length !== 3) {
    process.stderr.write('Uso: preflight.js <PDF_PATH>\n');
    return 2;
  }

  const filePath = path.resolve(expandTilde(argv[2]));
  const issues = [];

  if (!fs.existsSync(filePath)) {
    issues.push(`El archivo no existe: ${filePath}`);
    emit({ status: 'preflight_failed', path: filePath, issues });
    return 1;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    issues.push(`No es un archivo regular: ${filePath}`);
    emit({ status: 'preflight_failed', path: filePath, issues });
    return 1;
  }

  if (stat.size === 0) {
    issues.push('El archivo está vacío.');
    emit({ status: 'preflight_failed', path: filePath, bytes: 0, issues });
    return 1;
  }

  const fd = fs.openSync(filePath, 'r');
  let head;
  let sample;
  try {
    head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const sampleSize = Math.min(stat.size, 1024 * 1024);
    sample = Buffer.alloc(sampleSize);
    fs.readSync(fd, sample, 0, sampleSize, 0);
  } finally {
    fs.closeSync(fd);
  }

  const magicHeader = head.toString('latin1');
  if (!head.slice(0, 5).equals(Buffer.from('%PDF-'))) {
    issues.push(`Magic bytes inválidos. Se esperaba '%PDF-' al inicio, se recibió: ${JSON.stringify(magicHeader)}`);
  }

  const encrypted = sample.includes(Buffer.from('/Encrypt'));
  if (encrypted) {
    issues.push('El PDF está protegido con contraseña (/Encrypt). Pídele al usuario uno desbloqueado.');
  }

  emit({
    status: issues.length ? 'preflight_failed' : 'preflight_ok',
    path: filePath,
    bytes: stat.size,
    magicHeader,
    encrypted,
    platform: process.platform,
    nodeVersion: process.version,
    issues,
  });
  return issues.length ? 1 : 0;
}

process.exit(main(process.argv));
