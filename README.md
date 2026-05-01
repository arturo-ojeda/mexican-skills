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

## 🔑 Variables clave

| | Variable | Para | Tipo |
|---|---|---|---|
| 🛂 | `SAT_RFC` | Skills SAT | PII |
| 🔒 | `SAT_PASSWORD` | Skills SAT | **Secreto** |
| ⚡ | `CFE_USERNAME` | Skill CFE | PII |
| 🔒 | `CFE_PASSWORD` | Skill CFE | **Secreto** |
| 🔒 | `TWOCAPTCHA_API_KEY` | CAPTCHA del SAT (cuenta en [2captcha.com](https://2captcha.com)) | **Secreto** |
| 🌐 | `CHROME_BIN` | Override del binario de Chrome (si la detección falla) | Path |

Lista completa: [`.env.example`](./.env.example).

**Resolución por dato:** `process.env` → `~/.zshrc`/`~/.zprofile`/`~/.bashrc`/`~/.bash_profile`/`~/.profile` → preguntar.

## 📁 Outputs

Los PDFs y screenshots caen directamente en **`$(pwd)`** — la carpeta desde donde corres el comando. Override por skill: `SAT_ARTIFACTS_DIR`, `SAT_BUZON_ARTIFACTS_DIR`, `CFE_ARTIFACTS_DIR`. Contienen PII: bórralos antes de compartir.

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
