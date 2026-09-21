# AuthBoundry GitHub browser administration defect

Status: the relying-application integration is fixed upstream in
`@authboundry/core@1.15.2` and consumed by Factory through the package's
`/server` export. Durable AuthBoundry application registration and capability
policy remain deployment-owned requirements.

Verified 2026-09-21 against Factory `https://factory-idvhpa.fly.dev`, deployed
AuthBoundry `authboundry-api`, and `@authboundry/core@1.15.1` (the current npm
latest release).

## Impact

The deployed AuthBoundry authority can create a GitHub OAuth challenge, but its
published browser flow cannot establish an AuthBoundry session on the Factory
origin or authorize that GitHub principal to administer AppPort Services.
Factory must not work around this with local users, passwords, sessions, admin
tokens, or claim-based authorization.

## Reproduction and evidence

1. `GET /auth/login?return_to=%2F` through Factory returns AuthBoundry's
   generated sign-in page. GitHub is listed as an actionable provider.
2. Submitting that form calls `auth.signIn(...)`. For the GitHub connector,
   `POST /auth/sign-in` returns HTTP 202 containing only a challenge connector
   and state. The generated page treats the response as a completed sign-in and
   navigates to `/`; no GitHub authorization redirect occurs.
3. The canonical `GET /_authboundry/begin?provider=github&tenant=default`
   succeeds and returns a GitHub redirect challenge with single-use state.
4. That challenge currently uses
   `redirect_uri=https://www.authboundry.com/api/auth/callback`, copied from the
   deployed `GITHUB_REDIRECT_URI`. It cannot return a Factory-origin cookie.
5. `GET /_authboundry/callback/github` validates and consumes the OAuth
   response and returns the authority-issued `session_id`, `tenant_id`, and
   `principal_id` as JSON. It does not establish a relying-application browser
   cookie or redirect to Factory. The separate AuthBoundry portal currently
   performs that relying-party handoff itself.
6. The callback registers a new GitHub identity with `role=member`. The durable
   genesis policy grants only explicit `authority.*` capabilities to
   `role=admin`. The deployed app has no `AUTHBOUNDRY_OPERATOR_PRINCIPAL`, and
   the policy has no rules for `factory.ui.read`, `configuration.read`,
   `configuration.write`, `configuration.delete`, `secret.rotate`, or AppPort
   API-key administration. Authentication therefore cannot imply the requested
   application authority.

GitHub validates the requested callback against callbacks registered on the
OAuth application. The Factory callback cannot simply replace the deployed URL
without registering it in GitHub and deciding how the AuthBoundry portal and
Factory select their respective callbacks.

## Required owning-package/deployment fix

- Make the generated AuthBoundry login provider-aware: an OAuth provider must
  use the existing `/_authboundry/begin` challenge and follow its redirect,
  while local credentials may continue to use `/auth/sign-in`.
- Provide one canonical relying-application callback/session handoff (or an
  exported server adapter) that validates browser-bound state, delegates code
  exchange/principal/session creation to AuthBoundry, installs the opaque
  `authboundry_session` credential on the relying origin, and returns only to an
  allowlisted local path.
- Support an allowlisted relying-application callback selection when one
  AuthBoundry deployment serves multiple applications. Do not accept an
  arbitrary caller-provided external callback.
- Register the selected Factory callback in the GitHub OAuth application. A
  proposed relying-app callback is
  `https://factory-idvhpa.fly.dev/auth/github/callback`; it must not be deployed
  until the GitHub application and AuthBoundry agree on the exact value.
- Provision application capabilities through normal durable AuthBoundry policy
  and delegation administration after the GitHub principal is resolved. Do not
  infer administrator authority from the GitHub login name or from successful
  authentication.
- Test invalid, expired, mismatched, and replayed state; callback reuse;
  session durability; safe local return; and an authenticated principal both
  with and without each application capability.

## Factory boundary

Factory already forwards the opaque AuthBoundry session to `/auth/session` and
uses `/auth/authorize` for every protected operation. It should consume the
corrected browser/session adapter and durable policies. It should not reproduce
OAuth token exchange, identity storage, session authority, or policy state.
