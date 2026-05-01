---
name: constancia-fiscal-extractor
description: Extrae datos fiscales estructurados (RFC, nombre o razón social, domicilio, régimen fiscal, obligaciones) de un PDF de la Constancia de Situación Fiscal mexicana del SAT y los normaliza a JSON. Úsala cuando el usuario te dé una CSF (también llamada "constancia fiscal", "constancia del SAT", "PDF del SAT" o "situación fiscal") y necesites su contenido en JSON — por ejemplo para llenar una solicitud de factura, poblar un perfil de facturación, validar identidad fiscal, o encadenar con skills de facturación. NO la uses cuando "constancia" se refiera a otro documento (estudios, laboral, no adeudo, residencia, etc.) — sólo aplica a la Constancia de Situación Fiscal del SAT.
---

# Constancia de Situación Fiscal — Extractor

> Tip: si necesitas **descargar** la CSF antes de parsearla, usa la skill hermana [`constancia-situacion-fiscal`](../constancia-situacion-fiscal/) de este mismo repo: inicia sesión en SAT, resuelve el CAPTCHA con `TWOCAPTCHA_API_KEY` y baja el PDF real validando los magic bytes `%PDF`. Luego pasa el PDF resultante a esta skill para extraer los campos a JSON. La skill [`agent-browser`](https://github.com/agent-browser) también es buena alternativa cuando esté disponible.

## Qué hace

La *Constancia de Situación Fiscal* es el documento que el SAT emite a cada contribuyente registrado. Contiene RFC, nombre o razón social, domicilio fiscal, regímenes registrados y obligaciones. Esta skill convierte ese PDF en un objeto JSON normalizado que otras skills (e.g. de facturación) pueden consumir directamente.

Sin red, sin telemetría, sin dependencias externas: sólo Python 3 stdlib. Corre igual en macOS y Linux.

## Invariantes del agente

**Reglas obligatorias al usar esta skill:**

0. **Responde siempre en español** (neutro mexicano). Sólo las claves del JSON quedan en inglés por diseño, y los mensajes internos de `validate.py` permanecen en inglés.
1. **Nunca inventes valores que no estén en el documento.** Si un campo es ilegible, borroso o no aparece, **omítelo del JSON** (no emitas `""` ni `null`). Si el RFC mismo no se puede leer con certeza, detente y pídele al usuario una mejor versión.
2. **Verifica RFC y código postal carácter por carácter.** Estos se validan server-side por servicios downstream (e.g. facturación). Un dígito mal y la factura se rechaza.
3. **La constancia es PII.** No la subas a servicios externos, no pegues su contenido en canales compartidos, y no dejes el JSON normalizado en ubicaciones compartidas. Escribe el output sólo donde el usuario lo indique.
4. **Reporta los datos extraídos al usuario en español** antes de considerar el trabajo terminado — nombre, RFC, tipo de persona, CP, régimen principal — y deja que confirme antes de encadenar con otras skills.

## Pre-flight

Antes de leer el PDF o extraer cualquier dato, corre este pre-flight con la ruta absoluta del PDF:

```bash
python3 ./scripts/preflight.py "<PDF_PATH>"
```

El script verifica:

- El archivo existe, es regular y no está vacío.
- Es un PDF de verdad (magic bytes `%PDF-`).
- No está protegido con contraseña (no contiene `/Encrypt`).
- Reporta versión de Python y plataforma.

Exit code `0` = OK; `1` = falló (razones en `issues` del JSON impreso). Stdlib only, sin dependencias.

### Pre-flight semántico (lo haces tú)

Después de pasar el pre-flight mecánico, lee la primera página del PDF y confirma:

- **Es una Constancia de Situación Fiscal del SAT.** Busca *"Cédula de Identificación Fiscal"* o *"Constancia de Situación Fiscal"* y el logo del SAT. Si es otro documento (factura/CFDI, opinión de cumplimiento, acuse de inscripción, comprobante de domicilio, etc.), detente y dilo.
- **El RFC y el código postal son legibles carácter por carácter.** Si el escaneo está borroso, cortado, rotado o con sombras que tapen dígitos, pide una mejor versión. **No adivines.**
- **La constancia parece vigente.** Si el `Estatus en el padrón` dice algo distinto de `ACTIVO` (e.g. `SUSPENDIDO`, `CANCELADO`), avísale al usuario antes de encadenar con skills de facturación — la factura se va a rechazar.

Si todo pasa, sigue con **Steps**.

## Steps

1. **Origen del PDF.**
   - Si el usuario tiene el PDF en disco: usa esa ruta absoluta como `<PDF_PATH>`.
   - Si NO lo tiene: pídele que lo descargue, o usa la skill [`constancia-situacion-fiscal`](../constancia-situacion-fiscal/) de este repo y usa la ruta `pdfPath` o `pdfDeliverySafePath` que devuelve.
2. **Pre-flight.** Corre `./scripts/preflight.py <PDF_PATH>` y los chequeos visuales descritos arriba.
3. **Lee el PDF.** Lee sólo la primera página salvo que el documento sea inusualmente largo — todos los datos de identidad fiscal viven en la página 1.
4. **Extrae los campos** (ver tabla de mapeo abajo) en un objeto JSON. Las claves van en inglés; los valores vienen de las etiquetas en español del documento. **Omite la clave por completo** si el valor no está presente (no emitas `""` ni `null`).
5. **Pasa el JSON por `./scripts/validate.py`** para chequear campos requeridos, normalizar RFC y código postal, y derivar `personaType` / `primaryRegimeCode` / `currentRegimes`.
6. **Reporta el JSON normalizado** al usuario. Escríbelo a un archivo sólo si el usuario nombró una ruta explícitamente.

## Field mapping

### Identidad

| JSON key | Etiqueta en español |
|---|---|
| `rfc` | RFC |
| `nameOrBusinessName` | Nombre / Denominación o Razón Social |
| `capitalRegime` | Régimen Capital *(persona moral solamente)* |
| `commercialName` | Nombre Comercial |
| `startDateOfOperations` | Fecha inicio de operaciones |
| `statusInRegistry` | Estatus en el padrón |
| `dateOfLastStatusChange` | Fecha de último cambio de estado |

### Domicilio (Datos del Domicilio Registrado)

| JSON key | Etiqueta |
|---|---|
| `postalCode` | Código Postal |
| `roadType` | Tipo de Vialidad |
| `roadName` | Nombre de Vialidad |
| `exteriorNumber` | Número Exterior |
| `interiorNumber` | Número Interior |
| `colonyName` | Nombre de la Colonia |
| `localityName` | Nombre de la Localidad |
| `municipalityName` | Nombre del Municipio o Demarcación Territorial |
| `stateName` | Nombre de la Entidad Federativa |
| `betweenStreet` | Entre Calle |
| `andStreet` | Y Calle |

### Regímenes (Datos del Régimen)

La constancia lista uno o más regímenes con código, nombre y fechas. Emítelos como array en `regimes`:

```json
"regimes": [
  {
    "code": "612",
    "name": "Régimen de las Personas Físicas con Actividades Empresariales y Profesionales",
    "startDate": "2018-01-01",
    "endDate": null
  }
]
```

Un régimen sin `endDate` (o con `Vigente`) está activo. El validator selecciona el primer activo como `primaryRegimeCode`.

## Reglas de extracción

- Las fechas en la constancia salen como `DD/MM/YYYY`. Emítelas como ISO `YYYY-MM-DD`.
- El código postal debe ser 5 dígitos. El validator rechaza cualquier otra cosa.
- El RFC es 13 caracteres para *persona física*, 12 para *persona moral*. Normaliza a mayúsculas, sin espacios. El validator deriva `personaType` de la longitud.
- Deja fuera del JSON `capitalRegime`, `commercialName`, `interiorNumber`, `betweenStreet`, `andStreet` si no aparecen en el documento — un campo en blanco en la constancia es común y no debe convertirse en `""`.

## Correr el validator

```bash
cat "<JSON_INPUT_PATH>" | python3 ./scripts/validate.py > "<OUTPUT_PATH>"
```

O en un one-shot con heredoc:

```bash
python3 ./scripts/validate.py <<'JSON'
{
  "rfc": "XAXX010101000",
  "nameOrBusinessName": "PUBLICO EN GENERAL",
  "postalCode": "06100",
  "regimes": [
    {"code": "612", "name": "Personas Físicas con Actividades Empresariales", "startDate": "2018-01-01"}
  ]
}
JSON
```

El ejemplo usa el RFC genérico publicado por el SAT `XAXX010101000` ("público en general"). **Nunca sustituyas un RFC real en un comando de ejemplo.**

### Códigos de salida

- `0` — válido; JSON normalizado en stdout.
- `1` — validación falló (campo requerido faltante, RFC con longitud incorrecta, CP con menos/más de 5 dígitos, JSON malformado).

### Qué agrega el validator

- `personaType`: `"FISICA"` o `"MORAL"`, derivado de la longitud del RFC.
- `primaryRegimeCode`: el `code` del primer régimen activo (si se proporcionó `regimes`).
- `currentRegimes`: el subconjunto de `regimes` sin `endDate`.
- Normaliza `rfc` (mayúsculas, sin espacios) y `postalCode` (5 dígitos).

## Encadenamiento con otras skills

El output normalizado calza directamente con skills de facturación que necesitan la identidad fiscal del contribuyente:

| Esta skill emite | Campo de facturación downstream |
|---|---|
| `rfc` | `rfc` |
| `nameOrBusinessName` | `nombres` o `razonSocial` |
| `postalCode` | `codigoPostal` |
| `personaType` | `persona` |
| `primaryRegimeCode` | `regimenFiscal` |

La skill downstream todavía necesita `usoCfdi` (G03, D01, etc.) y `correoElectronico` del usuario — la constancia no los contiene.

## Pre-requisitos

- **Python 3.8+** (stdlib only). En macOS viene preinstalado; en Linux usualmente también, o `apt install python3` / `dnf install python3`.
- **Permisos de ejecución** en los scripts:
  ```bash
  chmod +x scripts/preflight.py scripts/validate.py
  ```
- Esta skill no necesita Node, ni `playwright-core`, ni red.

## Anonimato y portabilidad

Esta skill es **standalone, stateless y agnóstica del usuario**. No carga datos del usuario, ni API keys, ni configuración específica de máquina. Para reusarla en otro lado, copia la carpeta — los dos scripts dependen sólo de la stdlib de Python 3.

### Disciplina de paths

- **Usa rutas absolutas** cuando le pases `<PDF_PATH>` a los scripts. El CWD del agente es impredecible.
- Los scripts internamente expanden `~` y resuelven symlinks, así que el usuario puede pasar `~/Downloads/...` y va a funcionar — pero el agente debe pasar absolutas.

### Manejo de datos (refuerza invariante #3)

- Los scripts leen de stdin o argumento CLI, escriben sólo a stdout/stderr. Nada se persiste, loguea o manda a la red. Cero telemetría.
- El JSON extraído es PII. Escríbelo sólo a una ruta que el usuario nombre explícitamente. No pegues el JSON completo en canales compartidos (PRs, Slack público, issues, gists).
- Stderr puede incluir el path del usuario (e.g. `/home/<user>/Descargas/...`). Devuélveselo, pero no lo pegues en canales compartidos.
