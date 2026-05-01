/**
 * Unit tests para scripts/validate.js.
 *
 * Sólo stdlib: usa node:test (built-in desde Node 18). Cero dependencias
 * extras para mantener la promesa de "stdlib only" del SKILL.md.
 *
 * Corre con:  node --test test/
 *
 * Cada test invoca el script real por stdin/stdout (execFileSync) en lugar
 * de importarlo como módulo, para probar el contrato CLI público que usan
 * el agente y CI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VALIDATE = path.resolve(__dirname, '..', 'scripts', 'validate.js');

function runValidate(input) {
  const stdinText = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync('node', [VALIDATE], {
    input: stdinText,
    encoding: 'utf8',
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('persona física: RFC 13 chars normaliza y deriva personaType=FISICA', () => {
  const { code, stdout } = runValidate({
    rfc: 'xaxx010101000',
    nameOrBusinessName: 'PUBLICO EN GENERAL',
    postalCode: '06100',
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.rfc, 'XAXX010101000');
  assert.equal(out.personaType, 'FISICA');
  assert.equal(out.postalCode, '06100');
});

test('persona moral: RFC 12 chars deriva personaType=MORAL', () => {
  const { code, stdout, stderr } = runValidate({
    rfc: 'XEX010101000',
    nameOrBusinessName: 'EMPRESA SA DE CV',
    postalCode: '11560',
    capitalRegime: 'S.A. DE C.V.',
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.personaType, 'MORAL');
  assert.equal(out.capitalRegime, 'S.A. DE C.V.');
  assert.equal(stderr, '', 'no debería emitir warning si trae capitalRegime');
});

test('persona moral sin capitalRegime: warning a stderr pero exit 0', () => {
  const { code, stderr } = runValidate({
    rfc: 'XEX010101000',
    nameOrBusinessName: 'EMPRESA SA DE CV',
    postalCode: '11560',
  });
  assert.equal(code, 0);
  assert.match(stderr, /capitalRegime/i);
});

test('RFC con espacios y minúsculas se normaliza a mayúsculas sin espacios', () => {
  const { code, stdout } = runValidate({
    rfc: '  xaxx 010101 000 ',
    nameOrBusinessName: 'X',
    postalCode: '06100',
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.rfc, 'XAXX010101000');
});

test('RFC con longitud incorrecta (11 chars) → exit 1', () => {
  const { code, stderr } = runValidate({
    rfc: 'XAX01010100',
    nameOrBusinessName: 'X',
    postalCode: '06100',
  });
  assert.equal(code, 1);
  assert.match(stderr, /unexpected length/i);
});

test('RFC con longitud incorrecta (14 chars) → exit 1', () => {
  const { code } = runValidate({
    rfc: 'XAXX0101010000X',
    nameOrBusinessName: 'X',
    postalCode: '06100',
  });
  assert.equal(code, 1);
});

test('postalCode con leading zero se preserva', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
  });
  assert.equal(JSON.parse(stdout).postalCode, '06100');
});

test('postalCode con 4 dígitos → exit 1', () => {
  const { code, stderr } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '6100',
  });
  assert.equal(code, 1);
  assert.match(stderr, /5 digits/i);
});

test('postalCode con 6 dígitos → exit 1', () => {
  const { code } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '061000',
  });
  assert.equal(code, 1);
});

test('postalCode con espacios alrededor se trimea', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '  06100  ',
  });
  assert.equal(JSON.parse(stdout).postalCode, '06100');
});

test('postalCode con caracteres no numéricos: extrae sólo dígitos (5 finales)', () => {
  const { code, stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: 'CP 06100',
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).postalCode, '06100');
});

test('falta rfc → exit 1 con mensaje de campos requeridos', () => {
  const { code, stderr } = runValidate({
    nameOrBusinessName: 'X',
    postalCode: '06100',
  });
  assert.equal(code, 1);
  assert.match(stderr, /Missing required fields.*rfc/);
});

test('falta nameOrBusinessName → exit 1', () => {
  const { code, stderr } = runValidate({
    rfc: 'XAXX010101000',
    postalCode: '06100',
  });
  assert.equal(code, 1);
  assert.match(stderr, /nameOrBusinessName/);
});

test('falta postalCode → exit 1', () => {
  const { code, stderr } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
  });
  assert.equal(code, 1);
  assert.match(stderr, /postalCode/);
});

test('JSON malformado → exit 1', () => {
  const { code, stderr } = runValidate('{not json');
  assert.equal(code, 1);
  assert.match(stderr, /Invalid JSON/);
});

test('top-level array → exit 1', () => {
  const { code, stderr } = runValidate('[]');
  assert.equal(code, 1);
  assert.match(stderr, /must be an object/);
});

test('top-level null → exit 1', () => {
  const { code } = runValidate('null');
  assert.equal(code, 1);
});

test('regimes con uno activo (sin endDate) → currentRegimes y primaryRegimeCode', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [
      { code: '612', name: 'Personas Físicas con Actividades Empresariales', startDate: '2018-01-01' },
    ],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.primaryRegimeCode, '612');
  assert.equal(out.currentRegimes.length, 1);
});

test('regimes con varios activos → primaryRegimeCode es el primer code', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [
      { code: '612', name: 'Actividades Empresariales', startDate: '2018-01-01' },
      { code: '625', name: 'Plataformas Tecnológicas', startDate: '2020-06-01' },
    ],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.primaryRegimeCode, '612');
  assert.equal(out.currentRegimes.length, 2);
});

test('regimes con un activo y uno cerrado → currentRegimes sólo el activo', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [
      { code: '621', name: 'RIF', startDate: '2014-01-01', endDate: '2021-12-31' },
      { code: '612', name: 'Actividades Empresariales', startDate: '2022-01-01' },
    ],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.primaryRegimeCode, '612');
  assert.equal(out.currentRegimes.length, 1);
  assert.equal(out.currentRegimes[0].code, '612');
});

test('regimes todos con endDate → ni currentRegimes ni primaryRegimeCode', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [
      { code: '621', name: 'RIF', startDate: '2014-01-01', endDate: '2021-12-31' },
    ],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.currentRegimes, undefined);
  assert.equal(out.primaryRegimeCode, undefined);
});

test('regimes vacío → no deriva nada', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.currentRegimes, undefined);
  assert.equal(out.primaryRegimeCode, undefined);
});

test('regimes con code numérico se coerciona a String', () => {
  const { stdout } = runValidate({
    rfc: 'XAXX010101000',
    nameOrBusinessName: 'X',
    postalCode: '06100',
    regimes: [{ code: 612, name: 'X', startDate: '2018-01-01' }],
  });
  const out = JSON.parse(stdout);
  assert.equal(out.primaryRegimeCode, '612');
  assert.equal(typeof out.primaryRegimeCode, 'string');
});
