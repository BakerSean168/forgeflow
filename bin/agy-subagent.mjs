#!/usr/bin/env node

import { spawn } from "node:child_process";

const VALID_MODES = new Set(["plan", "accept-edits"]);
const mode = process.argv[2];

if (!VALID_MODES.has(mode)) {
  process.stderr.write("Usage: agy-subagent.mjs <plan|accept-edits>\n");
  process.exit(64);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  prompt += chunk;
}

if (!prompt.trim()) {
  process.stderr.write("Antigravity subagent prompt must not be empty.\n");
  process.exit(64);
}

const args = [
  "--mode",
  mode,
  "--output-format",
  "text",
  "--dangerously-skip-permissions",
  "--print-timeout",
  "0s",
  `--print=${prompt}`
];

const child = spawn("agy", args, {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(
    `Failed to launch Antigravity CLI (agy): ${error.message}\n`
  );
  process.exitCode = 127;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`Antigravity CLI terminated by ${signal}.\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
