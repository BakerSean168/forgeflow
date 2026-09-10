"""Operator preflight commands for ForgeFlow Policy V1."""

import argparse
import asyncio
import json

from forgeflow.adapters.github import preflight_github_repository


def _parse_repo(value: str) -> tuple[str, str]:
    owner, sep, repo = value.strip().partition("/")
    if not sep or not owner or not repo or "/" in repo:
        raise argparse.ArgumentTypeError("repository must be OWNER/REPO")
    return owner, repo


async def _github(repo: tuple[str, str]) -> int:
    result = await preflight_github_repository(*repo)
    print(
        json.dumps(
            {
                "status": result.status,
                "repository": f"{repo[0]}/{repo[1]}",
                "installation_id": result.installation_id,
            },
            sort_keys=True,
        )
    )
    return 0 if result.status == "READY" else 2


def main() -> None:
    parser = argparse.ArgumentParser(description="ForgeFlow Policy deployment preflight")
    sub = parser.add_subparsers(dest="command", required=True)
    github = sub.add_parser("github", help="verify the Open SWE GitHub App for one repository")
    github.add_argument("repository", type=_parse_repo)
    args = parser.parse_args()
    if args.command == "github":
        raise SystemExit(asyncio.run(_github(args.repository)))
    raise SystemExit(2)


if __name__ == "__main__":
    main()
