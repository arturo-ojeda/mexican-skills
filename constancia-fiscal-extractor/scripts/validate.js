#!/usr/bin/env node
/**
 * Validate and enrich a Constancia de Situación Fiscal JSON extraction.
 *
 * Lee un objeto JSON desde stdin (los campos extraídos por un modelo a partir
 * del PDF de la CSF), verifica que los campos mínimos estén presentes,
 * normaliza algunos, y deriva extras (personaType, primaryRegimeCode) que
 * dejan el output listo para skills de facturación.
 *
 * Ejemplo:
 *   cat extracted.json | node scripts/validate.js > normalized.json
 *
 * Sólo stdlib de Node — corre en macOS y Linux con Node ≥ 18.
 *
 * Códigos de salida:
 *   0 — válido; JSON normalizado en stdout.
 *   1 — validación falló (razón en stderr).
 */

const REQUIRED_FIELDS = ['rfc', 'nameOrBusinessName', 'postalCode'];
const RFC_LEN_FISICA = 13;
const RFC_LEN_MORAL = 12;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const text = await readStdin();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    process.stderr.write(`Invalid JSON on stdin: ${error.message}\n`);
    return 1;
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    process.stderr.write('Top-level JSON must be an object\n');
    return 1;
  }

  const missing = REQUIRED_FIELDS.filter((field) => !data[field]);
  if (missing.length) {
    process.stderr.write(`Missing required fields: ${missing.join(', ')}\n`);
    return 1;
  }

  const rfc = String(data.rfc).trim().toUpperCase().replace(/\s+/g, '');
  data.rfc = rfc;

  if (rfc.length === RFC_LEN_FISICA) {
    data.personaType = 'FISICA';
  } else if (rfc.length === RFC_LEN_MORAL) {
    data.personaType = 'MORAL';
  } else {
    process.stderr.write(`RFC has unexpected length (${rfc.length} chars): ${rfc}\n`);
    return 1;
  }

  const postalRaw = String(data.postalCode).trim();
  const postalDigits = postalRaw.replace(/\D/g, '');
  if (postalDigits.length !== 5) {
    process.stderr.write(`Postal code must normalize to 5 digits, got: ${JSON.stringify(postalRaw)}\n`);
    return 1;
  }
  data.postalCode = postalDigits;

  if (data.personaType === 'MORAL' && !data.capitalRegime) {
    process.stderr.write('Warning: persona moral without capitalRegime — check extraction\n');
  }

  const regimes = Array.isArray(data.regimes) ? data.regimes : [];
  if (regimes.length) {
    const active = regimes.filter((r) => r && typeof r === 'object' && !r.endDate);
    if (active.length) {
      data.currentRegimes = active;
      const primary = active[0].code;
      if (primary) data.primaryRegimeCode = String(primary);
    }
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exit(1);
  });
