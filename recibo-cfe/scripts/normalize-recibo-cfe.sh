#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Cross-platform date helper (macOS bsdate y GNU date aceptan +%d-%m-%Y).

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Uso: $0 <pdf-origen> [directorio-destino]" >&2
  exit 1
fi

src="$1"
out_dir="${2:-${CFE_ARTIFACTS_DIR:-$(pwd)/artifacts}}"
prefix="${CFE_PDF_NAME_PREFIX:-Recibo CFE}"

if [[ ! -f "$src" ]]; then
  echo "No existe el archivo origen: $src" >&2
  exit 1
fi

mkdir -p "$out_dir"

fecha="$(TZ=America/Mexico_City date +%d-%m-%Y)"
dest="$out_dir/${prefix} ${fecha}.pdf"

if [[ "$src" == "$dest" ]]; then
  echo "$dest"
  exit 0
fi

mv -f "$src" "$dest"
echo "$dest"
