import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "deploy/gcp-dev"


def _load_runtime_unit_health_module():
    path = DEPLOY / "check-runtime-units.py"
    spec = importlib.util.spec_from_file_location("forgeflow_runtime_unit_health", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_runtime_unit_health_reports_all_required_units_ready() -> None:
    module = _load_runtime_unit_health_module()

    class Result:
        returncode = 0
        stdout = "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
        stderr = ""

    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return Result()

    report = module.inspect_required_units(run=fake_run)
    assert report.ok is True
    assert [item.unit for item in report.items] == list(module.REQUIRED_USER_UNITS)
    assert all(item.status == "READY" for item in report.items)
    assert all(call[0][:3] == ["systemctl", "--user", "show"] for call in calls)


def test_runtime_unit_health_fails_closed_on_enabled_but_inactive_timer() -> None:
    module = _load_runtime_unit_health_module()

    class Result:
        returncode = 0
        stderr = ""

        def __init__(self, stdout: str) -> None:
            self.stdout = stdout

    def fake_run(command, **_kwargs):
        unit = command[3]
        active = "inactive" if unit == "forgeflow-project-supervisor.timer" else "active"
        return Result(
            f"LoadState=loaded\nActiveState={active}\nUnitFileState=enabled\n"
        )

    report = module.inspect_required_units(run=fake_run)
    assert report.ok is False
    item = next(
        item for item in report.items if item.unit == "forgeflow-project-supervisor.timer"
    )
    assert item.status == "NOT_ACTIVE"
    assert item.active_state == "inactive"


def test_installer_verifies_runtime_units_after_enabling_required_timers() -> None:
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    project_timer = installer.index(
        "systemctl --user enable --now forgeflow-project-supervisor.timer"
    )
    health_check = installer.index('python3 "$root/deploy/gcp-dev/check-runtime-units.py"')
    assert project_timer < health_check


def test_runtime_unit_health_checker_is_read_only_and_covers_required_units() -> None:
    checker = (DEPLOY / "check-runtime-units.py").read_text(encoding="utf-8")
    for unit in (
        "open-swe-codex-broker.service",
        "forgeflow-policy.service",
        "forgeflow-openswe-sandbox-gc.timer",
        "forgeflow-invariant-supervisor.timer",
        "forgeflow-project-supervisor.timer",
    ):
        assert unit in checker
    assert '"systemctl"' in checker
    assert '"--user"' in checker
    assert '"show"' in checker
    assert "systemctl --user start" not in checker
    assert "systemctl --user restart" not in checker
    assert "local-auth.secret" not in checker
