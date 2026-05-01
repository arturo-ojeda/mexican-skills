Skill: recibo-cfe

Entrypoint estable:
  ./download-recibo-cfe.js

Hace el flujo completo:
- carga credenciales (env o archivos shell como ~/.zshrc)
- login a Mi Espacio CFE
- detecta el recibo más reciente
- descarga el PDF
- normaliza el nombre a `<prefix> DD-MM-YYYY.pdf` (default: "Recibo CFE")
- lo deja en <CFE_ARTIFACTS_DIR>/ (default: <skill-root>/artifacts/)

Comandos:
  node ./download-recibo-cfe.js --preflight   # valida entorno
  node ./download-recibo-cfe.js --self-test   # imprime config resuelta sin tocar red
  node ./download-recibo-cfe.js               # flujo completo

Variables de entorno requeridas: CFE_USERNAME, CFE_PASSWORD.
Ver SKILL.md para la lista completa.
