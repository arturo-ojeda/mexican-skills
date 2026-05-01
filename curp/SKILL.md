---
name: curp
description: Descarga la Constancia de CURP (Clave Única de Registro de Población) en PDF desde el portal oficial de RENAPO en gob.mx. Modo default usa Chrome headed con tu perfil real para que el reCAPTCHA Enterprise invisible sea resuelto por Google sin solver. Modo headless usa 2Captcha como fallback. Valida los magic bytes %PDF antes de declarar éxito. Úsala cuando el usuario pida CURP, constancia de CURP, comprobante de CURP o un PDF oficial con su clave única para trámites, registros o validación de identidad.
---

# CURP (Constancia oficial RENAPO)

Skill autónoma que orquesta `agent-browser` para automatizar el flujo público de [https://www.gob.mx/curp/](https://www.gob.mx/curp/). El sitio usa **reCAPTCHA Enterprise score-based** (invisible) más una capa Cloudflare-like de "Challenge Validation" en cargas frías.

**Hallazgo importante**: el captcha sólo protege la primera capa. Una vez que se obtiene la respuesta de `/v1/renapoCURP/consulta`, el endpoint del PDF (`https://consultas.curp.gob.mx/CurpSP/pdfgobmx?curp=…&pcurp=…&hash=…`) **es público** y replayable con `curl` sin cookies ni headers.

## Layout

```text
curp/
├── SKILL.md
├── package.json
└── scripts/
    ├── curp-flow.js        # entrypoint principal (preflight, self-test, run)
    └── curp-pdf-tools.js   # helpers de naming/validación PDF
```

## Pre-flight

```bash
node ./scripts/curp-flow.js --preflight
```

Verifica:

- Versión de Node y plataforma.
- Que `agent-browser` esté disponible en PATH (override con `AGENT_BROWSER_BIN`).
- Que `CURP_VALUE` esté definida (env o shell rc) y respete el formato de 18 caracteres.
- En modo headed (default): que **Chrome no esté corriendo con tu perfil real** (chocan dos instancias del mismo `user-data-dir`). Si `pgrep` detecta tu Chrome activo, falla con `chrome_running_conflict`.
- En modo headless / `--force-solver`: que `TWOCAPTCHA_API_KEY` esté definida.
- La carpeta de artefactos (`CURP_ARTIFACTS_DIR`, default `$(pwd)`).

Salida JSON con `status: "preflight_ok"` (exit 0) o `"preflight_failed"` (exit 2).

## Modos de operación

| Modo | Cuándo | Captcha | Costo | Tasa de éxito |
| ---- | ------ | ------- | ----- | ------------- |
| `headed_real_profile` (default) | Tienes Chrome instalado y puedes cerrarlo durante el run. | Resuelto invisible por Google (score alto = perfil real). | $0 | Alta |
| `headless_solver` (`--headless` o `--force-solver`) | CI, servidores, o no quieres cerrar tu Chrome. | 2Captcha Enterprise. | ~$0.005 USD/run cuando solve. | Media: 2Captcha workers reciben score bajo del backend con frecuencia. |
| `manual_token` (`TOKEN` o `--captcha=TOKEN`) | Tienes un token Enterprise resuelto fuera de banda. | El que tú proveas. | $0 | Depende del score del token. |

### Modo default (recomendado)

```bash
# Cierra Chrome primero. Después:
CURP_VALUE=AAAA000000HDFXXX01 node ./scripts/curp-flow.js
```

Flujo interno:

1. `agent-browser --headed --profile Default --session curp open https://www.gob.mx/curp/`.
2. Espera al `#curpinput` (la página puede cargar primero un "Challenge Validation" que se resuelve solo en ~50s).
3. Llena `#curpinput` con tu CURP.
4. Click submit nativo (`document.getElementById('searchButton').click()` vía `eval` — `agent-browser click` no dispara el handler delegado de Ember).
5. El JS de gob.mx llama `grecaptcha.enterprise.execute(sitekey, {action:"CONSULTA"})`. Con tu perfil real, Google devuelve un token con score alto y el backend `/v1/renapoCURP/consulta` lo acepta.
6. Espera al botón `#download` ("Paso 2 — Descarga del CURP").
7. Click descarga nativo. El JS hace GET a `/CurpSP/pdfgobmx?curp=…&pcurp=…&hash=…`, recibe el PDF como base64 y lo pega en `#dwnldLnk.href`.
8. Polling cada 200ms a `#dwnldLnk.href` (la ventana en la que el data URL existe es de ~10s antes de que el JS lo limpie).
9. Decode base64 → `Buffer` → valida `%PDF`.
10. Fallback secundario: si no se capturó el data URL, lee `~/Downloads/curp.pdf` (Chrome headed lo descarga al filesystem real).
11. Copia el PDF a `${CURP_ARTIFACTS_DIR}/CURP <DD-MM-YYYY>.pdf` y `curp-<DD-MM-YYYY>.pdf` (delivery-safe).

### Modo headless / solver

```bash
CURP_VALUE=AAAA000000HDFXXX01 TWOCAPTCHA_API_KEY=... node ./scripts/curp-flow.js --headless
```

Igual que el flujo default, pero con `agent-browser` headless y un token Enterprise pedido a 2Captcha (`enterprise=1&action=CONSULTA&min_score=0.7`). Notas:

- El `searchButton` se sigue activando con click nativo, pero antes el script monkey-patchea `window.grecaptcha.enterprise.execute` para que devuelva el token resuelto por 2Captcha.
- 2Captcha cobra alrededor de $0.005 USD por solve exitoso. Tasks `ERROR_CAPTCHA_UNSOLVABLE` no cobran.
- En la práctica, el backend de `/CurpSP/pdfgobmx` puede rechazar tokens con score Enterprise bajo (los workers de 2Captcha suelen estar en IPs de datacenter). Si la consulta avanza al paso 2 pero el data URL nunca aparece, ese es el síntoma.

### Modo manual

```bash
CURP_VALUE=AAAA000000HDFXXX01 node ./scripts/curp-flow.js TOKEN_RECAPTCHA_ENTERPRISE
```

## Self-test

```bash
node ./scripts/curp-flow.js --self-test
```

Imprime la configuración resuelta sin tocar la red ni el browser.

## Credenciales

`CURP_VALUE` y `TWOCAPTCHA_API_KEY` se resuelven en este orden: `process.env` → `~/.zshrc` → `~/.zprofile` → `~/.bashrc` → `~/.bash_profile` → `~/.profile`.

`CURP_VALUE` es PII pero no es secreto — está bien dejarla en `~/.zshrc`. `TWOCAPTCHA_API_KEY` es **secreto**.

## Variables de entorno

| Variable | Propósito | Default |
| -------- | --------- | ------- |
| `CURP_VALUE` | CURP de 18 caracteres del usuario. | — (requerida) |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. **Secreto.** | — (requerida sólo para `--headless` / `--force-solver`) |
| `CURP_PUBLIC_START_URL` | Página pública del trámite. | `https://www.gob.mx/curp/` |
| `CURP_RECAPTCHA_SITEKEY` | Sitekey reCAPTCHA Enterprise. | sitekey actual de gob.mx/curp |
| `CURP_RECAPTCHA_ACTION` | Action que se envía a 2Captcha (Enterprise score-based). | `CONSULTA` |
| `CURP_RECAPTCHA_MIN_SCORE` | min_score que 2Captcha exige al worker. | `0.7` |
| `CURP_CHROME_PROFILE` | Nombre del perfil Chrome o ruta absoluta. | `Default` |
| `CURP_SESSION_NAME` | Nombre de sesión de agent-browser. | `curp` |
| `CURP_DOWNLOADS_DIR` | Carpeta donde Chrome guarda descargas (fallback). | `~/Downloads` |
| `CURP_ARTIFACTS_DIR` | Carpeta de artefactos (PDF + screenshots). | `$(pwd)` |
| `CURP_PDF_NAME_PREFIX` | Prefijo del nombre final. | `CURP` |
| `CURP_PDF_NAME_SLUG` | Slug delivery-safe. | `curp` |
| `CURP_TIMEOUT_MS` | Timeout general en ms. | `60000` |
| `CURP_PDF_TIMEOUT_MS` | Timeout para esperar el data URL del PDF. | `30000` |
| `AGENT_BROWSER_BIN` | Ruta al binario de `agent-browser`. | `agent-browser` (PATH) |

## Investigación: el captcha es sólo guarda de primera capa

Durante la construcción se confirmó que `https://consultas.curp.gob.mx/CurpSP/pdfgobmx` regresa `HTTP 200` con el PDF en base64 a un `curl` crudo, sin cookies ni headers, siempre que se pasen `curp`, `pcurp` y `hash` válidos. Los tres parámetros vienen del response de `POST https://www.gob.mx/v1/renapoCURP/consulta` (que sí exige token Enterprise válido en el body):

```json
{ "curp": "AAAA000000HDFXXX01", "token": "<recaptcha-enterprise-token>" }
```

El response trae `registros[0].parametro` (32 hex, `pcurp`) y `registros[0].curp` (que se usa como `hash` de 40 hex). Esto sugiere un futuro modo "HTTP-only" del skill: si capturáramos `(pcurp, hash)` desde el response del consulta (vía CDP en agent-browser, o re-emitiendo el `fetch` con un token Enterprise nuevo desde el contexto de la página), podríamos saltar el clic en `#download` y construir la URL del PDF directamente para `curl`. Hoy el skill se apoya en el JS del propio gob.mx para hacer ese paso.

## Instalación

```bash
cd <skill-root>
npm install
```

No descarga deps de runtime. Sólo registra los scripts.

### Registro global (descubrimiento por nombre desde cualquier directorio)

Para que la skill aparezca en `~/.claude/skills/` y sea invocable como `/curp` desde cualquier CWD, crea un symlink:

```bash
ln -s "$(pwd)/curp" ~/.claude/skills/curp
```

Sigue el mismo patrón que `buzon-tributario`, `recibo-cfe` y `constancia-situacion-fiscal` en este repo.

## Soporte cross-platform

| Plataforma | Estado | Notas |
| ---------- | ------ | ----- |
| macOS | Probada end-to-end | Perfil Default en `~/Library/Application Support/Google/Chrome/Default` |
| Linux | Soportada por diseño | Perfil Default en `~/.config/google-chrome/Default` o `~/.config/chromium/Default` |
| Windows | No soportada | `pgrep` y rutas de perfil son POSIX-only |

La detección de "Chrome corriendo" usa `pgrep -fl '(Google Chrome|google-chrome|chromium|chromium-browser).*--user-data-dir'` y compara contra los user-data-dirs canónicos por OS. La descarga del PDF (modo default) no depende del filesystem — usa el polling de `#dwnldLnk.href`. El fallback `~/Downloads/curp.pdf` funciona en ambos OS.

`agent-browser` debe estar en `PATH` o exportado en `AGENT_BROWSER_BIN`. Es cross-platform.

## Criterio operativo

- La skill no debe declarar éxito si no existe PDF real (validación de magic bytes `%PDF`).
- El sitekey Enterprise puede rotar. Si gob.mx lo cambia, exporta `CURP_RECAPTCHA_SITEKEY` con el nuevo valor.
- Si gob.mx renombra `#curpinput`, `#searchButton`, `#download` o `#dwnldLnk`, el flujo fallará con `submitted_failed` o `pdf_unavailable`. Revisa los screenshots en `runDir`.
- En modo `headed_real_profile`, **Chrome debe estar cerrado** durante el run. El skill detecta procesos Chrome con tu perfil activo y aborta limpio (`chrome_running_conflict`) en lugar de fallar oscuro.
