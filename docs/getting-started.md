# Getting started

ForgeFlow is a headless autonomous software-engineering control plane. The fastest local path is to install dependencies, run the deterministic verification suite, and start the API without enabling any project or provider credentials.

## Prerequisites

- Node.js 24+
- npm 10+
- Git

For the full execution plane you will also need Docker and host-level privileges required by the hardened OpenHands/systemd deployment.

## Local verification

```bash
git clone https://github.com/BakerSean168/forgeflow.git
cd forgeflow
npm ci
npm run check
```

`npm run check` is the broad deterministic repository gate:

1. product-boundary validation;
2. TypeScript type checking;
3. full test suite;
4. clean production build.

## Start the local control plane

```bash
npm run dev
```

The default HTTP endpoint is `127.0.0.1:8420`. The checked-in example configuration is intentionally fail-closed: no projects or credentials are enabled by default.

## Configure an execution environment

Read [`configuration.md`](./configuration.md) before enabling providers or repositories. A production-style GCP/Linux deployment also uses:

- `/etc/forgeflow` for operator configuration;
- `/var/lib/forgeflow` for durable state and managed workspaces;
- a version-pinned OpenHands Agent Server execution plane;
- optional provider-native Antigravity systemd workers;
- LiteLLM and/or provider-native resources selected through the ForgeFlow resource directory.

The installer intentionally refuses to start autonomous execution when required project allowlists, credentials, or execution-plane prerequisites are missing.

## Real-provider acceptance

Real-provider lifecycle acceptance is deliberately not part of ordinary `npm run check`:

```bash
npm run smoke:autonomous-lifecycle
```

This creates real Plan/Execution/Review state and can spend provider resources. It should be used as an operator/release gate, not a routine unit-test command.

For the runtime model and release evidence requirements, continue with [`architecture.md`](./architecture.md) and [`development.md`](./development.md).
