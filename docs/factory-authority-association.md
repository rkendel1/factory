# Factory authority association

Factory acts in AuthBoundry as an agent principal associated with the Factory
application. This document records who owns each part of that association, and
what Factory does when it is absent.

## The association

| Element | Value | Owner |
| --- | --- | --- |
| Application | `factory` (resource `application:factory`) | `.flow` declares it; AuthBoundry authorizes it |
| Agent principal | `agent:factory-service`, from each `.flow` `principal` statement | Factory registers it |
| Delegation | `factory-application-<tenant>-delegation`, delegator `system`, no expiry | AuthBoundry creates and maintains it |
| Capabilities | the eight `FactoryApplicationAccess` grants in `.flow` | shared vocabulary; no aliases |

AuthBoundry's bootstrap re-asserts the delegation on every start, which is what
makes the association survive a restart or a redeployment. It refuses to assign
that authority to a principal that does not exist, so registering the agent
principal is Factory's step and must happen first.

## What Factory does

1. **Registers its agent principals** through `POST /_authboundry/agents`, once
   per principal. Re-running provisioning addresses the same principal instead
   of adding another.
2. **Resolves its authority** by reading the association back from
   `/_authboundry/delegations`. Factory never creates a delegation: an
   application that could issue itself the authority it is about to check would
   not be checking anything.
3. **Derives its connection state** from that answer — `associated`,
   `unassociated`, or `unverified` — rather than from the fact that an
   `AUTHBOUNDRY_URL` was configured.
4. **Fails closed.** A Factory service principal with no resolved application
   context cannot act, and an authority Factory cannot reach is never mistaken
   for one that agrees.
5. **Executes Actions in the authorized application context** and records that
   context — application, resource, tenant, principal, delegation — in the
   execution contract and in the FeltDB evidence for the run.

`.flow`'s application id is a contract identity, not a grant. It names which
application Factory *is*; it cannot stand in for the authority's answer about
what Factory may do, and Factory no longer treats it as one.

## Deployment

Control-plane access needs an operator credential:

```sh
fly secrets set AUTHBOUNDRY_OPERATOR_CREDENTIAL="..." -a factory-idvhpa
```

Without it Factory reports `unverified` and its service principals fail closed.
The association itself is created by AuthBoundry once its own
`AUTHBOUNDRY_OPERATOR_PRINCIPAL` names the registered Factory principal.

## Surfaces

- `GET /v1/connection` — the association as AuthBoundry reports it. Returns 503
  while the status is not `associated`.
- `GET /health` — `authorities.authBoundry` carries the same status.
