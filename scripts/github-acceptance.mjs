#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { evaluateGithubAcceptance } from "../extension/github-acceptance.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  if (argv.length % 2 !== 0) fail("Invalid arguments.");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("Invalid arguments.");
    const name = key.slice(2);
    if (!name || Object.hasOwn(result, name)) fail("Invalid arguments.");
    result[name] = value;
  }
  return result;
}

function ghJson(args) {
  let stdout;
  try {
    stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    fail(`GitHub CLI request failed${stderr ? `: ${stderr}` : "."}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail("GitHub CLI returned invalid JSON.");
  }
}

const args = parseArgs(process.argv.slice(2));
const allowed = new Set(["owner", "repo", "pr", "expected-head", "base-ref", "required-checks-json"]);
if (Object.keys(args).some((key) => !allowed.has(key))) fail("Invalid arguments.");

const owner = args.owner;
const repo = args.repo;
const pr = Number(args.pr);
const expectedHead = args["expected-head"];
const baseRef = args["base-ref"];
let requiredChecks;

if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner ?? "")) fail("Invalid owner.");
if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? "")) fail("Invalid repo.");
if (!Number.isSafeInteger(pr) || pr <= 0) fail("Invalid pull request number.");
if (!/^[0-9a-f]{40,64}$/i.test(expectedHead ?? "")) fail("Invalid expected head.");
if (
  typeof baseRef !== "string" ||
  !baseRef ||
  baseRef.length > 200 ||
  /[\\~^:?*\[\]\s]/.test(baseRef) ||
  baseRef.includes("..") ||
  baseRef.includes("@{") ||
  baseRef.startsWith("/") ||
  baseRef.endsWith("/") ||
  baseRef.includes("//")
) {
  fail("Invalid base ref.");
}
try {
  requiredChecks = JSON.parse(args["required-checks-json"]);
} catch {
  fail("Invalid required checks.");
}
if (
  !Array.isArray(requiredChecks) ||
  requiredChecks.length === 0 ||
  requiredChecks.length > 64 ||
  requiredChecks.some(
    (name) => typeof name !== "string" || !name.trim() || name.length > 200 || /[\r\n\0]/.test(name)
  )
) {
  fail("Invalid required checks.");
}
requiredChecks = requiredChecks.map((name) => name.trim());
if (new Set(requiredChecks).size !== requiredChecks.length) fail("Invalid required checks.");

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function checkRunsForHead() {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = ghJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${owner}/${repo}/commits/${expectedHead}/check-runs?per_page=${PAGE_SIZE}&page=${page}`
    ]);
    const pageRows = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
    rows.push(...pageRows);
    const total = Number(payload?.total_count);
    if ((Number.isSafeInteger(total) && rows.length >= total) || pageRows.length < PAGE_SIZE) {
      return rows;
    }
  }
  fail("GitHub check-run evidence exceeds the supported pagination limit.");
}

function statusesForHead() {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = ghJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${owner}/${repo}/commits/${expectedHead}/statuses?per_page=${PAGE_SIZE}&page=${page}`
    ]);
    if (!Array.isArray(payload)) fail("GitHub commit-status response was not an array.");
    rows.push(...payload);
    if (payload.length < PAGE_SIZE) return rows;
  }
  fail("GitHub commit-status evidence exceeds the supported pagination limit.");
}

const pullRequest = ghJson(["api", `repos/${owner}/${repo}/pulls/${pr}`]);

const result = evaluateGithubAcceptance({
  pullRequest,
  expectedHead,
  baseRef,
  requiredChecks,
  checkRuns: checkRunsForHead(),
  statuses: statusesForHead()
});

process.stdout.write(`${JSON.stringify(result)}\n`);
