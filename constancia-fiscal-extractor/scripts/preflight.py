#!/usr/bin/env python3
"""
Pre-flight check for a Constancia de Situación Fiscal PDF.

Verifies the file the user pointed at is actually a usable, unencrypted PDF
before any extraction is attempted. Stdlib only — runs on macOS and Linux with
Python 3.8+.

Usage:
    python3 scripts/preflight.py <PDF_PATH>

Exit codes:
    0 — OK, file is a usable PDF.
    1 — Validation failed (reason on stderr).
    2 — Wrong invocation.

Output (stdout, JSON):
    {
        "status": "preflight_ok" | "preflight_failed",
        "path": "...",
        "bytes": 123456,
        "magicHeader": "%PDF-1.7",
        "encrypted": false,
        "issues": []
    }
"""

import json
import os
import sys
from pathlib import Path


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: preflight.py <PDF_PATH>", file=sys.stderr)
        return 2

    raw = argv[1]
    path = Path(raw).expanduser().resolve()
    issues: list[str] = []

    if not path.exists():
        issues.append(f"El archivo no existe: {path}")
        emit({"status": "preflight_failed", "path": str(path), "issues": issues})
        return 1

    if not path.is_file():
        issues.append(f"No es un archivo regular: {path}")
        emit({"status": "preflight_failed", "path": str(path), "issues": issues})
        return 1

    size = path.stat().st_size
    if size == 0:
        issues.append("El archivo está vacío.")
        emit({"status": "preflight_failed", "path": str(path), "bytes": 0, "issues": issues})
        return 1

    try:
        with path.open("rb") as fh:
            head = fh.read(8)
            fh.seek(0)
            sample = fh.read(min(size, 1_048_576))
    except OSError as exc:
        issues.append(f"No se pudo leer el archivo: {exc}")
        emit({"status": "preflight_failed", "path": str(path), "bytes": size, "issues": issues})
        return 1

    magic_header = head[:8].decode("latin-1", errors="replace") if head else ""
    if not head.startswith(b"%PDF-"):
        issues.append(
            f"Magic bytes inválidos. Se esperaba '%PDF-' al inicio, se recibió: {magic_header!r}"
        )

    encrypted = b"/Encrypt" in sample
    if encrypted:
        issues.append("El PDF está protegido con contraseña (/Encrypt). Pídele al usuario uno desbloqueado.")

    payload = {
        "status": "preflight_failed" if issues else "preflight_ok",
        "path": str(path),
        "bytes": size,
        "magicHeader": magic_header,
        "encrypted": encrypted,
        "platform": sys.platform,
        "pythonVersion": sys.version.split()[0],
        "issues": issues,
    }
    emit(payload)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
