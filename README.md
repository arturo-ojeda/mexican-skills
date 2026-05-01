# 🇲🇽 mexican-skills

> Agent skills para automatizar trámites mexicanos (SAT, CFE) desde Cursor, Claude Code u otro agente.

🍎 macOS · 🐧 Linux · ⚙️ Node 18+ · 🐍 Python 3.8+

## 🛠️ Skills

| | Skill | Qué hace |
|---|---|---|
| 📬 | [`buzon-tributario`](./buzon-tributario) | Lee mensajes del Buzón Tributario del SAT sin disparar acuses. |
| 📄 | [`constancia-situacion-fiscal`](./constancia-situacion-fiscal) | Descarga la CSF del SAT en PDF. |
| 🔍 | [`constancia-fiscal-extractor`](./constancia-fiscal-extractor) | Convierte un PDF de CSF en JSON normalizado. |
| ⚡ | [`recibo-cfe`](./recibo-cfe) | Descarga el recibo de luz más reciente para usar como comprobante de domicilio. |

> Cada skill tiene su `SKILL.md` con todos los detalles. **Léelo antes de invocarla.**

```text
📄 constancia-situacion-fiscal  →  🔍 constancia-fiscal-extractor  →  💰 facturación
        (baja PDF)                       (PDF → JSON)
```

## 🚀 Setup

```bash
# 1. Clona y entra
git clone <repo> && cd mexican-skills

# 2. Instala dependencias por skill (las que uses)
cd buzon-tributario && npm install && cd ..
cd constancia-situacion-fiscal && npm install && cd ..
cd recibo-cfe && npm install && cd ..

# 3. Configura credenciales
cp .env.example .env && $EDITOR .env
export $(grep -v '^#' .env | xargs)

# 4. Pre-flight (valida entorno antes de correr)
node ./constancia-situacion-fiscal/sat-flow.js --preflight
```

## 🔑 Variables clave

| | Variable | Para |
|---|---|---|
| 🛂 | `SAT_RFC`, `SAT_PASSWORD` | Skills SAT |
| ⚡ | `CFE_USERNAME`, `CFE_PASSWORD` | Skill CFE |
| 🤖 | `TWOCAPTCHA_API_KEY` | CAPTCHA del SAT (cuenta en [2captcha.com](https://2captcha.com)) |
| 🌐 | `CHROME_BIN` | Override del binario de Chrome (si la detección automática falla) |

📋 Lista completa: [`.env.example`](./.env.example) · 📖 Detalles por skill: cada `SKILL.md`.

## 📁 Outputs

Los PDFs y screenshots caen en **`$(pwd)/artifacts/`** — la carpeta desde donde corres el comando, no dentro de la skill. Override con `*_ARTIFACTS_DIR`.

```bash
# Limpia los artifacts del CWD actual
./scripts/clean-artifacts.sh

# Otras opciones
./scripts/clean-artifacts.sh --dry-run
./scripts/clean-artifacts.sh --older-than 7
./scripts/clean-artifacts.sh --recursive ~/dev
```

## 🤝 Recomendación: `agent-browser`

Si tienes [`agent-browser`](https://github.com/agent-browser) instalada, úsala como primera opción para flujos de navegador — es más estable cuando los portales del SAT/CFE cambian de DOM. Las skills aquí funcionan de forma autónoma, pero `agent-browser` es la opción recomendada cuando esté disponible.

## 📜 Convenciones

- 🇲🇽 Triggers en español neutro/mexicano en cada `SKILL.md`.
- ✅ `--preflight` y `--self-test` en cada skill (JSON con `status` + `issues`).
- 🔁 Variables del entorno con fallback a `~/.zshrc`, `~/.zprofile`, etc.
- 📤 Salida JSON estructurada para que el agente la parse con confianza.
- 🚫 Cero datos personales hardcoded.

## 🔒 Privacidad

- Las credenciales se inyectan en runtime; no hay secretos en el repo.
- Los ejemplos usan el RFC genérico del SAT: `XAXX010101000`.
- Las carpetas `artifacts/` (con datos personales) están ignoradas por git. Aun así, limpia con `clean-artifacts.sh` antes de compartir.

## 📜 Licencia

[MIT](./LICENSE) © 2026 Arturo Ojeda
