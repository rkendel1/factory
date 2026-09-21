# Production Fly deployment audit

Audit date: 2026-09-21. Application: `factory-idvhpa`, region: `iad`.

## Observed deployment before hardening

- The deployed app was suspended with one stopped version-7 machine and a
  warning health check because the machine had not started.
- The app had no public IP allocation, so its generated hostname could not
  resolve. A shared IPv4 address and public IPv6 address were allocated.
- One `http_service` exposed internal port 3000, forced HTTPS, and checked
  unauthenticated `GET /health`. There was no duplicate `[[services]]` block.
- `AUTHBOUNDRY_URL` referenced nonexistent app `authboundry.fly.dev`; the
  deployed authority is `authboundry-api` on private port 8000.
- `FELTDB_URL` referenced `https://feltdb.fly.dev`, but the `feltdb` app has no
  public ingress IP. Its private DNS name and port are
  `feltdb.internal:7700`.
- Fly private DNS resolves both `authboundry-api.internal` and
  `feltdb.internal` in the Factory organization.
- Private Fly DNS is IPv6. FeltDB was bound only to IPv4 (`0.0.0.0`), so the
  first private connection failed. Its deployed machine now uses `HOST=::`;
  the canonical FeltDB deployment configuration must retain that setting or a
  later FeltDB deployment can regress private connectivity.
- The FeltDB app declares `FELTDB_AUTH_TOKEN`; Factory had no deployed
  `FELTDB_TOKEN` secret. The token is bootstrap infrastructure, not AppPort
  application configuration.
- `fly.toml` declared both `memory = '1gb'` and `memory_mb = 256` for one VM.
- Both Docker stages ran `npm ci` without first copying the vendored GitHub
  tarball required by `package.json`, making clean image resolution invalid.
- The runtime command was correctly `node dist/src/server.js`; PAX was pinned
  and verified at image build; the final image ran as non-root `node`.

## Hardened contract

- Factory binds explicitly to `0.0.0.0:3000` in production.
- Fly has one HTTPS service and one `/health` check on port 3000.
- FeltDB traffic uses Fly private topology at
  `http://feltdb.internal:7700`; AuthBoundry uses its verified HTTPS origin at
  `https://authboundry-api.fly.dev`.
- The single VM memory declaration is `1gb`.
- Each Docker stage copies `vendor/` before `npm ci`.
- Production still fails closed when `FELTDB_URL` or `AUTHBOUNDRY_URL` is
  absent. `FELTDB_TOKEN`, when required, remains a Fly secret.
- Factory has both public IPv4 and IPv6 ingress allocations for
  `factory-idvhpa.fly.dev`.
- AppPort Services remains the application configuration owner. No Factory
  configuration store, secret fallback, or management portal was introduced.

## Final production verification

- Remote image build and rolling deployment succeeded at machine version 12.
- The unauthenticated `/health` check passes after startup and reports remote,
  persistent FeltDB plus `@appport/services@0.4.2` initialization.
- HTTP redirects to HTTPS with status 301. Unauthenticated `/v1/ui` and
  `POST /v1/runs` requests return 401; health remains unauthenticated.
- The running container resolves `@appport/services@0.4.2`,
  `@feltdb/core@0.11.4`, `@authboundry/core@1.15.1`,
  `@appport/appboundry@1.1.0`, and the GitHub integration at `1.0.1`, with no
  nested older AppPort Services copy.
- A controlled Factory machine restart completed and `/health` returned the
  same application fingerprint with all remote authorities initialized. Cold
  initialization currently takes about one minute while Factory validates and
  deploys its FlowSpec to FeltDB.
- The repository contains authenticated production smoke scripts for AppPort
  Services CRUD and Factory execution/retrieval. They were not run because no
  production AuthBoundry bearer credential or authorized run body was supplied
  to this environment. Consequently, live authenticated UI/CRUD, execution
  provenance, and retrieval of pre-restart application records remain pending;
  these checks must not be bypassed with a fabricated identity.

## Browser entrypoint follow-up

The original hardened deployment intentionally exposed APIs and package-owned
management routes but had no handler for `/`. Factory now checks the canonical
AuthBoundry session at the public root and redirects unauthenticated users to
the existing AuthBoundry login surface on the Factory origin. Authenticated
users continue to the package-owned `/configuration` surface. Only the
AuthBoundry browser routes required for login/session/logout, its published
client and password policy, and OAuth begin/callback are relayed. Arbitrary
AuthBoundry control-plane routes are not exposed, and caller-provided return
targets do not influence redirects.

Production verification after deployment:

- `HEAD /` returns 302 to `/auth/login?return_to=%2F`.
- The relayed login route returns the published AuthBoundry sign-in page.
- An external `return` query still redirects only to the fixed local login.
- `/health` returns 200 while unauthenticated `/v1/ui` and `/configuration`
  return 401.
- The published AuthBoundry browser client returns 200, fabricated OAuth state
  returns 400, and an unrelated AuthBoundry control-plane route returns 404.
- Fly's configured health check passes on the deployed image.

The subsequent GitHub administration audit found two owning-product blockers.
Their package contracts are now available and consumed without Factory-owned
workarounds: see [authboundry-github-factory-administration-defect.md](authboundry-github-factory-administration-defect.md)
and [appport-services-api-key-administration-defect.md](appport-services-api-key-administration-defect.md).
Application capability policy and relying-application registration remain
deployment-owned AuthBoundry state.

The Factory consumer now uses `@authboundry/core@1.15.2`'s supported server
adapter. Production deployment remains intentionally blocked until the
AuthBoundry service registers relying application `factory` with callback
`/api/auth/callback`: after the 2026-09-21 AuthBoundry upgrade, the live route
works for registered application `portal` but returns HTTP 400
`unknown_application` for `factory`. Factory also has no
`AUTHBOUNDRY_BROWSER_COOKIE_SECRET` Fly secret yet. Do not deploy the consumer
until both deployment-owned prerequisites exist; the current release fails
closed rather than restoring the former proxy workaround.

## Verification commands

Local and artifact verification:

```sh
npm ci
npm test
npm ls @appport/services @feltdb/core @authboundry/core @appport/appboundry
docker build -t factory-production-audit .
fly config validate --config fly.toml
```

Production health and authenticated checks:

```sh
fly deploy --config fly.toml --remote-only --strategy rolling
fly status -a factory-idvhpa
fly checks list -a factory-idvhpa
curl --fail https://factory-idvhpa.fly.dev/health

FACTORY_URL=https://factory-idvhpa.fly.dev \
FACTORY_AUTHORIZATION='Bearer …' \
node scripts/smoke-production-services.mjs
```

Factory execution and restart durability use `scripts/smoke-production.mjs` as
documented in [deployment.md](deployment.md). Neither smoke script bypasses
AuthBoundry, `.flow`, or product authorization.

The live audit never records credential values. When reusing FeltDB's existing
bootstrap token, note that `fly ssh console -C` executes the command directly;
shell-style `$VARIABLE` text is not expanded unless an explicit interpreter is
used. The production repair emitted the value from a remote Node process into
`fly secrets import` and verified only secret metadata.
