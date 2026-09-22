import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FlowSpec } from '@feltdb/core';
import { getOperationAuthorities, type OperationAuthority } from './authority.js';
import {
  capabilityResourceKind,
  isOperationalCapability,
  REQUIRED_VERIFICATION,
  type OperationalCapability,
} from './capabilities.js';
import type {
  ActionRecord,
  DesiredStateRecord,
  EnvironmentRecord,
  ProviderExecution,
  RepositoryDiscovery,
  RepositoryRecord,
  StructuredEvidence,
  VerificationCheck,
} from './types.js';

/**
 * The provider boundary.
 *
 * Factory coordinates an Action; an adapter knows how to talk to one external
 * system. An adapter plans, hands the execution boundary what to run, and
 * reads the result back for verification. It creates no Actions, authorizes
 * nothing, holds no cache, and schedules nothing: it has nothing Factory did
 * not give it and produces nothing Factory does not record.
 */
export interface ProviderContext {
  repository: RepositoryRecord | null;
  environment: EnvironmentRecord | null;
  desiredState: DesiredStateRecord | null;
  discovery: RepositoryDiscovery | null;
  /** The durable identity the provider operation is keyed on. */
  idempotencyKey: string;
}

export interface ProviderPlan {
  provider: string;
  capability: OperationalCapability;
  operation: string;
  resource: string;
  expectedEffects: string[];
  verification: string[];
  requiredAuthority: string[];
  parameters: Record<string, string>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Credentials the adapter needs, by name. Values are never its business. */
  readonly credentials: readonly string[];
  /** Whether the adapter can reach its system from this process. */
  availability(): Promise<{ state: 'available' | 'unavailable'; detail: string }>;
  /** Non-secret parameters for an operation, derived from durable state. */
  parameters(capability: OperationalCapability, context: ProviderContext): Record<string, string>;
  /** Reads the operation's result back into Factory's verification model. */
  verify(capability: OperationalCapability, evidence: StructuredEvidence, context: ProviderContext): VerificationCheck[];
  /** What the operation is expected to change, for planning and review. */
  effects(capability: OperationalCapability, context: ProviderContext): string[];
  /** Whether the provider makes an operation exactly-once under our key. */
  idempotency(capability: OperationalCapability): { exactlyOnce: boolean; note?: string };
}

async function onPath(binary: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, binary), constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

function resourceFor(kind: 'repository' | 'environment', context: ProviderContext): string {
  if (kind === 'repository') {
    return context.repository ? `repository:${context.repository.owner}/${context.repository.name}` : 'repository:unresolved';
  }
  return context.environment ? `environment:${context.environment.name}` : 'environment:unresolved';
}

/** Git: the repository as it is. Runs in the materialized checkout. */
export const gitAdapter: ProviderAdapter = {
  id: 'git',
  displayName: 'Git',
  credentials: [],
  async availability() {
    return (await onPath('git'))
      ? { state: 'available', detail: 'git is on PATH' }
      : { state: 'unavailable', detail: 'git is not on PATH' };
  },
  parameters() { return {}; },
  verify(capability, evidence) {
    return [{
      name: capability === 'repository.inspect' ? 'repository head observed' : 'checkout observed',
      status: evidence.exitCode === 0 && evidence.stdout.trim() ? 'passed' : 'failed',
      detail: evidence.stdout.trim().split('\n')[0] ?? '',
    }];
  },
  effects() { return ['reads the repository; changes nothing']; },
  idempotency() { return { exactlyOnce: true, note: 'read-only' }; },
};

/** Local: the project's own build and test, in the controlled execution boundary. */
export const localAdapter: ProviderAdapter = {
  id: 'local',
  displayName: 'Local execution',
  credentials: [],
  async availability() {
    return (await onPath('npm'))
      ? { state: 'available', detail: 'npm is on PATH' }
      : { state: 'unavailable', detail: 'npm is not on PATH' };
  },
  parameters() { return {}; },
  verify(capability, evidence, context) {
    const script = capability === 'build.run' ? 'build' : capability === 'test.run' ? 'test' : null;
    const declared = script ? context.discovery?.signals.scripts?.includes(script) ?? false : false;
    return [{
      name: `${capability} completed`,
      status: evidence.exitCode === 0 ? 'passed' : 'failed',
      detail: declared ? `package.json declares ${script}` : `package.json declares no ${script} script; --if-present made this a no-op`,
    }];
  },
  effects(capability) {
    return capability === 'build.run'
      ? ['runs the repository build script in an ephemeral workspace']
      : ['runs the repository test script in an ephemeral workspace'];
  },
  idempotency() { return { exactlyOnce: true, note: 'ephemeral workspace; no external effect' }; },
};

