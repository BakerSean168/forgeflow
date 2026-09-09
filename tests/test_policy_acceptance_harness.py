import importlib.util
import json
import stat
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/run_policy_acceptance.py"
spec = importlib.util.spec_from_file_location("run_policy_acceptance", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_acceptance_evidence_is_bounded_and_mode_600(tmp_path: Path) -> None:
    values = {
        "status": "READY",
        "pr_url": "https://github.com/o/r/pull/1",
        "observed_head_sha": "a" * 40,
        "ci_head_sha": "a" * 40,
        "reviewed_head_sha": "a" * 40,
        "huge_runtime_blob": {"must": "not leak"},
    }
    evidence = module.extract_evidence(values, thread_id="thread-1", worktree=tmp_path / "wt")
    assert evidence["status"] == "READY"
    assert evidence["ci_head_sha"] == evidence["reviewed_head_sha"] == "a" * 40
    assert "huge_runtime_blob" not in evidence
    path = tmp_path / "evidence.json"
    module.write_evidence(path, evidence)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    saved = json.loads(path.read_text())
    assert saved["policy_thread_id"] == "thread-1"


def test_acceptance_terminal_set_treats_ready_as_evidence_not_runtime_terminal() -> None:
    assert module.TERMINAL_FOR_ACCEPTANCE == {"READY", "ESCALATED", "CANCELLED"}
