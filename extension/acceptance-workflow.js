import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderPreflight } from "./invariants.js";
import { reviewContractTask, reviewVerdictGate } from "./review-workflow.js";

const HELPER_PATH = fileURLToPath(new URL("../scripts/github-acceptance.mjs", import.meta.url));
export const CLEAN_HEAD_COMMAND =
  "git diff --quiet && git diff --cached --quiet && test -z \"$(git ls-files --others --exclude-standard | grep -v '^.pi/subagents/' || true)\" && git rev-parse HEAD";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validateArgs(args) {
  const allowed = new Set(["task", "owner", "repo", "pr", "expectedHead", "baseRef", "requiredChecks"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    return { error: "forgeflow.accept received unsupported fields." };
  }

  const task = typeof args.task === "string" ? args.task.trim() : "";
  const owner = typeof args.owner === "string" ? args.owner.trim() : "";
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  const pr = args.pr;
  const expectedHead = typeof args.expectedHead === "string" ? args.expectedHead.trim() : "";
  const baseRef = typeof args.baseRef === "string" ? args.baseRef.trim() : "";
  const requiredChecks = Array.isArray(args.requiredChecks)
    ? args.requiredChecks.map((name) => (typeof name === "string" ? name.trim() : name))
    : null;

  if (!task || task.length > 12000) return { error: "task must contain 1-12000 characters." };
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) return { error: "owner is invalid." };
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return { error: "repo is invalid." };
  if (!Number.isSafeInteger(pr) || pr <= 0) return { error: "pr must be a positive integer." };
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead)) {
    return { error: "expectedHead must be a full hexadecimal commit id." };
  }
  if (
    !baseRef ||
    baseRef.length > 200 ||
    /[\\~^:?*\[\]\s]/.test(baseRef) ||
    baseRef.includes("..") ||
    baseRef.includes("@{") ||
    baseRef.startsWith("/") ||
    baseRef.endsWith("/") ||
    baseRef.includes("//")
  ) {
    return { error: "baseRef is invalid." };
  }
  if (
    !requiredChecks ||
    requiredChecks.length === 0 ||
    requiredChecks.length > 64 ||
    new Set(requiredChecks).size !== requiredChecks.length ||
    requiredChecks.some(
      (name) => typeof name !== "string" || !name || name.length > 200 || /[\r\n\0]/.test(name)
    )
  ) {
    return { error: "requiredChecks must contain 1-64 unique check names." };
  }

  return {
    task,
    owner,
    repo,
    pr,
    expectedHead: expectedHead.toLowerCase(),
    baseRef,
    requiredChecks
  };
}

export function createAcceptanceWorkflowDefinition(repoRoot) {
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new Error("ForgeFlow acceptance workflow requires the session cwd.");
  }

  return {
    name: "forgeflow.accept",
    version: 4,
    resolve(args) {
      const validated = validateArgs(args);
      if ("error" in validated) return validated;

      const { task, owner, repo, pr, expectedHead, baseRef, requiredChecks } = validated;
      const githubCommand = [
        shellQuote(process.execPath),
        shellQuote(HELPER_PATH),
        "--owner",
        shellQuote(owner),
        "--repo",
        shellQuote(repo),
        "--pr",
        shellQuote(String(pr)),
        "--expected-head",
        shellQuote(expectedHead),
        "--base-ref",
        shellQuote(baseRef),
        "--required-checks-json",
        shellQuote(JSON.stringify(requiredChecks))
      ].join(" ");

      const reviewTask = reviewContractTask([
        "You are the final independent ForgeFlow reviewer for an exact committed candidate.",
        "Review the current repository at the exact checked-out HEAD against the operator task and owner contracts.",
        "Do not mutate files. Review code, contracts, tests, and repository-local evidence only.",
        "Do not block merely because live GitHub check-run evidence is unavailable to the reviewer: the enclosing trusted workflow performs the authoritative GitHub exact-head CI gate after this review.",
        "Use BLOCK when another code change is required before delivery.",
        "",
        "Operator task:",
        task,
        "",
        renderPreflight(task).join("\n")
      ]);
      const reviewPath = resolve(repoRoot, `.pi/subagents/forgeflow-final-review-${expectedHead}.md`);
      const reviewGate = reviewVerdictGate(reviewPath);

      const headParams = {
        kind: "command",
        command: CLEAN_HEAD_COMMAND,
        timeoutMs: 15000,
        role: "gate",
        provider: "git"
      };
      const githubParams = {
        kind: "command",
        command: githubCommand,
        timeoutMs: 60000,
        role: "ci",
        provider: "github"
      };

      return {
        hostCommands: [
          { key: "head-before-review", command: CLEAN_HEAD_COMMAND },
          { key: "head-after-review", command: CLEAN_HEAD_COMMAND },
          { key: "github-exact-head", command: githubCommand }
        ],
        script: `
          const expectedHead = ${JSON.stringify(expectedHead)};
          const requestedReviewPath = ${JSON.stringify(reviewPath)};

          const before = await runs.host("head-before-review", ${JSON.stringify(headParams)});
          if (!before.ok) throw new Error("ForgeFlow requires a clean committed candidate before final review");
          const reviewedHead = before.stdout.trim().toLowerCase();
          if (reviewedHead !== expectedHead) {
            throw new Error("ForgeFlow local HEAD does not match expectedHead");
          }

          const review = await runs.run("forgeflow-final-review", {
            label: "Review exact ForgeFlow head",
            agent: "reviewer",
            model: "forgeflow/reviewer",
            context: "fresh",
            agentContract: { version: 1 },
            task: ${JSON.stringify(reviewTask)},
            output: requestedReviewPath,
            outputMode: "file-only",
            gate: ${JSON.stringify(reviewGate)}
          });
          if (!review.ok || !review.structuredOutput) {
            throw new Error("ForgeFlow final reviewer or verdict gate failed");
          }

          const reviewPath = requestedReviewPath;

          if (review.structuredOutput.status === "blocked") {
            throw new Error("ForgeFlow final reviewer blocked the candidate; see " + reviewPath);
          }
          if (review.structuredOutput.status !== "clean") {
            throw new Error("ForgeFlow final reviewer verdict contract returned an invalid state");
          }

          const after = await runs.host("head-after-review", ${JSON.stringify(headParams)});
          if (!after.ok || after.stdout.trim().toLowerCase() !== expectedHead) {
            throw new Error("ForgeFlow candidate changed during final review");
          }

          const github = await runs.host("github-exact-head", ${JSON.stringify(githubParams)});
          if (!github.ok) throw new Error("ForgeFlow GitHub acceptance command failed");

          let evidence;
          try {
            evidence = JSON.parse(github.stdout);
          } catch {
            throw new Error("ForgeFlow GitHub acceptance returned invalid JSON");
          }
          if (evidence.status !== "accepted") {
            throw new Error("ForgeFlow exact-head acceptance blocked: " + String(evidence.reason || evidence.status));
          }

          return {
            status: "accepted",
            reviewedHead: expectedHead,
            review: { ...review.structuredOutput, reportPath: reviewPath },
            github: evidence
          };
        `
      };
    }
  };
}
