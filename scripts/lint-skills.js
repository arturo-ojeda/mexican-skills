#!/usr/bin/env node
/**
 * Lint estructural de los SKILL.md del repo.
 *
 * Verifica, para cada skill top-level (`<repo>/<dir>/SKILL.md`):
 *   - Frontmatter YAML con `name` (matchea el dir) y `description` no vacía
 *     y ≤ 1024 caracteres (límite documentado de Anthropic Skills).
 *   - Encabezado H1 presente.
 *   - Sección `## Pre-flight` presente (convención del repo).
 *   - Cada `node ./algo.js` en bloques bash apunta a un archivo existente
 *     relativo a la raíz de la skill.
 *   - Cada link Markdown relativo (`./...` o `../...`) resuelve a un archivo
 *     o directorio en disco. Links absolutos (`http(s)://`, `mailto:`) y
 *     anchors (`#...`) se ignoran.
 *
 * Sólo stdlib de Node ≥ 18. Exit 0 si todo OK; exit 1 si algún skill tiene
 * errores. Output JSON en stdout para ser parseable desde CI.
 *
 * Uso:  node scripts/lint-skills.js
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_FILE = 'SKILL.md';
const DESCRIPTION_MAX = 1024;
const REQUIRED_SECTION = '## Pre-flight';

function listSkillDirs(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'scripts')
    .map((d) => path.join(root, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, SKILL_FILE)));
}

function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { frontmatter: null, body: text };
  }
  const rest = text.replace(/^---\r?\n/, '');
  const end = rest.search(/^---\s*$/m);
  if (end < 0) return { frontmatter: null, body: text };
  const frontmatter = rest.slice(0, end);
  const body = rest.slice(end).replace(/^---\s*\r?\n?/, '');
  return { frontmatter, body };
}

/**
 * Mini-parser de YAML frontmatter restringido a `clave: valor` escalar.
 * Soporta continuation lines (líneas sin `clave:` que siguen a una clave) y
 * las concatena con espacio. Rechaza listas o nested maps emitiendo un error.
 */
function parseFrontmatter(text) {
  const errors = [];
  const data = {};
  let currentKey = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      currentKey = null;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) {
      const [, key, raw] = m;
      const value = raw.trim();
      if (value.startsWith('[') || value.startsWith('{') || value === '|' || value === '>' || value === '-') {
        errors.push(`Frontmatter usa estructura no soportada en clave "${key}" (sólo strings escalares).`);
        currentKey = null;
        continue;
      }
      data[key] = value;
      currentKey = key;
    } else if (currentKey && /^\s+\S/.test(line)) {
      data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
    } else if (line.trim().startsWith('-')) {
      errors.push(`Frontmatter incluye lista YAML (no soportada): ${line.trim()}`);
      currentKey = null;
    } else {
      errors.push(`Línea de frontmatter no parseable: ${JSON.stringify(line)}`);
      currentKey = null;
    }
  }
  return { data, errors };
}

function extractFencedBashBlocks(body) {
  const blocks = [];
  const re = /```(bash|sh|shell)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    blocks.push(m[2]);
  }
  return blocks;
}

function extractNodeInvocations(blocks) {
  const refs = new Set();
  const re = /\bnode\s+(\.{1,2}\/[^\s'"`)]+\.(?:js|mjs|cjs))/g;
  for (const block of blocks) {
    let m;
    while ((m = re.exec(block)) !== null) refs.add(m[1]);
  }
  return [...refs];
}

function extractRelativeLinks(body) {
  const links = new Set();
  const re = /\[(?:[^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('#')[0];
    if (!target) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith('#')) continue;
    links.add(target);
  }
  return [...links];
}

function lintSkill(skillDir) {
  const errors = [];
  const warnings = [];
  const skillPath = path.join(skillDir, SKILL_FILE);
  const text = fs.readFileSync(skillPath, 'utf8');

  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) {
    errors.push('Falta frontmatter YAML al inicio del archivo.');
    return { name: path.basename(skillDir), path: skillPath, errors, warnings };
  }

  const { data: meta, errors: fmErrors } = parseFrontmatter(frontmatter);
  errors.push(...fmErrors);

  if (!meta.name) errors.push('Frontmatter sin clave `name`.');
  else if (meta.name !== path.basename(skillDir)) {
    errors.push(`Frontmatter \`name\` ("${meta.name}") no matchea el directorio ("${path.basename(skillDir)}").`);
  }

  if (!meta.description) errors.push('Frontmatter sin clave `description`.');
  else if (meta.description.length > DESCRIPTION_MAX) {
    errors.push(`\`description\` excede ${DESCRIPTION_MAX} caracteres (${meta.description.length}).`);
  } else if (meta.description.length < 40) {
    warnings.push(`\`description\` muy corta (${meta.description.length} chars). El agente puede no activar la skill.`);
  }

  if (!/^# /m.test(body)) errors.push('Falta encabezado H1 (`# Título`) en el cuerpo.');
  if (!body.includes(REQUIRED_SECTION)) {
    errors.push(`Falta la sección requerida \`${REQUIRED_SECTION}\` (convención del repo).`);
  }

  const bashBlocks = extractFencedBashBlocks(body);
  const nodeRefs = extractNodeInvocations(bashBlocks);
  for (const ref of nodeRefs) {
    const resolved = path.resolve(skillDir, ref);
    if (!fs.existsSync(resolved)) {
      errors.push(`Bloque bash invoca \`node ${ref}\` pero el archivo no existe (resuelto: ${resolved}).`);
    }
  }

  const links = extractRelativeLinks(body);
  for (const link of links) {
    const resolved = path.resolve(skillDir, link);
    if (!fs.existsSync(resolved)) {
      errors.push(`Link Markdown relativo no resuelve: \`${link}\` (resuelto: ${resolved}).`);
    }
  }

  return { name: meta.name || path.basename(skillDir), path: skillPath, errors, warnings };
}

function main() {
  const skillDirs = listSkillDirs(REPO_ROOT);
  if (skillDirs.length === 0) {
    process.stderr.write(`No se encontraron skills con SKILL.md en ${REPO_ROOT}\n`);
    return 1;
  }

  const results = skillDirs.map(lintSkill);
  const failed = results.some((r) => r.errors.length > 0);

  process.stdout.write(`${JSON.stringify({
    status: failed ? 'lint_failed' : 'ok',
    repoRoot: REPO_ROOT,
    skills: results,
  }, null, 2)}\n`);

  return failed ? 1 : 0;
}

process.exit(main());
