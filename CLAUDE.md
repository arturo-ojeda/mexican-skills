# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A monorepo of **independent agent skills** (Claude Code / Cursor) that automate Mexican government and utility flows: SAT (Buzón Tributario, Constancia de Situación Fiscal) and CFE (recibo de luz). Each top-level dir is one skill, fully self-contained with its own `SKILL.md`, `package.json`, and entrypoint script. Users install only the skills they need — there is no root `package.json` and no shared `node_modules`.

```
buzon-tributario/                # SAT inbox reader (read-only)
constancia-situacion-fiscal/     # Downloads CSF PDF from SAT
constancia-fiscal-extractor/     # Parses CSF PDF → normalized JSON (stdlib only)
recibo-cfe/                      # Downloads latest CFE receipt PDF (HTTP, no browser)
scripts/                         # Repo-wide tools (lint-skills.js, clean-artifacts.sh)
```

The natural pipeline is `constancia-situacion-fiscal` (download PDF) → `constancia-fiscal-extractor` (PDF → JSON) → downstream invoicing skills.

## Common commands

Each skill is invoked from its own dir or by absolute path. Per-skill scripts (`npm run preflight`, `npm run self-test`, etc.) are defined in each `package.json`.

```bash
# Install per-skill (no root install)
cd buzon-tributario && npm install
cd constancia-situacion-fiscal && npm install
cd recibo-cfe && npm install
# constancia-fiscal-extractor has no dependencies; npm install only registers scripts

# Repo-wide lint (CI gate): validates every SKILL.md frontmatter + structure
node ./scripts/lint-skills.js

# Run the only unit test suite in the repo (Node built-in test runner)
cd constancia-fiscal-extractor && node --test test/
# Single test file:
cd constancia-fiscal-extractor && node --test test/validate.test.js

# Per-skill preflight (validates env, deps, paths — exits 2 on failure)
node ./constancia-situacion-fiscal/scripts/sat-flow.js --preflight
node ./buzon-tributario/scripts/check-buzon.js --preflight
node ./recibo-cfe/scripts/download-recibo-cfe.js --preflight
node ./constancia-fiscal-extractor/scripts/preflight.js <PDF_PATH>

# Per-skill self-test (no network, dumps resolved config as JSON)
node ./constancia-situacion-fiscal/scripts/sat-flow.js --self-test
node ./recibo-cfe/scripts/download-recibo-cfe.js --self-test
```

CI (`.github/workflows/ci.yml`) runs `node --check` on every `.js`, `bash -n` on every `.sh`, all preflights (expecting exit 2 with empty env), self-tests, the SKILL.md lint, and the extractor unit tests across Node 18/20/22 on Ubuntu + macOS.

## Cross-skill conventions (load-bearing)

These conventions are enforced by `scripts/lint-skills.js` and the CI workflow. Future skills must follow them.

**SKILL.md structure.** YAML frontmatter must have `name` (matching the dir) and `description` (≤ 1024 chars, target ≥ 40). Body must include an H1 and a `## Pre-flight` section. Every `node ./path.js` referenced in fenced bash blocks must exist on disk. Every relative Markdown link must resolve. Run the linter before committing SKILL.md changes.

**Trilingual contract.** SKILL.md prose, agent-facing output, and user messages are in **Mexican-neutral Spanish**. JSON keys, code identifiers, and stderr from `validate.js`-style scripts stay in English. Don't translate JSON keys.

**JSON-only stdout.** Every entrypoint prints a single JSON object to stdout (`{ status, ... }` for runs; `{ status: 'preflight_failed', issues: [...] }` for preflight). Errors and progress go to stderr. Exit codes: `0` success, `1` runtime failure, `2` preflight/env failure. Don't add free-form prints to stdout — the agent parses it.

**Credential resolution order.** Read from `process.env` first; if missing, fall back to `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` in that order, parsing `KEY=value`, `KEY="value"`, `KEY='value'`, and `export KEY=value`. The CFE, CSF and Buzón scripts each implement this; copy the pattern, don't reinvent it. There is no per-user JSON profile / config file — every credential and PII value (RFC, CFE_USERNAME, etc.) lives in env or shell rc. Never hardcode user data — examples use the SAT generic RFC `XAXX010101000`.

**2Captcha key.** Canonical name is `TWOCAPTCHA_API_KEY`. `CAPTCHA_SOLVER_API_KEY` is accepted as a back-compat alias and should be preserved.

**Artifacts go to `$(pwd)`** — the *caller's* CWD, not the skill dir, and not a nested `artifacts/` subdir. Final user-facing PDFs land directly in pwd; per-run debug subdirs (`constancia-run-<ts>/`, `sat-buzon-<ts>/`, `constancia-live-capture-<ts>/`) hold the screenshots and `state.json`. Each skill has its own override env var (`SAT_ARTIFACTS_DIR`, `SAT_BUZON_ARTIFACTS_DIR`, `CFE_ARTIFACTS_DIR`). The CI's `--self-test` step explicitly verifies that `artifactsDir` resolves to `/tmp/work` (i.e. exactly the CWD) when invoked from there. Don't change this default lightly.

