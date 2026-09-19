# Software Factory Runner

A minimal Node.js + TypeScript Software Factory Runner that keeps `.flow` authoritative, uses FeltDB as the durable state boundary, admits idempotent runs through FeltDB operation admission, executes bounded local commands in ephemeral workspaces, and persists structured evidence back to FeltDB.

## Bootstrap

The implementation follows FeltDB tooling conventions and can be scaffolded from the FeltDB bootstrap command:

```bash
npx --yes create-feltdb@latest software-factory --runtime node --yes
npm install @feltdb/core @authboundry/core
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

Protected requests are authenticated and authorized by AuthBoundry. Configure its canonical origin with `AUTHBOUNDRY_URL` (or `authBoundryUrl` when embedding the service); the runner verifies the AuthBoundry session and asks it to authorize each operation. The request body never supplies the principal or tenant.

## Authority model

- AuthBoundry is the external authority boundary for identity, tenant, session, delegation, and operation authorization. The Factory has no local users, sessions, roles, API keys, or authorization fallback.
- `.flow` declares the Factory capability and execution authority; it does not replace AuthBoundry identity or authorization.
- FeltDB stores the durable run lifecycle, authorization decisions, execution contracts, and structured evidence.
- PAX-backed contracts verify `pax --version`, invoke `pax --json run <target>`, and record PAX provenance separately from native execution evidence.
- Native contracts execute only the command materialized into the execution contract; callers cannot select native execution.
- `POST /v1/runs` accepts only untrusted operation intent (`workId`, operation, repository identity, and optional idempotency key). It never accepts a command, execution mode, PAX target, timeout, capabilities, environment, secret, artifact path, evidence destination, or principal.
- Authorization is evaluated before a contract is created. The Factory derives an immutable, fingerprinted contract from `.flow` and the authorized FeltDB work record; the runner verifies that fingerprint before execution.
- Execution contracts are service-owned artifacts. The current `.flow` policy grammar does not express a distinct service writer subject, so the service enforces create-once semantics and rejects mutations. There is intentionally no contract creation endpoint.
- Evidence records the request, authorization decision, contract fingerprint, principal, operation, repository ref, execution mode, and PAX invocation needed to reconstruct the durable chain.
- Every protected read and cancellation is checked against the AuthBoundry principal and tenant. A run ID is not a bearer capability, and AuthBoundry outages fail closed.
- The Factory Runner never executes caller-supplied commands.
- Remote FeltDB must be explicitly configured with `FELTDB_URL`; the server does not silently fall back to local storage for production authority.

PAX is installed separately from the runner. Set `PAX_BIN` (or `paxExecutable` in an embedded service) when the executable is not on `PATH`. PAX availability is required only for capabilities declared with `execution_mode pax`; missing PAX fails that run without falling back to package-manager detection.
# Software Factory

The Factory composes the execution stack without replacing any layer:

```text
Attn → Factory → AuthBoundry → .flow → FeltDB → ExecutionContract
     → AppPort SDK → AppPort Services → AppBoundry/PAX → execution
     → JEV → FeltDB evidence
```

AuthBoundry remains the authority boundary (who may act), `.flow` remains the
Factory capability boundary (what may happen), and FeltDB remains the durable
state boundary. AppPort is the protocol boundary; `@appport/sdk` supplies the
canonical protocol contract and `@appport/services` supplies scoped service
capabilities. The Factory adapter records only stable operation, service, and
capability references in contracts and evidence. Secret values are never copied
into process environments, contracts, events, evidence, or logs.

AppPort Services operations are downstream of Factory authorization. Webhooks
and jobs may only be used through an explicitly granted capability, and their
tenant is taken from the authorized contract rather than caller input. Direct
AppPort service calls cannot create a Factory run or bypass `.flow`.

## Development

```sh
npm install
npm run check
npm ls @appport/sdk @appport/services
```
