# Factory Composition Audit — Pre-JEV Baseline

## Baseline

Clean commit `6bfd5cea493f52d35e0760f1cb212d19f73c281a`, tree `7057e40fdbedfd27cf7bd6ddcad585b3b183aea7`.

- JEV integrated: **NO**
- JEV authority: **NO**
- JEV persistence: **NO**
- JEV execution authority: **NO**
- Canonical flow: `.flow` (239 LOC, SHA-256 `dde2e6af337ca1b08be3548ccbb160af3fc5cd5900d5be3d45330abb84288bab`)

## LOC

| Measure | LOC |
| --- | ---: |
| Factory application source | 2000 |
| Factory integration/adapter subset | 834 |
| Factory tests | 1112 |
| `.flow` | 239 |
| Packaged GitHub integration runtime (separate) | 694 |
| GitHub integration source checkout (separate) | 1221 |
| GitHub integration tests (separate) | 362 |

The packaged integration is not Factory code. The historical Factory GitHub footprint was the unused 33-physical-line `src/github.ts` formatter; it was removed as dead code, not extracted as a subsystem.

## Direct dependencies

| Package | Version | Integrity/resolution |
| --- | --- | --- |
| `@appport/appboundry` | `1.0.10` | `sha512-Bx9mmb/ZBdZzo1855ayEMksH2wuqIXJP3OYU1QwlVTsQOG8Mlt9sTFU/MzHxlTH1LmjceCaDrTLMLkcEIsxhOQ==` |
| `@appport/sdk` | `1.1.19` | `sha512-eXM3OJUGMgecVfjEj5mrANTWLVRcgInKQ+GnUtvQZ6N9OuLhZTttQuVBNC1xA7Uvk2P+bFOF4j0p04RJPOJ3AA==` |
| `@authboundry/core` | `1.15.1` | `sha512-O+sIQmWIpGNASiOt0sEQjQejlVKnBoUW/RLF/8JA6paj0EK14jGMCzIZqJai36pzSCww9NBnthuSCw6khTLkTw==` |
| `@feltdb/core` | `0.11.4` | `sha512-g0T/m66jdYYouarLdR8gxXYrbYP9pKoPtibNrpL3sUGdtyRKZ6CAoIIyHBBy8PQb5jxpXHYj0DJ4FrBcudt6zQ==` |
| `@rkendel1/github-integration` | `1.0.0` | `sha512-TeWDO6s39RVKW8woCzvdvRke9I7brQS5pIYIwcvvcFKfu7kXmhVNQX4v4i313yKZsS1rEnI9mdS5uBVX1PJadg==` |

Factory has no direct `@appport/services` or Express dependency. `@rkendel1/github-integration@1.0.0` declares `@appport/services@0.4.0`; that dependency is integration-owned.

## Boundary inventory

| Boundary | Classification | Factory file |
| --- | --- | --- |
| Factory → FeltDB | direct composition | `src/felt.ts` |
| Factory → AuthBoundry | thin adapter | `src/auth.ts` |
| Factory → .flow | projection | `src/authority.ts` |
| Factory → AppPort | thin contract adapter | `src/appport.ts` |
| Factory → AppBoundry | projection | `src/application-contract.ts` |
| Factory → PAX/OS | serialization and process boundary | `src/execution.ts` |
| Factory → GitHub integration | thin package consumer adapter | `src/integrations/github.ts` |
| Factory → AppPort Services | absent; integration-owned transitive dependency only | none |

## Authority and durable state

AuthBoundry owns identity and external authorization. `.flow` owns application capabilities and execution declarations. Factory creates the immutable authorized ExecutionContract. FeltDB owns all durable Factory state and evidence. The GitHub package owns GitHub transport, credentials, webhooks, normalized behavior, and provider persistence.

Factory durable collections remain: `Work`, `ExecutionRequest`, `ExecutionContract`, `Run`, `RunEvent`, `Artifact`, `Evidence`, `AuthorizationDecision`. There are no Factory GitHub credential, webhook, provider-model, or persistence collections.

## Reproduction

Run from a clean committed tree:

```sh
npm ci
BASELINE_COMMIT="$(git rev-parse HEAD)" node scripts/audit-factory.mjs
```

For a non-baseline working-tree preview only, use `AUDIT_ALLOW_DIRTY=1`.
