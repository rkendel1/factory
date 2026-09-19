import { defineApplication, defineCapability, s } from '@appport/sdk';
import { createServices, type AppPortServices } from '@appport/services';
import type { ExecutionContract, StructuredEvidence } from './types.js';

export interface AppPortContract {
  protocol: 'appport';
  operation: string;
  service: string;
  capability: string;
  resource?: string;
}

export type AppPortFailureCode =
  | 'authorization'
  | 'invalid_request'
  | 'service_unavailable'
  | 'credential'
  | 'timeout'
  | 'execution';

export class AppPortAdapterError extends Error {
  constructor(
    message: string,
    readonly code: AppPortFailureCode = 'invalid_request',
  ) {
    super(message);
    this.name = 'AppPortAdapterError';
  }
}

const factoryRunCapability = defineCapability({
  name: 'factory.execution.run',
  version: 1,
  input: s.object({
    operation: s.string(),
    service: s.string(),
    capability: s.string(),
  }),
  output: s.object({ accepted: s.boolean() }),
  authorization: ['factory.execution'],
  handler: async () => ({ accepted: true }),
});

export const factoryAppPortApplication = defineApplication({
  id: 'software-factory',
  name: 'Software Factory',
  version: '1.0.0',
  provides: [factoryRunCapability],
});

export interface AppPortAdapterOptions {
  namespace: string;
  path: string;
}

export interface FactoryAppPortAdapter {
  readonly protocol: 'appport';
  readonly applicationFingerprint: string;
  bindContract(contract: ExecutionContract): void;
  provenance(contract: ExecutionContract): Pick<StructuredEvidence, 'appport'>;
  emitWebhook(
    contract: ExecutionContract,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  enqueueJob(contract: ExecutionContract, type: string, payload: unknown): Promise<unknown>;
}

function requireCapability(contract: ExecutionContract, capability: string): void {
  if (!contract.appport || !contract.capabilities.includes(capability)) {
    throw new AppPortAdapterError(
      `AppPort capability ${capability} is not authorized by the execution contract`,
      'authorization',
    );
  }
}

export function createAppPortAdapter(options: AppPortAdapterOptions): FactoryAppPortAdapter {
  const services: AppPortServices = createServices({
    mode: 'local',
    namespace: `${options.namespace}-appport`,
    path: options.path,
  });

  return {
    protocol: 'appport',
    applicationFingerprint: factoryAppPortApplication.fingerprint(),
    bindContract(contract) {
      if (!contract.appport || contract.appport.protocol !== 'appport') {
        throw new AppPortAdapterError('Execution contract is missing its AppPort binding');
      }
      if (contract.appport.operation !== contract.operation) {
        throw new AppPortAdapterError('Execution contract AppPort operation does not match the Factory operation');
      }
      requireCapability(contract, contract.appport.capability);
    },
    provenance(contract) {
      return { appport: contract.appport };
    },
    async emitWebhook(contract, type, payload) {
      requireCapability(contract, 'webhook.emit');
      if (!contract.tenantId) {
        throw new AppPortAdapterError('Tenant is required for AppPort webhook delivery', 'authorization');
      }
      return services.webhooks.emitWebhookEvent({
        tenantId: contract.tenantId,
        type,
        payload,
      });
    },
    async enqueueJob(contract, type, payload) {
      requireCapability(contract, 'job.enqueue');
      if (!contract.tenantId) {
        throw new AppPortAdapterError('Tenant is required for AppPort jobs', 'authorization');
      }
      return services.jobs.enqueue({
        tenantId: contract.tenantId,
        type,
        payload,
      });
    },
  };
}
