const ROOT_RULE = Object.freeze({
  id: "INV-ROOT-001",
  title: "Owner truth before new entrypoints",
  triggers: [],
  check:
    "Inspect the owning domain, contracts, write path, and characterization tests before editing; reuse owner invariants instead of cloning weaker validation.",
  adversarial:
    "Compare the new path with the canonical owner path for invalid, null, boundary, and already-existing inputs."
});

const PRIORITY = Object.freeze({
  "INV-TIME-001": 100,
  "INV-IDENTITY-001": 95,
  "INV-OWNER-001": 90,
  "INV-LIFECYCLE-001": 90,
  "INV-CUTOVER-001": 90,
  "INV-PARITY-001": 85,
  "INV-REPLAY-001": 80,
  "INV-HOST-001": 80,
  "INV-ATOMIC-001": 75,
  "INV-ORDER-001": 70
});

export const INVARIANT_RULES = Object.freeze(
  [
    {
      id: "INV-OWNER-001",
      title: "Validation parity",
      triggers: ["schema", "import", "portable", "portability", "profile", "contract", "adapter", "restore"],
      check:
        "The new schema, import, restore, or adapter path must be at least as strict as the owner command or domain invariant.",
      adversarial:
        "Try malformed formats, out-of-range values, nullable edges, and values rejected by the normal owner mutation path."
    },
    {
      id: "INV-TIME-001",
      title: "Explicit product-time semantics",
      triggers: ["birthday", "date", "time", "timezone", "dst", "schedule", "routine", "reminder", "clock"],
      check:
        "Resolve relative-time rules through the project time abstraction or injected clock with explicit user timezone and day semantics.",
      adversarial:
        "Test future and past boundaries, day rollover, leap day, and DST when the domain can observe them."
    },
    {
      id: "INV-IDENTITY-001",
      title: "Identity-scoped ownership",
      triggers: ["identity", "tenant", "user", "deterministic", "portable", "import", "restore", "ownership"],
      check:
        "IDs, lookups, and upserts must not let one identity collide with, mutate, or adopt another identity's state.",
      adversarial:
        "Replay the same logical input for two identities and pre-seed a foreign-owned deterministic ID or child ID."
    },
    {
      id: "INV-LIFECYCLE-001",
      title: "Lifecycle and tombstone safety",
      triggers: ["status", "lifecycle", "archive", "archived", "delete", "deleted", "restore", "replay", "cutover"],
      check:
        "Model archived, deleted, and terminal states explicitly; preflight must reject transitions the owner commands reject.",
      adversarial:
        "Exercise active, terminal, archived, and soft-deleted targets, including an already-matching terminal replay."
    },
    {
      id: "INV-REPLAY-001",
      title: "Retry and idempotency",
      triggers: ["retry", "replay", "batch", "import", "restore", "idempot", "scheduler", "routine"],
      check:
        "A retry after partial progress must converge or fail closed without duplicating side effects or silently accepting drift.",
      adversarial:
        "Interrupt after an early write, retry the same batch, then retry with the same identity or key but divergent business facts."
    },
    {
      id: "INV-PARITY-001",
      title: "Equivalent execution paths",
      triggers: ["dryrun", "dry-run", "apply", "prisma", "powersync", "desktop", "api", "adapter", "runtime"],
      check:
        "Dry-run and apply, plus parallel adapters or runtimes, must perform equivalent semantic validation and produce equivalent owner-visible facts.",
      adversarial:
        "Run one valid and one invalid case through every supported path and compare results, ordering, and failure class."
    },
    {
      id: "INV-ATOMIC-001",
      title: "Preflight before mutation",
      triggers: ["batch", "bulk", "import", "portable", "portability", "transaction", "apply"],
      check:
        "Validate the whole mutable unit before the first irreversible write unless an owner transaction guarantees rollback.",
      adversarial:
        "Make a later item invalid and verify earlier items were not committed or have an explicit rollback contract."
    },
    {
      id: "INV-ORDER-001",
      title: "Stable canonical ordering",
      triggers: ["export", "list", "sort", "order", "reference", "ref", "prisma", "powersync", "portable"],
      check:
        "Any ordinal or ref-producing output needs one owner-level deterministic ordering shared by all adapters.",
      adversarial:
        "Seed the same logical set in different persistence orders or adapters and compare exported refs byte-for-byte."
    },
    {
      id: "INV-HOST-001",
      title: "Host-owned facts stay host-owned",
      triggers: ["portable", "portability", "backup", "import", "export", "identity", "auth", "version", "timestamp"],
      check:
        "Do not serialize or restore host identity, auth, database IDs, versions, timestamps, or derived projections unless explicitly owner-owned.",
      adversarial:
        "Inspect the payload for host identifiers and verify import binds to the target host rather than recreating source ownership."
    },
    {
      id: "INV-CUTOVER-001",
      title: "Single-truth cutover",
      triggers: ["cutover", "legacy", "retire", "delete", "destructive", "dual-write", "migration"],
      check:
        "A destructive cutover must name the sole post-cutover truth, characterize old behavior first, and avoid accidental permanent dual-write or read paths.",
      adversarial:
        "Verify old storage or contracts cannot still mutate truth after cutover and rollback is source or deployment rollback, not hidden compatibility state."
    }
  ].map(Object.freeze)
);

function normalizeTerms(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function inferInvariants(text, { limit = 6 } = {}) {
  const normalized = normalizeTerms(text);
  const haystack = ` ${normalized} `;
  const scored = [];

  for (let index = 0; index < INVARIANT_RULES.length; index += 1) {
    const rule = INVARIANT_RULES[index];
    let hits = 0;
    for (const trigger of rule.triggers) {
      if (haystack.includes(` ${normalizeTerms(trigger)} `)) hits += 1;
    }
    if (hits > 0) {
      scored.push({
        score: (PRIORITY[rule.id] ?? 0) + hits * 10,
        index,
        rule
      });
    }
  }

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const count = Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) - 1 : 5);
  return [ROOT_RULE, ...scored.slice(0, count).map((item) => item.rule)];
}

export function renderPreflight(text, { limit = 6 } = {}) {
  const rules = inferInvariants(text, { limit });
  return [
    "ForgeFlow invariant preflight:",
    "- Inspect the existing owner/domain/contracts and relevant characterization tests before choosing a write path.",
    ...rules.map(
      (rule) =>
        `- [${rule.id}] ${rule.title}: ${rule.check} Adversarial: ${rule.adversarial}`
    ),
    "- Convert applicable invariants into characterization or regression tests before or with the production change.",
    "- Validate narrowly first; reserve broad integration/E2E for the candidate exact head."
  ];
}
