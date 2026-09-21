# AuthBoundry Factory delegation durability defect

Status: fixed upstream. AuthBoundry now re-asserts the durable Factory
application delegation on every bootstrap under the deterministic id
`factory-application-<tenant>-delegation`, and refuses to assign that authority
to a principal that does not exist. Factory's side of the association is
described in [factory-authority-association.md](factory-authority-association.md).

The reproduction below is retained as the record of the original defect.

## Impact

Factory cannot complete authenticated UI, configuration, secret-rotation, or
API-key management verification. Factory correctly asks AuthBoundry for each
capability and must not replace the missing authority with local role or
identity checks.

## Reproduction and evidence

1. Deploy AuthBoundry with Factory application provisioning enabled for tenant
   `default` and the eight required application capabilities.
2. Startup reports:

   ```text
   genesis for tenant `default` (from Initialized): tenant=false policy=false
   system_principal=false authority_operator_delegation=false
   factory_application_delegation=true
   ```

3. Restart the same Fly machine with the same persistent volume attached.
4. Startup then reports that tenant `default` is already initialized and leaves
   the existing authority intact.
5. Inspect `/data/authboundry/authority.json`. Its durable state contains:

   - the GitHub human principal in tenant `default`, still `role=member`;
   - the system service principal;
   - the original authority-only policy;
   - `delegations: []`.

The successful provisioning result is therefore not represented in the durable
authority after restart. The principal has none of the expected Factory
capabilities, so AuthBoundry continues to deny Factory operations.

## Expected result

Provisioning must durably and idempotently retain exactly one tenant-scoped
Factory application delegation containing:

- `factory.ui.read`
- `configuration.read`
- `configuration.write`
- `configuration.delete`
- `secret.rotate`
- `apikeys.read`
- `apikeys.create`
- `apikeys.revoke`

It must not grant `authority.*`, change the principal's `member` role, or rely
on Factory-side authorization state. After restart, the delegation must still
be present and `/auth/authorize` must evaluate it for the existing session.

## Suggested regression coverage

Provision against an already initialized durable tenant, close and reopen the
store, then assert the exact delegation set and successful authorization for
all eight capabilities. Also assert idempotence, tenant isolation, and denial
of `authority.*`.
