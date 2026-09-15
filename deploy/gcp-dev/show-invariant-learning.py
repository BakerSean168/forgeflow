#!/usr/bin/env -S uv run --isolated --python 3.14 python
"""Show bounded ForgeFlow project invariant-learning summary."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from forgeflow.learning import summarize_repository


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repository", help="OWNER/REPO")
    args = parser.parse_args()
    print(json.dumps([asdict(item) for item in summarize_repository(args.repository)], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
