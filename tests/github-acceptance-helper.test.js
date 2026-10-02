import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EXPECTED_HEAD = "a".repeat(40);

function runHelper(finalHead) {
  const dir = mkdtempSync(join(tmpdir(), "forgeflow-gh-helper-"));
  const state = join(dir, "state");
  const fakeGh = join(dir, "gh");

  writeFileSync(
    fakeGh,
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done

case "$last" in
  repos/BakerSean168/forgeflow/pulls/107)
    count=0
    if [ -f "$FAKE_GH_STATE" ]; then count=$(cat "$FAKE_GH_STATE"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_GH_STATE"
    if [ "$count" -eq 1 ]; then head="$FAKE_EXPECTED_HEAD"; else head="$FAKE_FINAL_HEAD"; fi
    printf '{"state":"open","head":{"sha":"%s"},"base":{"ref":"main"}}\\n' "$head"
    ;;
  *"/check-runs?per_page=100&page=1")
    printf '{"total_count":1,"check_runs":[{"id":1,"name":"verify","status":"completed","conclusion":"success"}]}\\n'
    ;;
  *"/statuses?per_page=100&page=1")
    printf '[]\\n'
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 9
    ;;
esac
`,
    "utf8"
  );
  chmodSync(fakeGh, 0o755);

  const helper = resolve("scripts/github-acceptance.mjs");
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "--owner",
      "BakerSean168",
      "--repo",
      "forgeflow",
      "--pr",
      "107",
      "--expected-head",
      EXPECTED_HEAD,
      "--base-ref",
      "main",
      "--required-checks-json",
      '["verify"]'
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FAKE_GH_STATE: state,
        FAKE_EXPECTED_HEAD: EXPECTED_HEAD,
        FAKE_FINAL_HEAD: finalHead
      }
    }
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    return {
      output: JSON.parse(result.stdout),
      pullRequestReads: Number(readFileSync(state, "utf8"))
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("helper rechecks the authoritative PR after collecting CI evidence", () => {
  const result = runHelper("b".repeat(40));

  assert.equal(result.pullRequestReads, 2);
  assert.equal(result.output.status, "blocked");
  assert.equal(result.output.reason, "PR_HEAD_MISMATCH");
  assert.equal(result.output.expectedHead, EXPECTED_HEAD);
  assert.equal(result.output.headSha, "b".repeat(40));
});

test("helper accepts only when the final PR identity still matches the checked head", () => {
  const result = runHelper(EXPECTED_HEAD);

  assert.equal(result.pullRequestReads, 2);
  assert.deepEqual(result.output, {
    status: "accepted",
    reason: null,
    headSha: EXPECTED_HEAD,
    requiredChecks: ["verify"]
  });
});
