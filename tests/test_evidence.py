from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.evidence import implementation_evidence, tracked_pull_request
from forgeflow.state import initial_state

PR_URL = "https://github.com/o/r/pull/1"
BASE = "a" * 40
HEAD = "b" * 40
NEXT = "c" * 40


def _authoritative(head=HEAD, *, state="open"):
    return PullRequestEvidence(
        owner="o",
        repo="r",
        number=1,
        url=PR_URL,
        state=state,
        head_sha=head,
        head_ref="open-swe/task",
        base_sha=BASE,
        base_ref="main",
    )


def _tracked():
    return tracked_pull_request(
        {
            "pull_requests": [
                {
                    "url": PR_URL,
                    "number": 1,
                    "state": "open",
                    "head_ref": "open-swe/task",
                    "base_ref": "main",
                }
            ]
        }
    )


def test_initial_success_requires_real_pr_head_delta() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    evidence = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=_authoritative()
    )
    assert evidence.progressed is True
    assert evidence.head_sha == HEAD


def test_success_without_tracked_pr_is_no_progress() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    evidence = implementation_evidence(
        state, run_status="success", tracked_pr=None, authoritative_pr=None
    )
    assert evidence.progressed is False
    assert evidence.failure_code == "NO_PROGRESS_NO_TRACKED_PR"


def test_success_with_head_equal_to_base_is_no_progress() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    evidence = implementation_evidence(
        state,
        run_status="success",
        tracked_pr=_tracked(),
        authoritative_pr=_authoritative(BASE),
    )
    assert evidence.progressed is False
    assert evidence.failure_code == "NO_PROGRESS_HEAD_EQUALS_BASE"


def test_repair_requires_new_head_not_same_rejected_head() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    state["observed_head_sha"] = HEAD
    stale = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=_authoritative(HEAD)
    )
    fresh = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=_authoritative(NEXT)
    )
    assert stale.failure_code == "NO_PROGRESS_HEAD_UNCHANGED"
    assert fresh.progressed is True
    assert fresh.head_sha == NEXT


def test_pr_identity_or_branch_mismatch_fails_closed() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    tracked = _tracked()
    assert tracked is not None
    mismatched = tracked.__class__(
        owner=tracked.owner,
        repo=tracked.repo,
        url=tracked.url,
        number=tracked.number,
        state=tracked.state,
        head_ref="different-branch",
        base_ref=tracked.base_ref,
    )
    evidence = implementation_evidence(
        state, run_status="success", tracked_pr=mismatched, authoritative_pr=_authoritative()
    )
    assert evidence.failure_code == "PR_BRANCH_MISMATCH"


def test_non_success_child_run_never_counts_as_repository_progress() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    evidence = implementation_evidence(
        state, run_status="error", tracked_pr=_tracked(), authoritative_pr=_authoritative()
    )
    assert evidence.progressed is False
    assert evidence.failure_code == "CHILD_RUN_NOT_SUCCESS"


def test_authoritative_pr_must_match_objective_repository_and_base() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r", base_ref="main")
    foreign = PullRequestEvidence(
        owner="other", repo="repo", number=1, url="https://github.com/other/repo/pull/1",
        state="open", head_sha=HEAD, head_ref="open-swe/task", base_sha=BASE, base_ref="main"
    )
    tracked = tracked_pull_request({
        "pr_url": foreign.url, "pr_number": 1, "pr_state": "open",
        "branch_name": "open-swe/task", "base_branch": "main"
    })
    evidence = implementation_evidence(
        state, run_status="success", tracked_pr=tracked, authoritative_pr=foreign
    )
    assert evidence.progressed is False
    assert evidence.failure_code == "PR_REPOSITORY_MISMATCH"

    wrong_base = _authoritative()
    wrong_base = wrong_base.__class__(
        owner=wrong_base.owner, repo=wrong_base.repo, number=wrong_base.number, url=wrong_base.url,
        state=wrong_base.state, head_sha=wrong_base.head_sha, head_ref=wrong_base.head_ref,
        base_sha=wrong_base.base_sha, base_ref="release"
    )
    evidence = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=wrong_base
    )
    assert evidence.failure_code == "PR_BASE_MISMATCH"
