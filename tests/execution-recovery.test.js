import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { captureWorktreeEvidence } from "../extension/execution-git.js";
import { parseExecutionPolicy } from "../extension/execution-policy.js";
import { assessExecutionTakeover, classifyExecutionFailure } from "../extension/execution-recovery.js";

const executionPolicy = parseExecutionPolicy(readFileSync("config/execution-policy.v1.json", "utf8"));
const assess = (x) => assessExecutionTakeover(x, { policy: executionPolicy });
function fixture(t) {
  const cwd=mkdtempSync(path.join(os.tmpdir(),"forgeflow-takeover-"));
  execFileSync("git",["-C",cwd,"init","-q"],{stdio:"ignore"});
  writeFileSync(path.join(cwd,"a.txt"),"base\n");
  execFileSync("git",["-C",cwd,"add","."],{stdio:"ignore"});
  execFileSync("git",["-C",cwd,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","base"],{stdio:"ignore"});
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  writeFileSync(path.join(cwd,"a.txt"),"work-in-progress\n");
  writeFileSync(path.join(cwd,"new.txt"),"partial feature\n");
  return { cwd, snapshot:captureWorktreeEvidence(cwd) };
}
function records(f,overrides={}) {
  const runId="run-verified-0001";
  return {
    run: { id:runId, agent:"zcode-agent-writer",status:"failed",
      owner:"pi-subagents",stopConfirmed:true,worktree:f.cwd,
      error:"429 rate limit quota exceeded" },
    checkpoint:{sourceRunId:runId,summary:"Changes captured, tests pending.",
      head:f.snapshot.head,fingerprint:f.snapshot.fingerprint},
    approval:{id:"approval-20261013-001",granted:true,scope:"cross-agent",
      sourceRunId:runId,by:"operator"},
    targetAgent:"glm-agent-writer",
    targetWorktree:f.cwd,
    activeWriterRunIds:[],
    ...overrides
  };
}

test("P3 categorizes upstream supply failures, not request/tool/policy failures",()=>{
  assert.equal(classifyExecutionFailure("429 rate limit").supplyRelated,true);
  assert.equal(classifyExecutionFailure("invalid request 429").supplyRelated,false);
  assert.equal(classifyExecutionFailure("tool execution failed: 503").category,"tool-failure");
  assert.equal(classifyExecutionFailure("policy violation").supplyRelated,false);
  assert.equal(classifyExecutionFailure("no response").category,"unknown");
  assert.throws(()=>classifyExecutionFailure(undefined),/failureMessage/);
});

test("P3 controlled cross-Agent handoff returns proof and does not launch",t=>{
  const f=fixture(t);
  const result=assess(records(f));
  assert.equal(result.ok,true,JSON.stringify(result.blocked));
  assert.equal(result.status,"eligible-for-controlled-manual-handoff");
  assert.equal(result.automaticRestart,false);
  assert.equal(result.handoff.cwd,f.cwd);
  assert.equal(result.handoff.checkpointFingerprint,f.snapshot.fingerprint);
  assert.equal(result.handoff.toAgent,"glm-agent-writer");
  assert.equal(result.dirtyWorktree,true);
});

test("P3 active runs, missing supervisor proof, missing consent and stale checkpoint block",t=>{
  const f=fixture(t);
  const input=records(f);
  assert.equal(assess(records(f,{
    run:{...input.run,status:"running"}
  })).ok,false);
  assert.ok(assess(records(f,{
    run:{...input.run,stopConfirmed:false}
  })).blocked.includes("old-agent-termination-not-confirmed"));
  assert.ok(assess(records(f,{
    approval:{...input.approval,granted:false}
  })).blocked.includes("explicit-operator-cross-agent-approval-required"));
  assert.ok(assess(records(f,{
    checkpoint:{...input.checkpoint,fingerprint:"f".repeat(64)}
  })).blocked.includes("partial-diff-changed-since-checkpoint"));
});

test("P3 refuses a second active writer even with operator approval",t=>{
  const f=fixture(t);
  const result=assess(records(f,{activeWriterRunIds:["other-active-run"]}));
  assert.equal(result.ok,false);
  assert.ok(result.blocked.includes("another-active-writer-is-recorded"));
  assert.equal(result.automaticRestart,false);
});

test("P3 refuses missing active roster, different worktree, same Agent and unbound checkpoint",t=>{
  const f=fixture(t);const base=records(f);
  assert.ok(assess(records(f,{activeWriterRunIds:undefined})).blocked.includes("current-active-writer-roster-required"));
  assert.ok(assess(records(f,{targetWorktree:"/tmp/other"})).blocked.includes("takeover-requires-same-reviewed-worktree"));
  assert.ok(assess(records(f,{targetAgent:base.run.agent})).blocked.includes("takeover-must-specify-different-agent"));
  assert.ok(assess(records(f,{checkpoint:{...base.checkpoint,sourceRunId:"other"}})).blocked.includes("checkpoint-run-id-mismatch"));
});

test("P3 refuses partial working tree changes after a supposedly complete checkpoint",t=>{
  const f=fixture(t);const approved=records(f);
  writeFileSync(path.join(f.cwd,"new.txt"),"modified while old worker was stopping\n");
  const blocked=assess(approved);
  assert.equal(blocked.ok,false);
  assert.ok(blocked.blocked.includes("partial-diff-changed-since-checkpoint"));
});

test("P3 semantic errors and unknown failures are not cross-Agent quota failover",t=>{
  const f=fixture(t);const base=records(f);
  for(const error of ["invalid request", "context overflow", "tool execution failed", "unclassified error"]){
    const result=assess(records(f,{run:{...base.run,error}}));
    assert.equal(result.ok,false);
    assert.ok(result.blocked.includes("failure-not-eligible-for-agent-substitution"));
  }
});

test("P3 disabled or native-Pi target cannot take over a dirty external worktree",t=>{
  const f=fixture(t);
  const dsh=assess(records(f,{targetAgent:"dsh-agent-writer"}));
  assert.equal(dsh.ok,false);
  assert.ok(dsh.blocked.includes("target-agent-not-eligible-for-dirty-worktree-takeover"));
  const pi=assess(records(f,{targetAgent:"worker"}));
  assert.equal(pi.ok,false);
  assert.ok(pi.blocked.includes("target-agent-not-eligible-for-dirty-worktree-takeover"));
});

test("P3 source errors and partial prompt cannot leak into eligibility output",t=>{
  const f=fixture(t);const input=records(f,{
    run:{...records(f).run,error:"upstream error private credential placeholder secret-text"}
  });
  const result=assess(input);
  const text=JSON.stringify(result);
  assert.doesNotMatch(text,/private credential|secret-text/);
});
