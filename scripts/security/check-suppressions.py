#!/usr/bin/env python3
"""Checks that every scanner suppression carries a reason (and an expiry,
where the tool supports one). See docs/security-scanning.md.

- .trivyignore.yaml: each vulnerabilities/misconfigurations/secrets entry
  needs `statement` and `expired_at` (YYYY-MM-DD, not in the past).
- osv-scanner.toml: each [[IgnoredVulns]] needs `reason` and `ignoreUntil`
  (not in the past).
- .gitleaks.toml: each [[allowlists]] needs a `description`.
- Go sources: each `#nosec` needs a rule ID and a `-- reason`.

Standard library only, so it runs anywhere python3 >= 3.11 does. The YAML
reader only understands the flat list layout .trivyignore.yaml uses.
"""

import datetime
import pathlib
import re
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
TODAY = datetime.date.today()
errors: list[str] = []


def check_date(where: str, field: str, value) -> None:
    if isinstance(value, datetime.datetime):
        value = value.date()
    if isinstance(value, str):
        try:
            value = datetime.date.fromisoformat(value.strip().strip("'\"")[:10])
        except ValueError:
            errors.append(f"{where}: {field} {value!r} is not a YYYY-MM-DD date")
            return
    if not isinstance(value, datetime.date):
        errors.append(f"{where}: missing {field}")
    elif value < TODAY:
        errors.append(f"{where}: {field} {value} has passed; re-triage and renew or remove it")


def trivy() -> None:
    path = ROOT / ".trivyignore.yaml"
    if not path.exists():
        return
    entries: list[tuple[int, dict]] = []
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.split(" #", 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            continue  # top-level section key
        m = re.match(r"\s*(- )?\s*([A-Za-z_]+):\s*(.*)$", line)
        if not m:
            continue
        if m.group(1):
            entries.append((n, {}))
        if entries:
            entries[-1][1][m.group(2)] = m.group(3)
    for n, e in entries:
        where = f".trivyignore.yaml:{n} ({e.get('id', '?')})"
        if not e.get("statement", "").strip("'\" "):
            errors.append(f"{where}: missing statement (the reason)")
        check_date(where, "expired_at", e.get("expired_at"))


def osv() -> None:
    path = ROOT / "osv-scanner.toml"
    if not path.exists():
        return
    for v in tomllib.loads(path.read_text()).get("IgnoredVulns", []):
        where = f"osv-scanner.toml ({v.get('id', '?')})"
        if not str(v.get("reason", "")).strip():
            errors.append(f"{where}: missing reason")
        check_date(where, "ignoreUntil", v.get("ignoreUntil"))


def gitleaks() -> None:
    path = ROOT / ".gitleaks.toml"
    if not path.exists():
        return
    for i, a in enumerate(tomllib.loads(path.read_text()).get("allowlists", [])):
        if not str(a.get("description", "")).strip():
            errors.append(f".gitleaks.toml: allowlists[{i}] missing description")


def nosec() -> None:
    for path in ROOT.glob("**/*.go"):
        if any(p in path.parts for p in ("node_modules", ".git", ".bin")):
            continue
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if "#nosec" in line and not re.search(r"#nosec G\d+(,G\d+)* -- \S", line):
                errors.append(f"{path.relative_to(ROOT)}:{n}: #nosec needs a rule ID and '-- reason'")


trivy()
osv()
gitleaks()
nosec()
if errors:
    print("Suppression policy violations:", *errors, sep="\n  ")
    sys.exit(1)
print("All suppressions have a reason and a current expiry.")
