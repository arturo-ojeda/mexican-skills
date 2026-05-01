#!/usr/bin/env bash
#
# Borra artifacts/ acumulados (PDFs, screenshots, state.json con datos
# personales) de las skills.
#
# Por default opera sobre `$(pwd)/artifacts/` — la carpeta donde el usuario
# corre los flujos. También puedes pasarle uno o más directorios para
# limpiarlos explícitamente, o usar --recursive para buscar artifacts/ debajo
# de un árbol.
#
# Uso:
#   ./clean-artifacts.sh                     # borra ./artifacts/* del CWD
#   ./clean-artifacts.sh --dry-run           # sólo lista lo que borraría
#   ./clean-artifacts.sh --older-than 7      # borra entradas con mtime > 7 días
#   ./clean-artifacts.sh /path/a/dir [...]   # opera sobre los paths dados
#   ./clean-artifacts.sh --recursive ~/dev   # busca cualquier artifacts/ bajo ~/dev
#
set -euo pipefail

DRY_RUN=0
DAYS=""
RECURSIVE=0
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=1; shift ;;
    --older-than)
      DAYS="$2"; shift 2 ;;
    --recursive|-r)
      RECURSIVE=1; shift ;;
    -h|--help)
      sed -n '2,/^set -e/p' "$0" | sed 's/^# \{0,1\}//; $d'
      exit 0 ;;
    --)
      shift; while [[ $# -gt 0 ]]; do TARGETS+=("$1"); shift; done ;;
    -*)
      echo "Argumento desconocido: $1" >&2; exit 2 ;;
    *)
      TARGETS+=("$1"); shift ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS+=("$(pwd)")
fi

# Si --recursive: cada target se expande a sus artifacts/ descendientes;
# de lo contrario, cada target se interpreta como una carpeta cuyo "artifacts"
# inmediato (o sí mismo si ya se llama "artifacts") es el objetivo.
artifacts_dirs=()
for target in "${TARGETS[@]}"; do
  if [[ ! -e "$target" ]]; then
    echo "(omitido, no existe) $target" >&2
    continue
  fi
  if (( RECURSIVE )); then
    while IFS= read -r -d '' dir; do
      artifacts_dirs+=("$dir")
    done < <(find "$target" \
      -type d -name node_modules -prune -o \
      -type d -name artifacts -print0)
  else
    if [[ -d "$target" && "$(basename "$target")" == "artifacts" ]]; then
      artifacts_dirs+=("$target")
    elif [[ -d "$target/artifacts" ]]; then
      artifacts_dirs+=("$target/artifacts")
    else
      echo "(omitido, sin ./artifacts) $target" >&2
    fi
  fi
done

if [[ ${#artifacts_dirs[@]} -eq 0 ]]; then
  echo "No hay carpetas artifacts/ que limpiar."
  exit 0
fi

deleted=0
for dir in "${artifacts_dirs[@]}"; do
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
