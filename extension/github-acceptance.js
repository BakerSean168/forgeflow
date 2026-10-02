const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAIL_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale"
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function checkRank(check) {
  return [
    text(check?.completed_at) || text(check?.started_at) || text(check?.created_at),
    integer(check?.id)
  ];
}

function statusRank(status) {
  return [text(status?.updated_at) || text(status?.created_at), integer(status?.id)];
}

function compareRank(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  return left[1] - right[1];
}

function sameRank(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function normalizeLatest(rows, { key, rank, signature, ambiguousPrefix }) {
  const grouped = new Map();
  for (const row of rows) {
    const name = text(row?.[key]);
    if (!name) continue;
    const existing = grouped.get(name) ?? [];
    existing.push(row);
    grouped.set(name, existing);
  }

  const result = new Map();
  for (const [name, candidates] of grouped) {
    if (candidates.length === 1) {
      result.set(name, candidates[0]);
      continue;
    }

    const ranked = [...candidates].sort((left, right) =>
      compareRank(rank(right), rank(left))
    );
    const topRank = rank(ranked[0]);
    const tied = ranked.filter((row) => sameRank(rank(row), topRank));
    const signatures = new Set(tied.map(signature));
    if ((topRank[0] === "" && topRank[1] === -1) || signatures.size > 1) {
      return { error: `${ambiguousPrefix}:${name}` };
    }
    result.set(name, ranked[0]);
  }

  return { rows: result };
}

function normalizeChecks(checkRuns) {
  return normalizeLatest(checkRuns, {
    key: "name",
    rank: checkRank,
    signature: (row) => `${text(row?.status)}\0${text(row?.conclusion)}`,
    ambiguousPrefix: "AMBIGUOUS_CHECK_NAME"
  });
}

function normalizeStatuses(statuses) {
  return normalizeLatest(statuses, {
    key: "context",
    rank: statusRank,
    signature: (row) => text(row?.state),
    ambiguousPrefix: "AMBIGUOUS_STATUS_CONTEXT"
  });
}

function evaluateRequiredCheck(name, check, status) {
  let pending = false;
  let unresolved = false;

  if (check) {
    const checkStatus = text(check.status).toLowerCase();
    const conclusion = text(check.conclusion).toLowerCase();
    if (checkStatus !== "completed" || !conclusion) {
      pending = true;
    } else if (FAIL_CONCLUSIONS.has(conclusion)) {
      return { status: "blocked", reason: "CI_FAILED", requiredCheck: name };
    } else if (!PASS_CONCLUSIONS.has(conclusion)) {
      unresolved = true;
    }
  }

  if (status) {
    const state = text(status.state).toLowerCase();
    if (state === "pending") {
      pending = true;
    } else if (state === "failure" || state === "error") {
      return { status: "blocked", reason: "CI_FAILED", requiredCheck: name };
    } else if (state !== "success") {
      unresolved = true;
    }
  }

  if (pending) return { status: "pending", reason: "CI_PENDING", requiredCheck: name };
  if (unresolved) {
    return {
      status: "blocked",
      reason: "CI_STATE_UNRECOGNIZED",
      requiredCheck: name
    };
  }
  return null;
}

export function evaluateGithubAcceptance({
  pullRequest,
  expectedHead,
  baseRef,
  requiredChecks,
  checkRuns = [],
  statuses = []
}) {
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead ?? "")) {
    return { status: "blocked", reason: "EXPECTED_HEAD_INVALID" };
  }
  if (typeof baseRef !== "string" || !baseRef) {
    return { status: "blocked", reason: "EXPECTED_BASE_INVALID" };
  }
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length === 0 ||
    new Set(requiredChecks).size !== requiredChecks.length ||
    requiredChecks.some((name) => typeof name !== "string" || !name)
  ) {
    return { status: "blocked", reason: "REQUIRED_CHECK_POLICY_MISSING" };
  }

  const prHead = text(pullRequest?.head?.sha);
  if (!prHead) {
    return { status: "blocked", reason: "PR_HEAD_MISSING" };
  }
  if (text(pullRequest?.state).toLowerCase() !== "open") {
    return { status: "blocked", reason: "PR_NOT_OPEN", headSha: prHead };
  }

  const observedBase = text(pullRequest?.base?.ref);
  if (observedBase !== baseRef) {
    return {
      status: "blocked",
      reason: "PR_BASE_MISMATCH",
      headSha: prHead,
      expectedBase: baseRef,
      observedBase
    };
  }

  if (prHead.toLowerCase() !== expectedHead.toLowerCase()) {
    return {
      status: "blocked",
      reason: "PR_HEAD_MISMATCH",
      headSha: prHead,
      expectedHead
    };
  }

  const normalizedChecks = normalizeChecks(checkRuns);
  if (normalizedChecks.error) {
    return { status: "blocked", reason: normalizedChecks.error, headSha: prHead };
  }
  const normalizedStatuses = normalizeStatuses(statuses);
  if (normalizedStatuses.error) {
    return { status: "blocked", reason: normalizedStatuses.error, headSha: prHead };
  }

  for (const required of requiredChecks) {
    const check = normalizedChecks.rows.get(required);
    const status = normalizedStatuses.rows.get(required);
    if (!check && !status) {
      return {
        status: "blocked",
        reason: "MISSING_REQUIRED_CHECK",
        requiredCheck: required,
        headSha: prHead
      };
    }
    const decision = evaluateRequiredCheck(required, check, status);
    if (decision) return { ...decision, headSha: prHead };
  }

  return {
    status: "accepted",
    reason: null,
    headSha: prHead,
    requiredChecks: [...requiredChecks]
  };
}
