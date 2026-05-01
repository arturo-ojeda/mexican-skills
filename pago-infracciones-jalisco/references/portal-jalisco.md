# Referencia del portal de adeudos vehiculares — Jalisco

## URL

`https://gobiernoenlinea1.jalisco.gob.mx/serviciosVehiculares/adeudos`

## Datos para consultar

Pídelos al usuario al momento o vía env vars/CLI args. No los hardcodees.

| Campo | Selector DOM | Required real | Notas |
| ----- | ------------ | ------------- | ----- |
| Número de placa | `#placa` | Sí | Validado por `formIsValid()`. |
| Número de serie / VIN | `#numeroSerie` | Sí (mínimo 5 chars) | Validado por `formIsValid()`. |
| Nombre del propietario / razón social | `#nombrePropietario` | No | Marcado `required` en HTML pero no exigido por el JS de validación. |
| Número de motor | `#numeroMotor` | No | Marcado `required` en HTML pero no exigido por el JS de validación. |

## Protección anti-bot

- **reCAPTCHA v2 invisible** (sitekey `6LehxCgfAAAAAE_6lvOTiXBtQNZCyc37CLZssnzC`, `size=invisible&sa=submit`).
- El botón **Consultar** *es* el captcha (clase `g-recaptcha`, callback `onSubmit`).
- El handler `onSubmit(token)` simplemente hace `frmAdeudos.submit()` después de validar — no valida el token client-side. Eso significa que se puede inyectar un token (de 2Captcha o equivalente) directamente en el textarea oculto `#g-recaptcha-response` y llamar `onSubmit(token)`.

### Captcha por consulta — confirmado empíricamente

El backend es **stateless**: el GET inicial no setea cookies de sesión, y un segundo POST sin captcha tras una consulta exitosa devuelve la página del formulario, no resultados. Cada consulta requiere un solve fresco. La sospecha de "guard sólo en primera capa" no se cumple aquí.

## Plantillas que devuelve el portal

### A. Lista de adeudos

Render de tabla con filas (`<table><tbody><tr>`). El parser captura cada `<td>` y lo expone en `tableRows`. Por cada fila, en orden, suelen aparecer: folio, autoridad/tipo, descripción, ubicación, monto original, descuento, total, fecha límite.

### B. "No tiene adeudos" (toast)

El portal puede mostrar un toast SweetAlert2 (`Swal.mixin` en `common.js`, `timer: 3000`):

```text
El vehículo no tiene adeudos
```

El parser detecta este texto en el body y reporta `summary: 'no_tiene_adeudos'`.

### C. Plantilla `frmError` con "Información" vacío

Cuando la consulta es exitosa pero el vehículo no tiene adeudos, frecuentemente el portal renderiza una página minimalista:

```html
<form id="frmError" action="/serviciosVehiculares/adeudos" method="post">
  <div class="alert alert-info">
    <button type="button" class="close" data-dismiss="alert">×</button>
    <strong>Información</strong>
    <!-- <div th:text="${msg}"></div> -->
  </div>
</form>
```

**El cuerpo del mensaje está literalmente comentado en HTML** — un bug en su template. No podemos leer un texto explícito. El parser detecta este patrón (form `frmError` + alert-info + título "Información", sin tabla) y reporta `summary: 'no_tiene_adeudos_probable'` con un `summaryNote` que explica la inferencia.

### D. "Pagos pendientes de aplicar"

```text
El vehículo cuenta con pagos pendientes de aplicar
```

Estado intermedio de un pago previo. **No volver a pagar.** El parser reporta `summary: 'pagos_pendientes_de_aplicar'`.

### E. Form inicial otra vez (captcha o datos rechazados)

Si el POST se cae por captcha inválido o datos que no coinciden, el portal devuelve la misma página inicial con `frmAdeudos`. El parser reporta `summary: 'captcha_o_datos_rechazados'`. Conviene reintentar y, si persiste, pedir al usuario verificar los datos.

## Interpretación al usuario

| `summary` | Mensaje sugerido al usuario |
| --------- | --------------------------- |
| `lista_adeudos` | Detalla cada fila por folio, monto, descuento, total. |
| `no_tiene_adeudos` | "El vehículo no tiene adeudos." |
| `no_tiene_adeudos_probable` | "Lectura más probable: sin adeudos. El portal omite el texto explícito por un bug en su template." |
| `pagos_pendientes_de_aplicar` | "Hay un pago previo en proceso. No volver a pagar." |
| `captcha_o_datos_rechazados` | "El portal devolvió el formulario inicial. Verifica placa y número de serie." |
| `unknown` | Reporta `bodyDigest` y pide al usuario revisar manualmente. |

## Evidencia mínima al terminar

El script guarda en `${JALISCO_INFRACCIONES_ARTIFACTS_DIR:-$(pwd)}/jalisco-run-<ts>/`:

- `01-form.png` — formulario antes de enviar.
- `02-resultado.png` — captura del resultado.
- `02-resultado.html` — HTML completo del resultado (útil para debug del template).
- `cookies.json` — cookies en cada fase (útil para confirmar que sigue siendo stateless).
- `investigation.json` — datos del experimento "segunda consulta sin captcha".
- `resultado.json` — resultado parseado completo.

Estos artefactos contienen PII (placa, serie, propietario): borra antes de compartir.

## Errores comunes

- **`ERROR_CAPTCHA_UNSOLVABLE` de 2Captcha**: Google rechaza el token por fingerprint/IP del solver. Reintentar tras unos minutos suele bastar.
- **Asumir que un descuento sigue vigente**: los montos y reglas cambian; lee siempre el portal actual.
- **Tratar `pagos_pendientes_de_aplicar` como infracción nueva**: es un pago previo aún procesándose.
- **Reusar un token de captcha**: Google los marca single-use; cada POST necesita un solve nuevo.
