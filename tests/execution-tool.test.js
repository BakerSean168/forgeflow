import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseExecutionPolicy } from "../extension/execution-policy.js";
import { parseModelPolicy } from "../extension/model-policy.js";
import { registerExecutionPolicyTool } from "../extension/execution-tool.js";

const policy = parseExecutionPolicy(readFileSync("config/execution-policy.v1.json","utf8"));
const modelPolicy = parseModelPolicy(JSON.stringify({
  version:3, supplies:{ sol:{sources:[{id:"team",model:"openai-codex/gpt-6.1-sol",priority:1}] } },
  roles:{ worker:{ defaultRoute:"fast",defaultTaskClass:"implementation",routes:[
    {id:"fast",model:"litellm/deepseek-v4.1-flash",taskClasses:["mechanical","implementation"],
      minThinkingLevel:"low",maxThinkingLevel:"low",defaultThinkingLevel:"low"},
    {id:"core",supplyGroup:"sol",taskClasses:["implementation","debug"],
      minThinkingLevel:"medium",maxThinkingLevel:"high",defaultThinkingLevel:"medium"}
  ]} }
}));
const models=[
  {provider:"forgeflow",id:"worker",api:"pi-virtual"},
  {provider:"litellm",id:"deepseek-v4.1-flash",api:"openai-completions"},
  {provider:"openai-codex",id:"gpt-6.1-sol",api:"openai-codex-responses"}
];
function make() {
  let registered;
  registerExecutionPolicyTool({ registerTool(t){registered=t;} },{policy,modelPolicy});
  const ctx={cwd:process.cwd(),isProjectTrusted:()=>false,
    modelRegistry:{getAll:()=>models,find:(a,b)=>models.find(x=>x.provider===a&&x.id===b)}};
  return {registered,ctx};
}
const ticket={id:"api",description:"Implement API changes",kind:"implementation",complexity:"low",access:"write"};

test("Pi tool registers one read-only policy compiler, not a child runtime",()=>{
  const {registered}=make();
  assert.equal(registered.name,"forgeflow_execution");
  assert.deepEqual(registered.parameters.required,["action"]);
  assert.ok(registered.description.includes("NEVER launches"));
});

test("Pi tool select chooses executable model and reports why",async()=>{
  const {registered,ctx}=make();
  const selected=await registered.execute("test",{action:"select",task:ticket},ctx);
  assert.equal(selected.details.ok,true);
  assert.equal(selected.details.selection.agent,"worker");
  assert.equal(selected.details.selection.physicalModel,"litellm/deepseek-v4.1-flash");
  assert.ok(selected.content[0].text.includes("pi-fast-writer"));
});

test("Pi tool plan builds waves but doesn't launch",async()=>{
  const {registered,ctx}=make();
  const p=await registered.execute("t",{action:"plan",tasks:[ticket,{...ticket,id:"ui",dependsOn:["api"]}]},ctx);
  assert.equal(p.details.ok,true);
  assert.equal(p.details.launched,false);
  assert.deepEqual(p.details.waves.map(x=>x.taskIds),[["api"],["ui"]]);
});

test("Pi tool inventory/inputs fail closed and do not leak credentials",async()=>{
  const {registered,ctx}=make();
  const inv=await registered.execute("t",{action:"inventory"},ctx);
  assert.equal(inv.details.profiles.length,10);
  assert.equal(inv.details.profiles.find(x=>x.id==="dsh-writer").availableForPlanning,false);
  await assert.rejects(()=>registered.execute("t",{action:"select",tasks:[ticket]},ctx),/one task/);
  await assert.rejects(()=>registered.execute("t",{action:"recover"},ctx),/recovery only/);
});
