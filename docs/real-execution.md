# Real Action execution

Factory says an Action succeeded only when the external operation actually
happened and the required resulting state was actually verified. This document
describes the path that makes that true, what each part is allowed to know, and
the runtime configuration a deployed Factory needs for each provider.

```
Action
  ↓ capability            (the neutral vocabulary: deployment.create, …)
  ↓ provider              (resolved from .flow and durable configuration)
  ↓ preflight             (deterministic; recorded on the Action)
  ↓ AuthBoundry           (per Action, at execution time)
  ↓ credential resolution (by name, inside the execution boundary only)
  ↓ real provider operation
  ↓ provider result       (structured, sanitized, reported by the adapter)
  ↓ verification          (against reality: a health probe, an observed HEAD)
  ↓ Run
  ↓ Evidence
  ↓ Reality               (environment current state, from what was observed)
```

## What "executable" means

A capability is executable from a Factory instance only when all of these hold:

| Requirement | Where it is decided |
| --- | --- |
| an adapter implements the capability | `ProviderAdapter.capabilities` |
| a `.flow` operation declares it for that provider | `provider` and `operational_capability` statements |
| the mechanism is reachable from this process | `adapter.availability(capability)` — the CLI is on `PATH`, or the probe runs in-process |
| every credential the adapter names is present | `credentialResolver(name)` — presence by name only |
| the Factory resource binds to a provider resource | `adapter.resource(capability, context)` |

The Providers API and page report each of these separately as
`implementation`, `declared`, `available`, `credential`, `configuration` and
`executable`, with the reasons when `executable` is false. A capability in the
vocabulary that a provider does not implement (for example `deployment.rollback`
on Fly) is listed under `vocabulary`, never as an available Action. None of
this is authorization: whether Factory *may* act is AuthBoundry's answer, asked
per Action.

## Execution preflight

Before any provider is invoked, `runAction` performs these checks in order and
records them on the Action as `preflight.checks`:

1. **Terminal?** A succeeded, failed, running or cancelled Action returns
   without touching anything. A failed Action runs again only through an
   explicit retry, which admits one new attempt with its own Run.
2. **Autonomy.** AuthBoundry is asked whether the Action may run without a
   person (`factory.action.autonomous`). Denied → `awaiting-approval`,
   outcome `autonomy-denied`; unreachable → `authority-unavailable`.
3. **Capability supported.** Declared by `.flow` and implemented by an adapter,
   else `capability-unavailable`.
4. **Provider resolved and available.** The configured provider still satisfies
   the capability and its mechanism is reachable, else `provider-unavailable`.
5. **Resource bound.** `environment:production` resolves through the
   environment's configuration (or the repository's `fly.toml`) to a provider
   resource such as `fly:app:checkout-app`, else `resource-unavailable`. A
   caller cannot name a provider identifier directly; the binding is always
   derived from durable configuration.
6. **Configuration present.** The bound resource's parameters are known.
7. **Credentials available.** Every credential the adapter names resolves, by
   name. The value is not read here. Missing → `credential-unavailable`.
8. **Authority available.** The Factory application context AuthBoundry
   authorized exists, else `authority-unavailable`.
9. **Authorized.** The Run is admitted and `.flow` authorization is evaluated by
   AuthBoundry for this principal and operation.

Only after every check passes does the execution boundary spawn the provider
operation. A preflight failure writes a durable `failure: { phase, outcome,
reason }` on the Action and starts no Run.

## The execution boundary

`executeContract` is the only place a provider mechanism is started. It:

- resolves credential values by name at the moment of spawning and places them
  only in the child process environment;
- runs the exact command the `.flow` contract authorizes — never a shell, never
  a command assembled from Action parameters;
- captures stdout and stderr with a fixed bound (256 KiB each, the rest counted
  and marked truncated), distinguishable, with the exit code;
- redacts every resolved credential value, and bearer/cookie/`token=` patterns,
  from captured output and from any error message about the process;
- enforces the contract's timeout and cancellation by signalling the whole
  process group (SIGTERM, then SIGKILL after a grace period), so a provider CLI's
  children stop too;
- records the termination reason: `exit`, `signal`, `timeout`, `cancelled`,
  `spawn-failed` (the mechanism could not start) or `not-started` (Factory
  stopped before spawning).

The checkout commit recorded on evidence is what `git rev-parse HEAD` observed
after the checkout. A requested commit is recorded as `revision.requested`; a
checkout that does not reach it fails rather than reporting it as reality.

