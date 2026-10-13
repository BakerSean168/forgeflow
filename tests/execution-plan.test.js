import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseExecutionPolicy } from "../extension/execution-policy.js";
import { inspectPreparedWorktree, captureWorktreeEvidence } from "../extension/execution-git.js";
import { buildExecutionPlan } from "../extension/execution-plan.js";

const policy = parseExecutionPolicy(readFileSync("config/execution-policy.v1.json", "utf8"));
function exec(...args) { return execFileSync(args[0], args.slice(1),{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim(); }
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "forgeflow-policy-git-"));
  const repo = path.join(root, "main");
  const tree = path.join(root, "agent");
  exec("git","init","-q",repo);
  writeFileSync(path.join(repo,"README.md"),"baseline\n");
  exec("git","-C",repo,"add",".");
  exec("git","-C",repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","baseline");
  exec("git","-C",repo,"worktree","add","--detach",tree);
  t.after(()=>{
    try{exec("git","-C",repo,"worktree","remove","--force",tree);}catch{}
    rmSync(root,{recursive:true,force:true});
  });
  return { root, repo, tree, head: exec("git","-C",repo,"rev-parse","HEAD") };
}
const tsk=(id,more={})=>({id,description:"Implement bounded ticket "+id,kind:"implementation",complexity:"low",access:"write",...more});
const availability={isExecutable:()=>true,isModelAvailable:()=>true,resolvePiModel:(model)=>({
  physicalModel:model.endsWith(":low")?"litellm/deepseek-v4.1-flash":"openai-codex/gpt-6.1-sol"
})};

test("P2 read-only Git preflight accepts a registered clean independent worktree", t=>{
  const f=fixture(t);
  const check=inspectPreparedWorktree(f.repo,f.tree,f.head);
  assert.equal(check.ok,true,JSON.stringify(check));
  assert.equal(check.cwd,f.tree);
  assert.equal(check.head,f.head);
  assert.equal(check.clean,true);
  assert.equal(check.activeWriterProof,"not-checked-by-git");
});

test("P2 external writer gets exact cwd and no Pi model override or managed worktree",t=>{
  const f=fixture(t);
  const p=buildExecutionPlan(policy,[tsk("ui",{cwd:f.tree,repo:f.repo,expectedHead:f.head})],availability);
  assert.equal(p.ok,true,JSON.stringify(p.failures));
  assert.equal(p.waves.length,1);
  assert.equal(p.waves[0].nativeRunsAll.length,0);
  const call=p.waves[0].externalSubagentCalls[0];
  assert.equal(call.taskId,"ui");
  assert.equal(call.ownerVerificationRequired,true);
  assert.equal(call.subagent.agent,"zcode-agent-writer");
  assert.equal(call.subagent.cwd,f.tree);
  assert.equal(call.subagent.model,undefined);
  assert.equal(call.subagent.worktree,undefined);
  assert.equal(call.subagent.async,true);
  assert.deepEqual(Object.keys(call.subagent).sort(),["agent","async","cwd","task"]);
});

test("P2 native Pi workers use managed worktrees and explicit virtual models",()=>{
  const p=buildExecutionPlan(policy,[tsk("api"),tsk("component")],availability);
  assert.equal(p.ok,true);
  assert.equal(p.waves.length,1);
  assert.deepEqual(p.waves[0].nativeRunsAll.map(x=>x.agent),["worker","worker"]);
  assert.ok(p.waves[0].nativeRunsAll.every(x=>x.worktree===true));
  assert.ok(p.waves[0].nativeRunsAll.every(x=>x.async===undefined),
    "runs.all children must await completion rather than return launch receipts");
  assert.ok(p.waves[0].nativeRunsAll.every(x=>x.model==="forgeflow/worker:low"));
  assert.equal(p.waves[0].externalSubagentCalls.length,0);
});

test("P2 independent tasks execute together; dependent ones require explicit wave barrier",()=>{
  const p=buildExecutionPlan(policy,[
    tsk("schema",{complexity:"high"}), tsk("ui",{dependsOn:["schema"]}),
    tsk("api",{dependsOn:["schema"]}), tsk("e2e",{dependsOn:["api","ui"]})
  ],{...availability,maxParallel:2});
  assert.equal(p.ok,true);
  assert.deepEqual(p.waves.map(w=>w.taskIds),[["schema"],["ui","api"],["e2e"]]);
  assert.equal(p.waves[1].requiresBarrier,true);
  assert.equal(p.waves[0].requiresBarrier,false);
  assert.ok(p.waves.every(w=>w.requiresAcceptanceBeforeNextWave));
  assert.equal(p.launched,false);
});

