import { execFileSync } from "node:child_process";
import { realpathSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 6000, maxBuffer: 3 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  }).trimEnd();
}
function checkedDir(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("path-must-be-absolute");
  try { return realpathSync(path); }
  catch { throw new Error("path-unavailable"); }
}
function commonGitDir(root) {
  return realpathSync(resolve(root, git(root, "rev-parse", "--git-common-dir")));
}
function worktreesFromRepo(repo) {
  const lines = git(repo, "worktree", "list", "--porcelain").split("\n");
  return lines.flatMap((ln) => ln.startsWith("worktree ") ? [ln.slice(9)] : []);
}

// Pure read-only Git preflight. This is an admission hint, not a concurrency lease.
// The active-run owner must still be checked with pi-subagents immediately before launch.
export function inspectPreparedWorktree(repoPath, worktreePath, expectedHead) {
  const problems = [];
  let repo, cwd, head, status, origin;
  try {
    repo = checkedDir(repoPath);
    cwd = checkedDir(worktreePath);
    const repoTop = checkedDir(git(repo, "rev-parse", "--show-toplevel"));
    if (repoTop !== repo) problems.push("repository-path-not-git-root");
    const cwdTop = checkedDir(git(cwd, "rev-parse", "--show-toplevel"));
    if (cwdTop !== cwd) problems.push("worktree-path-not-git-root");
    if (cwd === repo) problems.push("external-writer-cannot-use-parent-checkout");
    if (commonGitDir(repo) !== commonGitDir(cwd)) problems.push("different-git-repository");
    const registered = worktreesFromRepo(repo).map((path) => {
      try { return checkedDir(path); } catch { return ""; }
    });
    if (!registered.includes(cwd)) problems.push("worktree-not-registered");
    head = git(cwd, "rev-parse", "HEAD");
    if (expectedHead && head !== expectedHead) problems.push("expected-head-mismatch");
    status = git(cwd, "status", "--porcelain", "--untracked-files=all");
    if (status) problems.push("worktree-not-clean");
    origin = repoTop;
  } catch {
    problems.push("git-preflight-failed");
  }
  return {
    ok: problems.length === 0, problems, ...(cwd ? { cwd } : {}),
    ...(origin ? { repo: origin } : {}), ...(head ? { head } : {}),
    ...(status !== undefined ? { clean: !status } : {}),
    activeWriterProof: "not-checked-by-git"
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Untracked contents are included without leaking bytes into receipts. Refuse
// symlink targets and special files rather than opening paths outside the repo.
export function captureWorktreeEvidence(cwdPath) {
  const cwd = checkedDir(cwdPath);
  const head = git(cwd, "rev-parse", "HEAD");
  const trackedDiff = execFileSync("git", ["-C", cwd, "diff", "--binary", "HEAD", "--"],
    { timeout: 6000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const untracked = execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
    { timeout: 6000, maxBuffer: 3 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
    .toString("utf8").split("\0").filter(Boolean).sort();
  if (untracked.length > 1024) throw new Error("too-many-untracked-files");
  const hashes = [];
  for (const file of untracked) {
    const path = resolve(cwd, file);
    if (!path.startsWith(cwd + sep)) throw new Error("untracked-path-escapes-worktree");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      throw new Error("untracked-special-or-oversized-file");
    }
    hashes.push([file, digest(readFileSync(path))]);
  }
  const status = git(cwd, "status", "--porcelain", "--untracked-files=all");
  const fingerprint = digest(JSON.stringify({ head, diff: digest(trackedDiff), untracked: hashes, status }));
  return Object.freeze({
    cwd, head, fingerprint, dirty: Boolean(status),
    trackedDiffSha256: digest(trackedDiff), untrackedCount: untracked.length,
    untrackedContentVerified: true
  });
}
