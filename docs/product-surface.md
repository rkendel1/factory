# Factory product surface

Factory is an Actions Orchestrator. AppPort Services remains the infrastructure
and configuration area and is still reachable from the navigation, but it is no
longer the landing surface.

## Four records, four questions

| Record | Question | Collection |
| --- | --- | --- |
| Desired State | What should be true? | `DesiredState` |
| Action | What are we going to do to make it true? | `Action` |
| Run | What actually happened? | `Run` |
| Evidence | What proves what happened? | `Evidence` |

They stay separate because collapsing them loses the questions the product
exists to answer. Projects group repositories, environments, and desired state.

`Run` is the existing Factory run with product linkage added — action, project,
environment, application, delegation, provider — rather than a second run
concept. Evidence is the existing FeltDB evidence model; there is no second
evidence store.

## Lifecycle

```text
Intent / Desired State → Action Plan → Authorization → Execution → Verification → Evidence
```

Executing an Action goes through the same path as any other Factory run: the
Action creates a durable work record and calls the existing run path, so `.flow`
derives the contract, AuthBoundry authorizes it, the execution provider runs it,
and FeltDB records the evidence. There is no separate Action execution path and
no demonstration path.

AI may eventually propose plans. It is not an authority layer and cannot stand
in for AuthBoundry.

## Planning from repository reality

An Action's plan is derived from what the repository actually contains —
`package.json` and its scripts, `Dockerfile`, `fly.toml`, Vercel configuration,
GitHub workflows — so an operator states the outcome rather than the commands.
Each step cites the desired-state field or repository file that produced it, and
discovery reports only what it found: a desired state with deployment disabled
produces a step that says so instead of a deployment step.

## Reality and reconciliation

Desired state alone makes Factory an execution dashboard. The loop that makes it
an orchestrator is:

```text
Reality → compare → drift → plan → authorize → execute → verify → reconcile
```

**Reality is observed, never assumed.** Every field comes from something Factory
can actually see: the repository's head commit, and the durable evidence of the
run that last reconciled the environment. A field Factory cannot observe is
reported as unknown rather than filled in with the desired value, because a
reality that quietly mirrors desire can never drift.

**Current state has exactly one writer** — reconciliation, from run evidence.
Reality is not re-derived from runs at read time: two derivations of one fact
disagree the moment they are computed differently, and the one that silently
won would decide whether drift exists.

**Drift needs both sides known.** A field is drifted only when desired and
current are both known and differ. An environment nothing has reconciled reports
`unknown`, which is a different problem from the environment being wrong;
conflating them would invent drift on every new environment.

**Reconciliation is the absence of work.** An environment that matches produces
no Action — not a run that confirms nothing changed.

An Action planned from drift carries the drift it exists to close, so a reviewer
reads why Factory wants to act before reading what it will do:

```text
production is running abc123def456. Repository main is def456abc123.
```

## Continuous reconciliation

Factory can keep an environment in the state it was declared to be in, rather
than running a command every N minutes. The scheduler triggers a pass; the
reconciliation engine decides whether any work is actually required.

One pass, always the same fourteen steps: load the project, environment and
desired state; observe reality; compare; stop if reality is unknown; do nothing
if there is no drift; otherwise plan a typed Action, ask AuthBoundry whether it
may run without a person, execute through the existing run path if it may,
verify, reconcile the evidence, and record the result.

**The manual button and the scheduler call the same function.** `Reconcile Now`
is not a shortcut past the comparison — it is the same comparison run sooner.

**The scheduler is not an authority.** It holds no state of its own: it asks
FeltDB which records are due, claims one with a compare-and-set on the record,
and writes back everything it learns. Two Factory instances cannot act on one
environment, a worker that dies releases its claim when the lease expires, and a
restart resumes the durable schedule instead of sweeping every environment
because a process booted.

**There is no hidden loop.** Every worker is a durable `Reconciliation` record
carrying its status, schedule, last observation, last reconciliation, current
Action and last error. If Factory is keeping something in sync, the record says
so; if a pass failed, it says why.

**Passes are idempotent.** A reconciliation fingerprint is derived from the
project, environment, desired-state revision, observed-state revision and Action
type — from the work, never from when it was planned. Repeating a pass over
unchanged inputs recognises the Action already open and adopts it; any real
change to desire or reality earns a new one.

**Failures stay distinguishable.** `autonomy-denied`, `authority-unavailable`,
`awaiting-approval`, `execution-failed` and `verification-failed` are separate
results, because they call for different responses and a single `failed` would
hide which happened.

The worker runs only when Factory has a credential to act under
(`FACTORY_SERVICE_CREDENTIAL`). Without one there is no authority to ask whether
it may act, and an autonomous loop acting on nobody's behalf is the thing this
design exists to prevent. Configuration and history stay durable either way, so
adding the credential later resumes rather than restarts.

### Reconciliation API

