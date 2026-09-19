# Factory Composition Audit — Pre-JEV Baseline

## Baseline

This audit measures commit `7848c83519fb36029cf18b945c18581bacedaa46` (the
commit immediately before these audit artifacts), tree
`6099b10f2f9671cfc9782b5c7e6a9533ef6f167b`. The audited tree was clean. The
locked runtime versions
are:

| Boundary | Version |
| --- | --- |
| Factory commit | `7848c83519fb36029cf18b945c18581bacedaa46` |
| Factory tree | `6099b10f2f9671cfc9782b5c7e6a9533ef6f167b` |
| FeltDB | `@feltdb/core@0.11.4` |
| AuthBoundry | `@authboundry/core@1.15.1` |
| AppPort | `@appport/sdk@1.1.18` |
| AppPort Services | `@appport/services@0.4.0` |
| AppBoundry | `@appport/appboundry@1.0.10` |
| PAX | external executable, invoked as `pax`; no npm dependency |
| JEV | not integrated; dependency/import/source/execution-path checks all false |

The canonical `.flow` is `.flow`, SHA-256
`64b90abf77644fb796340d7d711d9e596cb6c56599677c85f4815d27bf604903`. Its
Factory application identity is `software_factory@1.0.0`; the derived
application contract fingerprint is
`d6ca3d8f8c57dfc18d5b580826667f88a3a18884d5ef766503126f44590a0742`.

## Dependency Graph

```text
Factory
├── @feltdb/core             (runtime; direct)
├── @authboundry/core        (runtime; direct)
├── @appport/sdk             (runtime; direct)
├── @appport/services        (runtime; direct)
└── @appport/appboundry      (runtime; direct)
```

`src/felt.ts` consumes FeltDB parsing, validation, deployment, collections, and
state APIs. `src/auth.ts` consumes AuthBoundry authentication and authorization.
`src/application-contract.ts` consumes AppPort SDK and AppBoundry contract
projection. `src/appport.ts` consumes AppPort Services. `src/execution.ts`
crosses the PAX CLI subprocess boundary. The HTTP boundary is implemented in
`src/server.ts`; filesystem boundaries are in `src/felt.ts` (flow loading) and
`src/workspace.ts` (temporary workspaces and repository materialization).
There is no generated or vendored application code. Ordinary transitive npm
packages are not architectural integrations. All listed dependencies are
runtime dependencies; TypeScript, `tsx`, and Node types are dev dependencies.

## Production LOC

Method: count non-empty physical lines in tracked `src/**/*.ts` files. Blank
lines are excluded; comments and type declarations count. `node_modules`,
`dist`, generated dependency code, lockfiles, and vendored code are excluded.
Tests are counted separately with the same method.

| Measure | LOC |
| --- | ---: |
| Production | 1,703 |
| Tests | 742 |
| `.flow` contract (informational) | 209 |

Analytical categories (not additive because `server.ts` is both orchestration
and HTTP/API) are: orchestration 504, domain/model 209, HTTP/API 504,
persistence integration 65, contract/projection 96, execution integration 183,
and adapter/glue 722.

## Integration LOC

The deduplicated integration set is
`src/application-contract.ts` (96), `src/appport.ts` (106), `src/auth.ts`
(64), `src/authority.ts` (208), `src/execution.ts` (183), and `src/felt.ts`
(65): **722 LOC**. The boundary matrix below can overlap this set when one
adapter composes more than one boundary; it is therefore descriptive, not a
second total.

A line belongs to integration LOC when its primary purpose is translating,
adapting, invoking, persisting across, or enforcing a boundary between Factory
and another architectural component. Shared orchestration that merely calls a
boundary is not integration unless it performs boundary-specific work.
For `authority.ts`, integration LOC includes only the portion that resolves
`.flow` capability authority and derives the external execution/application
contract; generic authorization orchestration is excluded. These rules and the
six-file integration set are recorded in the JSON artifact.

