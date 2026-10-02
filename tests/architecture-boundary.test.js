import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("Pi package has one explicit runtime entrypoint and one execution dependency", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.deepEqual(packageJson.pi.extensions, ["./extension/index.js"]);
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.deepEqual(packageJson.dependencies, { "pi-subagents": "0.74.0" });
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.99.0");
  assert.deepEqual(
    new Set(packageJson.files),
    new Set(["extension", "scripts", "skills", "docs/architecture.md", "docs/model-policy.md", "README.md", "LICENSE"])
  );
});
