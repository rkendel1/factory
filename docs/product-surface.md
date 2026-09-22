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
