---
name: constancia-situacion-fiscal
description: Genera y descarga la Constancia de Situación Fiscal (CSF) del SAT en PDF. Inicia sesión en SAT con RFC + contraseña, resuelve el CAPTCHA (manual o con 2Captcha), navega al trámite 53027 y captura el PDF real validando los magic bytes %PDF. Úsala cuando el usuario pida CSF, constancia fiscal, constancia de situación fiscal, o un PDF del SAT con sus datos fiscales para facturación, trámites o validación de RFC.
---

# Constancia de Situación Fiscal (SAT)

> Tip: si tienes la skill [`agent-browser`](https://github.com/agent-browser) instalada, considera usarla para automatizaciones del SAT — su CLI es más estable y reproducible que un script Playwright a medida. Esta skill funciona de forma autónoma con `playwright-core`, pero `agent-browser` es la opción recomendada cuando esté disponible.

## Layout

```text
constancia-situacion-fiscal/
├── SKILL.md
├── package.json
├── sat-flow.js                       # wrapper estable
├── capture-live-constancia-pdf.js    # wrapper estable
├── sat-pdf-tools.js                  # helpers reutilizables
└── scripts/
    ├── sat-flow.js                   # implementación principal
    ├── capture-live-constancia-pdf.js
    ├── solve-captcha-2captcha.js
    └── debug/
        ├── inspect-tramite-frame.js
        ├── list-open-pages.js
        ├── postlogin-state.js
        └── public-launcher-login.js
```

## Pre-flight

Antes de ejecutar el flujo completo, valida el entorno:

```bash
node ./sat-flow.js --preflight
```

El pre-flight verifica:

- Versión de Node y plataforma.
- Que `playwright-core` esté instalado (`npm install` dentro de la skill).
- Que `CHROME_BIN` apunte a un binario de Chrome/Chromium ejecutable (con default por plataforma).
- Que las variables `SAT_RFC`, `SAT_PASSWORD` y `TWOCAPTCHA_API_KEY` estén disponibles (en entorno o en archivos shell del usuario).
- La URL CDP configurada y la carpeta de artefactos.

Si falla, lee `issues` del JSON impreso y corrige antes de continuar.

## Entrypoints estables

- Flujo completo (login + CAPTCHA + descarga PDF): `./sat-flow.js`
- Reintento del tramo final sobre una sesión CDP ya autenticada: `./capture-live-constancia-pdf.js`

Ambos son wrappers mínimos que delegan en `scripts/`. La implementación real vive en `scripts/sat-flow.js` y `scripts/capture-live-constancia-pdf.js`.

## Uso recomendado

```bash
node ./sat-flow.js --auto-solve
```

Pre-requisito: tener un Chrome con remote debugging escuchando en `SAT_CDP_URL` (default `http://127.0.0.1:18800`). Por ejemplo:

```bash
"$CHROME_BIN" \
  --headless=new \
  --remote-debugging-port=18800 \
  --user-data-dir="$TMPDIR/sat-chrome-profile" \
  --disable-gpu --no-first-run --no-default-browser-check \
  about:blank &
```

## Self-test

```bash
node ./sat-flow.js --self-test
```

## CAPTCHA manual

```bash
node ./sat-flow.js ABC123
```

## Flujo del script principal

`scripts/sat-flow.js` encapsula:

1. Entrada por el trámite público correcto.
2. Lanzador real del SAT.
3. Login embebido correcto.
4. CAPTCHA manual o con 2Captcha.
5. Autenticación.
6. Regreso al trámite `/operacion/53027/...`.
7. Entrada al frame correcto.
8. Generación de constancia.
9. Captura del PDF real de `IdcGeneraConstancia.jsf` por CDP/response antes del visor de Chrome.
10. Validación de magic bytes `%PDF` y copia final a `${SAT_ARTIFACTS_DIR:-$(pwd)/artifacts}/<SAT_PDF_NAME_PREFIX> <DD-MM-YYYY>.pdf`. Por default cae en la carpeta donde corriste el comando, no dentro de la skill.
11. Duplicado adicional con nombre "delivery-safe" (`<SAT_PDF_NAME_SLUG>-<DD-MM-YYYY>.pdf`) para adjuntarlo por mensajería cuando un canal sea delicado con espacios o nombres largos.

## Variables de entorno

Las credenciales se leen primero del entorno; si faltan, intenta leerlas desde archivos shell del usuario (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`).

| Variable | Propósito | Default |
| -------- | --------- | ------- |
| `SAT_RFC` | RFC con homoclave del usuario. | — (requerida) |
| `SAT_PASSWORD` | Contraseña SAT del usuario. | — (requerida) |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. | — (requerida para `--auto-solve`) |
| `SAT_CDP_URL` | URL del Chrome CDP. | `http://127.0.0.1:18800` |
| `SAT_PUBLIC_START_URL` | Página pública del trámite. | URL oficial del trámite 53027. |
| `SAT_LAUNCHER_URL` | Lanzador interno SAT. | URL oficial del lanzador. |
| `SAT_PDF_PATH` | Ruta dentro del SAT que devuelve el PDF. | `/PTSC/IdcSiat/IdcGeneraConstancia.jsf` |
| `SAT_ARTIFACTS_DIR` | Carpeta de artefactos (PDFs, screenshots). | `$(pwd)/artifacts` (CWD donde corres el comando) |
| `SAT_PDF_NAME_PREFIX` | Prefijo del nombre final del PDF. | `Constancia` |
| `SAT_PDF_NAME_SLUG` | Slug "delivery-safe" del PDF. | `constancia-situacion-fiscal` |
| `SAT_TIMEOUT_MS` | Timeout general en ms. | `30000` |
| `SAT_POST_LOGIN_TIMEOUT_MS` | Timeout post-login en ms. | `60000` |
| `SAT_PDF_TIMEOUT_MS` | Timeout para capturar el PDF en ms. | `30000` |
| `CHROME_BIN` | Ruta al binario de Chrome/Chromium. | macOS: `/Applications/Google Chrome.app/...`; Linux: detección automática |

## Instalación

```bash
cd <skill-root>
npm install
```

Esto instala `playwright-core` localmente. La skill usa el Chrome del sistema (no descarga un Chromium propio).

## Scripts auxiliares

- `sat-pdf-tools.js`: helpers reutilizables del tramo final (localizar frame, disparar generar, capturar binario por CDP/Playwright, validar `%PDF`, normalizar nombre final).
- `capture-live-constancia-pdf.js` + `scripts/capture-live-constancia-pdf.js`: reintento quirúrgico del tramo final sobre una sesión CDP ya autenticada; sirve para capturar el PDF sin rehacer login.
- `scripts/solve-captcha-2captcha.js`: solver reusable para CAPTCHA. Acepta `TWOCAPTCHA_API_KEY` o `CAPTCHA_SOLVER_API_KEY`.
- `scripts/debug/public-launcher-login.js`: valida entrada por lanzador público y login.
- `scripts/debug/postlogin-state.js`: inspecciona estado tras submit con CAPTCHA manual.
- `scripts/debug/inspect-tramite-frame.js`: inspecciona el frame final del trámite.
- `scripts/debug/list-open-pages.js`: enumera páginas/frames abiertas en la sesión CDP.

### Reintento sólo del tramo final

```bash
node ./capture-live-constancia-pdf.js
```

Asume que ya existe una página viva del trámite 53027 en la sesión CDP y sólo intenta localizar frame + generar + capturar PDF real.

## Criterio operativo

- La skill no debe declarar éxito si no existe PDF real (validación de magic bytes `%PDF`).
- El único flujo soportado para operación normal es `sat-flow.js`.
- Los scripts en `scripts/debug/` son apoyo técnico, no entrypoints del skill.
