import { createCanonicalApplicationContract, type CanonicalApplicationContract } from './application-contract.js';
import { loadFactoryFlow } from './felt.js';
import type { ExecutionContract } from './types.js';

export interface AppPortContract {
  protocol: 'appport';
  applicationId: string;
  applicationVersion: string;
  applicationFingerprint: string;
  operation: string;
  service: string;
  capability: string;
  resource?: string;
}

export class AppPortAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppPortAdapterError';
  }
}

export function createFactoryAppPortApplication(flowPath?: string): CanonicalApplicationContract['appPort'] {
  return createCanonicalApplicationContract(loadFactoryFlow(flowPath)).appPort;
}

export interface AppPortAdapterOptions {
  application: CanonicalApplicationContract;
}

export interface FactoryAppPortAdapter {
  readonly protocol: 'appport';
  readonly applicationFingerprint: string;
  bindContract(contract: ExecutionContract): void;
}

function requireCapability(contract: ExecutionContract, capability: string): void {
  if (!contract.appport || !contract.capabilities.includes(capability)) {
    throw new AppPortAdapterError(
      `AppPort capability ${capability} is not authorized by the execution contract`,
    );
  }
}

export function createAppPortAdapter(options: AppPortAdapterOptions): FactoryAppPortAdapter {
  return {
    protocol: 'appport',
    applicationFingerprint: options.application.fingerprint,
    bindContract(contract) {
      if (!contract.appport || contract.appport.protocol !== 'appport') {
        throw new AppPortAdapterError('Execution contract is missing its AppPort binding');
      }
      if (contract.appport.applicationFingerprint !== options.application.fingerprint) {
        throw new AppPortAdapterError('Execution contract AppPort binding does not match the authoritative .flow');
      }
      if (contract.appport.operation !== contract.operation) {
        throw new AppPortAdapterError('Execution contract AppPort operation does not match the Factory operation');
      }
      requireCapability(contract, contract.appport.capability);
    },
  };
}