**`package-lock.json` per skill with deps.** Skills with runtime `dependencies` (currently `buzon-tributario`, `constancia-situacion-fiscal` — both on `playwright-core`) commit their own `package-lock.json`. CI installs them with `npm ci` so version drift fails loudly instead of silently upgrading Playwright on a green build. Skills that are stdlib-only by contract (`constancia-fiscal-extractor`, `recibo-cfe`) must keep `"dependencies": {}` and have no lock — a lock appearing there is a red flag that a dep crept in. Never add a root `package.json`, a root `package-lock.json`, or a shared `node_modules/`; the "each skill is self-contained" rule is load-bearing.

**PDF outputs validate magic bytes.** Any flow that produces a PDF must verify the buffer starts with `%PDF` before declaring success (`isPdfBuffer()` in `sat-pdf-tools.js`, equivalent check in `scripts/download-recibo-cfe.js`). The contract in every SKILL.md is *"no real PDF, no success."*

## SAT browser flows (constancia-situacion-fiscal, buzon-tributario)

Both skills share an identical Chrome-via-CDP pattern that's worth understanding before editing either.

- They use **`playwright-core`** — not full `playwright` — and connect to a system Chrome (the package never downloads Chromium). `CHROME_BIN` overrides detection; macOS default is `/Applications/Google Chrome.app/...`, Linux iterates a candidate list then `$PATH`.
- On run, they auto-spawn Chrome with `--remote-debugging-port` and a persistent profile in `${TMPDIR}/sat-{csf,buzon}-chrome-profile/`. Set `SAT_NO_SPAWN=1` to skip the spawn and reuse a Chrome the user is already running on `SAT_CDP_URL` (default `http://127.0.0.1:18800`). Logs go to `SAT_CHROME_LOG`.
- The Chrome profile persists between runs to keep cookies/sessions warm. Don't blow it away in code paths the agent might trigger.
- CAPTCHA solving: `--auto-solve` uses 2Captcha; passing a literal token as the first positional arg (`node sat-flow.js ABC123`) does manual mode.

**`buzon-tributario` is read-only by contract.** It MUST NOT open individual notifications, actos, PDFs, acuses, or "aquí" links — clicking those triggers legal effects (acuse de notificación). The skill only enumerates list views. Preserve this when editing `check-buzon.js`.

**`constancia-situacion-fiscal` PDF capture.** The download endpoint is `/PTSC/IdcSiat/IdcGeneraConstancia.jsf`. The script intercepts the response via CDP *before* Chrome's PDF viewer renders it, validates `%PDF`, then writes two copies to the artifacts dir: a human-readable `<prefix> DD-MM-YYYY.pdf` and a delivery-safe `<slug>-DD-MM-YYYY.pdf` (no spaces) for chat channels that mishandle filenames. Both names are tunable via `SAT_PDF_NAME_PREFIX` / `SAT_PDF_NAME_SLUG`. Shared logic lives in `scripts/sat-pdf-tools.js` — `sat-flow.js` (full flow) and `capture-live-constancia-pdf.js` (retry-only on an already-authenticated session) both consume it. Don't duplicate the locate-frame / capture / validate logic in either entrypoint.

## CFE flow (recibo-cfe)

`scripts/download-recibo-cfe.js` is **HTTP-only** (Node `https`, manual cookie jar) — no browser, no Playwright. It scrapes ASP.NET form state (`__VIEWSTATE`, `__EVENTVALIDATION`) from `Login.aspx`, then triggers the `__doPostBack(...DescargaPDF...)` for the most recent row in `GVHistorial`. If CFE adds CAPTCHA or migrates to an SPA, the documented escape hatch is to switch to the `agent-browser` skill rather than introducing Playwright here. After download, the file is renamed by `scripts/normalize-recibo-cfe.sh`.

## constancia-fiscal-extractor (stdlib-only extractor)

This skill is **stdlib-only by design** — no `dependencies`, no network, no telemetry. The agent (Claude) does the actual PDF text extraction by reading page 1; the two scripts in `scripts/` only do mechanical pre/post checks:

- `preflight.js <PDF_PATH>`: existence, magic bytes, no `/Encrypt` (password-protected PDFs are rejected). Exit 0/1.
- `validate.js`: reads JSON from stdin, normalizes `rfc` (uppercase, no whitespace) and `postalCode` (5 digits), derives `personaType` from RFC length (13 = `FISICA`, 12 = `MORAL`), picks `primaryRegimeCode` from the first régimen without `endDate`, and emits `currentRegimes`. Exit 0 with normalized JSON on stdout, exit 1 on validation failure.

The SKILL.md encodes hard rules the agent must follow at extraction time: never invent missing values (omit the key, don't emit `""`/`null`); verify RFC + CP character-by-character; treat the JSON as PII (don't paste into shared channels); emit dates as ISO `YYYY-MM-DD` even though the PDF prints `DD/MM/YYYY`. When changing the field map in `validate.js`, update the mapping table in `SKILL.md` in the same commit — the SKILL.md is the contract the agent reads.
