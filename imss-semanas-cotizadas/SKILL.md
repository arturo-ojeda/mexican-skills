---
name: imss-semanas-cotizadas
description: Descarga el documento de Semanas Cotizadas del IMSS en PDF desde el portal de Servicios Digitales. Inicia sesion con NSS + CURP + correo + telefono celular, resuelve el CAPTCHA con 2Captcha, valida el token SMS de IMSS y captura el PDF real validando los magic bytes %PDF. Implementacion HTTP-only (sin Playwright). Usala cuando el usuario pida semanas cotizadas, reporte de semanas, constancia de semanas IMSS, historial laboral del IMSS o un PDF para tramites de pension, prestamo Infonavit o portabilidad IMSS-ISSSTE.
---

# Semanas Cotizadas (IMSS)

Skill autonoma **HTTP-only** (Node `https`, sin browser). Habla directo con `serviciosdigitales.imss.gob.mx/semanascotizadas-web` reusando cookies de Imperva/WebLogic, resuelve el CAPTCHA con 2Captcha, valida el token SMS de IMSS y descarga el PDF de Semanas Cotizadas validando los magic bytes `%PDF`.

## Arquitectura

El portal del IMSS es un Servlet/JSP detras de Imperva (Incapsula). Investigamos que:

- Imperva acepta `curl` con un User-Agent de Chrome real — el bloqueo "Error 15" solo aplica a navegadores headless con `navigator.webdriver` detectable.
- El CAPTCHA solo guarda la **primera capa** (POST a `/usuarios/LoginAsegurado` con datos del form). Una vez consumido, el `JSESSIONID` autentica el resto de la sesion.
- El submit del token SMS y la descarga del PDF **no requieren CAPTCHA** — son requests autenticados por sesion.

Por eso el skill no usa Playwright: `https.request` + jar de cookies basta.

El SMS es 2FA externa: la skill se ejecuta en **dos fases** y persiste estado entre corridas.

## Layout

```text
imss-semanas-cotizadas/
├── SKILL.md
├── package.json
└── scripts/
    ├── imss-flow.js       # entrypoint principal (HTTP-only)
    └── imss-pdf-tools.js  # helpers de nombrado y magic bytes
```

## Pre-flight

```bash
node ./scripts/imss-flow.js --preflight
```

Verifica:

- Versión de Node (≥ 18).
- Que `IMSS_NSS`, `IMSS_CURP`, `IMSS_EMAIL`, `IMSS_PHONE` y `TWOCAPTCHA_API_KEY` estén disponibles (en entorno o en archivos shell del usuario).
- Que `IMSS_CURP` cumpla el regex de CURP, `IMSS_NSS` sean 11 dígitos y `IMSS_PHONE` sean 10 dígitos.

Si falla, lee `issues` del JSON impreso y corrige antes de continuar.

## Self-test

```bash
node ./scripts/imss-flow.js --self-test
```

Imprime URLs configuradas, `artifactsDir`, el nombre final esperado del PDF y de qué fuente se resolvió cada credencial, sin tocar la red.

## Uso

### Fase 1: login + CAPTCHA (dispara SMS)

```bash
node ./scripts/imss-flow.js --auto-solve
```

Pasos internos:

1. `GET /usuarios/IngresoAsegurado` — recibe cookies de Imperva (`visid_incap_*`, `incap_ses_*`) y de WebLogic (`JSESSIONID`-equivalentes).
2. `GET /servlet/CaptchaServlet?<ts>` — descarga el JPEG (220×40) atado al `JSESSIONID`.
3. Envío a 2Captcha (`regsense=1`, IMSS distingue mayúsculas/minúsculas). Reintenta hasta 3 veces si IMSS rechaza el código.
4. `POST /usuarios/LoginAsegurado` con `curp`, `nss`, `correo`, `correoConfirma`, `telefono`, `telefonoConfirma`, `captcha`.
5. Detecta la pantalla de token ("Por favor, ingresa el token que se envió a tú teléfono"). IMSS dispara el SMS al telefono.
6. Persiste cookies + HTML del form de token en `${runDir}/state.json` y sale con `status: "awaiting_sms_token"`.

### Fase 2: SMS token + descarga del PDF

```bash
IMSS_SMS_TOKEN=ABC123 node ./scripts/imss-flow.js --auto-solve
# o
node ./scripts/imss-flow.js --sms-token=ABC123
```

Reusando el `state.json` mas reciente:

7. Reconstruye la sesion (cookies del jar) y postea el token al form action descubierto en la fase 1.
8. Detecta token invalido / expirado; en error, sale con `status: "token_invalid"` para que vuelvas a intentar.
9. Si IMSS acepta el token, escanea el HTML resultante para localizar el endpoint del PDF (heuristicas: anchors con `pdf|reporte|constancia|historia laboral|imprimir|descarga`, `window.open(...)`, form actions).
10. `GET <pdf_url>` con cookies, valida `%PDF` magic bytes, copia a `${IMSS_ARTIFACTS_DIR:-$(pwd)}/<IMSS_PDF_NAME_PREFIX> <DD-MM-YYYY>.pdf` y al duplicado "delivery-safe" (`<IMSS_PDF_NAME_SLUG>-<DD-MM-YYYY>.pdf`).

### CAPTCHA manual (sin 2Captcha)

```bash
node ./scripts/imss-flow.js Ab12CdE
```

(Distingue entre mayúsculas y minúsculas — IMSS valida case-sensitive en el servidor.)

## Credenciales

