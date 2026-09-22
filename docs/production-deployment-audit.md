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

The Factory consumer now uses `@authboundry/core@1.15.3`'s supported server
adapter. After AuthBoundry registered relying application `factory`, the
initial adapter image `deployment-01M32K3FGNVTR42XEBVP086R9K` was deployed with server-only
`AUTHBOUNDRY_BROWSER_COOKIE_SECRET` sealing material. Production verification
confirmed that login redirects through the registered AuthBoundry application
to GitHub, the pending transaction cookie is `HttpOnly; Secure; SameSite=Lax`,
unsafe returns and callbacks without a browser transaction return 400, and
unauthenticated `/_appport/api/keys` returns 401. The Fly health check passes.

The deployed container resolves `@authboundry/core@1.15.3`,
`@appport/services@0.4.3`, and `@feltdb/core@0.11.5`. Interactive GitHub consent,
callback completion, authenticated management mutations, logout, and restart
persistence still require a human browser session and are not claimed by this
non-interactive smoke test.

The `1.15.3` consumer image `deployment-01M32NN7NY245ACMB4XFDYH696` exposes
`/api/auth/login/github` as Factory's login entry and `/api/auth/callback` only
as the AuthBoundry application-handoff callback. Production checks confirm the
former `/auth/login` route and AuthBoundry-owned
`/_authboundry/browser/callback/github` provider callback both return 404 from
Factory; `/` redirects through the new login entry and `/health` remains 200.

## Factory application delegation verification

The 2026-09-21 authenticated-management follow-up did not confirm the claimed
durable AuthBoundry provisioning. AuthBoundry logged
`factory_application_delegation=true` during genesis at 19:32:02 UTC. After a
controlled restart, the same persistent store contained `delegations: []`, the
GitHub human principal remained `role=member`, and the only policy remained the
authority-administration policy. Authenticated Factory management therefore
remains blocked by the upstream durability defect documented in
[authboundry-factory-delegation-durability-defect.md](authboundry-factory-delegation-durability-defect.md).

Factory retains no authorization fallback. Its local verification covers the
eight declared application capabilities, 401 for missing authentication, 403
for an AuthBoundry denial, tenant isolation, host-owned application/environment
context, configuration and secret lifecycle, API-key one-time secret behavior,
and AppBoundry execution evidence. Live authenticated 200 responses and
post-restart management persistence cannot be claimed until AuthBoundry retains
the delegation and a normal browser logout/login refreshes the session.

The OAuth callback ownership and URLs were not changed. OAuth transaction
durability remains explicitly recorded as `DRIFT`.

Factory image `deployment-01M32QW90XN8TNEK95B2EABYH1` (machine version 17)
deployed the verified semantics and passed its Fly health check. Production
`GET /v1/ui`, `GET /v1/configuration`, and `GET /_appport/api/keys` each return
structured `401 UNAUTHENTICATED` without a session. Authenticated 200/403
verification remains gated on the durable AuthBoundry delegation above.

## PAX commit-pinned binary update

On 2026-09-22 Factory replaced the earlier `v0.1.0` archive with the Linux
x86-64 artifact built from PAX commit
`295cacfd338ab03e0beffb897fe1047427858c31` and published as release
`build-295cacf`. Docker and GitHub Actions both verify archive SHA-256
`dc039e848c763215569823c9fed423ee03c1664a83543203a1f3880bb026f4eb`
before extracting or executing it.

Fly image `deployment-01M34R41ADKER4Q1VH1NGETBTJ` deployed on machine version
26. The Debian image build passed its checksum verification and executed
`pax --version`; the running container and public `/health` endpoint both
reported `pax 0.1.0`, and the Fly health check passed.

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
