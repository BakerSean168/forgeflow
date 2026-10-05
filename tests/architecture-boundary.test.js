import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const FORBIDDEN_PREFIXES = [
  "forgeflow/",
  "openswe_ext/"
];

const FORBIDDEN_FILES = new Set([
  "UPSTREAM_OPEN_SWE_SHA",
  "langgraph.json",
  "pyproject.toml",
  "uv.lock",
  "deploy/gcp-dev/Dockerfile.openswe-sandbox",
  "deploy/gcp-dev/open-swe-codex-broker.service.in"
]);

const PLUGIN_OWNED_RUNTIME_FILES = [
  "extension/review-workflow.js",
  "extension/review-verdict.js",
  "extension/acceptance-workflow.js",
  "extension/github-acceptance.js",
  "scripts/review-verdict.mjs",
  "scripts/github-acceptance.mjs"
];

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("repository does not reintroduce the retired Python/Open SWE control plane", () => {
  const tracked = trackedFiles();

  for (const path of tracked) {
    assert.equal(path.endsWith(".py"), false, path);
    assert.equal(FORBIDDEN_FILES.has(path), false, path);
    assert.equal(
      FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)),
      false,
      path
    );
  }
});

test("review and delivery workflows remain outside ForgeFlow runtime", () => {
  for (const path of PLUGIN_OWNED_RUNTIME_FILES) {
    assert.equal(existsSync(path), false, path);
  }
});

test("active ForgeFlow sources do not depend on Gauntlet", () => {
  const tracked = trackedFiles();
  for (const path of tracked) {
    if (!/\.(?:js|json|md)$/.test(path)) continue;
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("pi-" + "gauntlet"), false, path);
    assert.equal(source.includes("gatekeep-" + "pr"), false, path);
  }
});

test("Pi package has one explicit runtime entrypoint and one plugin dependency", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.deepEqual(packageJson.pi.extensions, ["./extension/index.js"]);
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.deepEqual(packageJson.dependencies, { "pi-subagents": "0.75.0" });
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.99.0");
  assert.deepEqual(
    new Set(packageJson.files),
    new Set(["bin", "extension", "skills", "docs/architecture.md", "docs/model-policy.md", "README.md", "LICENSE"])
  );
});
