#!/usr/bin/env -S uv run --isolated --python 3.14 python
"""Show bounded ForgeFlow unknown-finding proposals and accepted dynamic rules."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from forgeflow.proposals import accepted_dynamic_rules, discover_proposals, pending_proposals


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repository", help="OWNER/REPO")
    args = parser.parse_args()
    payload = {
        "discovered": [asdict(item) for item in discover_proposals(args.repository)],
        "pending": [asdict(item) for item in pending_proposals(args.repository)],
        "accepted_dynamic_rules": [
            asdict(item) for item in accepted_dynamic_rules(args.repository)
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
