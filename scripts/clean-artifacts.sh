#!/usr/bin/env bash
#
# Borra los artifacts/ acumulados por las skills (PDFs, screenshots, state.json
# con datos personales). Usa esto periódicamente o cuando vayas a compartir el
# repo.
#
# Uso:
#   ./scripts/clean-artifacts.sh              # borra todo
#   ./scripts/clean-artifacts.sh --dry-run    # sólo lista
#   ./scripts/clean-artifacts.sh --older-than 7   # borra runs >7 días
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
DAYS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=1
      shift
      ;;
    --older-than)
      DAYS="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Argumento desconocido: $1" >&2
      exit 2
      ;;
  esac
done

# Encuentra todas las carpetas artifacts/ dentro del repo (excluyendo node_modules).
targets=()
while IFS= read -r -d '' dir; do
  targets+=("$dir")
done < <(find "$ROOT" \
  -type d -name node_modules -prune -o \
  -type d -name artifacts -print0)

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "No hay carpetas artifacts/ que limpiar."
  exit 0
fi

deleted=0
for dir in "${targets[@]}"; do
  if [[ -n "$DAYS" ]]; then
    while IFS= read -r -d '' path; do
      if (( DRY_RUN )); then
        echo "[dry-run] borraría: $path"
      else
        rm -rf "$path"
        echo "borrado: $path"
        deleted=$((deleted + 1))
      fi
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -mtime "+$DAYS" -print0)
  else
    while IFS= read -r -d '' path; do
      if (( DRY_RUN )); then
        echo "[dry-run] borraría: $path"
      else
        rm -rf "$path"
        echo "borrado: $path"
        deleted=$((deleted + 1))
      fi
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0)
  fi
done

if (( DRY_RUN )); then
  echo "(dry-run) sin cambios"
else
  echo "Total borrados: $deleted"
fi
