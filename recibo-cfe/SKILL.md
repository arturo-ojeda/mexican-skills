---
name: recibo-cfe
description: Descarga el recibo más reciente de CFE (Comisión Federal de Electricidad) en PDF directamente desde Mi Espacio CFE. Inicia sesión con CFE_USERNAME + CFE_PASSWORD, detecta el último recibo, baja el PDF y lo deja con nombre normalizado en la carpeta de artefactos. Úsala cuando el usuario pida un recibo de luz, comprobante de domicilio, recibo CFE, factura de luz, recibo bimestral o un PDF para trámites donde necesite acreditar domicilio.
---

# Recibo CFE / Comprobante de domicilio

> Tip: si tienes la skill [`agent-browser`](https://github.com/agent-browser) instalada, considera usarla cuando CFE cambie su portal o introduzca CAPTCHA — su CLI es más resistente a cambios de DOM que el flujo HTTP de esta skill. Hoy esta skill funciona sin navegador (sólo `https` + cookies de Node), pero `agent-browser` es la opción recomendada cuando esté disponible y CFE rompa el flujo actual.

## Entrypoint estable

- Script principal: `./download-recibo-cfe.js`
- Ejecuta el flujo completo y devuelve JSON con `finalPath`.
- Nombre final por default: `Recibo CFE DD-MM-YYYY.pdf` (configurable con `CFE_PDF_NAME_PREFIX`).

## Pre-flight

Antes de ejecutar el flujo completo, valida el entorno:

```bash
node ./download-recibo-cfe.js --preflight
```

El pre-flight verifica:

- Versión de Node y plataforma.
- Que las variables `CFE_USERNAME` y `CFE_PASSWORD` estén disponibles (en entorno o en archivos shell del usuario como `~/.zshrc`, `~/.zprofile`, etc.).
- Que `normalize-recibo-cfe.sh` exista y sea ejecutable.
- Que las URLs y la carpeta de artefactos estén configuradas.
- Reporta si `TWOCAPTCHA_API_KEY` está disponible (no se usa en el flujo actual, pero queda lista por si CFE introduce CAPTCHA).

Si falla, lee `issues` del JSON impreso y corrige antes de continuar.

## Self-test

```bash
node ./download-recibo-cfe.js --self-test
```

Imprime la configuración resuelta sin hacer red.

## Uso

```bash
node ./download-recibo-cfe.js
```

Flujo:

1. Lee credenciales (`CFE_USERNAME`, `CFE_PASSWORD`) desde entorno o archivos shell.
2. POST a `Login.aspx` de Mi Espacio CFE con los campos del formulario ASP.NET (incluyendo `__VIEWSTATE`, `__EVENTVALIDATION`).
3. Extrae el primer `__doPostBack(...DescargaPDF...)` de la tabla `GVHistorial` — el recibo más reciente.
4. POST a `default.aspx` con `__EVENTTARGET` apuntando a ese postback para disparar la descarga PDF.
5. Valida `Content-Disposition` / `Content-Type` antes de aceptar el binario.
6. Guarda el PDF en `<artifactsDir>/recibo-cfe-<timestamp>.pdf` y luego invoca `normalize-recibo-cfe.sh` para renombrarlo a `<prefix> DD-MM-YYYY.pdf`.

## Resultado mínimo aceptable

- PDF real descargado desde Mi Espacio CFE (validación por `Content-Type` / `Content-Disposition`).
- Ruta final dentro de `<artifactsDir>` (default: `<skill-root>/artifacts/`).
- No declarar éxito si no existe PDF real.

## Variables de entorno

| Variable | Propósito | Default |
| -------- | --------- | ------- |
| `CFE_USERNAME` | Usuario de Mi Espacio CFE (correo o RPU). | — (requerida) |
| `CFE_PASSWORD` | Contraseña de Mi Espacio CFE. | — (requerida) |
| `TWOCAPTCHA_API_KEY` | API key de 2Captcha (no se usa hoy, queda disponible si CFE introduce CAPTCHA). Acepta `CAPTCHA_SOLVER_API_KEY` como alias. | — (opcional) |
| `CFE_ARTIFACTS_DIR` | Carpeta de salida. | `<skill-root>/artifacts` |
| `CFE_LOGIN_URL` | URL del login. | `https://app.cfe.mx/Aplicaciones/CCFE/MiEspacio/Login.aspx` |
| `CFE_RECEIPTS_URL` | URL de recibos / postback. | `https://app.cfe.mx/Aplicaciones/CCFE/MiEspacio/default.aspx` |
| `CFE_PDF_NAME_PREFIX` | Prefijo del nombre final. | `Recibo CFE` |
| `CFE_TIMEOUT_MS` | Timeout por request en ms. | `30000` |
| `CFE_USER_AGENT` | User-Agent para los requests. | UA Chrome estándar |

## Instalación

```bash
cd <skill-root>
npm install
```

No tiene dependencias externas — sólo módulos nativos de Node (`https`, `fs`, etc.). El `npm install` queda como hábito por consistencia con las otras skills del repo.

## Entrega por chat

- Para adjuntar el PDF en la respuesta, usa `MEDIA:` con ruta relativa al workspace, no ruta absoluta del host.
- Formato preferido: `MEDIA:./artifacts/<nombre-del-archivo>.pdf`.
- Evita espacios en el nombre del archivo cuando lo vayas a mandar por chat. Si hace falta, crea una copia con guiones bajos antes de responder.
- Si el script devuelve una ruta absoluta, conviértela mentalmente a relativa para la entrega.

## Troubleshooting

- **HTTP no-200 en login**: revisa `CFE_USERNAME`/`CFE_PASSWORD`. CFE bloquea por intentos fallidos.
- **"Login no llegó a la página de recibos"**: el HTML devuelto no contiene `GVHistorial` ni `DescargaPDF`. Probable cambio de portal o credencial inválida.
- **"CFE no devolvió un PDF descargable"**: el postback devolvió HTML en lugar de binario. Suele indicar sesión expirada o cambio de selectores ASP.NET. Inspecciona los primeros 300 caracteres del cuerpo en el mensaje de error.
- **Cambio mayor del portal**: si CFE migra a un SPA o agrega CAPTCHA, usa la skill `agent-browser` para automatizar el navegador real.