| Route | Purpose |
| --- | --- |
| `GET /v1/reconciliation` | What Factory is currently keeping in sync |
| `POST\|GET\|PATCH\|DELETE /v1/projects/:id/environments/:environmentId/reconciliation` | Configure it |
| `POST /v1/projects/:id/environments/:environmentId/reconcile-now` | Run one pass now |

Intervals are clamped between one minute and one day: how often Factory talks to
a repository, an authority and a provider is not arbitrary caller input.

## Action graphs

Factory is the Actions Coordinator for the product ecosystem. It coordinates
the operational actions that happen before, after and around development; it
is not the agent that decides or materializes development.

| System | Owns |
| --- | --- |
| Attn | human attention, goals, priorities, development work, requests for operational work |
| Eve | autonomous development, code changes, commits and PRs |
| Factory | operational Actions, dependencies, sequencing, provider execution, reconciliation, operational verification and evidence |
| AuthBoundry | authority, authorization decisions, delegation, policy |
| FeltDB | durable state and evidence |
| AppPort | the protocol between independently owned systems |

An `ActionGraph` is durable coordination state. Its nodes are ordinary
Actions with graph metadata — `graphId`, `dependsOn`, `sequence` — so there is
no second execution abstraction: a node in a graph runs through `runAction`,
producing one Run and one Evidence record exactly as a lone Action does. The
graph only says what must finish before what.

**Every node is authorized on its own.** A graph is never authorized once. A
grant that holds for one node need not hold for the next, and a grant revoked
between nodes stops the nodes after it.

**Coordination is derived, never remembered.** Node status — ready, blocked,
awaiting-approval, running, completed, failed, cancelled — is computed from the
Actions as FeltDB has them, so two instances, or one before and after a restart,
derive the same answer. Why a node is blocked is persisted on it as `blockedBy`.
Coordinating twice re-runs nothing.

**Failure is explicit and stays distinct.** A failed dependency blocks its
dependents; it does not fail them, because they never ran. `execution-failed`,
`verification-failed`, `autonomy-denied` and `authority-unavailable` survive
as the Action's `outcome` and the graph's `failure`, never flattened into
"failed". Nothing retries on its own: a retry is explicit, returns the Action
to planned, admits a new Run, and keeps the earlier Run as history.

**Reconciliation plans a one-node graph.** It behaves exactly as the lone
Action did and gives drift a path into multi-step coordination later. The
reconciliation fingerprint still makes repeated passes idempotent: unchanged
drift reuses the open graph.

**Origins reference other systems without reading them.** A graph's origin can
say `sourceSystem: attn, sourceType: work, sourceId: …` — Factory can say this
operational graph exists because Attn requested it, while Attn stays the owner
of its Work state. Eve's commits reach Factory the same way: as a reference,
never as database access.

### Action graph API

| Route | Purpose |
| --- | --- |
| `GET\|POST /v1/action-graphs` | List, or create from a typed plan validated against `.flow` |
| `GET /v1/action-graphs/:id` | The graph with its nodes' derived statuses |
| `POST /v1/action-graphs/:id/run` | Begin coordinating; every node is still authorized on its own |
| `POST /v1/action-graphs/:id/cancel` | Stop coordinating; history is kept |
| `POST /v1/actions/:id/retry` | Explicit retry of a failed node |

## What waits for a person

Whether an Action waits for a person is the authority's decision, not a rule
Factory holds. Factory asks AuthBoundry for `factory.action.autonomous`:

- **granted** → the Action is `planned` and Factory may run it on its own
- **denied** → the Action is `awaiting-approval` and a person must drive it

The default answer is the safe one and needs no coordination: an authority that
does not grant the capability denies it, so Actions wait for a person until
someone deliberately grants autonomy. Factory could not ask at all — no session
— is also a denial.

The question is asked again at execution time rather than trusting the answer
stored at planning time, because a grant can be given or revoked in between and
what matters is whether this may run now. A person driving an Action is the
human judgement the authority asked for, and their approval is recorded on it.

> Factory determines what needs to happen. AuthBoundry determines what may cause
> it to happen without a human.

## Providers

Execution providers and their capabilities are read from `.flow` through the
provider capability model, never hard-coded in the UI. A capability the
Providers page shows is one an Action could actually be authorized for.

## Surfaces

| Page | Answers |
| --- | --- |
| `/factory` | What exists, what is running, what needs a human, on whose authority |
| `/factory/projects` | What projects exist and what belongs to them |
| `/factory/projects/:id` | Repositories, environments, desired state, actions, runs |
| `/factory/actions` | Actions by state, from planned through succeeded or failed |
| `/factory/actions/:id` | Intent, plan, authority, execution, verification, evidence |
| `/factory/runs/:id` | The lifecycle phases; logs are supporting detail, folded away |
| `/factory/providers` | Providers, connection state, capabilities, what they operate on |
| `/factory/settings` | The authority association and links to infrastructure |

The Overview reports the association state — `associated`, `unassociated`,
`unverified` — and never reports a connection merely because `AUTHBOUNDRY_URL`
is set.
