# ForgeFlow TaskGraph V1

## Decision

ForgeFlow separates **planning truth** from **execution truth**.

```text
Large Objective
      |
      v
Repository plan / ADR / current code / open work
      |
      v
TaskGraph V1                     <- planning truth
      |
      +-- Task A
      +-- Task B depends_on A
      +-- Task C
      +-- Task D conflicts/overlaps C
      |
      v
bounded mutation slots (max 4)   <- runtime scheduling capacity only
      |
      v
independent ForgeFlow threads / sandboxes
      |
      v
implementation -> tests -> PR -> exact-head CI -> review -> repair -> acceptance
```

A **Task is not a lane**. A Task is a durable, versioned implementation contract. A lane/slot is only
runtime capacity used to execute a dependency-ready Task. This prevents scheduler mechanics from
becoming the project model.

## Three sources of truth

ForgeFlow intentionally keeps three different concerns separate:

1. **Repository plan / ADR / code** explain the product and architecture context.
2. **TaskGraph** is the machine-readable, execution-ready decomposition of one large objective.
3. **ForgeFlow LangGraph threads** own runtime state such as implementation, PR, CI, review, repair,
   waiting, and acceptance evidence.

TaskGraph never stores live execution status. Runtime state never rewrites the architectural plan.

## TaskGraph contract

A TaskGraph is a repository-owned JSON file. It has an explicit `schema_version`, stable `graph_id`,
and positive integer `revision`.

Graph-level fields:

- `objective`: the large outcome all Tasks jointly serve;
- `planned_by`: planning provenance such as `chatgpt-web` or a future AI planner;
- `context_refs`: repository-relative plans/ADRs the implementation workers should read;
- `architecture_decisions`: system-wide decisions every Task must preserve;
- `protected_contracts`: invariants no local implementation may bypass;
- `non_goals`: adjacent work that must not leak into the objective;
- `acceptance_criteria`: system-level completion evidence;
- `tasks`: ordered implementation contracts. Order is the preferred deterministic scheduling order,
  subject to dependencies and conflicts.

Each Task contains:

- `id`, `title`, `goal`, `why_now`, and `risk`;
- `scope` and `out_of_scope`;
- `context_refs` and task-specific `protected_contracts`;
- concrete `implementation_steps`;
- `integration_notes` describing adjacent boundaries;
- verifiable `acceptance_criteria`;
- exact `verification_commands`;
- `depends_on` for hard acceptance prerequisites;
- `conflicts_with` for semantic conflicts that cannot run concurrently;
- `mutation_keys` for deterministic exclusive ownership domains.

TaskGraph deliberately does **not** support legacy `match_terms` or plan-text completion markers. A
TaskGraph writer must carry current semantic fingerprint metadata, and Task completion must come from
exact-head CI/review evidence already accepted onto the configured base. Legacy adoption shortcuts stay
confined to the old inline-lane compatibility format.

See [`examples/task-graph-v1.example.json`](./examples/task-graph-v1.example.json).

## Why `mutation_keys` exist

File lists alone are not a sufficient concurrency boundary. Two workers can edit different files while
mutating the same schema or contract. TaskGraph therefore declares stable semantic ownership keys,
for example:

```text
contract:routine
schema:task
package:@memoflow/time
domain:notification
ui:task-management
```

If a dependency-ready candidate shares a `mutation_key` with an active Task, the supervisor does not
start it even when neither Task explicitly declares `conflicts_with`.

`conflicts_with` remains available for conflicts that are real but not represented by the same
ownership key.

## Deterministic validation before mutation

TaskGraph V1 fails closed before any writer starts when, among other cases:

- the schema version or revision is invalid;
- Task IDs are duplicated;
- a dependency/conflict references an unknown Task;
- the dependency graph contains a cycle;
- a Task lacks scope, implementation steps, acceptance criteria, verification commands, or
  `mutation_keys`;
- a context reference escapes the repository or a configured repository reference is missing;
- both legacy inline `lanes` and a first-class `task_graph_path` are configured;
- a running Task cannot prove the current TaskGraph semantic fingerprint and therefore cannot be safely adopted;
- Task entries attempt to use legacy lane-only adoption/completion fields such as `match_terms`.

