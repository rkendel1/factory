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

## Public FeltDB package

Factory consumes the published `@feltdb/core` package through its public
entrypoint. The current release is `0.11.4`; no workspace or repository-local
FeltDB package is required.

```bash
npm install @feltdb/core
```

The smallest durable-state example is:

```ts
import { createFeltDB } from '@feltdb/core';

const db = createFeltDB({
  namespace: 'example',
  authorityScope: { kind: 'tenant', tenantId: 'example', environmentId: 'local' },
});
await db.collection('records').put({ status: 'ready' }, 'record-1');
```

`@feltdb/core` is the public FeltDB release consumed by Factory. `@feltdb/webllm`
is not a Factory runtime dependency and is published and consumed separately.
The `test:external` check installs the registry artifact into a clean temporary
project, compiles a public import, and executes a state operation.

## Factory is an Actions Orchestrator

Factory's product surface is the orchestration of Actions, not the management of
AppPort Services. AppPort Services remains the infrastructure and configuration
area and stays reachable from the navigation, but it is no longer where a new
user lands.

The loop that makes Factory an orchestrator rather than an execution dashboard
is reality, not intent alone:

```text
Reality → compare → drift → plan → authorize → execute → verify → reconcile
```

An operator says what production should look like. Factory observes what it
currently looks like, explains the difference in plain sentences, and proposes
the Action that would close it. Reality is observed from the repository and from
the durable evidence of the run that last reconciled the environment; a field
Factory cannot observe is reported as unknown rather than assumed.

Actions are provider-backed operational work. An Action names a neutral
capability — `deployment.create`, `environment.health`, `build.run` — and
Factory resolves the provider deterministically from durable configuration,
asks AuthBoundry, and hands the provider adapter to the execution boundary.
Credentials are resolved there by name and never recorded. `.flow` decides
which capabilities Factory can perform at all.

Multi-step operational work is an Action Graph: durable coordination over
ordinary Actions with dependencies. The graph coordinates; it does not execute.
Each node runs through the one execution path, is authorized on its own, and
leaves its own Run and Evidence. Factory coordinates operational Actions; Attn
decides what work matters and Eve materializes development, both referenced by
origin metadata rather than read.

With continuous reconciliation enabled for an environment, Factory runs that
loop on a schedule: observe, compare, and act only when desire and reality
actually disagree. The scheduler triggers a pass; the engine decides whether
work is required. `Reconcile Now` calls the same function, just sooner.

Whether an Action may run without a person is AuthBoundry's decision, asked as
the `factory.action.autonomous` capability, not a rule Factory holds. Factory
determines what needs to happen; AuthBoundry determines what may cause it to
happen without a human.

The product model keeps four questions in four records, because collapsing them
loses exactly what the product exists to answer:

| Record | Question |
| --- | --- |
| Desired State | What should be true? |
| Action | What are we going to do to make it true? |
| Run | What actually happened? |
| Evidence | What proves what happened? |

Projects group repositories, environments, and desired state. The lifecycle is
intent → plan → authorization → execution → verification → evidence. An Action
plan is derived from what the repository actually contains — `package.json`,
`Dockerfile`, `fly.toml`, Vercel configuration, GitHub workflows — so an
operator states the outcome rather than the commands. Each plan step cites the
desired-state field or repository file it came from.

Executing an Action goes through the same authority, contract, and evidence path
as any other Factory run. There is no separate Action execution path: the Action
supplies intent and a durable work record, and `.flow` plus AuthBoundry decide
the rest.

AI may eventually propose plans. It is not an authority layer and cannot stand
in for AuthBoundry.

See [docs/product-surface.md](docs/product-surface.md) for the full surface map.

### Product surface

`/factory` is the landing page: Overview, Projects, Actions, Runs, Operations, Requested work, Providers,
AppPort Services, Settings. Providers and their capabilities are read from
`.flow`, never hard-coded in the UI, and the Overview reports the association
state — `associated`, `unassociated`, `unverified` — rather than claiming a
connection because `AUTHBOUNDRY_URL` is set.

## HTTP API

