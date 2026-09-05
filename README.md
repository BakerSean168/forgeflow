# ForgeFlow

**ForgeFlow** is an autonomous software engineering system.

It accepts a software-engineering objective and owns the durable path from planning through implementation, independent review, repair, integration, delivery, recovery, and continuous improvement.

## Product boundary

ForgeFlow is intentionally headless. It is **not** a pixel-art visualization, virtual office, employee/workforce simulator, or VS Code decoration layer.

The v1 product consists of:

- a durable Plan and work-graph engine;
- an AI Supervisor for diagnosis, replanning, and exceptional recovery;
- isolated execution/worktree management;
- model/provider resource selection and bounded fallback;
- exact-revision independent review and repair loops;
- deterministic integration, CI, PR, merge, and delivery governance;
- system-repair child plans and a bounded self-improvement pipeline.

## v1 migration status

This repository was bootstrapped from the proven Pixel Agent V4 control-plane kernel. Migration work removes legacy naming and infrastructure coupling while preserving tested execution, provenance, review, and safety invariants.

The old Pixel Agents visual product, Office Bridge, VS Code extension, game assets, and office/employee/workforce domain are intentionally not part of this repository.
