# TODO — pago-infracciones-jalisco

Pendientes en orden de costo. Marcar con `[x]` cuando se completen.

## 1. Verificar CI en GitHub (gratis)

- [ ] Confirmar que el job `Preflight & self-test` (Ubuntu + macOS) pasó tras los commits `eeab3e6` y `8ed5d9d`.
- Si rompió en Ubuntu, ajustar `defaultChromeBinary()` o el step de `npm ci` y re-pushear.

## 2. Validar la heurística `no_tiene_adeudos_probable` (~$0.003 USD)

La heurística se confirmó con 1 caso real (un vehículo sin multas). No sé si el portal usa la misma plantilla `frmError` cuando los datos no coinciden con un vehículo registrado.

- [ ] Correr el flujo con datos deliberadamente inválidos (placa real + serie mala, p.ej.).
- [ ] Comparar el HTML resultante con el del caso "sin adeudos".
- Si la respuesta es la misma plantilla `frmError` con `Información` vacío:
  - Distinguir los dos casos requiere otra señal (status code, longitud del HTML, presencia de algún clase específica).
  - Actualizar `extractResultadosFromHTML()` en `scripts/jalisco-flow.js` y los `summary` documentados en `SKILL.md` y `references/portal-jalisco.md`.

## 3. Validar el ramo `lista_adeudos` (~$0.003 USD + acceso a una placa con multas)

El parser de la tabla de adeudos (`document.querySelectorAll('table tbody tr')`) está implementado por inspección esperada del DOM, no validado contra HTML real con infracciones.

- [ ] Conseguir una placa con multas registradas (propia o cedida por un usuario).
- [ ] Correr la consulta y verificar que `tableRows` extrae correctamente: folio, autoridad, descripción, monto, descuento, total, fecha límite.
- [ ] Si el orden o el shape no coincide, ajustar el parser para emitir un objeto estructurado por fila en lugar de un arreglo de strings.
- [ ] Actualizar la sección "Plantilla A — Lista de adeudos" en `references/portal-jalisco.md` con un ejemplo real (sanitizado).

## Caveats ya documentados

Estos están en `SKILL.md` como troubleshooting/limitaciones, no como pendientes de implementación:

- 2Captcha v2 invisible es frágil; el `userAgent` mejora la tasa, no garantiza.
- Linux pasa preflight + self-test en CI, pero el flujo completo no se probó en vivo en una máquina Linux.
- El pago (3DS, OTP, datos de tarjeta) es out-of-scope; vivirá en un skill aparte cuando se necesite.
