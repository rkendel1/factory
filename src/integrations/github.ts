import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createGitHubIntegration,
  type AuthorityBoundary,
  type GitHubIntegration,
} from '@rkendel1/github-integration';
import { assertContractIntegrity } from '../contract.js';
import { buildGitHubEvidence } from '../evidence.js';
import type { ExecutionOutcome } from '../execution.js';
import type { ExecutionContract } from '../types.js';

export interface FactoryGitHubAdapter {
  execute(contract: ExecutionContract): Promise<ExecutionOutcome>;
}

interface FactoryGitHubAdapterOptions {
  integration?: GitHubIntegration;
  namespace: string;
  path: string;
}

export function createFactoryGitHubAdapter(options: FactoryGitHubAdapterOptions): FactoryGitHubAdapter {
  const contracts = new AsyncLocalStorage<ExecutionContract>();
  const authority: AuthorityBoundary = {
    async session() {
      const contract = contracts.getStore();
      return {
        authenticated: Boolean(contract),
        principal: contract ? { id: contract.principal, kind: 'service' } : null,
        tenant: contract?.tenantId ? { id: contract.tenantId } : null,
        claims: {},
        capabilities: contract?.capabilities ?? [],
        session: null,
        delegation: null,
      };
    },
    async authorize(capability) {
      const contract = contracts.getStore();
      return Boolean(contract?.github?.capability === capability
        && contract.capabilities.includes(capability));
    },
  };
  const github = options.integration ?? createGitHubIntegration({
    authority,
    felt: {
      mode: 'local',
      namespace: options.namespace,
      path: options.path,
    },
  });

  return {
    async execute(contract) {
      assertContractIntegrity(contract);
      const operation = contract.github;
      if (!operation || contract.execution.mode !== 'integration') {
        throw new Error('Execution contract does not contain an authorized GitHub operation');
      }

      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const result = await contracts.run(contract, async () => {
        const invocation = { applicationId: contract.applicationContract?.id ?? 'software_factory' };
        if (operation.operation === 'repositories.list') {
          return github.repositories.list(
            { connectionId: operation.connectionId, organization: operation.resource.owner },
            invocation,
          );
        }
        if (!operation.resource.pullNumber) {
          throw new Error('GitHub pull request merge requires a pull request number');
        }
        return github.pullRequests.merge(
          {
            connectionId: operation.connectionId,
            owner: operation.resource.owner,
            repository: operation.resource.repository,
            pullNumber: operation.resource.pullNumber,
            method: operation.mergeMethod,
          },
          invocation,
        );
      });
      const completedAtMs = Date.now();
      return {
        evidence: buildGitHubEvidence(contract, result, {
          startedAt,
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
        }),
      };
    },
  };
}
