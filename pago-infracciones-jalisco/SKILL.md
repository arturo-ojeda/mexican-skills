---
name: pago-infracciones-jalisco
description: Consulta adeudos vehiculares e infracciones en el portal del Gobierno de Jalisco (gobiernoenlinea1.jalisco.gob.mx/serviciosVehiculares/adeudos). Usa playwright-core + 2Captcha porque el portal está protegido por reCAPTCHA v2 invisible y rechaza cada POST sin token nuevo. Por default es solo lectura — si el vehículo tiene adeudos, los lista; si no, lo reporta. El pago es out-of-scope hoy y vivirá en un skill aparte. Úsala cuando el usuario quiera revisar placas/vehículos en Jalisco, ver multas estatales, o automatizar esa consulta.
---

# Adeudos vehiculares — Jalisco (consulta)

Skill autónoma basada en `playwright-core` + 2Captcha. Lanza Chrome del sistema vía CDP, abre el portal de adeudos vehiculares de Jalisco, resuelve el reCAPTCHA v2 invisible (`size=invisible`, sitekey `6LehxCgfAAAAAE_6lvOTiXBtQNZCyc37CLZssnzC`), inyecta el token, envía la consulta y parsea el resultado.

**Alcance hoy: consulta solamente.** El flujo de pago (3DS, OTP, datos de tarjeta) requiere human-in-the-loop y se cubrirá en un skill separado cuando se necesite.

## Pre-flight

```bash
node ./scripts/jalisco-flow.js --preflight
```

Verifica:

- Versión de Node y plataforma.
- Que `playwright-core` esté instalado (`npm install` en la skill).
- Que `CHROME_BIN` apunte a Chrome ejecutable (con default por plataforma).
- Que `TWOCAPTCHA_API_KEY` esté disponible (env o shell rc).
- Reporta si los datos del vehículo (placa, número de serie) están en env vars.

Si falla, lee `issues` del JSON impreso y corrige antes de seguir.

## Quick run

Los datos del vehículo se pueden pasar vía CLI args (preferido para uso ad-hoc) o env vars (cómodo si siempre consultas el mismo vehículo). El agente debe pedirlos al usuario al momento si no están definidos.

```bash
# Por CLI args (recomendado para multi-vehículo)
node ./scripts/jalisco-flow.js \
  --placa=AAA1234 \
  --serie=ABCDE12345FGHIJ67 \
  --propietario="NOMBRE DEL PROPIETARIO" \
  --motor=ABC1234567890

# Por env vars (cómodo para un solo vehículo recurrente)
JALISCO_PLACA=AAA1234 \
JALISCO_NUMERO_SERIE=ABCDE12345FGHIJ67 \
node ./scripts/jalisco-flow.js
```

Sólo `placa` y `serie` son requeridos. `propietario` y `motor` son opcionales — el portal los marca `required` en HTML pero su validación JS sólo exige los primeros dos.

El script:

1. Levanta Chrome headless con CDP en `http://127.0.0.1:${JALISCO_CDP_PORT:-18830}` (auto-spawn; perfil persistente en `${JALISCO_CHROME_PROFILE:-$TMPDIR/jalisco-chrome-profile}`).
2. Abre `https://gobiernoenlinea1.jalisco.gob.mx/serviciosVehiculares/adeudos`.
3. Llena el formulario con los datos del vehículo.
4. Resuelve reCAPTCHA v2 invisible vía 2Captcha (passa `userAgent` del navegador para mejorar la tasa de éxito; reintenta hasta 3 veces).
5. Inyecta el token en `#g-recaptcha-response` e invoca `onSubmit(token)` directamente (igual que lo haría el botón de la página).
6. Parsea la respuesta:
   - **Lista de infracciones** (`tableRows`): por cada fila, las celdas en orden.
   - **`no_tiene_adeudos`**: el portal mostró el texto "no tiene adeudos".
   - **`pagos_pendientes_de_aplicar`**: hay un pago previo en proceso. **No volver a pagar.**
   - **`no_tiene_adeudos_probable`** *(quirk del portal — ver abajo)*.
   - **`captcha_o_datos_rechazados`**: el portal devolvió el formulario inicial; revisar datos o reintentar.
7. Guarda screenshots, HTML completo, cookies y `investigation.json` en `${JALISCO_INFRACCIONES_ARTIFACTS_DIR:-$(pwd)}/jalisco-run-<timestamp>/`.

## Quirk del portal: la plantilla `frmError`

Cuando la consulta es exitosa pero el vehículo **no tiene adeudos**, el portal renderiza una página minimalista con `<form id="frmError">` y un alert `alert-info` titulado "Información". El cuerpo del mensaje (`<div th:text="${msg}">`) **está literalmente comentado en HTML** — un bug de su template, no nuestro. No podemos leer un texto explícito como "el vehículo no tiene adeudos".

Heurística que aplica el script: si la respuesta tiene `frmError` + `alert-info` + título "Información" sin tabla de adeudos, reporta `summary: 'no_tiene_adeudos_probable'` con un `summaryNote` que advierte la inferencia. El agente debe presentar ese caso al usuario como "lectura más probable: sin adeudos" y, si hay duda, pedirle al usuario que lo revise manualmente.

