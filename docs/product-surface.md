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

## What waits for a person

An Action whose project has deployment enabled in desired state is created as
`awaiting-approval` rather than `planned`, and refuses to run until someone
approves it. That is deliberately the only gate: deployment is the operator's
own statement that this project changes a running environment. Everything else
is planned and runs when someone chooses to. Approved or not, the Overview's
attention list is the answer to "what requires human attention".

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
