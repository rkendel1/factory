# Composable product UI

Factory exposes contextual product discovery at `GET /v1/ui` using the real
`AppPort/ui/1` protocol and `@appport/client` composer. Composition is generic:
contributors are discovered through a common interface, validated, then
filtered against the exact capabilities supplied by AuthBoundry. Factory does
not branch on product IDs or add grants during composition.

Factory contributes Work, Runs, Evidence, and Artifacts. AppPort Services
contributes its package-owned Configuration, Secrets, API Keys, Notifications,
Webhooks, and Jobs management surfaces. The same principal, tenant, application,
environment, and capabilities context is passed to every contribution.

The package's configuration API and management router are mounted directly.
Factory's adapter only translates authenticated AuthBoundry context into the
principal shape expected by AppPort Services; it does not create a second
configuration store, secret resolver, or management screen. Secret values are
accepted only by the service operation and are omitted from UI discovery,
configuration list responses, Factory contracts, evidence, and logs.

UI visibility is convenience, not authority. Every service route authenticates
and authorizes independently, and a missing or denied AuthBoundry decision fails
closed.
