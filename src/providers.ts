import type { FlowSpec } from '@feltdb/core';
import { getOperationAuthorities } from './authority.js';

/**
 * Factory's execution providers, derived from `.flow`.
 *
 * A provider is not a UI concept and its capabilities are not a UI constant:
 * both are read from the same `.flow` authority the runner executes against, so
 * a capability the UI shows is one an Action could actually be authorized for.
 */
export interface ProviderOperation {
  operation: string;
  capabilities: readonly string[];
  /** The AppPort service the operation is projected through. */
  service?: string;
  integration?: string;
  timeoutMs: number;
}

export type ProviderConnectionState = 'ready' | 'requires-connection' | 'requires-executable';

export interface ExecutionProvider {
  id: 'native' | 'pax' | 'integration';
  name: string;
  /**
   * What the provider needs before it can run. `.flow` decides which providers
   * exist at all; deployment decides whether each one is reachable.
   */
  connectionState: ProviderConnectionState;
  connectionDetail: string;
  capabilities: readonly string[];
  operations: readonly ProviderOperation[];
  /** The resources the provider operates on, as `.flow` describes them. */
  operatesOn: readonly string[];
}

const PROVIDER_NAMES: Record<ExecutionProvider['id'], string> = {
  native: 'Native execution',
  pax: 'PAX',
  integration: 'Integrations',
};

export function executionProviders(flowSpec: FlowSpec, runtime: {
  paxVersion?: string;
  githubConfigured?: boolean;
} = {}): ExecutionProvider[] {
  const grouped = new Map<ExecutionProvider['id'], ProviderOperation[]>();
  const integrations = new Map<ExecutionProvider['id'], Set<string>>();

  for (const authority of getOperationAuthorities(flowSpec).values()) {
    const id = authority.mode;
    const operations = grouped.get(id) ?? [];
    operations.push({
      operation: authority.operation,
      capabilities: [...authority.capabilities],
      ...(authority.appportService ? { service: authority.appportService } : {}),
      ...(authority.integration ? { integration: authority.integration } : {}),
      timeoutMs: authority.timeoutMs,
    });
    grouped.set(id, operations);
    if (authority.integration) {
      const names = integrations.get(id) ?? new Set<string>();
      names.add(authority.integration);
      integrations.set(id, names);
    }
  }

  return [...grouped.entries()].map(([id, operations]) => {
    const capabilities = [...new Set(operations.flatMap((operation) => operation.capabilities))].sort();
    const connection = describeConnection(id, runtime, integrations.get(id));
    return {
      id,
      name: PROVIDER_NAMES[id],
      ...connection,
      capabilities,
      operations: operations.sort((left, right) => left.operation.localeCompare(right.operation)),
      operatesOn: [...new Set(operations.map((operation) => operation.service ?? 'execution'))].sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function describeConnection(
  id: ExecutionProvider['id'],
  runtime: { paxVersion?: string; githubConfigured?: boolean },
  integrationNames?: Set<string>,
): { connectionState: ProviderConnectionState; connectionDetail: string } {
  if (id === 'native') {
    return { connectionState: 'ready', connectionDetail: 'Runs the command materialized into the execution contract' };
  }
  if (id === 'pax') {
    return runtime.paxVersion
      ? { connectionState: 'ready', connectionDetail: `PAX ${runtime.paxVersion}` }
      : { connectionState: 'requires-executable', connectionDetail: 'PAX executable not verified in this process' };
  }
  const names = [...(integrationNames ?? [])].sort().join(', ') || 'none';
  return runtime.githubConfigured
    ? { connectionState: 'ready', connectionDetail: `Integrations: ${names}` }
    : { connectionState: 'requires-connection', connectionDetail: `Integrations: ${names}; each run needs a connection on its work record` };
}

/** The provider that would execute a `.flow` operation. */
export function providerForOperation(flowSpec: FlowSpec, operation: string): ExecutionProvider['id'] | null {
  return getOperationAuthorities(flowSpec).get(operation)?.mode ?? null;
}
