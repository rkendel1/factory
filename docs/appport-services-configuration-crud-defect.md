# AppPort Services configuration CRUD defect

## Summary

`@appport/services@0.4.1` can create and list configuration records, but its
FeltDB-backed lookup incorrectly treats the entire mutation input as a scope.
This breaks variable updates and secret rotation, makes deletes silently leave
records behind, and can allow duplicate names when the submitted value differs.

This reproduces directly against AppPort Services with no Factory HTTP or UI
code involved. It occurs with both the package's declared
`@feltdb/core@0.11.1` and Factory's `@feltdb/core@0.11.4`.

## Minimal reproduction

```ts
import { createServices } from '@appport/services';

const services = createServices({ memory: true, namespace: 'configuration-repro' });
const principal = {
  principalId: 'operator-1',
  principalType: 'api_key' as const,
  tenantId: 'tenant-a',
  credentialId: 'credential-1',
  scopes: ['configuration.read', 'configuration.write', 'configuration.delete', 'secret.rotate'],
};
const input = {
  tenantId: 'tenant-a',
  applicationId: 'software_factory',
  environment: 'production' as const,
  name: 'PUBLIC_ORIGIN',
  value: 'https://factory.example',
};

await services.configuration.createVariable(input, principal);
await services.configuration.updateVariable(
  { ...input, value: 'https://updated.factory.example' },
  principal,
);
```

Actual result:

```text
ConfigurationValidationError: Configuration PUBLIC_ORIGIN not found
```

Expected result: the existing record is updated and its value becomes
`https://updated.factory.example`.

## Root cause

`ConfigurationService` passes the complete input object to store lookup calls:

```ts
this.options.store.getVariable(input, input.name)
this.options.store.getSecret(input, input.name)
```

`FeltDbConfigurationStore` then spreads that object into the FeltDB query:

```ts
this.variables.find({ ...scope, name })
this.secrets.find({ ...scope, name })
```

At runtime, `input` contains fields outside `ConfigurationScope`, including
`value` and `required`. TypeScript's structural typing does not remove them.
Consequently an update searches for the replacement value rather than the
stored value. Delete inputs similarly include `kind`; persisted records do not.

The in-memory test store masks the defect because its `getVariable` and
`getSecret` implementations explicitly compare only tenant, application,
environment, and name.

## Affected behavior

- `updateVariable`: reports an existing variable as missing when its value changes.
- `rotateSecret`: reports an existing secret as missing when its value changes.
- `delete`: can return successfully without deleting because `kind` enters the lookup query.
- duplicate checks in `createVariable` and `createSecret`: can miss an existing
  same-name record when non-scope input fields differ.
- variable/secret cross-kind name collision checks are affected for the same reason.

## Recommended fix

Make the FeltDB store project scope fields explicitly instead of spreading an
object received across an interface boundary:

```ts
getVariable(scope: Scope, name: string) {
  return this.variables.find({
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    environment: scope.environment,
    name,
  }).then((items) => items[0] ?? null);
}

getSecret(scope: Scope, name: string) {
  return this.secrets.find({
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    environment: scope.environment,
    name,
  }).then((items) => items[0] ?? null);
}
```

Projecting a `ConfigurationScope` inside `ConfigurationService` before every
store call would add defense in depth, but the store should still avoid object
spread because it is the persistence query boundary.

## Regression coverage

Add tests using the real `FeltDbConfigurationStore`, not only the in-memory
fake store:

1. Create, update to a different value, list, and delete a variable.
2. Create, rotate to a different value, list metadata, and delete a secret.
3. Assert deletion actually removes each record.
4. Assert a second same-name variable or secret is rejected even when its value differs.
5. Assert variable/secret cross-kind name collisions are rejected.
6. Assert secret values remain absent from views, errors, and audit events.

Factory should not work around this by implementing configuration CRUD itself;
the fix belongs in AppPort Services so every consumer receives identical
behavior and authorization.
