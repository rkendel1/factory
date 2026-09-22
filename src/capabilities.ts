/**
 * The operational vocabulary: what Factory needs done, never who does it.
 *
 * A capability says "create a deployment"; a provider says "on Fly". Keeping
 * the two apart is what lets the same Action Graph deploy to a different
 * provider without a different coordination model, and what keeps provider
 * names out of Factory's public contract.
 *
 * `.flow` stays authoritative over which of these Factory can actually
 * perform: a capability listed here but declared by no `.flow` operation is
 * one Factory refuses, not one it improvises.
 */
export const OPERATIONAL_CAPABILITIES = [
  'repository.inspect',
  'repository.checkout',
  'build.run',
  'test.run',
  'deployment.create',
  'deployment.rollback',
  'environment.inspect',
  'environment.health',
  'service.restart',
  'configuration.apply',
  'migration.run',
] as const;

export type OperationalCapability = typeof OPERATIONAL_CAPABILITIES[number];

export function isOperationalCapability(value: unknown): value is OperationalCapability {
  return typeof value === 'string' && (OPERATIONAL_CAPABILITIES as readonly string[]).includes(value);
}

/** Capabilities that act on a repository rather than an environment. */
export function capabilityResourceKind(capability: OperationalCapability): 'repository' | 'environment' {
  return capability.startsWith('repository.') || capability === 'build.run' || capability === 'test.run'
    ? 'repository'
    : 'environment';
}

/**
 * What must be true after a capability ran for it to have succeeded
 * operationally. A deployment that finished is not yet a deployment that
 * serves traffic; the health capability is what says so.
 */
export const REQUIRED_VERIFICATION: Partial<Record<OperationalCapability, OperationalCapability>> = {
  'deployment.create': 'environment.health',
  'deployment.rollback': 'environment.health',
  'service.restart': 'environment.health',
};
