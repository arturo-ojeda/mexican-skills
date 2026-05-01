# TODO

Pendientes para cerrar la skill `imss-semanas-cotizadas` end-to-end.

## Bloqueante: validar fase 2 con SMS válido

La fase 1 quedó probada en HTTP-only (Imperva pasa, captcha + 2Captcha + retry funcionan, login submit reconocido por IMSS, `state.json` persistido). La fase 2 está implementada pero **nunca se ejecutó con un token válido** porque el día de la prueba se agotó la cuota de 2 SMS/día antes de poder validar.

Para cerrar:

1. Día con cuota fresca, correr fase 1 y guardar el `state.json` resultante.
2. Cuando llegue el SMS, correr fase 2: `IMSS_SMS_TOKEN=<código> node ./scripts/imss-flow.js`.
3. Verificar que `POST /usuarios/Token` devuelva `200` y un HTML que no incluya `tokenInvalid`/`tokenRequired`.
4. Confirmar que `findPdfDownloadUrl` localice el endpoint correcto y `tryDownloadPdf` traiga un buffer con magic bytes `%PDF`.

## PDF endpoint: heurística vs. selector estable

`findPdfDownloadUrl` busca anchors/`window.open`/form actions que matcheen `pdf|reporte|constancia|historia.?laboral|imprimir|descarga`. Es una red para no fallar si IMSS cambia el render.

Cuando tengamos el HTML real post-token (`after-token.html` del primer run exitoso), reemplazar la heurística por el selector exacto que use IMSS. Mantener la heurística como fallback con menor prioridad.

Sospecha por el patrón JSF/Servlet: el endpoint puede ser algo como:

- `/semanascotizadas-web/usuarios/HistoriaLaboralPDF`
- `/semanascotizadas-web/usuarios/ReporteSemanasCotizadas`
- `/semanascotizadas-web/conector/PDF`

Confirmar con un run real.

## Reenvío de SMS

IMSS expone `/semanascotizadas-web/usuarios/ReenvioToken` (anchor visible en el form de token). Útil cuando el SMS no llega.

Sugerencia de implementación:

- Flag `--resend-token` (sin valor) que reanuda el `state.json` y hace `GET /ReenvioToken` antes de salir con `awaiting_sms_token`.
- Cuidado: el reenvío también consume la cuota de 2 SMS/día.

## Detección de límite diario

Hoy detectamos `daily_limit_exceeded` después del POST de login con captcha (gastando un solve de 2Captcha). Posible optimización:

- Revisar el HTML del `GET` inicial a `/usuarios/IngresoAsegurado` para ver si IMSS ya muestra el aviso "Numero de intentos alcanzado" antes de pedir captcha.
- Si lo hace, salir con `daily_limit_exceeded` antes de gastar el solve.

## Edge case: correo no registrado

Cuando un usuario nuevo corre la skill por primera vez, IMSS le **registra** el correo en su sistema en el primer login exitoso. La skill no documenta explícitamente este "primer uso" — solo el caso de correo ya registrado a otra CURP. Considerar:

- Diferenciar `credentials_rejected` con razón = `email_unknown` vs. `email_belongs_to_other_curp`.
- Sumar al `SKILL.md` una nota corta sobre el primer uso.

## CI: agregar al matrix

`ci.yml` corre `node --check`, `lint-skills.js`, preflights y self-tests para todas las skills. Confirmar que `imss-semanas-cotizadas` esté incluido implícitamente vía `find */SKILL.md` y que el preflight pase con env vacío (exit 2). Hacer un dry-run local: `node ./scripts/lint-skills.js && node ./imss-semanas-cotizadas/scripts/imss-flow.js --self-test`.

## Notas sobre 2Captcha

Reportar como malo (`reportbad`) el captcha cuando IMSS lo rechaza, para que 2Captcha no nos cobre por solves erróneos. El endpoint es `https://2captcha.com/res.php?key=...&action=reportbad&id=<requestId>`. Hoy la skill no lo hace; agregar al loop de retry en `attemptCaptchaPhase`.
