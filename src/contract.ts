import { createHash } from 'node:crypto';
import type { ExecutionContract } from './types.js';

type FingerprintableContract = Omit<ExecutionContract, 'fingerprint'>;

export function canonicalContract(contract: ExecutionContract): string {
  const { fingerprint: _fingerprint, ...immutable } = contract;
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(immutable));
}

export function contractFingerprint(contract: FingerprintableContract | ExecutionContract): string {
  return createHash('sha256').update(canonicalContract({ ...contract, fingerprint: '' })).digest('hex');
}

export function withContractFingerprint(contract: Omit<ExecutionContract, 'fingerprint'>): ExecutionContract {
  const fingerprint = contractFingerprint(contract);
  return Object.freeze({ ...contract, fingerprint });
}

export function assertContractIntegrity(contract: ExecutionContract): void {
  if (!contract.fingerprint || contractFingerprint(contract) !== contract.fingerprint) {
    throw new Error('Execution contract fingerprint validation failed');
  }
}