| Source | Destination | LOC | Purpose | Data translated | Authority | Necessary? |
| --- | --- | ---: | --- | --- | --- | --- |
| `src/felt.ts` | FeltDB | 65 | Load/validate/deploy `.flow`, create scoped DB | Flow source to FeltDB spec | FeltDB | Yes |
| `src/auth.ts` | AuthBoundry | 64 | Authenticate and authorize requests | HTTP headers to Auth context | AuthBoundry | Yes |
| `src/authority.ts` | `.flow` / Factory | 208 | Resolve capability authority and derive contract | Flow statements to execution authority | `.flow` | Yes |
| `src/application-contract.ts` | AppPort/AppBoundry | 96 | Derive shared application projections | Flow capability data to manifests/contracts | `.flow` | Yes |
| `src/appport.ts` | AppPort Services | 106 | Bind contract, scope tenant, invoke services | Contract to service requests | `.flow` + AuthBoundry | Yes |
| `src/execution.ts` | PAX / OS | 183 | Build argv/environment, spawn, cancel, capture | Contract to CLI process | ExecutionContract | Yes |
| none | FeltDB Studio | 0 | Reuse Studio collection discovery and live state | None | FeltDB | No custom adapter |

Glue ratio = `722 / 1,703` = **0.423959**. This is descriptive only.

## Glue Ratio

The ratio counts boundary-crossing source files once, not every import or
every line in the server. It should be compared only with a later audit using
the same script and exclusions; it is not a quality target.

## Boundary Integration Matrix

| Boundary | Classification | Evidence |
| --- | --- | --- |
| Factory ↔ FeltDB | Direct composition | `createFeltDB`, `deployFlowSpec`, collection operations in `src/felt.ts` and `src/server.ts` |
| Factory ↔ AuthBoundry | Thin adapter | `createAuthBoundry`, `authenticate`, `authorize` in `src/auth.ts` |
| Factory ↔ `.flow` | Projection | `loadFactoryFlow`, authority parsing, and canonical contract derivation |
| Factory ↔ AppPort | Thin adapter | `createFactoryAppPortApplication` and contract binding |
| Factory ↔ AppPort Services | Direct composition | `createServices`, `webhooks.emitWebhookEvent`, `jobs.enqueue` |
| Factory ↔ AppBoundry | Projection | `appBoundryContractFromManifest` and fingerprinting |
| Factory ↔ PAX | Serialization | `pax --version` and `pax --json run <target>` |
| Factory ↔ Studio | Direct composition | Studio consumes the same FeltDB collections; custom code: 0 LOC |

No architectural authority duplication or independently authoritative
application capability model was identified. Serialization is required at the PAX process boundary; the
`.flow` to AppPort/AppBoundry projections preserve the application identity and
fingerprint.

## .flow Composition

`.flow` is parsed once by FeltDB and is also the input to
`createCanonicalApplicationContract`. The same source supplies:

| Projection | LOC | Form |
| --- | ---: | --- |
| `.flow → Factory` authority and execution derivation | 208 | derived |
| `.flow → AppPort` application manifest | 96 (shared adapter) | derived |
| `.flow → AppPort Services` service/capability requirements | 106 (shared adapter) | derived |
| `.flow → AppBoundry` contract and fingerprint | 96 (shared adapter) | derived |

Identity `software_factory`, version `1.0.0`, and the derived fingerprint are
carried into AppPort and AppBoundry. The two declared capabilities carry the
same grants into the projections: `repository.read` plus
`artifact.write,evidence.write` for the PAX capability, and
`repository.read,evidence.write` for the native capability. No Factory-local
service registry exists.

## Authority Audit

AuthBoundry decides principal, tenant, session, delegation, and external
operation authorization (`src/auth.ts:44-68`). `.flow` owns capability,
execution mode, command/PAX target, timeout, and grants
(`src/authority.ts:47-75`). Factory checks the authoritative FeltDB `Work`
record and derives the execution contract (`src/authority.ts:141-232`).
FeltDB stores authorization decisions, contracts, runs, events, and evidence.
AppPort validates capability and tenant before service calls
(`src/appport.ts:58-112`); execution enforces command/PAX constraints
(`src/execution.ts:55-148`).

The request body cannot supply principal, tenant authority, command, mode,
capabilities, secrets, or evidence destinations (`src/server.ts` request
validation and `src/authority.ts`). These checks are defensive at the Factory
boundary; AuthBoundry and `.flow` remain the authoritative decisions. No
authority violation was found.

## Persistence Audit

The only durable state API used by production code is FeltDB
(`src/felt.ts`, collection writes in `src/server.ts`). The `.flow` declares
eight collections: `Work`, `ExecutionRequest`, `ExecutionContract`, `Run`,
`RunEvent`, `Artifact`, `Evidence`, and `AuthorizationDecision`. Temporary
workspace files are destroyed after execution (`src/execution.ts:82-91`);
they are not Factory application state. No JSON database, SQLite database,
local cache, duplicate execution record, or competing durable store was found.
FeltDB is the durable authority: new persistence 0, persistence violations 0.

