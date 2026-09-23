# Factory authority association

Factory acts in AuthBoundry as an agent principal associated with the Factory
application. This document records who owns each part of that association, and
what Factory does when it is absent.

## The association

| Element | Value | Owner |
| --- | --- | --- |
| Project | `factory` | AuthBoundry |
| Application | `factory` (resource `application:factory`) | AuthBoundry |
| Attachment and manifest | the discovered canonical application | AuthBoundry |
| Agent principal | `agent:factory-service` | AuthBoundry manifest; Factory may request provisioning |
| Policies and delegations | the manifest requirements and actual grants | AuthBoundry |
| Autonomous capabilities | `factory.run`, `factory.action.autonomous` | AuthBoundry manifest and grants |

Factory does not reconstruct this association from `.flow`, environment names,
the repository, or deployment metadata. `.flow` remains the data/execution
contract; it is not an AuthBoundry policy manifest.

## What Factory does

1. Discover the explicit Factory project, canonical application and attachment.
2. Read the linked manifest and compare its principals, policies, delegations
   and capabilities with AuthBoundry's actual state.
3. Request missing state through AuthBoundry's privileged provisioning surface.
   Factory never creates a policy or delegation and never treats a request as a
   grant. `pending_approval` stops autonomous execution.
4. Verify the service credential produces canonical authorization evidence for
   both required capabilities.
5. Persist discovery, differences, requests, outcomes and FeltDB semantic
   decision evidence in `AuthorityReconciliation`, including prior passes.
6. Execute only after the complete relationship reconciles successfully.

`.flow`'s application id is a contract identity, not a grant. It names which
application Factory *is*; it cannot stand in for the authority's answer about
what Factory may do, and Factory no longer treats it as one.

## Deployment

Normal discovery and autonomous operation require the service credential. Only
provisioning requests use the operator credential:

```sh
fly secrets set AUTHBOUNDRY_OPERATOR_CREDENTIAL="..." -a factory-idvhpa
fly secrets set FACTORY_SERVICE_CREDENTIAL="..." -a factory-idvhpa
```

The credentials are never substituted for each other. Missing service authority
keeps the autonomous worker idle; missing operator authority leaves missing
requirements visible without allowing Factory to grant them itself.

## Surfaces

- `GET /v1/connection` — discovered project/application/manifest, exact missing
  authority, provisioning request, and resulting association. Returns 503 until
  complete.
- `GET /health` — separate reachability, project, attachment, manifest,
  principal, policy, delegation, credential, capability and reconciliation
  states.

## Product routes

Factory's product surface (`/factory`, `/v1/projects`, `/v1/actions`, …) uses the
same authenticator as the rest of Factory, so the association check applies to
every route. It asks for capability names the association already carries:

| Operation | Capability |
| --- | --- |
| Product reads | `factory.ui.read` |
| Project, repository, environment, desired-state and Action writes | `configuration.write` |
| Repository removal | `configuration.delete` |
| Executing an Action | `factory.run` |

Factory declares no capability of its own for these routes. A new name would
have to exist in AuthBoundry's `FACTORY_APPLICATION_CAPABILITIES` to be
grantable, and inventing one Factory alone recognises would be a second
authorization vocabulary. If product writes should be distinguishable from
AppPort Services configuration writes, the capability has to be added upstream
first and then used here.
