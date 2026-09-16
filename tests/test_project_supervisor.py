from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.projects import (
    ContinuousLaneConfig,
    ContinuousProjectConfig,
    load_continuous_project_configs,
)

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/run-project-supervisor.py"
spec = importlib.util.spec_from_file_location("forgeflow_project_supervisor_cli", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeThreads:
    def __init__(self, rows=None):
        self.rows = list(rows or [])

    async def search(self, **kwargs):
        return self.rows

    async def create(self, **kwargs):
        row = {
            "thread_id": kwargs["thread_id"],
            "metadata": {**kwargs.get("metadata", {}), "graph_id": kwargs.get("graph_id")},
            "values": {},
        }
        self.rows.insert(0, row)
        return row


class FakeRuns:
    def __init__(self):
        self.calls = []

    async def create(self, thread_id, assistant_id, **kwargs):
        self.calls.append((thread_id, assistant_id, kwargs))
        return {"run_id": f"run-{len(self.calls)}"}


class FakeClient:
    def __init__(self, rows=None):
        self.threads = FakeThreads(rows)
        self.runs = FakeRuns()


def _config(tmp_path: Path, *, auto_merge=True) -> ContinuousProjectConfig:
    plan = tmp_path / "docs/plan/active/current.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# plan\n", encoding="utf-8")
    return ContinuousProjectConfig(
        project_key="memoflow",
        owner="BakerSean168",
        repo="memoflow",
        cwd=tmp_path,
        base_ref="feat/convergence",
        plan_paths=(plan,),
        objective="Continue the canonical plan",
        acceptance_criteria=("CI passes",),
        auto_merge_ready=auto_merge,
    )


def _thread(status: str, *, thread_id: str = "policy-1", source: str = "hermes", lane_key: str | None = None, **values):
    defaults = {
        "objective": "Continue canonical plan",
        "repo_owner": "BakerSean168",
        "repo_name": "memoflow",
        "base_ref": "feat/convergence",
    }
    defaults.update(values)
    metadata = {
        "graph_id": "forgeflow",
        "project_key": "memoflow",
        "source": source,
        "repo": {"owner": "BakerSean168", "name": "memoflow"},
    }
    if lane_key is not None:
        metadata["lane_key"] = lane_key
    return {
        "thread_id": thread_id,
        "status": "idle",
        "values": {"status": status, **defaults},
        "metadata": metadata,
    }


def _acceptance_thread(status: str, *, thread_id: str = "acceptance-1", **values):
    row = _thread(status, thread_id=thread_id, source="forgeflow-acceptance", **values)
    row["metadata"].pop("project_key", None)
    return row