/**
 * Fly: deployment and environment operations for a project with fly.toml.
 *
 * Deployment is not exactly-once: `fly deploy` has no idempotency key, so a
 * retried deployment may deploy twice. That is recorded on the evidence rather
 * than hidden.
 */
export const flyAdapter: ProviderAdapter = {
  id: 'fly',
  displayName: 'Fly',
  credentials: ['FLY_API_TOKEN'],
  async availability() {
    if (!(await onPath('fly'))) return { state: 'unavailable', detail: 'fly CLI is not on PATH' };
    return process.env.FLY_API_TOKEN
      ? { state: 'available', detail: 'fly CLI on PATH and FLY_API_TOKEN present' }
      : { state: 'unavailable', detail: 'fly CLI on PATH but FLY_API_TOKEN is not configured' };
  },
  parameters(capability, context) {
    const app = context.discovery?.signals.flyApp ?? context.environment?.configuration?.flyApp;
    const parameters: Record<string, string> = {};
    if (typeof app === 'string' && app) {
      parameters.FLY_APP = app;
      if (capability === 'environment.health') {
        const configured = context.environment?.configuration?.healthUrl;
        parameters.FACTORY_HEALTH_URL = typeof configured === 'string' && configured
          ? configured
          : `https://${app}.fly.dev/health`;
      }
    }
    return parameters;
  },
  verify(capability, evidence) {
    if (capability === 'environment.health') {
      let observed: { ok?: boolean; status?: number; error?: string; url?: string } = {};
      try { observed = JSON.parse(evidence.stdout.trim().split('\n').pop() ?? '{}'); } catch { /* not JSON */ }
      return [{
        name: 'environment responds healthy',
        status: observed.ok ? 'passed' : 'failed',
        detail: observed.ok
          ? `${observed.url} returned HTTP ${observed.status}`
          : observed.error ?? (observed.status ? `HTTP ${observed.status}` : 'no health response'),
      }];
    }
    if (capability === 'deployment.create') {
      return [{
        name: 'deployment command completed',
        status: evidence.exitCode === 0 ? 'passed' : 'failed',
        detail: evidence.exitCode === 0 ? 'fly deploy exited 0; health is verified separately' : 'fly deploy did not exit 0',
      }];
    }
    return [{ name: `${capability} completed`, status: evidence.exitCode === 0 ? 'passed' : 'failed' }];
  },
  effects(capability, context) {
    const app = context.discovery?.signals.flyApp ?? 'the Fly app';
    return capability === 'deployment.create'
      ? [`deploys the checkout to ${app}`, 'serves new traffic once healthy']
      : capability === 'environment.health'
        ? [`probes ${app} health; changes nothing`]
        : [`reads ${app} status; changes nothing`];
  },
  idempotency(capability) {
    return capability === 'deployment.create'
      ? { exactlyOnce: false, note: 'fly deploy has no idempotency key; a retry may deploy again' }
      : { exactlyOnce: true, note: 'read-only' };
  },
};

export const DEFAULT_ADAPTERS: readonly ProviderAdapter[] = [gitAdapter, localAdapter, flyAdapter];

/**
 * What Factory can perform: the intersection of what `.flow` declares and
 * what an adapter implements. Neither alone is enough — an adapter for an
 * undeclared capability is not authority, and a declaration with no adapter
 * is not an ability.
 */
export interface ProviderCapability {
  capability: OperationalCapability;
  operation: string;
  authority: OperationAuthority;
}

export class ProviderRegistry {
  private readonly byProvider = new Map<string, ProviderCapability[]>();

  constructor(flowSpec: FlowSpec, readonly adapters: readonly ProviderAdapter[] = DEFAULT_ADAPTERS) {
    for (const authority of getOperationAuthorities(flowSpec).values()) {
      if (!authority.provider || !isOperationalCapability(authority.operationalCapability)) continue;
      if (!adapters.some((adapter) => adapter.id === authority.provider)) continue;
      const list = this.byProvider.get(authority.provider) ?? [];
      list.push({ capability: authority.operationalCapability, operation: authority.operation, authority });
      this.byProvider.set(authority.provider, list);
    }
  }

  adapter(id: string): ProviderAdapter | null {
    return this.adapters.find((adapter) => adapter.id === id) ?? null;
  }

  providers(): string[] {
    return [...this.byProvider.keys()].sort();
  }