test("P2 external writer cannot edit the parent integration checkout",t=>{
  const f=fixture(t);
  const result=buildExecutionPlan(policy,[tsk("ui",{cwd:f.repo,repo:f.repo})],{
    ...availability,inspectWorktree:inspectPreparedWorktree
  });
  assert.equal(result.ok,true,"should safely fall back to native Pi worktree");
  assert.equal(result.waves[0].nativeRunsAll[0].agent,"worker");
  assert.ok(result.decisions[0].candidates.find(x=>x.profile==="zcode-fast-writer")
    .reasons.includes("external-writer-cannot-use-parent-checkout"));
});

test("P2 external worktree dirty/incorrect HEAD cannot pass preflight",t=>{
  const f=fixture(t);
  writeFileSync(path.join(f.tree,"README.md"),"dirty\n");
  const invalid=inspectPreparedWorktree(f.repo,f.tree,f.head);
  assert.equal(invalid.ok,false);
  assert.ok(invalid.problems.includes("worktree-not-clean"));
  const select=buildExecutionPlan(policy,[tsk("ui",{cwd:f.tree,repo:f.repo})],availability);
  assert.equal(select.ok,true);
  assert.equal(select.waves[0].nativeRunsAll.length,1,"dirty external path forces isolated Pi alternative");
  const wrong=inspectPreparedWorktree(f.repo,f.tree,"a".repeat(40));
  assert.ok(wrong.problems.includes("expected-head-mismatch"));
});

test("P2 forced external writer with dirty worktree is blocked, no unsafe fallback",t=>{
  const f=fixture(t);
  writeFileSync(path.join(f.tree,"untracked.txt"),"pending\n");
  const p=buildExecutionPlan(policy,[tsk("ui",{cwd:f.tree,repo:f.repo,profile:"zcode-fast-writer"})],availability);
  assert.equal(p.ok,false);
  assert.equal(p.launched,false);
  assert.equal(p.reason,"fail-closed-before-dispatch");
  assert.ok(p.failures[0].candidates.find(x=>x.profile==="zcode-fast-writer").reasons.includes("worktree-not-clean"));
});

test("P2 duplicate external worktree is rejected across all waves",t=>{
  const f=fixture(t);
  const p=buildExecutionPlan(policy,[
    tsk("first",{cwd:f.tree,repo:f.repo}),
    tsk("second",{cwd:f.tree,repo:f.repo,dependsOn:["first"]})
  ],availability);
  assert.equal(p.ok,false);
  assert.ok(p.failures.some(x=>x.reason==="worktree-claimed-by-another-task"));
});

test("P2 known active external writer blocks a new launch",t=>{
  const f=fixture(t);
  const p=buildExecutionPlan(policy,[tsk("ui",{cwd:f.tree,repo:f.repo})],{
    ...availability,activeWriterPaths:[f.tree]
  });
  assert.equal(p.ok,false);
  assert.ok(p.failures.some(x=>x.reason==="worktree-has-known-active-writer"));
});

test("P2 invalid dependency graph and unsafe parallel count never produce launch plan",()=>{
  assert.throws(()=>buildExecutionPlan(policy,[tsk("a",{dependsOn:["b"]})],availability),/unknown dependency/);
  assert.throws(()=>buildExecutionPlan(policy,[tsk("a")],{...availability,maxParallel:9}),/maxParallel/);
});

test("P3 checkpoint evidence fingerprints both tracked and untracked bytes",t=>{
  const f=fixture(t);
  const original=captureWorktreeEvidence(f.tree);
  assert.equal(original.dirty,false);
  writeFileSync(path.join(f.tree,"README.md"),"changed\n");
  const tracked=captureWorktreeEvidence(f.tree);
  assert.equal(tracked.dirty,true);
  assert.notEqual(original.fingerprint,tracked.fingerprint);
  writeFileSync(path.join(f.tree,"untracked.txt"),"first\n");
  const untracked=captureWorktreeEvidence(f.tree);
  assert.equal(untracked.untrackedCount,1);
  assert.notEqual(tracked.fingerprint,untracked.fingerprint);
  writeFileSync(path.join(f.tree,"untracked.txt"),"second\n");
  assert.notEqual(untracked.fingerprint,captureWorktreeEvidence(f.tree).fingerprint);
});
