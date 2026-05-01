# mexican-skills

Colección de **agent skills** para automatizar trámites mexicanos comunes desde un agente (Cursor, Claude Code, etc.). Cada skill es autónoma, vive en su propio directorio, expone un `SKILL.md` con triggers en español y se puede compartir/redistribuir sin datos personales.

[![CI](https://github.com/arturoo/mexican-skills/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml) — Funciona en macOS y Linux. Windows no está soportado.

## Skills incluidas

| Skill | Qué hace | Stack | Entrypoint |
| ----- | -------- | ----- | ---------- |
| [`buzon-tributario`](./buzon-tributario) | Revisa los mensajes del Buzón Tributario del SAT (mis notificaciones, mis comunicados, mis documentos) en modo lectura. No abre actos individuales ni dispara acuses. | Node + Playwright + Chrome | `bash ./scripts/check-buzon.sh` |
| [`constancia-situacion-fiscal`](./constancia-situacion-fiscal) | Genera y descarga la Constancia de Situación Fiscal (CSF) del SAT en PDF. Inicia sesión, resuelve CAPTCHA y captura el PDF real validando los magic bytes `%PDF`. | Node + Playwright + Chrome | `node ./sat-flow.js --auto-solve` |
| [`constancia-fiscal-extractor`](./constancia-fiscal-extractor) | Toma un PDF de CSF y lo convierte en JSON normalizado (RFC, nombre, domicilio, regímenes) para encadenar con skills de facturación. | Python 3 stdlib | `python3 ./scripts/preflight.py <PDF>` luego extracción |
| [`recibo-cfe`](./recibo-cfe) | Descarga el recibo más reciente de CFE en PDF para usarlo como comprobante de domicilio. Flujo HTTP puro (sin navegador). | Node stdlib | `node ./download-recibo-cfe.js` |

Cada skill tiene su propio `SKILL.md` con detalles, variables y troubleshooting. Lee ese archivo antes de invocarla.

### Encadenamiento

```text
   ┌────────────────────────────┐    ┌──────────────────────────────┐
   │ constancia-situacion-fiscal │ →  │ constancia-fiscal-extractor  │
   │  baja CSF.pdf desde SAT     │    │  parsea CSF.pdf → JSON       │
   └────────────────────────────┘    └──────────────────────────────┘
                                                  │
                                                  ▼
                                       skill de facturación
                                       (rfc, nombre, CP, régimen…)
```

`recibo-cfe` y `buzon-tributario` son independientes y no necesitan encadenarse.

## Convenciones del repo

Todas las skills siguen las mismas reglas para ser intercambiables y portables:

- **Triggers en español neutro/mexicano** en el `description` del frontmatter de `SKILL.md`, con casos de uso reales.
- **Rutas relativas**. Los artefactos se escriben por default en `<skill-root>/artifacts/`. Nada está hardcoded a un usuario o ruta absoluta del sistema.
- **Variables de entorno con fallback a archivos shell** (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`). Si una variable no está en el entorno, el script intenta leerla de esos archivos antes de fallar.
- **Pre-flight check** (`--preflight`) en cada skill: valida runtime, dependencias, binarios, variables y permisos. Imprime JSON con `status` (`preflight_ok` / `preflight_failed`) y un array `issues` accionable. Exit code `2` si falla.
- **Self-test** (`--self-test`) cuando aplica: imprime la configuración resuelta sin tocar red.
- **Salida en JSON estructurada** para que el agente la pueda parsear con confianza.
- **Sin información personal hardcoded** (sin RFC, sin nombre de usuario, sin paths personales). Todo configurable.
- **Cross-platform** macOS y Linux. Cada `package.json` declara `"os": ["darwin","linux"]` y `"engines": {"node": ">=18"}`.

## Pre-requisitos

### Comunes a todas las skills

- **macOS o Linux.** Windows no soportado oficialmente. WSL2 debería funcionar.
- **Node.js ≥ 18** para las skills Node (se usa `fetch` nativo y `URLSearchParams`).
  ```bash
  node --version   # debe ser v18 o superior
  ```
- **Python 3.8+** para `constancia-fiscal-extractor`. Suele venir preinstalado.
  ```bash
  python3 --version
  ```
- **`npm`** para instalar dependencias locales por skill (cuando aplique).
- **Cuenta en [2Captcha](https://2captcha.com)** y su API key en `TWOCAPTCHA_API_KEY` para las skills que enfrentan CAPTCHA del SAT (`buzon-tributario`, `constancia-situacion-fiscal`). `recibo-cfe` no la necesita hoy.

### Específicos por skill

#### `buzon-tributario` y `constancia-situacion-fiscal` (SAT con navegador)

- **Google Chrome / Chromium instalado**. La skill **no descarga** un Chromium propio: usa el binario del sistema. Detección automática:
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Linux: `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`, `/opt/google/chrome/google-chrome`, y fallback a `$PATH`.
  - Override: `CHROME_BIN=/ruta/a/chrome`
- **`playwright-core`** instalado dentro de la skill:
  ```bash
  cd <skill> && npm install
  ```
- **Credenciales SAT**: `SAT_RFC`, `SAT_PASSWORD`.
- **`TWOCAPTCHA_API_KEY`** (acepta `CAPTCHA_SOLVER_API_KEY` como alias).

#### `constancia-fiscal-extractor` (parser CSF → JSON)

- **Python 3.8+** stdlib only. Sin dependencias externas, sin red, sin telemetría.
- Permisos de ejecución: `chmod +x scripts/*.py`.

#### `recibo-cfe` (CFE por HTTP)

- **Credenciales CFE** de Mi Espacio CFE: `CFE_USERNAME`, `CFE_PASSWORD`.
- Usa `https` nativo de Node — no necesita Chrome ni Playwright.

## Instalación

```bash
# Skills SAT con Playwright
cd buzon-tributario && npm install
cd ../constancia-situacion-fiscal && npm install

# Skill CFE (sin dependencias, npm install opcional para registrar package.json)
cd ../recibo-cfe && npm install

# Skill extractor (sólo permisos)
cd ../constancia-fiscal-extractor && chmod +x scripts/*.py
```

## Uso recomendado

1. **Configura tus variables.** Copia [`.env.example`](./.env.example) a `.env`, completa los valores y exporta:
   ```bash
   cp .env.example .env
   $EDITOR .env
   export $(grep -v '^#' .env | xargs)
   ```
   O simplemente ponlas en tu `~/.zshrc` (las skills las leen automáticamente).
2. **Pre-flight primero.** Antes de correr el flujo real, valida el entorno:
   ```bash
   cd buzon-tributario && node ./scripts/check-buzon.js --preflight
   cd ../constancia-situacion-fiscal && node ./sat-flow.js --preflight
   cd ../recibo-cfe && node ./download-recibo-cfe.js --preflight
   ```
3. **Ejecuta el entrypoint** de la skill que necesites (ver tabla arriba).
4. **Lee el JSON de salida** — incluye `status`, `runDir` con screenshots, y la ruta del PDF cuando aplica.

## Variables de entorno (resumen)

| Variable | Skills | Propósito |
| -------- | ------ | --------- |
| `SAT_RFC` | buzon, constancia-csf | RFC con homoclave. |
| `SAT_PASSWORD` | buzon, constancia-csf | Contraseña SAT. |
| `CFE_USERNAME` | recibo-cfe | Usuario Mi Espacio CFE. |
| `CFE_PASSWORD` | recibo-cfe | Contraseña Mi Espacio CFE. |
| `TWOCAPTCHA_API_KEY` | buzon, constancia-csf (opcional en cfe) | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. |
| `CHROME_BIN` | buzon, constancia-csf | Override de la ruta a Chrome. |
| `SAT_CDP_URL` / `SAT_CDP_PORT` | buzon, constancia-csf | Endpoint del Chrome CDP. |
| `*_ARTIFACTS_DIR` | todas | Carpeta de salida (default: `<skill-root>/artifacts`). |
| `CFE_RETRIES` / `CFE_RETRY_BASE_DELAY_MS` | recibo-cfe | Tuning del retry con backoff exponencial. |

Cada `SKILL.md` documenta las variables específicas de su skill con defaults y notas.

> **Nota sobre el fallback a archivos shell.** Si una variable falta en el entorno, las skills Node intentan leerla de `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile` y `~/.profile`. Esto es cómodo para uso local pero **lee tus archivos shell completos** en busca de la variable; si te incomoda, define las variables sólo en el entorno (`export VAR=...`) y nunca en archivos shell. La skill nunca persiste, copia o transmite el contenido leído.

## Recomendación: `agent-browser`

Si tienes la skill [`agent-browser`](https://github.com/agent-browser) instalada, **considérala como primera opción** para automatizaciones de navegador. Su CLI (`npm i -g agent-browser`) es más estable y reproducible que un script Playwright a medida y se adapta mejor cuando los portales del SAT/CFE cambian de DOM.

Las skills de este repo funcionan de forma autónoma sin `agent-browser`, pero los `SKILL.md` lo recomiendan explícitamente cuando esté disponible.

## Mantenimiento del repo

### Limpiar `artifacts/`

Las skills escriben PDFs, screenshots y `state.json` con datos personales (RFC, dirección, líneas de captura) en `<skill>/artifacts/`. **Nunca commitees esa carpeta** — el `.gitignore` la excluye, pero localmente conviene limpiarla:

```bash
./scripts/clean-artifacts.sh                 # borra todo
./scripts/clean-artifacts.sh --dry-run       # sólo lista
./scripts/clean-artifacts.sh --older-than 7  # borra runs > 7 días
```

### CI

GitHub Actions corre en cada push/PR sobre `ubuntu-latest` y `macos-latest` con Node 18, 20 y 22:

- `node --check` en todos los `.js`
- `bash -n` en todos los `.sh`
- `python3 -m py_compile` en todos los `.py`
- `--preflight` y `--self-test` para confirmar que todo arranca limpio

Ver [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Estructura típica de una skill

```text
<skill>/
├── SKILL.md             # frontmatter (name + description con triggers en español) + docs
├── package.json         # dependencias, scripts, engines, os
├── README.txt           # nota corta de uso (cuando aplique)
├── <entrypoint>.js      # script principal con --preflight / --self-test / --help
├── scripts/             # implementación + helpers + debug
└── artifacts/           # (creada en runtime, en .gitignore) screenshots, PDFs, state.json
```

## Licencia

[MIT](./LICENSE) — Copyright (c) 2026 Arturo Ojeda.

## Privacidad

- Este repo no contiene credenciales ni datos personales. Todo se inyecta en runtime vía variables de entorno o archivos shell.
- Las carpetas `artifacts/` están ignoradas por git; aun así, conviene limpiarlas con `./scripts/clean-artifacts.sh` antes de compartir el repo.
- Los ejemplos en docs usan el RFC genérico publicado por el SAT `XAXX010101000` ("público en general"). Nunca se sustituye por uno real.

## Contribuir

Si agregas una skill nueva, sigue las convenciones de arriba: `SKILL.md` con triggers en español, `--preflight`, paths relativos, `engines` + `os` en `package.json`, sin datos personales, y agrega una entrada en la tabla de skills de este README.
