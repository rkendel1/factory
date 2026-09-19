# Production deployment

Factory Runner is deployed as the dedicated `factory-runner` Fly application.
It owns execution orchestration only: FeltDB owns durable state, AuthBoundry
owns identity and authorization, and `.flow` remains the application capability
contract. No Factory database or Fly volume is required.

## Prerequisites

- Fly CLI authenticated to the target organization
- A deployed AuthBoundry service
- A remote FeltDB service using `@feltdb/core@0.11.4`
- The pinned PAX release available to the image build

Create the application once if necessary:

```sh
fly apps create factory-runner
```

Set deployment-managed secrets (never commit these values):

```sh
fly secrets set \
  FELTDB_URL="https://feltdb.example" \
  FELTDB_TOKEN="..." \
  AUTHBOUNDRY_URL="https://auth.example"
```

Deploy and verify:

```sh
fly deploy
curl --fail https://factory-runner.fly.dev/health
```

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
Run durability is verified by running the retrieval step again after
`fly machine restart <machine-id>`.

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
