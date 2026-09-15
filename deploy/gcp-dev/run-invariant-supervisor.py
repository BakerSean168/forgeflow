#!/usr/bin/env python3
"""Advance at most one evidence-backed invariant proposal per invocation."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from langgraph_sdk import get_client

from forgeflow.proposals import (
    InvariantProposalDecision,
    pending_proposals,
    record_proposal_decision,
)


def _repositories(projects_file: Path) -> tuple[str, ...]:
    try:
        raw = json.loads(projects_file.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return ()
    if not isinstance(raw, list):
        return ()
    repos = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        repo = item.get("repo")
        if isinstance(repo, str) and repo.count("/") == 1:
            repos.append(repo)
    return tuple(dict.fromkeys(repos))


async def _assistant_id(client: Any) -> str:
    items = await client.assistants.search(graph_id="invariant_reviewer", limit=10)
    matches = [item for item in items if item.get("graph_id") == "invariant_reviewer"]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected exactly one invariant_reviewer assistant, found {len(matches)}"
        )
    assistant_id = matches[0].get("assistant_id")
    if not isinstance(assistant_id, str) or not assistant_id:
        raise RuntimeError("invariant_reviewer assistant has no assistant_id")
    return assistant_id


def _decision(values: dict[str, Any]) -> InvariantProposalDecision | None:
    raw = values.get("decision")
    if not isinstance(raw, dict):
        return None
    decision = raw.get("decision")
    if decision not in {"accept", "reject", "needs_more_evidence"}:
        return None
    triggers = raw.get("triggers", [])
    if not isinstance(triggers, (list, tuple)):
        return None
    return InvariantProposalDecision(
        decision=decision,
        title=str(raw.get("title", "")),
        triggers=tuple(str(item) for item in triggers),
        check=str(raw.get("check", "")),
        adversarial=str(raw.get("adversarial", "")),
        rationale=str(raw.get("rationale", "")),
    )


async def run_once(*, port: int, config_dir: Path, state_dir: Path) -> int:
    os.environ.setdefault("FORGEFLOW_POLICY_STATE_DIR", str(state_dir))
    auth = (config_dir / "local-auth.secret").read_text(encoding="utf-8").strip()
    client = get_client(
        url=f"http://127.0.0.1:{port}",
        headers={"Authorization": f"Bearer {auth}"},
    )
    assistant_id = await _assistant_id(client)
    projects = config_dir / "projects.json"
    candidate = None
    for repository in _repositories(projects):
        pending = pending_proposals(repository)
        if pending:
            candidate = pending[0]
            break
    if candidate is None:
        print("invariant_supervisor=no_pending_proposal")
        return 0

    thread_id = str(uuid5(NAMESPACE_URL, f"forgeflow:invariant-proposal:{candidate.proposal_id}"))
    await client.threads.create(
        thread_id=thread_id,
        if_exists="do_nothing",
        metadata={
            "source": "forgeflow-invariant-supervisor",
            "proposal_id": candidate.proposal_id,
            "repository": candidate.repository,
        },
    )

    state = await client.threads.get_state(thread_id)
    values = dict(state.get("values") or {})
    state_proposal = values.get("proposal")
    cached = (
        isinstance(state_proposal, dict)
        and state_proposal.get("revision_id") == candidate.revision_id
        and _decision(values) is not None
    )
    runs = await client.runs.list(thread_id, limit=20)
    matching = [
        run
        for run in runs
        if isinstance(run, dict)
        and isinstance(run.get("metadata"), dict)
        and run["metadata"].get("proposal_id") == candidate.proposal_id
        and run["metadata"].get("revision_id") == candidate.revision_id
    ]
    reviewer_run_id = next(
        (
            str(run.get("run_id"))
            for run in matching
            if run.get("status") in {"success", "completed"} and run.get("run_id")
        ),
        "",
    )
    if not cached:
        if any(run.get("status") in {"pending", "running"} for run in matching):
            print("invariant_supervisor=review_in_progress proposal=" + candidate.proposal_id)
            return 0
        created: dict[str, str] = {}

        def capture_run(meta: Any) -> None:
            value = meta.get("run_id") if isinstance(meta, dict) else getattr(meta, "run_id", None)
            if isinstance(value, str) and value:
                created["run_id"] = value

        await client.runs.wait(
            thread_id,
            assistant_id,
            input={"proposal": asdict(candidate)},
            metadata={
                "source": "forgeflow-invariant-supervisor",
                "proposal_id": candidate.proposal_id,
                "revision_id": candidate.revision_id,
            },
            config={"configurable": {"thread_id": thread_id}},
            multitask_strategy="reject",
            durability="sync",
            raise_error=True,
            on_run_created=capture_run,
        )
        reviewer_run_id = created.get("run_id", "")
        values = dict((await client.threads.get_state(thread_id)).get("values") or {})
        if not reviewer_run_id:
            reruns = await client.runs.list(thread_id, limit=20)
            reviewer_run_id = next(
                (
                    str(run.get("run_id"))
                    for run in reruns
                    if isinstance(run, dict)
                    and isinstance(run.get("metadata"), dict)
                    and run["metadata"].get("proposal_id") == candidate.proposal_id
                    and run["metadata"].get("revision_id") == candidate.revision_id
                    and run.get("run_id")
                ),
                "",
            )

    decision = _decision(values)
    model_id = values.get("reviewer_model_id")
    if decision is None or not isinstance(model_id, str) or not model_id:
        raise RuntimeError("invariant reviewer produced no valid structured decision")
    if not reviewer_run_id:
        raise RuntimeError("invariant reviewer run provenance is unavailable")
    try:
        event = record_proposal_decision(
            candidate,
            decision,
            reviewer_run_id=reviewer_run_id,
            reviewer_model_id=model_id,
        )
    except ValueError as exc:
        event = record_proposal_decision(
            candidate,
            InvariantProposalDecision(
                decision="reject",
                rationale=(
                    "Deterministic proposal validation rejected the reviewer output: "
                    + str(exc)[:240]
                ),
            ),
            reviewer_run_id=reviewer_run_id,
            reviewer_model_id=model_id,
        )
    if event is None:
        print("invariant_supervisor=ledger_unconfigured")
        return 0
    print(
        "invariant_supervisor="
        + event.status
        + " proposal="
        + event.proposal_id
        + " repository="
        + event.repository
        + " evidence="
        + str(event.evidence_count)
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument(
        "--config-dir",
        default=os.environ.get(
            "FORGEFLOW_POLICY_CONFIG_DIR", str(Path.home() / ".config/forgeflow-policy")
        ),
    )
    parser.add_argument(
        "--state-dir",
        default=os.environ.get(
            "FORGEFLOW_POLICY_STATE_DIR", str(Path.home() / ".local/share/forgeflow-policy")
        ),
    )
    args = parser.parse_args()
    raise SystemExit(
        asyncio.run(
            run_once(
                port=args.port,
                config_dir=Path(args.config_dir).expanduser(),
                state_dir=Path(args.state_dir).expanduser(),
            )
        )
    )


if __name__ == "__main__":
    main()
