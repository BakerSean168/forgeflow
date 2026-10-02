#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { parseReviewVerdict } from "../extension/review-verdict.js";

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ status: "invalid", reason })}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--report") fail("INVALID_ARGUMENTS");

const report = argv[1];
if (
  typeof report !== "string" ||
  !report ||
  report.length > 1024 ||
  report.includes("\0")
) {
  fail("INVALID_REPORT_PATH");
}

const cwd = process.cwd();
const allowedRoot = resolve(cwd, ".pi/subagents");
const absolute = isAbsolute(report) ? resolve(report) : resolve(cwd, report);
const rel = relative(allowedRoot, absolute);
if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail("REPORT_PATH_OUTSIDE_REVIEW_ROOT");

let content;
try {
  content = readFileSync(absolute, "utf8");
} catch {
  fail("REVIEW_REPORT_UNREADABLE");
}

if (Buffer.byteLength(content, "utf8") > 256 * 1024) fail("REVIEW_REPORT_TOO_LARGE");

const result = parseReviewVerdict(content);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "invalid") process.exit(2);
