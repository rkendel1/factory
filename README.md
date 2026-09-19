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

Authenticate requests by sending the caller principal after the word ****** the Authorization header, or by setting the X-Factory-Principal header during local testing.

## Authority model

- `.flow` declares the operation authority and authorized principals.
- FeltDB stores the durable run lifecycle, authorization decisions, execution contracts, and structured evidence.
- The runner executes only the command materialized into the execution contract.
- Remote FeltDB must be explicitly configured with `FELTDB_URL`; the server does not silently fall back to local storage for production authority.