## Process State Audit

`process.env` is configuration only (`FELTDB_URL`, `FELTDB_TOKEN`,
`AUTHBOUNDRY_URL`, `PAX_BIN`, paths, and port). `Map` instances in authority
and contract projection are local derivation indexes, not caches or authority.
Child-process handles and workspace paths are ephemeral execution state.
There are no module-level mutable singletons, global authority, process-local
durable state substitutes, or Factory caches.

## ExecutionContract Trace

The path is caller intent → AuthBoundry context → `.flow` authority and
FeltDB `Work` → `withContractFingerprint` → FeltDB `ExecutionContract` →
`assertContractIntegrity` → bounded execution → evidence in FeltDB. The
contract is built only after the authorization decision is persisted
(`src/authority.ts:170-232`), frozen with SHA-256
(`src/contract.ts:24-35`), and checked immediately before execution
(`src/execution.ts:74-77`). Caller-controlled fields are matched against
authoritative Work and repository data; no caller command or execution mode
can bypass `.flow`.

Contract-specific code measured in the audit is 32 LOC for fingerprinting,
96 LOC for canonical application projection, and the contract derivation
portion of `src/authority.ts`. Immutability verification is one explicit
runtime check; persistence is via FeltDB collection writes.

## FeltDB Integration

`src/felt.ts` is 65 non-empty LOC. It loads the filesystem `.flow`, parses and
validates it using the published `@feltdb/core@0.11.4`, creates a tenant and
environment-scoped DB, and deploys the same spec. Server code uses FeltDB
collections for admission, lifecycle, authorization decisions, contracts,
events, and evidence. Tests verify isolated registry consumption in
`tests/package-boundary.test.ts`. No compatibility shim for the published
package was required.

## Studio Integration

Custom Studio code, views, projections, state models, mutation handlers, and
adapters are all **0 LOC**. Studio discovers the `.flow` collections and
relationships from the same FeltDB authority. New persistence: **N**; new
authority: **N**; shadow state: **N**. This is direct composition.

## AppPort Integration

`src/appport.ts` is 106 LOC. It derives the AppPort application from `.flow`,
binds the immutable contract fingerprint and operation, checks the declared
capability, and records AppPort provenance in evidence. It does not create a
separate application capability model.

## AppPort Services Integration

The same 106 LOC adapter creates AppPort Services locally and invokes webhook
and job APIs. Tenant scope comes from the authorized contract; API keys and
webhook/job types are passed only to the service boundary. The current Factory
execution path does not invoke webhooks or jobs, so those methods are
available integration surfaces rather than an additional execution path.

## AppBoundry Integration

AppBoundry receives the manifest-derived contract and fingerprint from
`src/application-contract.ts`; runtime mode and grants are placed in the
authorized contract in `src/authority.ts:190-199`. There is no separate
filesystem, network, credential, or cancellation adapter for AppBoundry in
Factory; execution cancellation and failure handling are owned by the local
execution adapter. The measured Factory-specific AppBoundry integration is
the 96-LOC projection, classified as projection rather than semantic
translation.

## PAX Integration

PAX integration is 183 LOC in `src/execution.ts`. Factory verifies the
executable version, constructs `--json <operation> <target> <args>`, supplies
bounded environment values, captures stdout/stderr and exit status, handles
timeout/cancellation, and records PAX provenance in evidence
(`src/evidence.ts:89-103`). Factory does not recreate PAX's repository or
tooling model; target and operation originate in `.flow`.

## Concept Duplication

| Concept | Canonical owner | Other representation | Translation | Duplication |
| --- | --- | --- | --- | --- |
| identity/fingerprint | `.flow` + canonical application contract | AppPort/AppBoundry fields | projection | no |
| capability/grant | `.flow` | AppPort requires/authorization, contract grants | projection | no |
| principal/tenant/authorization | AuthBoundry | authorization decision and contract | evidence projection | no |
| execution contract | Factory after authorization | FeltDB `ExecutionContract` | persistence | no |
| run/event/evidence/artifact | FeltDB | typed Factory records | serialization to collections | no |
| service/secret | AppPort Services/AuthBoundry | contract references only | capability check | no |
| runtime permission | `.flow` grants/AppBoundry contract | execution contract | projection | no |