`IMSS_NSS`, `IMSS_CURP`, `IMSS_EMAIL`, `IMSS_PHONE` y `TWOCAPTCHA_API_KEY` se resuelven en este orden: `process.env` → archivos shell rc (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`).

`IMSS_NSS`, `IMSS_CURP`, `IMSS_EMAIL` y `IMSS_PHONE` son **PII** pero no son secretos — está bien dejarlos en `~/.zshrc`. `TWOCAPTCHA_API_KEY` es **secreto**; mantenlo en env o shell rc, nunca commiteado.

`*Source` que devuelve `--preflight` y `--self-test` te dice de dónde salió cada valor.

### El correo importa

IMSS valida server-side que **`IMSS_EMAIL` sea el correo previamente registrado en el sistema para esa CURP**. Si nunca has usado el portal, IMSS te lo registrará en el primer intento exitoso; en intentos posteriores debes usar exactamente ese mismo correo. Mensajes posibles del servidor:

- `El correo que está intentando ingresar no es válido` → IMSS no acepta ese dominio o el correo no está registrado.
- `El correo electrónico que capturó ya se encuentra registrado en el Instituto relacionado a una CURP distinta a la capturada` → ese correo ya está en uso por otra CURP, no se puede reutilizar.

La skill marca esos casos como `status: "credentials_rejected"`.

### Limite de SMS

IMSS envia hasta **2 tokens SMS por dia** por celular. Si la cuota se agota o el SMS no llega, espera al dia siguiente o cambia el celular registrado en IMSS via "Datos de contacto".

## Variables de entorno

| Variable | Propósito | Default |
| -------- | --------- | ------- |
| `IMSS_NSS` | Número de Seguridad Social (11 dígitos). | — (requerida) |
| `IMSS_CURP` | CURP de 18 caracteres. | — (requerida) |
| `IMSS_EMAIL` | Correo registrado en el IMSS para esa CURP. | — (requerida) |
| `IMSS_PHONE` | Teléfono celular (10 dígitos, sin código de país). | — (requerida) |
| `IMSS_SMS_TOKEN` | Token recibido por SMS (fase 2). | — |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. **Secreto.** | — (requerida para `--auto-solve`) |
| `IMSS_STATE_FILE` | Override del path al `state.json` de fase 1. | autodetecta el `state.json` mas reciente en `IMSS_ARTIFACTS_DIR` |
| `IMSS_ENTRY_URL` / `IMSS_LOGIN_URL` / `IMSS_CAPTCHA_URL` | Override de URLs IMSS. | URLs oficiales del portal. |
| `IMSS_ARTIFACTS_DIR` | Carpeta de artefactos (PDFs, run dirs). | `$(pwd)` (CWD donde corres el comando) |
| `IMSS_PDF_NAME_PREFIX` | Prefijo del nombre final del PDF. | `Semanas cotizadas IMSS` |
| `IMSS_PDF_NAME_SLUG` | Slug "delivery-safe" del PDF. | `semanas-cotizadas-imss` |
| `IMSS_TIMEOUT_MS` | Timeout HTTP por request en ms. | `30000` |
| `IMSS_RETRIES` | Reintentos por request. | `3` |
| `IMSS_RETRY_BASE_DELAY_MS` | Delay base (exponencial) entre reintentos. | `2000` |
| `IMSS_USER_AGENT` | User-Agent enviado a IMSS. | Chrome 130 estable. |

## Instalación

```bash
cd <skill-root>
npm install
```

`npm install` solo registra los `bin`/`scripts` del `package.json` — la skill **no tiene dependencias runtime** (stdlib de Node ≥ 18 con `https` y `fetch` global).

## Estados de salida

`scripts/imss-flow.js` siempre imprime un único objeto JSON a stdout. Los `status` posibles:

- `preflight_ok` / `preflight_failed` — modo `--preflight` (exit 0 / 2).
- `self_test_ok` — modo `--self-test`.
- `config_missing` — falta alguna credencial obligatoria.
- `entry_failed` — el GET inicial al portal IMSS fallo (HTTP no-200).
- `imperva_blocked` — Imperva bloqueo el request. Cambia `IMSS_USER_AGENT` o reintenta desde otra IP.
- `awaiting_captcha` — se requiere texto de CAPTCHA (sin `--auto-solve`).
- `solver_unavailable` / `solver_failed` — 2Captcha no devolvió texto.
- `captcha_failed` — IMSS rechazó el CAPTCHA tras todos los reintentos.
- `credentials_rejected` — IMSS rechazó CURP / NSS / correo (ver sección "El correo importa").
- `daily_limit_exceeded` — IMSS reporta "Numero de intentos alcanzado por el día de hoy"; espera al día siguiente.
- `blocked` — IMSS frenó el acceso por intentos repetidos; espera y reintenta.
- `awaiting_sms_token` — fase 1 exitosa; corre fase 2 con `IMSS_SMS_TOKEN`.
- `state_missing` / `state_corrupt` — fase 2 no encontró el state.json o no se pudo leer.
- `token_invalid` — IMSS rechazó el token SMS o sigue pidiéndolo.
- `token_field_not_found` — el HTML guardado no tenia un input con `name=token`.
- `pdf_downloaded` — éxito; el PDF está en `pdfPath` y `pdfDeliverySafePath`.
- `pdf_unavailable` — login + token aceptados, pero no se localizó endpoint de PDF (incluye `triedCandidates` con lo que se intento).
- `error` — excepción no esperada.

## Criterio operativo

- La skill no debe declarar éxito si no existe PDF real (validación de magic bytes `%PDF`).
- IMSS trata el correo como una credencial vinculada a la CURP. Cambiar de correo en intentos sucesivos puede romper el acceso o duplicar registros.
- El SMS es 2FA fuera del control del skill; solo se puede esperar a que llegue.
