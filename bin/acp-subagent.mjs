#!/usr/bin/env node

// One bounded ACP session per pi-subagents external-cli run.
// Pi-subagents owns run/mission/worktree state; the target ACP agent owns tools and credentials.
import { spawn } from "node:child_process";

const AGENTS = Object.freeze({
  glm: { env: "FORGEFLOW_GLM_ACP_COMMAND", command: "glm-acp-t3", args: [], modes: { plan: "default", writer: "accept_edits" } },
  zcode: { env: "FORGEFLOW_ZCODE_ACP_COMMAND", command: "zcode-acp-t3", args: [], modes: { plan: "plan", writer: "build" } },
  dsh: { env: "FORGEFLOW_DSH_ACP_COMMAND", command: "dsh", args: ["acp"], modes: { writer: null } }
});
const [agentName, role] = process.argv.slice(2);
const agent = AGENTS[agentName];
if (!agent || !Object.hasOwn(agent.modes, role)) {
  process.stderr.write("Usage: acp-subagent.mjs <glm|zcode> <plan|writer> | dsh writer\n");
  process.exit(64);
}

function duration(env, fallback, max) {
  const value = process.env[env];
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1000 || n > max) {
    throw new Error(`Invalid ${env}: expected milliseconds between 1000 and ${max}`);
  }
  return n;
}
const startupTimeout = duration("FORGEFLOW_ACP_STARTUP_TIMEOUT_MS", 45_000, 180_000);
const runTimeout = duration("FORGEFLOW_ACP_RUN_TIMEOUT_MS", 3_600_000, 7_200_000);

async function readPrompt() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 256 * 1024) throw new Error("Delegated prompt exceeds 256 KiB");
    chunks.push(bytes);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (!prompt.trim()) throw new Error("Delegated prompt must not be empty");
  return prompt;
}

function selectPermission(options, writing) {
  const items = Array.isArray(options) ? options : [];
  if (writing) {
    const allowed = items.find((item) => item?.kind === "allow_once");
    if (allowed && typeof allowed.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: allowed.optionId } };
    }
  }
  const denied = items.find((item) => item?.kind === "deny_once" || item?.kind === "reject_once");
  if (denied && typeof denied.optionId === "string") {
    return { outcome: { outcome: "selected", optionId: denied.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

async function main() {
  const originalPrompt = await readPrompt();
  const command = process.env[agent.env]?.trim() || agent.command;
  if (!command || /[\r\n\0]/.test(command)) throw new Error("Invalid ACP executable name");
  const child = spawn(command, agent.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  let exited = false;
  let exitError;
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let rawResponseSize = 0;
  let finalText = "";
  const requests = new Map();

  function terminate() {
    if (exited) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { /* already exited */ }
  }

  const interrupt = () => {
    terminate();
    process.exitCode = 130;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  function rejectPending(error) {
    for (const [id, request] of requests) {
      clearTimeout(request.timer);
      requests.delete(id);
      request.reject(error);
    }
  }

  function writeFrame(frame) {
    if (child.stdin.destroyed) throw new Error("ACP input stream closed");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  }

  function rpc(method, params, timeout) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`ACP ${method} timed out`));
        terminate();
      }, timeout);
      requests.set(id, { resolve, reject, timer, method });
      try { writeFrame({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        requests.delete(id);
        reject(error);
      }
    });
  }

  function onFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (Object.hasOwn(frame, "id") && !Object.hasOwn(frame, "method")) {
      const request = requests.get(frame.id);
      if (!request) return;
      clearTimeout(request.timer);
      requests.delete(frame.id);
      if (frame.error) {
        const code = Number.isInteger(frame.error.code) ? frame.error.code : "unknown";
        request.reject(new Error(`ACP ${request.method} failed (code ${code})`));
      } else {
        request.resolve(frame.result);
      }
      return;
    }

    if (Object.hasOwn(frame, "id") && typeof frame.method === "string") {
      if (frame.method === "session/request_permission") {
        writeFrame({ id: frame.id, result: selectPermission(frame.params?.options, role === "writer") });
      } else {
        // No remote filesystem, terminal or user-interaction permission is granted.
        writeFrame({ id: frame.id, error: { code: -32601, message: "Unavailable in headless delegation" } });
      }
      return;
    }

    if (frame.method === "session/update") {
      const update = frame.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        const text = update.content.text;
        if (typeof text !== "string") return;
        rawResponseSize += Buffer.byteLength(text);
        if (rawResponseSize > 256 * 1024) {
          rejectPending(new Error("ACP final text exceeds 256 KiB"));
          terminate();
          return;
        }
        finalText += text;
      }
    }
  }

  child.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 2 * 1024 * 1024) {
      rejectPending(new Error("ACP protocol line exceeds 2 MiB"));
      terminate();
      return;
    }
    let idx;
    while ((idx = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, idx).toString("utf8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try { onFrame(JSON.parse(line)); }
      catch (error) {
        rejectPending(new Error("ACP protocol framing error"));
        terminate();
        return;
      }
    }
  });
  // Backend diagnostics can contain credentials or prompts. Never mirror raw stderr.
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    exited = true;
    exitError = new Error(`Cannot launch ACP agent ${agentName}: ${error.code || "spawn_failed"}`);
    rejectPending(exitError);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitError = new Error(`ACP agent ${agentName} exited before completion (code=${code ?? "signal"}, signal=${signal ?? "none"})`);
    rejectPending(exitError);
  });

  try {
    const hello = await rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "ForgeFlow ACP delegation", version: "1.0.0" }
    }, startupTimeout);
    if (!hello || hello.protocolVersion !== 1) throw new Error("ACP protocol version mismatch");

    const session = await rpc("session/new", { cwd: process.cwd(), mcpServers: [] }, startupTimeout);
    if (!session || typeof session.sessionId !== "string" || !session.sessionId) {
      throw new Error("ACP agent did not create a session");
    }

    const selectedMode = agent.modes[role];
    if (selectedMode !== null) {
      const advertisedModes = session.modes?.availableModes;
      if (!Array.isArray(advertisedModes) || !advertisedModes.some((mode) => mode.id === selectedMode)) {
        throw new Error(`ACP agent does not advertise required ${role} mode`);
      }
      if (session.modes.currentModeId !== selectedMode) {
        await rpc("session/set_mode", { sessionId: session.sessionId, modeId: selectedMode }, startupTimeout);
      }
    }

    const preamble = role === "plan"
      ? "READ-ONLY DELEGATION: inspect and explain only. Do not modify any file or run mutating commands. If a modification is required, report it as a proposed change.\n\n"
      : "WRITER DELEGATION: execute only this explicitly assigned task within the provided working directory. Do not expand scope. Observe one-writer-per-worktree and include validation evidence.\n\n";
    const result = await rpc("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: preamble + originalPrompt }]
    }, runTimeout);

    if (!result || result.stopReason !== "end_turn") {
      throw new Error(`ACP run ended without successful completion (stop=${result?.stopReason ?? "missing"})`);
    }
    if (!finalText.trim()) throw new Error("ACP run ended without final text (empty response)");
    process.stdout.write(finalText.trimEnd() + "\n");
  } finally {
    terminate();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

try {
  await main();
} catch (error) {
  // Errors are typed/sanitized: do not print original Agent stderr, prompt, or API credentials.
  process.stderr.write(`ForgeFlow external agent ${agentName}/${role}: ${error.message}\n`);
  process.exitCode = 1;
}