Measured concepts: 11 canonical concepts, 7 projected representations, 0
duplicate concepts, 0 authority duplications.

## Type Translation

The meaningful architectural types are: FlowSpec/FlowBlock, AuthenticatedContext,
WorkRecord, AuthorizationDecisionRecord, ExecutionContract,
CanonicalApplicationContract, AppPortContract, AppBoundry contract, and
StructuredEvidence. The audit counts 9 conceptual types: 3 canonical or
authoritative, 5 projections/adapters, and 1 serialization boundary
representation. These are concepts, not every TypeScript interface.

## End-to-End Execution Trace

1. `src/server.ts` parses `POST /v1/runs` intent and obtains AuthBoundry
   context; caller identity fields are ignored.
2. `src/auth.ts` calls AuthBoundry authentication/authorization.
3. `src/authority.ts:authorizeExecution` loads `Work` from FeltDB, checks
   tenant/owner/operation/repository, and records `AuthorizationDecision`.
4. The same function derives the `.flow` capability into AppPort,
   AppBoundry, and execution fields, fingerprints the contract, and admits
   `ExecutionRequest`, `Run`, and `ExecutionContract` in FeltDB.
5. `src/execution.ts:executeContract` verifies the fingerprint, materializes
   an ephemeral workspace, invokes native command or PAX, and captures
   cancellation, timeout, stdout, stderr, and exit status.
6. `src/evidence.ts:buildEvidence` adds contract/application fingerprints,
   AppPort/PAX provenance, repository commit, result, and JEV status
   (`UNAVAILABLE` for this pre-JEV baseline).
7. `src/server.ts` persists `RunEvent`, `Run`, and `Evidence` back to FeltDB.
   Studio observes these same durable collections; it does not execute them.

## Natural Composition

The natural compositions are `.flow` → FeltDB parsing/deployment,
`.flow` → canonical application projection, AuthBoundry → authenticated
context, Factory → FeltDB collections, and FeltDB → Studio observation:
import, call, persist, observe. AppPort Services is direct API invocation
after capability/tenant validation. PAX is necessarily a serialization and
process boundary, but Factory does not reimplement PAX.

## Architectural Friction

| Boundary | Evidence | Why necessary | Implication |
| --- | --- | --- | --- |
| `.flow` → AppPort/AppBoundry | `src/application-contract.ts:71-103` | Each downstream API requires its own manifest/contract shape | A canonical contract still needs projections |
| Factory → PAX | `src/execution.ts:8-31,110-198` | PAX is a CLI process, not an in-process API | argv, status, streams, timeout, and cancellation must be adapted |
| Factory → AuthBoundry | `src/auth.ts:44-68` | HTTP requests carry transport credentials while AuthBoundry owns identity | Transport context must be normalized before authorization |
| Published FeltDB package | `tests/package-boundary.test.ts:11-63` | Registry package is a real external boundary | Boundary is verified by an isolated package test, with no shim |

These are measured integration costs, not defects. No compatibility workaround,
duplicate service registry, persistence mismatch, or authority ambiguity was
found.

## Findings

1. The measured production baseline is 1,703 non-empty source LOC and 742
   non-empty test LOC.
2. Deduplicated boundary integration is 722 LOC, a glue ratio of 0.423959.
3. `.flow` remains the shared application contract; AppPort and AppBoundry
   fingerprints are derived from it.
4. FeltDB is the only durable application-state authority; Studio adds no
   Factory-specific persistence or UI architecture.
5. AuthBoundry owns identity/authorization, `.flow` owns capability authority,
   and Factory derives an immutable execution contract after authorization.
6. JEV integration is not present and is intentionally excluded.

## Reproduction Method

From the repository root:

```sh
npm ci
BASELINE_COMMIT="$(git rev-parse HEAD)" node scripts/audit-factory.mjs
```

The script writes `docs/factory-composition-audit-pre-jev.json`. When
`BASELINE_COMMIT` is supplied, it must equal `HEAD`; the script also requires
a clean working tree before measuring and records both the commit and
`HEAD^{tree}`. It counts non-empty physical lines, reads exact versions and
integrity values from `package-lock.json`, and hashes `.flow`. It excludes
`node_modules`, `dist`, generated dependency code, lockfiles, and vendored
code. It asserts that JEV is absent from dependencies, imports, dedicated
source files, and the execution path. Conceptual counts, authority findings,
and friction are explicit manual-review classifications. JEV was not
installed, added, or integrated.