## Provider adapters report; Factory records

An adapter never creates a Run or Evidence. After the operation it reads the
evidence back into a `ProviderExecutionResult`:

```
{ status: succeeded | rejected | failed | cancelled,
  providerOperationId, startedAt, completedAt, durationMs,
  metadata, observed: { revision?, health?, healthStatus?, healthUrl? }, summary }
```

`rejected` means the provider refused (unauthorized, app not found); `failed`
means the operation ran and did not succeed. Factory stores the result on the
evidence as `providerResult` and summarises it on the Action as `execution`.

Verification then asks reality:

| Capability | Verification |
| --- | --- |
| `repository.inspect` | the HEAD git observed |
| `repository.checkout` | the resulting HEAD, and that it matches the requested revision when one was requested |
| `build.run`, `test.run` | the script exited 0; a repository that declares no such script is `verification-unavailable`, not success |
| `deployment.create` | `fly deploy` exited 0, **and** a real HTTP probe of the environment's health URL returns success; no health URL → `verification-unavailable` |
| `environment.health` | the probe's response |

An Action's outcome is one of `succeeded`, `capability-unavailable`,
`provider-unavailable`, `resource-unavailable`, `credential-unavailable`,
`autonomy-denied`, `authority-unavailable`, `awaiting-approval`,
`execution-failed`, `verification-failed`, `verification-unavailable` or
`cancelled`. `execution.requestedAt`, `startedAt`, `completedAt` and
`durationMs` come from the boundary's own clock; an Action that was only
planned has no `execution` at all.

## Cancellation and restart

`POST /v1/actions/:id/cancel` marks a planned Action cancelled (it never runs)
or stops a running one through its Run. A late provider result never un-cancels
a Run: what was cancelled stays cancelled, and the evidence says so. On startup
Factory marks Runs and Actions that were executing when the previous process
stopped as failed with phase `interrupted`; nothing resumes on its own.

## Reconciliation reaches reality

A reconciliation pass that executes an Action re-observes the environment
before reporting. Current state is written from what the operation observed
(the revision git or the provider reported) and what verification found (health
from a probe that ran; `unknown` when nothing probed). Only a fresh comparison
that finds no drift lets the pass report `executed`; otherwise it reports
`drift-detected` with the re-observation's explanation.

## Durable execution ownership and uncertain outcomes

Every Run has one durable execution history and one authoritative attempt at
a time. Ownership lives on the Run record, never in process memory:

| Field | Meaning |
| --- | --- |
| `executionOwner` | the worker that holds the Run |
| `leaseExpiresAt` | when that ownership lapses without a heartbeat |
| `attempt` | advanced each time ownership is acquired or reclaimed |
| `heartbeatAt` | last renewal by the owning worker |
| `finishedAt` | when execution ended, whatever the outcome |
| `providerOperationId` | the provider's own reference, when it gave one; never manufactured |
| `uncertainty` | present while, or since, the external outcome could not be determined |

Ownership is acquired by compare-and-swap on the Run. A lease another worker
still holds refuses the acquisition; an expired lease is reclaimed with the
attempt advanced. Reclaiming decides nothing about the external operation:
what the new owner may do follows from the Run's status and the provider's
idempotency, never from the lease.

**Unknown is its own state.** When the provider may have been invoked and
Factory did not see the result — the process stopped in flight, the result
could not be persisted, contact was lost — the Run is `unknown`, the Action
is `unknown` with outcome `unknown`, evidence records the verdict `UNKNOWN`,
and the graph or operational work containing it is `unresolved`. None of this
is failure. `execution-failed` is written only when Factory knows the
operation did not complete.

**Reality resolves unknown; retries never do so blindly.** Resolution asks the
provider adapter to observe, never to repeat:

| Observation | Result |
| --- | --- |
| `established` (for a deployment: the environment is serving and healthy) | the Run completes, the Action succeeds with the observation as its verification, reality is recorded |
| `absent` | the Run and Action fail, with the observation as the reason |
| `retry-safe` (read-only or ephemeral operations) | the Action returns to planned for a new attempt; the unknown Run stays as history |
| `undetermined` | everything stays unknown; the observation is recorded on the Run |

A retry of an unknown Action is refused unless the provider's semantics make
a repeat safe. Reconciliation treats an unknown Action as open and adopts it
rather than planning a duplicate.

