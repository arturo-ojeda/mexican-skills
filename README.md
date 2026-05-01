# 🇲🇽 mexican-skills

> Agent skills para automatizar trámites mexicanos (SAT, CFE) desde Cursor, Claude Code u otro agente.

🍎 macOS · 🐧 Linux · ⚙️ Node 18+ · 📦 Cada skill es **independiente**: instalas sólo la que necesitas

## 🛠️ Skills

| | Skill | Qué hace |
|---|---|---|
| 📬 | [`buzon-tributario`](./buzon-tributario) | Lee mensajes del Buzón Tributario del SAT sin disparar acuses. |
| 📄 | [`constancia-situacion-fiscal`](./constancia-situacion-fiscal) | Descarga la CSF del SAT en PDF. |
| 🔍 | [`constancia-fiscal-extractor`](./constancia-fiscal-extractor) | Convierte un PDF de CSF en JSON normalizado. |
| ⚡ | [`recibo-cfe`](./recibo-cfe) | Descarga el recibo de luz más reciente para usar como comprobante de domicilio. |

Cada skill tiene su `SKILL.md` con todos los detalles. **Léelo antes de invocarla.**

```text
📄 constancia-situacion-fiscal  →  🔍 constancia-fiscal-extractor  →  💰 facturación
        (baja PDF)                       (PDF → JSON)
```

## 🚀 Setup

```bash
git clone <repo> && cd mexican-skills

# Instala sólo las skills que vayas a usar
cd buzon-tributario && npm install && cd ..
cd constancia-situacion-fiscal && npm install && cd ..
cd recibo-cfe && npm install && cd ..

# Configura secretos (las skills NO leen .env automáticamente; expórtalos)
cp .env.example .env && $EDITOR .env
export $(grep -v '^#' .env | xargs)

# Pre-flight (valida entorno antes de correr)
node ./constancia-situacion-fiscal/scripts/sat-flow.js --preflight
```

## 🔑 Variables clave

| | Variable | Para | Tipo |
|---|---|---|---|
| 🛂 | `SAT_RFC` | Skills SAT | PII (acepta profile) |
| 🔒 | `SAT_PASSWORD` | Skills SAT | **Secreto** |
| ⚡ | `CFE_USERNAME` | Skill CFE | PII (acepta profile) |
| 🔒 | `CFE_PASSWORD` | Skill CFE | **Secreto** |
| 🔒 | `TWOCAPTCHA_API_KEY` | CAPTCHA del SAT (cuenta en [2captcha.com](https://2captcha.com)) | **Secreto** |
| 🌐 | `CHROME_BIN` | Override del binario de Chrome (si la detección falla) | Path |

Lista completa: [`.env.example`](./.env.example).

**Resolución por dato:** `process.env` → `~/.zshrc`/`~/.zprofile`/`~/.bashrc`/`~/.bash_profile`/`~/.profile` → [profile](#-profile-pii-no-secreta) → preguntar.

## 🧠 Profile (PII no-secreta)

Sólo los **secretos** viven en env/shell rc. La PII no-secreta (RFC, nombre, CP, régimen, uso CFDI, email, usuario CFE) vive en un JSON local con permisos `0600`:

```text
${MEXICAN_SKILLS_PROFILE:-${XDG_CONFIG_HOME:-~/.config}/mexican-skills/profile.json}
```

```json
{
  "rfc": "XAXX010101000",
  "nameOrBusinessName": "PUBLICO EN GENERAL",
  "postalCode": "06100",
  "primaryRegimeCode": "612",
  "usoCfdi": "G03",
  "email": "mi@correo.com",
  "cfeUsername": "mi@correo.com"
}
```

Claves canónicas: `rfc`, `nameOrBusinessName`, `personaType`, `postalCode`, `primaryRegimeCode`, `regimes`, `address`, `usoCfdi`, `email`, `cfeUsername`. Úsalas para que las skills se hablen entre sí — el output normalizado de `constancia-fiscal-extractor` se mergea directo al profile.

**JAMÁS** metas secretos (`password`, `apiKey`, `token`, etc.) en el profile.

## 📁 Outputs

Los PDFs y screenshots caen en **`$(pwd)/artifacts/`** — la carpeta desde donde corres el comando, no dentro de la skill. Override por skill: `SAT_ARTIFACTS_DIR`, `SAT_BUZON_ARTIFACTS_DIR`, `CFE_ARTIFACTS_DIR`. Ya están ignoradas por git, pero contienen PII: bórralas antes de compartir.

```bash
rm -rf ./artifacts/*
```

## 📜 Convenciones

- 🇲🇽 Triggers en español neutro/mexicano. Claves JSON en inglés.
- ✅ `--preflight` y `--self-test` en cada skill (JSON con `status` + `issues`).
- 📤 Stdout = JSON estructurado; errores y progreso a stderr.
- 🚫 Cero datos personales hardcoded (los ejemplos usan el RFC genérico `XAXX010101000`).
- 🔒 Skills con `dependencies` commitean su `package-lock.json` e instalan con `npm ci`. Skills stdlib-only no tienen lock.

## 🤝 Compañero opcional

Si tu agente tiene [`agent-browser`](https://github.com/vercel-labs/agent-browser) instalado, úsalo como fallback cuando los portales del SAT/CFE cambien de DOM o agreguen CAPTCHA. Las skills de este repo no lo necesitan para correr.

## 📜 Licencia

[MIT](./LICENSE) © 2026 Arturo Ojeda
