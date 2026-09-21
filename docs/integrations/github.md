# GitHub integration

Factory consumes `@rkendel1/github-integration@1.0.0` as its only GitHub boundary. Factory owns run orchestration, authorization sequencing, immutable execution contracts, lifecycle transitions, and Factory evidence. The integration owns GitHub transport, SDK behavior, normalized provider models, connections, credentials, provider evidence, webhooks, and its FeltDB state.

```text
                  .flow
                    │
                    ▼
               AuthBoundry
                    │
                    ▼
                 Factory
                    │
             ExecutionContract
                    │
                    ▼
       @rkendel1/github-integration
                    │
              ┌─────┴─────┐
              ▼           ▼
           FeltDB       GitHub
```

## Supported operation path

The canonical `.flow` declares the initial supported operations. There is no separate Factory GitHub capability registry.

| Factory operation | Required capability | Integration operation |
| --- | --- | --- |
| `repositories.list` | `github.repository.read` | `github.repositories.list` |
| `pull_request.merge` | `github.pull_request.merge` | `github.pullRequests.merge` |

An HTTP run first requires `factory.run`, then the GitHub capability selected from `.flow`. Factory verifies the authenticated principal and tenant against durable Work state, creates a fingerprinted `ExecutionContract`, and invokes the package through its root public API. A read grant cannot authorize the merge mutation.

Work state holds only the integration-owned `connectionId`. The contract records that reference, the normalized operation and resource, execution mode, application identity, authenticated principal and tenant, capability, and fingerprint. Caller-supplied identity, tenant, capability, connection, command, or authorization fields are rejected.

## Evidence and failures

Factory evidence records the run ID, contract fingerprint, application and authenticated context, connection ID, normalized operation and resource, normalized result, and `@rkendel1/github-integration@1.0.0` provenance. It does not copy the integration's internal evidence model. The integration persists its provider-specific operation/evidence records in its own FeltDB collections.

Provider or authorization errors flow through the normal Factory lifecycle and produce failed Factory evidence. They do not create a second GitHub error authority or bypass `accepted → authorized → allocated → preparing → executing → verifying → completed/failed/cancelled`.

## Credentials, state, webhooks, and UI

Factory stores no GitHub token, private key, OAuth secret, refresh token, webhook secret, or GitHub-specific durable model. Secret resolution and connection lifecycle belong to the integration and platform composition. Factory does not define GitHub credential environment variables.

Factory is not a GitHub webhook endpoint and does not verify webhook signatures. GitHub webhooks terminate at the integration, which normalizes and persists events in FeltDB for consumers to observe. Likewise, the integration contributes its own `AppPort/ui/1` surface; Factory does not host a GitHub portal.

## Package resolution

The integration repository provides a verified `1.0.0` package artifact, but its documentation does not yet assert npm publication. Factory therefore vendors only that immutable tarball at `vendor/rkendel1-github-integration-1.0.0.tgz` and resolves it with `file:vendor/rkendel1-github-integration-1.0.0.tgz`. No integration source is copied into Factory, and Node enforces the package's normal exports.

After npm publication, migration is limited to changing the dependency value to the exact registry version:

```json
"@rkendel1/github-integration": "1.0.0"
```