**Restart recovery** loads every non-terminal Run, leaves those whose lease
another worker still holds alone, and settles the rest from what they had
reached: before invocation they are failed and known (`interrupted`), in
flight they are unknown, and past persistence their verification resumes
from the durable evidence. No successful or failed Run is replayed, no
unknown operation is repeated, and nothing is fabricated. The same rules apply
to Action Graphs: a completed node is never executed again, an unknown node
blocks its dependents until reality resolves it, and a restarted coordinator
resumes from durable node state.

**Cancellation records what it cancelled.** The Action's `cancellation` names
the stage — `before-invocation`, `native-execution`,
`after-external-submission`, `during-verification`, `after-completion` — and
the effect: `not-started`, `stopped` (a local process), `submitted` (an
external operation that may stand), or `none`. Cancelling never claims an
external effect was reversed.

**The evidence chain.** Each attempt's evidence carries `chain`:
operational work → graph → Action → authorization decision → Run → execution
owner and attempt → provider, capability, resource and provider resource →
idempotency identity and provider operation id → verification → observed
reality. It holds identifiers and names only.

Tests inject process failure through `executionHooks` checkpoints
(`before-authorization`, `after-authorization`, `after-run-created`,
`after-ownership`, `before-invocation`, `after-invocation`,
`after-result-before-persistence`, `after-persistence-before-verification`,
`after-verification-before-completion`, `after-evidence`). Production
configures no hooks, and no behaviour depends on them.

## Runtime configuration

Four kinds of configuration are kept apart. None of them is a credential value
in a repository file.

**Factory service identity** — how Factory itself is authenticated and
authorized:

| Setting | Purpose |
| --- | --- |
| `AUTHBOUNDRY_URL` | the authority Factory asks, per Action |
| `AUTHBOUNDRY_OPERATOR_CREDENTIAL` | provisioning and association verification only |
| `FACTORY_SERVICE_CREDENTIAL` | the continuous reconciliation worker's own credential; without it no autonomous loop runs |
| `executionLeaseMs`, `workerId` (service configuration) | how long a worker's Run ownership lasts without a heartbeat (default 60 s), and the worker's durable identity (default per process) |
| `FELTDB_URL`, `FELTDB_TOKEN` | the durable state and evidence store |

**Provider credentials** — resolved by name at the execution boundary and never
stored, logged or returned:

| Provider | Credential names | Notes |
| --- | --- | --- |
| git | none | reads the mirrored repository |
| local | none | runs the repository's own scripts in an ephemeral workspace |
| fly | `FLY_API_TOKEN` | read by the fly CLI from its process environment |

In production, set provider credentials as platform secrets (for the Fly
deployment, `fly secrets set FLY_API_TOKEN=... -a <factory-app>`). Factory's own
process environment is the default credential resolver; a deployment can supply
a different `credentialResolver` (for example one backed by a secrets manager)
without any other part of Factory changing.

**Provider configuration** — what a provider needs installed or reachable:

| Provider | Requirement |
| --- | --- |
| git | `git` on `PATH` |
| local | `npm` on `PATH` |
| fly | `fly` CLI on `PATH` for `deployment.create` and `environment.inspect`; `environment.health` probes over HTTPS from Factory itself |

**Project and environment resource configuration** — how a Factory resource
binds to a provider resource, kept in FeltDB on the environment:

| Field | Meaning |
| --- | --- |
| `environment.provider` (or `desiredState.targetProvider`) | which provider performs environment capabilities |
| `environment.configuration.flyApp` | the Fly app; when absent, the repository's `fly.toml` `app` is used |
| `environment.configuration.healthUrl` | the URL health is verified against; defaults to `https://<app>.fly.dev/health` |

Without a binding the Action stops at preflight with `resource-unavailable`
and the provider is never invoked.

## Smoke and integration tests

`tests/real-execution.test.ts` proves the whole path with a real process at
the boundary: a fake `fly` CLI placed on `PATH`, a live HTTP health endpoint,
and the real git and npm mechanisms. It covers success, missing and invalid
credentials, an absent provider, an unbound resource, denial and unavailability
of authority, provider rejection, non-zero exit, timeout, cancellation,
verification failure, restart during execution, bounded output and redaction of
Action, Run, Evidence, API and page output.

The fake never replaces the production path: it is only a program named `fly`
in a test's temporary directory. To exercise the real Fly CLI against a real app
without destroying anything (status and health only), opt in:

```sh
FACTORY_INTEGRATION_FLY=1 FACTORY_INTEGRATION_FLY_APP=<app> FLY_API_TOKEN=<token> npm run check
```