def test_load_continuous_project_configs_uses_existing_manifest(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "memoflow"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "project_key": "memoflow",
                    "repo": "BakerSean168/memoflow",
                    "cwd": str(repo),
                    "continuous_supervisor": {
                        "enabled": True,
                        "base_ref": "feat/convergence",
                        "plan_paths": ["docs/plan/active/current.md"],
                        "objective": "Continue canonical plan",
                        "acceptance_criteria": ["CI passes"],
                        "auto_merge_ready": True,
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    configs = load_continuous_project_configs()
    assert len(configs) == 1
    assert configs[0].project_key == "memoflow"
    assert configs[0].auto_merge_ready is True
    assert configs[0].plan_paths[0] == repo / "docs/plan/active/current.md"


@pytest.mark.asyncio
async def test_supervisor_leaves_active_resource_wait_alone(tmp_path: Path) -> None:
    client = FakeClient([_thread("WAITING_FOR_RESOURCE")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "active:WAITING_FOR_RESOURCE"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_supervisor_recovers_only_resource_escalation(tmp_path: Path) -> None:
    client = FakeClient([_thread("ESCALATED", last_failure_code="OPENSWE_PROVIDER_UNAVAILABLE")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "recovering:OPENSWE_PROVIDER_UNAVAILABLE"
    assert client.runs.calls[0][2]["input"] == {"recover_requested": True}


@pytest.mark.asyncio
async def test_supervisor_does_not_loop_on_engineering_escalation(tmp_path: Path) -> None:
    client = FakeClient([_thread("ESCALATED", last_failure_code="REPAIR_BUDGET_EXHAUSTED")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "blocked:REPAIR_BUDGET_EXHAUSTED"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_ready_exact_head_merges_then_creates_next_objective(tmp_path: Path, monkeypatch) -> None:
    head = "a" * 40
    client = FakeClient(
        [
            _thread(
                "READY",
                pr_url="https://github.com/BakerSean168/memoflow/pull/1",
                observed_head_sha=head,
                ci_head_sha=head,
                reviewed_head_sha=head,
            )
        ]
    )
    monkeypatch.setattr(module, "_head_is_on_base", lambda config, sha: False)

    async def fake_fetch(url):
        return PullRequestEvidence(
            owner="BakerSean168",
            repo="memoflow",
            number=1,
            url=url,
            state="open",
            head_sha=head,
            head_ref="agent/task",
            base_sha="b" * 40,
            base_ref="feat/convergence",
        )

    async def fake_merge(pr, *, expected_head_sha, merge_method):
        assert expected_head_sha == head
        assert merge_method == "merge"
        return True

    monkeypatch.setattr(module, "fetch_pull_request", fake_fetch)
    monkeypatch.setattr(module, "merge_pull_request_exact_head", fake_merge)
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "merged"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_ready_head_already_on_base_creates_exactly_one_next_objective(tmp_path: Path, monkeypatch) -> None:
    head = "a" * 40
    client = FakeClient(
        [
            _thread(
                "READY",
                pr_url="https://github.com/BakerSean168/memoflow/pull/1",
                observed_head_sha=head,
                ci_head_sha=head,
                reviewed_head_sha=head,
            )
        ]
    )
    monkeypatch.setattr(module, "_head_is_on_base", lambda config, sha: True)
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result.startswith("created:")
    assert len(client.runs.calls) == 1
    assert client.runs.calls[0][2]["input"]["base_ref"] == "feat/convergence"
    assert "Continue the canonical plan" in client.runs.calls[0][2]["input"]["objective"]


@pytest.mark.asyncio
async def test_missing_plan_stops_project_without_new_objective(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.plan_paths[0].unlink()
    client = FakeClient([])
    result = await module.supervise_project(client, "assistant", cfg)
    assert result == "plan-complete"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_supervisor_discovers_legacy_acceptance_thread_by_repo_identity(tmp_path: Path) -> None:
    legacy = _acceptance_thread(
        "ESCALATED",
        last_failure_code="OPENSWE_PROVIDER_UNAVAILABLE",
    )
    client = FakeClient([legacy])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "recovering:OPENSWE_PROVIDER_UNAVAILABLE"
    assert client.runs.calls[0][0] == "acceptance-1"


@pytest.mark.asyncio
async def test_any_viable_active_objective_wins_over_newer_terminal_record(tmp_path: Path) -> None:
    active = _acceptance_thread("REPAIRING", thread_id="active-old")
    terminal = _thread(
        "ESCALATED",
        thread_id="terminal-new",
        last_failure_code="OPENSWE_PROVIDER_UNAVAILABLE",
    )
    client = FakeClient([terminal, active])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "active:REPAIRING"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_malformed_graph_error_shell_does_not_mask_recoverable_objective(tmp_path: Path) -> None:
    malformed = {
        "thread_id": "broken-new",
        "status": "error",
        "values": {"status": "NEW", "objective": "quota reset continuation"},
        "metadata": {
            "graph_id": "forgeflow",
            "project_key": "memoflow",
            "repo": {"owner": "BakerSean168", "name": "memoflow"},
        },
    }
    recoverable = _acceptance_thread(
        "ESCALATED",
        thread_id="routine-349",
        last_failure_code="OPENSWE_PROVIDER_UNAVAILABLE",
    )
    client = FakeClient([malformed, recoverable])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "recovering:OPENSWE_PROVIDER_UNAVAILABLE"
    assert client.runs.calls[0][0] == "routine-349"


def _lane(
    key: str,
    *,
    depends_on: tuple[str, ...] = (),
    conflicts_with: tuple[str, ...] = (),
    completion_markers: tuple[str, ...] = (),
) -> ContinuousLaneConfig:
    return ContinuousLaneConfig(
        key=key,
        objective=f"Own {key} only",
        acceptance_criteria=(f"{key} is validated",),
        depends_on=depends_on,
        conflicts_with=conflicts_with,
        match_terms=(key,),
        completion_markers=completion_markers,
    )


def _parallel_config(
    tmp_path: Path,
    *,
    max_parallel: int = 4,
    lanes: tuple[ContinuousLaneConfig, ...] | None = None,
) -> ContinuousProjectConfig:
    plan = tmp_path / "docs/plan/active/current.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    if not plan.exists():
        plan.write_text("# plan\n", encoding="utf-8")
    return ContinuousProjectConfig(
        project_key="memoflow",
        owner="BakerSean168",
        repo="memoflow",
        cwd=tmp_path,
        base_ref="feat/convergence",
        plan_paths=(plan,),
        objective="Continue the canonical plan",
        acceptance_criteria=("CI passes",),
        auto_merge_ready=True,
        max_parallel_mutations=max_parallel,
        lanes=lanes
        or (
            _lane("routine"),
            _lane("notification"),
            _lane("portability"),
            _lane("home"),
            _lane("ai"),
        ),
    )


def test_load_continuous_project_configs_parses_bounded_parallel_lanes(
    tmp_path: Path, monkeypatch
) -> None:
    repo = tmp_path / "memoflow"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "project_key": "memoflow",
                    "repo": "BakerSean168/memoflow",
                    "cwd": str(repo),
                    "continuous_supervisor": {
                        "enabled": True,
                        "base_ref": "feat/convergence",
                        "plan_paths": ["docs/plan/active/current.md"],
                        "objective": "Continue canonical plan",
                        "max_parallel_mutations": 4,
                        "lanes": [
                            {
                                "key": "routine",
                                "objective": "Finish ROUTINE-2201",
                                "match_terms": ["ROUTINE-2201"],
                                "completion_markers": ["ROUTINE-2201 DONE"],
                            },
                            {
                                "key": "planner",
                                "objective": "Finish PLAN-2301",
                                "depends_on": ["routine"],
                                "conflicts_with": [],
                            },
                        ],
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    configs = load_continuous_project_configs()
    assert len(configs) == 1
    cfg = configs[0]
    assert cfg.max_parallel_mutations == 4
    assert [lane.key for lane in cfg.lanes] == ["routine", "planner"]
    assert cfg.lanes[1].depends_on == ("routine",)
    assert cfg.lanes[0].match_terms == ("ROUTINE-2201",)


def test_load_continuous_project_configs_rejects_parallelism_above_four(
    tmp_path: Path, monkeypatch
) -> None:
    repo = tmp_path / "memoflow"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "project_key": "memoflow",
                    "repo": "BakerSean168/memoflow",
                    "cwd": str(repo),
                    "continuous_supervisor": {
                        "enabled": True,
                        "base_ref": "feat/convergence",
                        "plan_paths": ["docs/plan/active/current.md"],
                        "objective": "Continue canonical plan",
                        "max_parallel_mutations": 5,
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    with pytest.raises(ValueError, match="1 to 4"):
        load_continuous_project_configs()


@pytest.mark.asyncio
async def test_parallel_supervisor_fills_at_most_four_mutation_slots(tmp_path: Path) -> None:
    client = FakeClient([])
    cfg = _parallel_config(tmp_path, max_parallel=4)
    result = await module.supervise_project(client, "assistant", cfg)
    assert "parallel:active=4/4" in result
    assert len(client.runs.calls) == 4
    lane_keys = [call[2]["metadata"]["lane_key"] for call in client.runs.calls]
    assert lane_keys == ["routine", "notification", "portability", "home"]
    assert all(call[2]["input"]["workspace_path"] is None for call in client.runs.calls)


@pytest.mark.asyncio
async def test_parallel_supervisor_unknown_active_writer_blocks_new_lanes(tmp_path: Path) -> None:
    client = FakeClient(
        [
            _thread(
                "IMPLEMENTING",
                thread_id="legacy-writer",
                objective="A legacy broad objective with no configured lane marker",
            )
        ]
    )
    cfg = _parallel_config(tmp_path, max_parallel=4)
    result = await module.supervise_project(client, "assistant", cfg)
    assert "parallel:active=1/4" in result
    assert "blocked=unknown-active:1" in result
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_parallel_supervisor_does_not_start_dependency_before_completion(
    tmp_path: Path,
) -> None:
    cfg = _parallel_config(
        tmp_path,
        lanes=(
            _lane("routine"),
            _lane("planner", depends_on=("routine",)),
        ),
    )
    client = FakeClient([])
    result = await module.supervise_project(client, "assistant", cfg)
    assert len(client.runs.calls) == 1
    assert client.runs.calls[0][2]["metadata"]["lane_key"] == "routine"
    assert "planner:depends-on:routine" in result


@pytest.mark.asyncio
async def test_parallel_supervisor_completion_marker_unlocks_dependency(tmp_path: Path) -> None:
    cfg = _parallel_config(
        tmp_path,
        lanes=(
            _lane("routine", completion_markers=("ROUTINE-2201 DONE",)),
            _lane("planner", depends_on=("routine",)),
        ),
    )
    cfg.plan_paths[0].write_text("# plan\nROUTINE-2201 DONE\n", encoding="utf-8")
    client = FakeClient([])
    result = await module.supervise_project(client, "assistant", cfg)
    assert len(client.runs.calls) == 1
    assert client.runs.calls[0][2]["metadata"]["lane_key"] == "planner"
    assert "created=planner:" in result


@pytest.mark.asyncio
async def test_parallel_supervisor_respects_bidirectional_conflict_guard(tmp_path: Path) -> None:
    cfg = _parallel_config(
        tmp_path,
        lanes=(
            _lane("scheduler", conflicts_with=("planner",)),
            _lane("planner"),
            _lane("notification"),
        ),
    )
    client = FakeClient([])
    result = await module.supervise_project(client, "assistant", cfg)
    assert len(client.runs.calls) == 2
    lane_keys = [call[2]["metadata"]["lane_key"] for call in client.runs.calls]
    assert lane_keys == ["scheduler", "notification"]
    assert "planner:conflicts:scheduler" in result


@pytest.mark.asyncio
async def test_parallel_supervisor_adopts_legacy_lane_by_match_term(tmp_path: Path) -> None:
    cfg = _parallel_config(
        tmp_path,
        lanes=(
            ContinuousLaneConfig(
                key="routine",
                objective="Finish routine",
                acceptance_criteria=(),
                depends_on=(),
                conflicts_with=(),
                match_terms=("ROUTINE-2201",),
                completion_markers=(),
            ),
            _lane("notification"),
        ),
    )
    client = FakeClient(
        [
            _thread(
                "IMPLEMENTING",
                thread_id="legacy-routine",
                objective="Continue MemoFlow ROUTINE-2201 repair",
            )
        ]
    )
    result = await module.supervise_project(client, "assistant", cfg)
    assert len(client.runs.calls) == 1
    assert client.runs.calls[0][2]["metadata"]["lane_key"] == "notification"
    assert "parallel:active=2/4" in result


@pytest.mark.asyncio
async def test_parallel_lane_replay_uses_stable_thread_identity(tmp_path: Path) -> None:
    cfg = _parallel_config(tmp_path, lanes=(_lane("notification"),))
    lane = cfg.lanes[0]
    client = FakeClient([])
    first = await module._create_objective(client, "assistant", cfg, lane)
    second = await module._create_objective(client, "assistant", cfg, lane)
    assert first == second
    assert client.runs.calls[0][0] == client.runs.calls[1][0] == first
