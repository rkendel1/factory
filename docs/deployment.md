# Production deployment

Factory Runner is deployed as the dedicated `factory-runner` Fly application.
It owns execution orchestration only: FeltDB owns durable state, AuthBoundry
owns identity and authorization, and `.flow` remains the application capability
contract. FeltDB and AuthBoundry are the only Factory authority URLs. GitHub operations are
delegated to the standalone GitHub integration package; Factory does not host
AppPort Services. No Factory database or Fly volume is required.

## Prerequisites

- Fly CLI authenticated to the target organization
- A deployed AuthBoundry service
- A remote FeltDB service using `@feltdb/core@0.11.4`
- The pinned PAX release available to the image build

Create the application once if necessary:

```sh
fly apps create factory-runner
```

Set the deployment-managed remote authority configuration (never commit
credential values):

```sh
fly secrets set \
  FELTDB_URL="https://feltdb.example" \
  FELTDB_TOKEN="..." \
  AUTHBOUNDRY_URL="https://auth.example"
```

`FELTDB_URL` and `AUTHBOUNDRY_URL` are topology, not application credentials.
`FELTDB_TOKEN` is an infrastructure bootstrap credential used only to establish
the FeltDB connection. Application API keys, GitHub credentials, webhook
secrets, and provider configuration belong to their integration boundaries and
must not be added to Factory environment configuration.

Deploy and verify:

```sh
fly deploy --config fly.toml --remote-only --strategy rolling
fly status -a factory-idvhpa
fly config show -a factory-idvhpa
fly logs -a factory-idvhpa
curl --fail https://factory-idvhpa.fly.dev/health
```

Confirm `FELTDB_URL` and `AUTHBOUNDRY_URL` are present in the deployed
configuration, without printing `FELTDB_TOKEN` or any other secret. Also confirm
that `fly status` reports the image digest from the new deployment. Startup logs
should show only `configured: true` or `configured: false` for each required
setting, followed by `Factory starting...`.

The health response contains only safe service, runtime, and PAX version
metadata. It does not authenticate or execute a workload.

## Smoke test

The optional authenticated smoke test requires an AuthBoundry bearer token and
an authorized run body supplied by the environment, not by source control:

```sh
FACTORY_URL=https://factory-runner.fly.dev \
FACTORY_AUTHORIZATION="******" \
FACTORY_RUN_BODY='{"workId":"...","repository":{"provider":"github","owner":"...","name":"...","ref":"main"},"operation":"..."}' \
node scripts/smoke-production.mjs
```

The script creates a run, retrieves it, and retrieves its evidence endpoint.
Restart the machine and run the retrieval check again:

```sh
fly machine restart <machine-id>
FACTORY_URL=https://factory-runner.fly.dev \
FACTORY_AUTHORIZATION="******" \
FACTORY_RUN_ID="<created-run-id>" \
FACTORY_RUN_BODY='{"workId":"...","repository":{"provider":"github","owner":"...","name":"...","ref":"main"},"operation":"..."}' \
node scripts/smoke-production.mjs
```

The second invocation retrieves the pre-restart run from FeltDB, proving that
Factory memory and the ephemeral filesystem are not the durable state store.

## Rollback and troubleshooting

```sh
fly releases
fly releases rollback <known-good-version>
fly logs
fly checks list
```

Rollback changes only the Factory image. Do not delete FeltDB state. A
compatible previous Factory image must be able to read the same durable Run
records. If startup fails, check that `FELTDB_URL`, `FELTDB_TOKEN`, and
`AUTHBOUNDRY_URL` are set and that the remote services are reachable; startup
also verifies `pax --version`.