## Hallazgo: el captcha NO es sólo guard de primera capa

Probado empíricamente en una corrida real: tras una consulta exitosa, un segundo POST al mismo endpoint sin un token de reCAPTCHA fresco devuelve la página del formulario inicial (no resultados). El backend es **stateless** — no setea cookies de sesión ni acepta token reusado. **Cada consulta cuesta un solve de 2Captcha.** El campo `investigation` del JSON final documenta el experimento por si quieres re-validarlo.

## Cómo resumir resultados al usuario

Lee el JSON final del script. Reporta en español, breve:

- Si `summary === 'lista_adeudos'`: detalla cada fila de `tableRows` con folio, autoridad/tipo, descripción, monto, descuento y total. Pregunta si quiere actuar sobre ellos.
- Si `summary === 'no_tiene_adeudos'`: confirma "el vehículo no tiene adeudos".
- Si `summary === 'pagos_pendientes_de_aplicar'`: avisa que hay un pago previo en proceso. **No sugerir pagar.**
- Si `summary === 'no_tiene_adeudos_probable'`: usa el `summaryNote`; explica el quirk del template y ofrece reintentar.
- Si `summary === 'captcha_o_datos_rechazados'`: pide al usuario que verifique placa/serie y reintenta.

## Credenciales y datos

`TWOCAPTCHA_API_KEY` (compartida con los skills SAT) se resuelve en este orden: `process.env` → archivos shell rc del usuario (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`). Acepta `CAPTCHA_SOLVER_API_KEY` como alias por compatibilidad.

Los datos del vehículo (placa, serie, propietario, motor) son **PII pero no secretos**. La política del repo es pedirlos al usuario al momento o aceptarlos vía env vars/CLI args. Nunca hardcodearlos en el skill ni guardarlos entre conversaciones.

## Variables de entorno

| Variable | Propósito | Default |
| -------- | --------- | ------- |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. **Secreto.** | — (requerida) |
| `JALISCO_PLACA` | Placa del vehículo. | — (preguntar al usuario si falta) |
| `JALISCO_NUMERO_SERIE` | VIN / número de serie. Mínimo 5 caracteres. | — (preguntar al usuario si falta) |
| `JALISCO_PROPIETARIO` | Nombre del propietario / razón social. | opcional |
| `JALISCO_NUMERO_MOTOR` | Número de motor. | opcional |
| `JALISCO_INFRACCIONES_ARTIFACTS_DIR` | Carpeta de artefactos (screenshots, HTML, cookies, investigación). | `$(pwd)` |
| `JALISCO_CDP_PORT` / `JALISCO_CDP_URL` | Puerto / URL del Chrome CDP. | `18830` / `http://127.0.0.1:18830` |
| `JALISCO_CHROME_PROFILE` | Perfil de Chrome (persistente). | `${TMPDIR}/jalisco-chrome-profile` |
| `JALISCO_CHROME_LOG` | Log de Chrome. | `${TMPDIR}/jalisco-chrome.log` |
| `JALISCO_NO_SPAWN` | `1` para no auto-lanzar Chrome (usar uno propio en `JALISCO_CDP_URL`). | unset (auto-spawn ON) |
| `JALISCO_TIMEOUT_MS` | Timeout general. | `60000` |
| `CHROME_BIN` | Binario de Chrome/Chromium. | macOS: `/Applications/Google Chrome.app/...`; Linux: detección automática |
| `JALISCO_PORTAL_URL` | URL del portal (override por si cambia). | URL canónica |
| `JALISCO_RECAPTCHA_SITEKEY` | Sitekey de reCAPTCHA (override por si rotan). | sitekey actual del portal |

## Instalación

```bash
cd <skill-root>
npm install
```

Esto instala `playwright-core`. La skill usa el Chrome del sistema (no descarga un Chromium propio).

## Costo y latencia

- ~$0.003 USD por consulta (un solve de reCAPTCHA v2 invisible en 2Captcha).
- ~15–60s por solve, más ~5s del flujo restante. Total típico: 20–70s por consulta.
- Si 2Captcha devuelve `ERROR_CAPTCHA_UNSOLVABLE`, el script reintenta hasta 3 veces. Si los 3 fallan, Google está scoring particularmente agresivo y conviene reintentar más tarde.

## Troubleshooting

- **`ERROR_CAPTCHA_UNSOLVABLE` repetido**: Google rechaza el token del solver por mismatch de fingerprint/IP. Espera unos minutos o intenta en otra hora; el portal no es de uso intensivo y este patrón se mueve.
- **`summary === 'captcha_o_datos_rechazados'`**: el captcha pasó pero el portal mostró el form inicial otra vez. Verifica que la placa esté bien escrita y que la serie tenga al menos 5 caracteres.
- **Chrome CDP no responde**: revisa el log apuntado por `JALISCO_CHROME_LOG`. Si el binario falla, define `CHROME_BIN`.
- **`playwright-core` falta**: `npm install` en la raíz de la skill.

## Referencias

- [`references/portal-jalisco.md`](./references/portal-jalisco.md) — campos del formulario, plantillas que renderiza el portal, errores comunes.
