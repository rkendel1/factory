# AppPort Services API-key administration integration defect

Verified 2026-09-21 with `@appport/services@0.4.2`, the current npm latest
release.

## Impact

The packaged `/api-keys` management page is mountable, but it cannot administer
API keys through the compatibility `createServices()` integration used by
Factory. Factory must not recreate these package-owned APIs or invent missing
authorization capability names.

## Reproduction and evidence

1. `createConfigurationManagementRouter(services.configuration)` mounts the
   configuration API plus all packaged management HTML pages.
2. The packaged `/api-keys` page calls `GET`, `POST`, and `DELETE` under
   `/_appport/api/keys`.
3. `createConfigurationManagementRouter` does not mount those endpoints; it
   only receives a `ConfigurationService`.
4. The implementation of the `/_appport/*` endpoints is private to the
   package's `startHttpRuntime` dispatch. The package exports neither that
   request handler nor an Express router that can be mounted around an existing
   `createServices()` instance. Starting the package's separate HTTP server is
   not composition into Factory's authenticated application host.
5. Factory consequently does not claim `/_appport/*` paths, so the page's API
   calls return 404.
6. The published UI contribution declares only `apikeys.read`. The packaged UI
   also creates and revokes keys, but the installed package exposes no
   documented authorization capability names for those mutations. The private
   runtime authenticates AppPort API keys but does not map an external
   AuthBoundry principal to per-operation read/create/revoke authorities.

Configuration capabilities are unambiguous and enforced by the package:
`configuration.read`, `configuration.write`, `configuration.delete`, and
`secret.rotate`. API-key administration does not currently have an equivalent
mountable external-authorization contract.

## Required owning-package fix

- Export a composable handler/router for the stable `/_appport/*` management
  contract that operates on an existing `AppPortServices` instance and can be
  mounted in an application host.
- Accept a host-supplied authenticated principal/authorization adapter so
  AuthBoundry remains authoritative. Do not require a second AppPort API key to
  administer AppPort API keys through an already authenticated browser.
- Publish and enforce explicit capabilities for API-key list, create, and
  revoke operations. The management UI contribution must declare the same
  capabilities it actually exercises.
- Preserve the one-time secret response on creation; list/get responses must
  contain metadata only and never return the secret or secret hash.
- Add integration tests using the exported host adapter for authorized and
  denied list/create/revoke, tenant isolation, restart durability, and secret
  non-disclosure.

## Factory boundary

After the package exports this contract, Factory should mount it beside the
existing configuration router and translate verified AuthBoundry context into
the package principal type. Factory should not copy `runtime/platform.js`, call
package internals, or build a parallel API-key service.

