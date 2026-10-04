#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readUsageEvents, resolveUsageLogPath } from "../extension/usage.js";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const path = resolveUsageLogPath();
if (!existsSync(path)) {
  console.error(`ForgeFlow usage log not found: ${path}`);
  process.exitCode = 1;
} else {
  const events = readUsageEvents(path);
  const usageEvents = events.filter((event) => event.event === "model_usage");
  const decisions = events.filter((event) => event.event === "route_decision");
  const groups = new Map();

  for (const event of usageEvents) {
    const supply = event.supplyId ?? event.provider ?? "unknown";
    const key = `${supply}\u0000${event.model ?? "unknown"}`;
    const row = groups.get(key) ?? {
      supply,
      model: event.model ?? "unknown",
      requests: 0,
      failures: 0,
      tokens: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: 0,
      cost: 0
    };
    row.requests += 1;
    if (event.status !== "success") row.failures += 1;
    row.tokens += Number(event.usage?.totalTokens ?? 0);
    row.input += Number(event.usage?.input ?? 0);
    row.output += Number(event.usage?.output ?? 0);
    row.cacheRead += Number(event.usage?.cacheRead ?? 0);
    row.reasoning += Number(event.usage?.reasoning ?? 0);
    row.cost += Number(event.usage?.cost?.total ?? 0);
    groups.set(key, row);
  }

  const failovers = new Map();
  for (const event of decisions) {
    if (event.basis !== "supply-failover") continue;
    const reason = event.failoverReason ?? "unknown";
    failovers.set(reason, (failovers.get(reason) ?? 0) + 1);
  }

  const result = {
    path,
    usage: [...groups.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
    failovers: [...failovers.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ForgeFlow usage: ${path}`);
    console.log("SUPPLY\tMODEL\tREQUESTS\tFAIL\tTOKENS\tCOST");
    for (const row of result.usage) {
      console.log(`${row.supply}\t${row.model}\t${row.requests}\t${row.failures}\t${row.tokens}\t${row.cost.toFixed(6)}`);
    }
    if (result.failovers.length > 0) {
      console.log("\nFAILOVER_REASON\tCOUNT");
      for (const row of result.failovers) console.log(`${row.reason}\t${row.count}`);
    }
  }
}