  capabilitiesOf(provider: string): ProviderCapability[] {
    return [...(this.byProvider.get(provider) ?? [])].sort((a, b) => a.capability.localeCompare(b.capability));
  }

  /** Providers that can satisfy a capability, in a stable order. */
  providersFor(capability: OperationalCapability): string[] {
    return this.providers().filter((provider) =>
      this.capabilitiesOf(provider).some((entry) => entry.capability === capability));
  }

  operationFor(provider: string, capability: OperationalCapability): ProviderCapability | null {
    return this.capabilitiesOf(provider).find((entry) => entry.capability === capability) ?? null;
  }
}

export type ProviderResolution =
  | { ok: true; provider: string; operation: string; capability: OperationalCapability; resource: string }
  | { ok: false; outcome: 'capability-unavailable' | 'provider-unavailable'; reason: string };

/**
 * Deterministic provider resolution.
 *
 * A repository capability goes to the provider `.flow` declares for it. An
 * environment capability goes to the provider the environment or desired
 * state names, and only that one: when it cannot satisfy the capability, or
 * nothing names a provider, the answer is provider-unavailable. Factory never
 * picks a different provider than the one that was configured.
 */
export function resolveProvider(
  registry: ProviderRegistry,
  capability: string,
  context: ProviderContext,
): ProviderResolution {
  if (!isOperationalCapability(capability)) {
    return { ok: false, outcome: 'capability-unavailable', reason: `${capability} is not an operational capability Factory knows` };
  }
  const candidates = registry.providersFor(capability);
  if (candidates.length === 0) {
    return { ok: false, outcome: 'capability-unavailable', reason: `no .flow operation declares ${capability}` };
  }
  const kind = capabilityResourceKind(capability);
  const resource = resourceFor(kind, context);

  if (kind === 'repository') {
    if (candidates.length === 1) {
      return { ok: true, provider: candidates[0]!, operation: registry.operationFor(candidates[0]!, capability)!.operation, capability, resource };
    }
    return { ok: false, outcome: 'provider-unavailable', reason: `${capability} is declared by ${candidates.join(', ')}; a repository capability must have one provider` };
  }

  const configured = context.environment?.provider ?? context.desiredState?.targetProvider ?? null;
  if (!configured) {
    return { ok: false, outcome: 'provider-unavailable', reason: `no provider is configured for ${resource}; declare one on the environment or in desired state` };
  }
  if (!candidates.includes(configured)) {
    return { ok: false, outcome: 'provider-unavailable', reason: `provider ${configured} does not satisfy ${capability}; providers that do: ${candidates.join(', ')}` };
  }
  return { ok: true, provider: configured, operation: registry.operationFor(configured, capability)!.operation, capability, resource };
}

/** Plan an operation without performing it. */
export function planOperation(
  registry: ProviderRegistry,
  resolution: Extract<ProviderResolution, { ok: true }>,
  context: ProviderContext,
): ProviderPlan {
  const adapter = registry.adapter(resolution.provider)!;
  const entry = registry.operationFor(resolution.provider, resolution.capability)!;
  const required = REQUIRED_VERIFICATION[resolution.capability];
  return {
    provider: resolution.provider,
    capability: resolution.capability,
    operation: resolution.operation,
    resource: resolution.resource,
    expectedEffects: adapter.effects(resolution.capability, context),
    verification: [`${resolution.capability} result`, ...(required ? [required] : [])],
    requiredAuthority: [...entry.authority.capabilities],
    parameters: adapter.parameters(resolution.capability, context),
  };
}

/** What the execution boundary receives. Credentials by name only. */
export function providerExecution(
  registry: ProviderRegistry,
  resolution: Extract<ProviderResolution, { ok: true }>,
  context: ProviderContext,
): ProviderExecution {
  const adapter = registry.adapter(resolution.provider)!;
  return {
    provider: resolution.provider,
    capability: resolution.capability,
    operation: resolution.operation,
    resource: resolution.resource,
    environment: adapter.parameters(resolution.capability, context),
    credentials: [...adapter.credentials],
    idempotency: { key: context.idempotencyKey, ...adapter.idempotency(resolution.capability) },
  };
}

export function verifyOperation(
  registry: ProviderRegistry,
  action: Pick<ActionRecord, 'provider' | 'capability'>,
  evidence: StructuredEvidence,
  context: ProviderContext,
): VerificationCheck[] {
  const adapter = action.provider ? registry.adapter(action.provider) : null;
  if (!adapter || !isOperationalCapability(action.capability)) return [];
  return adapter.verify(action.capability, evidence, context);
}
