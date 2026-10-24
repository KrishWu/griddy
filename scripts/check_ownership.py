#!/usr/bin/env python3
"""List files your branch changed outside your workstream's paths.

Usage:  python3 scripts/check_ownership.py B            (compares against origin/main)
        python3 scripts/check_ownership.py B main       (compares against another ref)

Exit code 1 if you touched another workstream's files, so it can gate a push.
Shared files are reported as warnings: they are allowed but need a team heads-up.
"""

import fnmatch
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def matches(path: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, g) or (g.endswith("/**") and path.startswith(g[:-2])) for g in globs)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    ws = sys.argv[1].upper()
    base = sys.argv[2] if len(sys.argv) > 2 else "origin/main"
    owners = json.loads((ROOT / "ownership.json").read_text())
    if ws not in "ABCDE" or ws not in owners:
        print(f"Unknown workstream {ws!r}; use one of A B C D E")
        return 2

    merge_base = subprocess.run(["git", "merge-base", base, "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    committed = subprocess.run(["git", "diff", "--name-only", merge_base], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    changed = sorted(set(committed + untracked))

    mine = owners[ws]["paths"]
    shared = owners["shared"]
    foreign, warn = [], []
    for f in changed:
        if matches(f, mine):
            continue
        if matches(f, shared):
            warn.append(f)
            continue
        owner = next((k for k in "ABCDE" if k != ws and matches(f, owners[k]["paths"])), "unowned")
        foreign.append(f"{f}  (owned by {owner})")

    print(f"Workstream {ws}: {owners[ws]['name']}  |  {len(changed)} changed file(s) vs {base}")
    for f in warn:
        print(f"  WARN shared file: {f}  -> tell the team before merging")
    for f in foreign:
        print(f"  FAIL not yours:   {f}")
    if not foreign:
        print("  OK: no other workstream's files touched")
    return 1 if foreign else 0


if __name__ == "__main__":
    sys.exit(main())
