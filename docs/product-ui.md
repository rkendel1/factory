# Composable product UI

Factory exposes its contextual product contribution at `GET /v1/ui` using the
real `AppPort/ui/1` discovery contract. A host passes independently discovered
contributions to the `@appport/client` composer. Composition is generic:
contributors are validated, filtered against the exact capabilities supplied
by AuthBoundry, and combined without branching on product IDs or adding grants.

Factory contributes Work, Runs, Evidence, and Artifacts. AppPort Services
contributes its package-owned Configuration, Secrets, API Keys, Notifications,
Webhooks, and Jobs management surfaces. The same principal, tenant, application,
environment, and capabilities context is passed to every contribution.

The package's configuration API and management router are mounted directly.
Factory `/` is only the browser authentication entrypoint: it redirects through
the existing AuthBoundry browser surface and then to `/configuration`. It does
not render another shell or own session state.
Factory's adapter only translates authenticated AuthBoundry context into the
principal shape expected by AppPort Services; it does not create a second
configuration store, secret resolver, or management screen. Secret values are
accepted only by the service operation and are omitted from UI discovery,
configuration list responses, Factory contracts, evidence, and logs.

`@appport/services@0.4.2` is covered through its real FeltDB-backed CRUD path:
variables can be created, edited, listed, and deleted; secrets can be created,
rotated, listed as metadata, and deleted. The host supplies the application and
environment defaults, while AuthBoundry supplies principal, tenant, and
authorized capabilities. Factory does not persist any of those product records.

UI visibility is convenience, not authority. Every service route authenticates
and authorizes independently, and a missing or denied AuthBoundry decision fails
closed.