- `GET /v1/overview`
- `GET|POST /v1/projects`, `GET|PATCH /v1/projects/:id`
- `GET|POST /v1/projects/:id/repositories`, `DELETE /v1/projects/:id/repositories/:repositoryId`
- `GET|POST /v1/projects/:id/environments`, `GET /v1/projects/:id/environments/:environmentId`
- `GET|PUT /v1/projects/:id/desired-state`
- `GET /v1/projects/:id/reality`, `GET /v1/projects/:id/environments/:environmentId/reality`
- `POST /v1/projects/:id/environments/:environmentId/reconcile`
- `GET|POST /v1/projects/:id/actions`, `GET /v1/actions/:id`, `POST /v1/actions/:id/run`
- `GET /v1/projects/:id/runs`
- `GET|POST /v1/action-graphs`, `GET /v1/action-graphs/:id`, `POST /v1/action-graphs/:id/run|cancel`, `POST /v1/actions/:id/retry`
- `GET|POST /v1/operational-work`, `GET /v1/operational-work/:id`, `GET /v1/operational-work/:id/events`, `POST /v1/operational-work/:id/cancel` — the Attn ↔ Factory contract (`factory.operational-work/1`), carried as the AppPort capability `softwarefactory.operationalwork@1`; see [docs/product-surface.md](docs/product-surface.md#requested-work-the-attn--factory-contract)
- `GET /v1/reconciliation`
- `GET|POST|PATCH|DELETE /v1/projects/:id/environments/:environmentId/reconciliation`
- `POST /v1/projects/:id/environments/:environmentId/reconcile-now`
- `GET /v1/providers`, `GET /v1/providers/:id`, `GET /v1/providers/:id/capabilities`
- `POST /v1/runs`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/evidence`
- `POST /v1/runs/:runId/cancel`
- `GET /v1/ui` (contextual Factory `AppPort/ui/1` discovery)
- `/v1/configuration` and AppPort Services management routes
- `/` as the browser entrypoint into AuthBoundry and the composed management UI
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
- Product routes use the same authorization middleware as the rest of Factory and the capability names the Factory application association already carries. Factory declares no capability of its own: a name AuthBoundry does not grant would be a second authorization vocabulary.
- Every protected read and cancellation is checked against the AuthBoundry principal and tenant. A run ID is not a bearer capability, and AuthBoundry outages fail closed.
- Factory registers its `.flow` service principals as AuthBoundry agents and resolves its authority from the Factory application association AuthBoundry maintains. The application id in `.flow` is a contract identity, not a grant: an Action executes in the application context AuthBoundry authorized, and a service principal with no such context fails closed. See [docs/factory-authority-association.md](docs/factory-authority-association.md).
- The Factory Runner never executes caller-supplied commands.
- Remote FeltDB must be explicitly configured with `FELTDB_URL`; the server does not silently fall back to local storage for production authority.

PAX is installed separately from the runner. Set `PAX_BIN` (or `paxExecutable` in an embedded service) when the executable is not on `PATH`. PAX availability is required only for capabilities declared with `execution_mode pax`; missing PAX fails that run without falling back to package-manager detection.

## Factory + FeltDB Studio

The Factory uses FeltDB's existing Studio; it does not contain a Factory-specific
Studio application or UI state store. Start Studio with `npx --package
@feltdb/core feltdb studio` and connect it to the same scoped FeltDB authority.
The authoritative `.flow` automatically discovers `Work`, `ExecutionRequest`,
`ExecutionContract`, `Run`, `RunEvent`, `Artifact`, `Evidence`, and
`AuthorizationDecision`, including their relationships and indexes.

Factory owns orchestration and execution. FeltDB owns durable state and evidence.
Studio provides human inspection and proposals, while AuthBoundry owns
authorization and `.flow` owns application capability authority. Studio is
observation-only for execution contracts and authorization decisions; proposals
must return through the Factory/API authority path. Studio never invokes shell,
PAX, AppBoundry, or AppPort directly, and secret values are not persisted in or
displayed from Factory records.

Run lifecycle and evidence are read from FeltDB's live collections, so a Studio
refresh reconstructs the view from durable state rather than a Factory cache.
The composition introduces no custom views, state models, adapter, or
persistence layer: it reuses FeltDB Studio's collection discovery, schema,
relationship, live-update, proposal, preview, and validation surfaces.

The Factory composes the execution stack without replacing any layer:

```text
AuthBoundry → .flow → Factory → ExecutionContract
                         ├── native/PAX execution
                         └── @rkendel1/github-integration → GitHub
                                      │
                                      └── FeltDB
Factory ─────────────────────────────────→ FeltDB evidence
```

AuthBoundry remains the authority boundary (who may act), and the application
`.flow` is the single canonical application contract (what the application
declares). Factory consumes AppPort capabilities through `@appport/sdk`, uses
AppBoundry contract identity, and invokes GitHub only through the public
`@rkendel1/github-integration` package. FeltDB remains the durable Factory state
and evidence boundary. Secret values are never copied into process environments,
contracts, events, evidence, or logs.

Factory directly consumes AppPort Services and mounts its package-owned
configuration API and management UI behind AuthBoundry. Factory contributes
Work, Runs, Evidence, and Artifacts to generic `AppPort/ui/1` composition; it
does not recreate service-management screens or store service state locally.
The GitHub integration remains independently responsible for GitHub transport,
credentials, webhooks, provider persistence, and normalized provider behavior.

| Concern | Distribution | Factory role |
| --- | --- | --- |
| FeltDB | `@feltdb/core@0.11.5` | Durable Factory and service authority |
| AuthBoundry | `@authboundry/core@1.15.3` | Identity, authorization, and browser relying-application adapter |
| AppPort contracts/UI | `@appport/sdk`, `@appport/client`, `@appport/protocol` | Contract projection and generic UI composition |
| AppPort Services | `@appport/services@0.4.3` | Thin authenticated router mount; package owns state and screens |
| AppBoundry | `@appport/appboundry@1.0.10` | Certified application identity |
| GitHub | vendored `@rkendel1/github-integration@1.0.1` package artifact | Thin operation adapter only |
| PAX | external executable | Bounded execution engine |

## Development

```sh
npm install
npm run check
npm ls @appport/sdk @appport/appboundry @rkendel1/github-integration
```
