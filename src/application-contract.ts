import { createHash } from 'node:crypto';
import { APPBOUNDRY_CERTIFICATION_PROTOCOL } from '@appport/appboundry';
import { defineApplication, defineCapability, appBoundryContractFromManifest, fingerprintAppBoundryContract, s, type AuthoredApplication } from '@appport/sdk';
import type { FlowBlock, FlowSpec } from '@feltdb/core';

export interface FlowCapabilityContract {
  name: string;
  operation: string;
  grants: string[];
  service?: string;
  capability?: string;
  executionMode: string;
}

export interface CanonicalApplicationContract {
  identity: {
    id: string;
    name: string;
    version: string;
  };
  fingerprint: string;
  capabilities: FlowCapabilityContract[];
  appPort: AuthoredApplication;
  appBoundry: ReturnType<typeof appBoundryContractFromManifest>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function statementValue(block: FlowBlock, prefix: string): string | undefined {
  return block.statements.find((statement) => statement.startsWith(prefix))?.slice(prefix.length).trim();
}

function statementValues(block: FlowBlock, prefix: string): string[] {
  return block.statements
    .filter((statement) => statement.startsWith(prefix))
    .map((statement) => statement.slice(prefix.length).trim())
    .filter(Boolean);
}

function flowFingerprint(flowSpec: FlowSpec): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(flowSpec))).digest('hex');
}

function appPortCapabilityName(operation: string): string {
  return `softwarefactory.${operation.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

export function createCanonicalApplicationContract(flowSpec: FlowSpec): CanonicalApplicationContract {
  const capabilities = flowSpec.capabilities.flatMap((block): FlowCapabilityContract[] => {
      const operation = statementValue(block, 'operation ');
      if (!operation) return [];
      return [{
        name: block.name,
        operation,
        grants: statementValues(block, 'grant '),
        service: statementValue(block, 'appport_service '),
        capability: statementValue(block, 'appport_capability '),
        executionMode: statementValue(block, 'execution_mode ') ?? 'native',
      }];
    });
  const identity = {
    id: flowSpec.app,
    name: flowSpec.app,
    version: `${flowSpec.version}.0.0`,
  };
  const sourceFingerprint = flowFingerprint(flowSpec);
  const appPort = defineApplication({
    ...identity,
    metadata: {
      source: '.flow',
      flowVersion: flowSpec.version,
      flowFingerprint: sourceFingerprint,
      appBoundryProtocol: APPBOUNDRY_CERTIFICATION_PROTOCOL,
    },
    provides: capabilities.map((capability) => defineCapability({
      name: appPortCapabilityName(capability.operation),
      version: 1,
      input: s.object({}),
      output: s.object({ accepted: s.boolean() }),
      authorization: capability.grants,
      handler: async () => ({ accepted: true }),
    })),
    requires: [...new Map(capabilities
      .filter((capability) => capability.service && capability.capability)
      .map((capability) => ({
        key: `${capability.service}.${capability.capability}`,
        value: { name: `${capability.service}.${capability.capability}`, version: 1 },
      }))
      .map(({ key, value }) => [key, value])).values()],
  });
  const appBoundry = appBoundryContractFromManifest(appPort.manifest(), flowSpec.version);
  const fingerprint = fingerprintAppBoundryContract(appBoundry);
  return { identity, fingerprint, capabilities, appPort, appBoundry };
}
