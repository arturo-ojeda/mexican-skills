---
name: constancia-situacion-fiscal
description: Genera y descarga la Constancia de Situación Fiscal (CSF) del SAT en PDF. Inicia sesión en SAT con RFC + contraseña, resuelve el CAPTCHA (manual o con 2Captcha), navega al trámite 53027 y captura el PDF real validando los magic bytes %PDF. Úsala cuando el usuario pida CSF, constancia fiscal, constancia de situación fiscal, o un PDF del SAT con sus datos fiscales para facturación, trámites o validación de RFC.
---

# Constancia de Situación Fiscal (SAT)

Skill autónoma basada en `playwright-core`. Lanza Chrome del sistema vía CDP, hace login en el SAT (con CAPTCHA manual o vía 2Captcha), navega al trámite 53027 y captura el PDF real validando los magic bytes `%PDF`.

## Layout

```text
constancia-situacion-fiscal/
├── SKILL.md
├── package.json
└── scripts/
    ├── sat-flow.js                   # entrypoint principal
    ├── capture-live-constancia-pdf.js # reintento del tramo final
    └── sat-pdf-tools.js              # helpers compartidos
```

## Pre-flight

Antes de ejecutar el flujo completo, valida el entorno:

```bash
node ./scripts/sat-flow.js --preflight
```

El pre-flight verifica:

- Versión de Node y plataforma.
- Que `playwright-core` esté instalado (`npm install` dentro de la skill).
- Que `CHROME_BIN` apunte a un binario de Chrome/Chromium ejecutable (con default por plataforma).
- Que las variables `SAT_RFC`, `SAT_PASSWORD` y `TWOCAPTCHA_API_KEY` estén disponibles (en entorno o en archivos shell del usuario).
- La URL CDP configurada y la carpeta de artefactos.

Si falla, lee `issues` del JSON impreso y corrige antes de continuar.

## Entrypoints

- Flujo completo (login + CAPTCHA + descarga PDF): `./scripts/sat-flow.js`
- Reintento del tramo final sobre una sesión CDP ya autenticada: `./scripts/capture-live-constancia-pdf.js`

## Uso recomendado

```bash
node ./scripts/sat-flow.js --auto-solve
```

El script auto-arranca Chrome headless con CDP si no encuentra uno corriendo en `SAT_CDP_URL` (default `http://127.0.0.1:18800`). Usa `CHROME_BIN` o lo detecta por plataforma; el perfil queda en `${SAT_CHROME_PROFILE:-$TMPDIR/sat-csf-chrome-profile}`. Para reusar tu Chrome existente en lugar de lanzar uno nuevo, exporta `SAT_NO_SPAWN=1`.

## Self-test

```bash
node ./scripts/sat-flow.js --self-test
```

## CAPTCHA manual

```bash
node ./scripts/sat-flow.js ABC123
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

## Memoria de datos personales

El RFC es PII no-secreta: el usuario lo teclearía cien veces. Para evitarle eso esta skill resuelve `SAT_RFC` con esta cadena:

1. `process.env.SAT_RFC`
2. `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` (línea `SAT_RFC=...`).
3. **Profile compartido del repo**: `${MEXICAN_SKILLS_PROFILE:-${XDG_CONFIG_HOME:-~/.config}/mexican-skills/profile.json}`, campo `rfc`.

Si el RFC viene en alguna de esas tres, no se le pregunta al usuario. **Si no viene en ninguna y el usuario lo proporciona en la conversación, escríbelo al profile y reúsalo de ahí en adelante** (no lo pongas en variables de entorno). El profile es un JSON plano con permisos `0600`:

```json
{
  "rfc": "XAXX010101000"
}
```

`SAT_PASSWORD` y `TWOCAPTCHA_API_KEY` **son secretos** y JAMÁS se guardan en el profile. Quédense en `process.env` o en archivos shell del usuario.

El campo `rfcSource` que devuelve `--preflight` y `--self-test` te dice de dónde salió el RFC (`environment`, una ruta de shell rc, o el path del profile, o `missing`).

Para más datos del usuario (nombre, CP, régimen, uso CFDI, email) que pueden encadenarse con `constancia-fiscal-extractor` y skills de facturación, ver el README del repo. Convención: el JSON normalizado de `constancia-fiscal-extractor` se mergea directo al profile (mismo schema de claves canónicas).

## Variables de entorno

Las credenciales se leen primero del entorno; si faltan, intenta leerlas desde archivos shell del usuario (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`). El **RFC** además acepta el profile como tercer fallback (ver sección anterior).

| Variable | Propósito | ¿Acepta profile? | Default |
| -------- | --------- | ---------------- | ------- |
| `SAT_RFC` | RFC con homoclave del usuario. | Sí (`rfc`) | — (requerida) |
| `SAT_PASSWORD` | Contraseña SAT del usuario. **Secreto.** | No | — (requerida) |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha. Acepta `CAPTCHA_SOLVER_API_KEY` como alias. **Secreto.** | No | — (requerida para `--auto-solve`) |
| `MEXICAN_SKILLS_PROFILE` | Override del path del profile. | — | `${XDG_CONFIG_HOME:-~/.config}/mexican-skills/profile.json` |
| `SAT_CDP_URL` / `SAT_CDP_PORT` | URL / puerto del Chrome CDP. | `http://127.0.0.1:18800` / `18800` |
| `SAT_CHROME_PROFILE` | Perfil de Chrome (sesión persistente entre runs). | `${TMPDIR}/sat-csf-chrome-profile` |
| `SAT_CHROME_LOG` | Log de Chrome. | `${TMPDIR}/sat-csf-chrome.log` |
| `SAT_NO_SPAWN` | `1` para no lanzar Chrome automáticamente. | unset (auto-spawn ON) |
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

- `scripts/sat-pdf-tools.js`: helpers reutilizables del tramo final (localizar frame, disparar generar, capturar binario por CDP/Playwright, validar `%PDF`, normalizar nombre final). Lo consumen los dos entrypoints.
- `scripts/capture-live-constancia-pdf.js`: reintento quirúrgico del tramo final sobre una sesión CDP ya autenticada; sirve para capturar el PDF sin rehacer login.

El solver de CAPTCHA con 2Captcha está integrado dentro de `scripts/sat-flow.js` y se activa con `--auto-solve`; no hay un binario standalone.

### Reintento sólo del tramo final

```bash
node ./scripts/capture-live-constancia-pdf.js
```

Asume que ya existe una página viva del trámite 53027 en la sesión CDP y sólo intenta localizar frame + generar + capturar PDF real.

## Criterio operativo

- La skill no debe declarar éxito si no existe PDF real (validación de magic bytes `%PDF`).
- El único flujo soportado para operación normal es `scripts/sat-flow.js`.
