# Software Factory Runner

A minimal Node.js + TypeScript Software Factory Runner that keeps `.flow` authoritative, uses FeltDB as the durable state boundary, admits idempotent runs through FeltDB operation admission, executes bounded local commands in ephemeral workspaces, and persists structured evidence back to FeltDB.

## Bootstrap

The implementation follows FeltDB tooling conventions and can be scaffolded from the FeltDB bootstrap command:

```bash
npx --yes create-feltdb@latest software-factory --runtime node --yes
npm install @feltdb/core
```

This repository keeps the runtime intentionally small and focused on the first authority → execution → evidence loop.

## Development

```bash
npm install
npm test
FACTORY_FELTDB_MODE=local npm run dev
```

## HTTP API

- `POST /v1/runs`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/evidence`
- `POST /v1/runs/:runId/cancel`
- `GET /health`

Authenticate requests with the `Authorization` header by sending the caller principal after the `Bearer` prefix, or by setting the `X-Factory-Principal: factory-service` header during local testing.

## Authority model

- `.flow` declares the operation authority and authorized principals.
- FeltDB stores the durable run lifecycle, authorization decisions, execution contracts, and structured evidence.
- PAX-backed contracts verify `pax --version`, invoke `pax --json run <target>`, and record PAX provenance separately from native execution evidence.
- Native contracts execute only the command materialized into the execution contract; callers cannot select native execution.
- Remote FeltDB must be explicitly configured with `FELTDB_URL`; the server does not silently fall back to local storage for production authority.

PAX is installed separately from the runner. Set `PAX_BIN` (or `paxExecutable` in an embedded service) when the executable is not on `PATH`. PAX availability is required only for capabilities declared with `execution_mode pax`; missing PAX fails that run without falling back to package-manager detection.
