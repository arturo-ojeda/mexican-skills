#!/usr/bin/env python3
"""
Validate and enrich a Constancia de Situación Fiscal JSON extraction.

Reads a JSON object on stdin (the fields pulled from a constancia PDF by a
vision/text model), checks that the minimum fields are present, normalizes a
few of them, and derives extras (personaType, primaryRegimeCode) that make the
output directly usable by downstream invoicing skills.

Example:
    cat extracted.json | scripts/validate.py > normalized.json

Stdlib only — runs on macOS and Linux with Python 3.8+.
"""

import json
import re
import sys

REQUIRED_FIELDS = ["rfc", "nameOrBusinessName", "postalCode"]
RFC_LEN_FISICA = 13
RFC_LEN_MORAL = 12


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON on stdin: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict):
        print("Top-level JSON must be an object", file=sys.stderr)
        return 1

    missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing:
        print(f"Missing required fields: {', '.join(missing)}", file=sys.stderr)
        return 1

    rfc = str(data["rfc"]).strip().upper().replace(" ", "")
    data["rfc"] = rfc

    if len(rfc) == RFC_LEN_FISICA:
        data["personaType"] = "FISICA"
    elif len(rfc) == RFC_LEN_MORAL:
        data["personaType"] = "MORAL"
    else:
        print(
            f"RFC has unexpected length ({len(rfc)} chars): {rfc}",
            file=sys.stderr,
        )
        return 1

    postal_raw = str(data["postalCode"]).strip()
    postal_digits = re.sub(r"\D", "", postal_raw)
    if len(postal_digits) != 5:
        print(
            f"Postal code must normalize to 5 digits, got: {postal_raw!r}",
            file=sys.stderr,
        )
        return 1
    data["postalCode"] = postal_digits

    if data["personaType"] == "MORAL" and not data.get("capitalRegime"):
        print(
            "Warning: persona moral without capitalRegime — check extraction",
            file=sys.stderr,
        )

    regimes = data.get("regimes") or []
    if isinstance(regimes, list) and regimes:
        active = [r for r in regimes if isinstance(r, dict) and not r.get("endDate")]
        if active:
            data["currentRegimes"] = active
            primary = active[0].get("code")
            if primary:
                data["primaryRegimeCode"] = str(primary)

    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