Task execution identity is derived from a deterministic semantic fingerprint over the graph objective,
global context references, architecture decisions, protected contracts, non-goals, graph acceptance
criteria, and the complete Task specification. `revision` and planning provenance are deliberately
excluded from that fingerprint.
A revision-only edit can therefore reuse an identical in-flight or accepted Task, while any execution-
relevant semantic change creates a new identity even when someone forgot to bump the revision. An
older or otherwise unknown writer without the current semantic fingerprint blocks parallel expansion.

## Execution prompt construction

A Task worker receives enough global context to avoid local optimization while still owning only one
bounded mutation unit. ForgeFlow renders into the objective:

- the large objective and TaskGraph identity/revision;
- architecture decisions and global protected contracts;
- global non-goals;
- the current Task's goal, rationale, risk, scope, and exclusions;
- task-level protected contracts and integration notes;
- dependencies, explicit conflicts, and exclusive mutation keys;
- implementation steps and verification commands;
- graph-level plus task-level acceptance criteria.

The worker is explicitly told to stop rather than widen scope when repository evidence contradicts the
TaskGraph or ownership boundary.

## Preferred external-planning workflow

The default workflow keeps planning with ChatGPT Web:

```text
User objective
   |
   v
ChatGPT Web
- inspect repository
- inspect canonical plan / ADRs
- inspect open PRs and active writers
- define system architecture and protected contracts
- decompose execution-ready Tasks
   |
   v
repository TaskGraph JSON
   |
   v
ForgeFlow deterministic validator
   |
   v
bounded parallel execution
```

Project configuration points at the versioned TaskGraph instead of embedding detailed Tasks in the
local project manifest:

```json
{
  "continuous_supervisor": {
    "enabled": true,
    "base_ref": "feat/convergence",
    "plan_paths": ["docs/plan/active/current.md"],
    "task_graph_path": "docs/plan/active/current.tasks.json",
    "max_parallel_mutations": 4,
    "ai_decomposition_enabled": false,
    "auto_merge_ready": true
  }
}
```

The local manifest remains deployment configuration. The repository-owned TaskGraph remains planning
truth.

## Optional AI decomposition

ForgeFlow includes an AI TaskGraph proposal generator, but it is **not part of the automatic
supervisor path** and is disabled by default.

Activation requires both:

1. global operator gate `FORGEFLOW_ENABLE_AI_DECOMPOSITION=1`; and
2. project-level `ai_decomposition_enabled: true`.

The planner uses the configured REASONING model route and structured output. It receives a bounded
large objective, constraints, and repository context, then produces the same TaskGraph V1 contract.
Its output still passes deterministic TaskGraph validation.

Most importantly, AI decomposition only returns a **proposal**. It does not change
`task_graph_path`, activate the proposal, or start mutation workers. A human/ChatGPT control plane can
review the proposal and explicitly make it canonical later.

The default remains:

```text
ChatGPT plans -> ForgeFlow validates -> ForgeFlow executes
```

not:

```text
ForgeFlow invents work -> ForgeFlow immediately executes it
```

## Legacy lanes

Inline `continuous_supervisor.lanes` remain a compatibility input for already-running deployments.
They are projected into the same bounded scheduler and may retain legacy `match_terms` / plan completion
markers, but those shortcuts never apply to TaskGraph V1. Legacy lanes do not carry the richer system
context, fingerprinted ownership, and verification contract of TaskGraph V1.

New project work should use `task_graph_path`. A project must not configure both formats at the same
time.

## Protected invariants

TaskGraph V1 does not weaken ForgeFlow's existing delivery gates:

- each mutation Task still runs in an isolated objective/sandbox;
- unknown ownership blocks automatic expansion;
- dependencies must be accepted before dependents dispatch;
- semantic and mutation-key conflicts block concurrent writers;
- `READY` completion requires matching observed/CI/reviewed exact-head evidence;
- CI/review stages continue to reserve mutation capacity because repair may reopen mutation;
- acceptance, repair, and re-review stay runtime evidence, not planner claims.
