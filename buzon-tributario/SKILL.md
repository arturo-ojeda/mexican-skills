---
name: buzon-tributario
description: Revisa los mensajes del Buzón Tributario del SAT (mis notificaciones, mis comunicados, mis documentos) en modo lectura. Inicia sesión con RFC + contraseña, resuelve el CAPTCHA con 2Captcha y captura el estado de cada sección sin abrir actos individuales ni activar acuses. Úsala cuando el usuario pida revisar Buzón Tributario, mensajes del SAT, comunicados, notificaciones, cobranza, líneas de captura o el estado del buzón fiscal.
---

# Buzón Tributario del SAT

Skill autónoma basada en `playwright-core`. Lanza Chrome del sistema vía CDP, hace login en el SAT (con CAPTCHA vía 2Captcha) y enumera los listados del buzón **sin abrir** notificaciones individuales (para no disparar acuses).

## Regla principal

Sólo se consultan **vistas/listados**. **No abrir** notificaciones, actos administrativos, PDFs, acuses ni enlaces "aquí" sin confirmación explícita del usuario, porque podría activar efectos legales o generar acuses de notificación.

## Pre-flight

Antes de ejecutar el flujo completo, valida el entorno:

```bash
node ./scripts/check-buzon.js --preflight
```

El pre-flight verifica:

- Versión de Node y plataforma.
- Que `playwright-core` esté instalado (`npm install` dentro de la skill).
- Que `CHROME_BIN` apunte a un binario de Chrome/Chromium ejecutable (con default por plataforma).
- Que las variables `SAT_RFC`, `SAT_PASSWORD` y `TWOCAPTCHA_API_KEY` estén disponibles (en entorno o en archivos shell del usuario).
- La URL CDP configurada.

Si falla, lee `issues` del JSON impreso y corrige antes de seguir.

## Quick run

```bash
node ./scripts/check-buzon.js
```

El script:

1. Levanta Chrome headless con CDP en `http://127.0.0.1:${SAT_CDP_PORT:-18800}` automáticamente si no existe (usa el binario de `CHROME_BIN` o el detectado por plataforma; perfil en `${SAT_CHROME_PROFILE:-$TMPDIR/sat-buzon-chrome-profile}`). Para deshabilitar el auto-spawn y reusar un Chrome propio, exporta `SAT_NO_SPAWN=1`.
2. Entra a `https://wwwmat.sat.gob.mx/personas/iniciar-sesion`.
3. Usa el lanzador del Buzón Tributario.
4. Lee `SAT_RFC` y `SAT_PASSWORD` del entorno o de archivos shell (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, etc.).
5. Resuelve el CAPTCHA con `TWOCAPTCHA_API_KEY` (acepta `CAPTCHA_SOLVER_API_KEY` como alias por compatibilidad).
6. Consulta sólo:
   - `https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/`
   - `https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/`
   - `https://wwwmat.sat.gob.mx/iniciar-expediente/mis-documentos/`
7. Guarda screenshots y `state.json` en `${SAT_BUZON_ARTIFACTS_DIR:-$(pwd)/artifacts}/sat-buzon-<timestamp>/`. Por default cae en la carpeta donde corriste el comando, no dentro de la skill.

## Cómo resumir resultados

Lee el JSON final que imprime el script o abre `state.json`. Reporta en español, breve:

- **Mis notificaciones:** total pendientes y si hay filas/resultados.
- **Mis comunicados:** mensajes no leídos y leídos relevantes con fecha y título.
- **Mis documentos:** secciones visibles, por ejemplo Cobranza/Líneas de captura.

Si el listado muestra enlaces o documentos individuales, indica que **no se abrieron** por seguridad legal y pide confirmación si el usuario quiere abrirlos.

## Memoria de datos personales

`SAT_RFC` se resuelve en este orden: env → shell rc → **profile compartido** (`${MEXICAN_SKILLS_PROFILE:-${XDG_CONFIG_HOME:-~/.config}/mexican-skills/profile.json}`, campo `rfc`).

El profile es un JSON plano con permisos `0600`. Si el usuario te dicta el RFC en la conversación, **escríbelo al profile y reúsalo** en lugar de pedirlo otra vez o exigir variables de entorno. Ejemplo del archivo:

```json
{
  "rfc": "XAXX010101000"
}
```

`SAT_PASSWORD` y `TWOCAPTCHA_API_KEY` son **secretos**: nunca los metas en el profile. Quédense en `process.env` o shell rc.

`rfcSource` en el output del `--preflight` te dice de dónde salió el RFC.

## Variables de entorno

| Variable | Propósito | ¿Acepta profile? | Default |
| -------- | --------- | ---------------- | ------- |
| `SAT_RFC` | RFC con homoclave del usuario. | Sí (`rfc`) | — (requerida) |
| `SAT_PASSWORD` | Contraseña SAT del usuario. **Secreto.** | No | — (requerida) |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. **Secreto.** | No | — (requerida) |
| `MEXICAN_SKILLS_PROFILE` | Override del path del profile. | — | `${XDG_CONFIG_HOME:-~/.config}/mexican-skills/profile.json` |
| `SAT_CDP_PORT` / `SAT_CDP_URL` | Puerto / URL del Chrome CDP. | `18800` / `http://127.0.0.1:18800` |
| `SAT_CHROME_PROFILE` | Perfil de Chrome para reusar sesión. | `${TMPDIR}/sat-buzon-chrome-profile` |
| `SAT_CHROME_LOG` | Log de Chrome. | `${TMPDIR}/sat-buzon-chrome.log` |
| `SAT_NO_SPAWN` | `1` para no lanzar Chrome automáticamente (usar uno propio en `SAT_CDP_URL`). | unset (auto-spawn ON) |
| `CHROME_BIN` | Ruta al binario de Chrome/Chromium. | macOS: `/Applications/Google Chrome.app/...`; Linux: detección automática |
| `SAT_BUZON_ARTIFACTS_DIR` | Carpeta de artefactos (screenshots, `state.json`). | `$(pwd)/artifacts` (CWD donde corres el comando) |
| `SAT_BUZON_TIMEOUT_MS` | Timeout general en ms. | `60000` |

## Instalación

```bash
cd <skill-root>
npm install
```

Esto instala `playwright-core` localmente. La skill usa el Chrome del sistema (no descarga un Chromium propio).

## Troubleshooting

- Si Chrome CDP falla, revisa el log apuntado por `SAT_CHROME_LOG`.
- Si el login se queda en la página de contraseña, normalmente fue CAPTCHA incorrecto; el script reintenta hasta 3 veces.
- Si SAT cambia URLs o iframes, inspecciona screenshots `01-start.png`, `02-launcher.png`, `03-login-*.png` y `04-after-submit-*.png` dentro del `runDir`.
- Si `playwright-core` falta, corre `npm install` en la raíz de la skill.
