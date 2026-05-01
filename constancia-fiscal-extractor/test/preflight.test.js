/**
 * Unit tests para scripts/preflight.js.
 *
 * Genera fixtures temporales en `os.tmpdir()` (no toca el working tree)
 * con magic bytes válidos / inválidos / encriptados.
 *
 * Corre con:  node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PREFLIGHT = path.resolve(__dirname, '..', 'scripts', 'preflight.js');

function runPreflight(...args) {
  const result = spawnSync('node', [PREFLIGHT, ...args], { encoding: 'utf8' });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function tmpFile(suffix, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csf-preflight-'));
  const file = path.join(dir, `fixture${suffix}`);
  fs.writeFileSync(file, contents);
  return { dir, file };
}

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('sin args → exit 2 (uso incorrecto)', () => {
  const { code, stderr } = runPreflight();
  assert.equal(code, 2);
  assert.match(stderr, /Uso/);
});

test('archivo inexistente → exit 1, status preflight_failed', () => {
  const { code, stdout } = runPreflight('/tmp/__no_existe__.pdf');
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'preflight_failed');
  assert.match(out.issues[0], /no existe/i);
});

test('archivo vacío → exit 1', () => {
  const { dir, file } = tmpFile('-empty.pdf', '');
  cleanup.push(dir);
  const { code, stdout } = runPreflight(file);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'preflight_failed');
  assert.match(out.issues.join(' '), /vacío/i);
});

test('magic bytes inválidos → exit 1', () => {
  const { dir, file } = tmpFile('-not-a-pdf.txt', 'this is plain text, definitely not a pdf');
  cleanup.push(dir);
  const { code, stdout } = runPreflight(file);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'preflight_failed');
  assert.match(out.issues.join(' '), /Magic bytes/);
});

test('PDF válido sin /Encrypt → exit 0, status preflight_ok', () => {
  const body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n';
  const { dir, file } = tmpFile('-ok.pdf', body);
  cleanup.push(dir);
  const { code, stdout } = runPreflight(file);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'preflight_ok');
  assert.equal(out.encrypted, false);
  assert.equal(out.magicHeader.startsWith('%PDF-'), true);
  assert.equal(out.bytes, Buffer.byteLength(body));
  assert.equal(typeof out.platform, 'string');
  assert.equal(typeof out.nodeVersion, 'string');
});

test('PDF con /Encrypt → exit 1 con issue de contraseña', () => {
  const body = '%PDF-1.7\n1 0 obj\n<< /Encrypt 5 0 R >>\nendobj\n%%EOF\n';
  const { dir, file } = tmpFile('-enc.pdf', body);
  cleanup.push(dir);
  const { code, stdout } = runPreflight(file);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.encrypted, true);
  assert.match(out.issues.join(' '), /contraseña|Encrypt/i);
});

test('directorio en lugar de archivo → exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csf-preflight-dir-'));
  cleanup.push(dir);
  const { code, stdout } = runPreflight(dir);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.match(out.issues.join(' '), /archivo regular/i);
});
