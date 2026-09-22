import type { FlowBlock, FlowSpec, StateFirstDB } from '@feltdb/core';
import { COLLECTIONS } from './felt.js';
import type {
  AuthorizationDecisionRecord,
  ExecutionContract,
  ProviderExecution,
  RepositoryRef,
  RunRequest,
  WorkRecord,
} from './types.js';
import { withContractFingerprint } from './contract.js';
import type { AuthenticatedContext } from './auth.js';
import { createCanonicalApplicationContract } from './application-contract.js';
import type { AuthorizedApplicationContext, FactoryAssociation } from './association.js';
import { isFactoryAgentPrincipal } from './association.js';

export interface OperationAuthority {
  name: string;
  operation: string;
  principals: string[];
  mode: 'pax' | 'native' | 'integration';
  command?: string[];
  paxOperation?: string;
  paxTarget?: string;
  timeoutMs: number;
  capabilities: string[];
  appportOperation?: string;
  appportService?: string;
  appportCapability?: string;
  integration?: string;
  githubOperation?: string;
  /** Which provider implementation performs this operation. */
  provider?: string;
  /** The neutral operational capability this operation fulfils. */
  operationalCapability?: string;
}

export interface AuthorizationResolution {
  allowed: boolean;
  reason: string;
  decision: AuthorizationDecisionRecord;
  contract?: ExecutionContract;
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

function parseOperationAuthority(block: FlowBlock): OperationAuthority | null {
  const operation = statementValue(block, 'operation ');
  const commandJson = statementValue(block, 'command ');
  const mode = statementValue(block, 'execution_mode ') as OperationAuthority['mode'] | undefined;
  const paxOperation = statementValue(block, 'pax_operation ');
  const paxTarget = statementValue(block, 'pax_target ');
  const appportOperation = statementValue(block, 'appport_operation ');
  const appportService = statementValue(block, 'appport_service ');
  const appportCapability = statementValue(block, 'appport_capability ');
  const integration = statementValue(block, 'integration ');
  const githubOperation = statementValue(block, 'github_operation ');

  if (!operation
    || (!commandJson && mode !== 'pax' && mode !== 'integration')
    || (mode === 'pax' && (!paxOperation || !paxTarget))
    || (mode === 'integration' && (!integration || !githubOperation))) {
    return null;
  }

  const command = commandJson ? JSON.parse(commandJson) as string[] : undefined;
  return {
    name: block.name,
    operation,
    principals: statementValues(block, 'principal '),
    mode: mode ?? 'native',
    command,
    paxOperation,
    paxTarget,
    timeoutMs: Number(statementValue(block, 'timeoutMs ') ?? 60000),
    capabilities: statementValues(block, 'grant '),
    appportOperation,
    appportService,
    appportCapability,
    integration,
    githubOperation,
    provider: statementValue(block, 'provider '),
    operationalCapability: statementValue(block, 'operational_capability '),
  };
}

export function getOperationAuthorities(flowSpec: FlowSpec): Map<string, OperationAuthority> {
  const authorities = new Map<string, OperationAuthority>();

  for (const block of flowSpec.capabilities) {
    const parsed = parseOperationAuthority(block);
    if (!parsed) {
      continue;
    }

    const existing = authorities.get(parsed.operation);
    if (existing) {
      throw new Error(`Duplicate .flow authority for operation ${parsed.operation} is not allowed`);
    }

    authorities.set(parsed.operation, parsed);
  }

  return authorities;
}

function repositoriesMatch(work: WorkRecord, repository: RepositoryRef): boolean {
  return work.repositoryProvider === repository.provider
    && work.repositoryOwner === repository.owner
    && work.repositoryName === repository.name
    && work.repositoryRef === repository.ref;
}

export async function authorizeExecution(
  db: StateFirstDB,
  flowSpec: FlowSpec,
  context: AuthenticatedContext,
  request: RunRequest,
  runId: string,
  applicationAuthority?: {
    association: FactoryAssociation;
    authorized: AuthorizedApplicationContext | null;
  },
  providerExecution?: ProviderExecution,
): Promise<AuthorizationResolution> {
  const principal = context.principal;
  const decisionCollection = db.collection<AuthorizationDecisionRecord>(COLLECTIONS.authorizationDecisions);
  const workCollection = db.collection<WorkRecord>(COLLECTIONS.work);
  const createdAt = new Date().toISOString();
  const authorities = getOperationAuthorities(flowSpec);
  const authority = authorities.get(request.operation);
  const application = createCanonicalApplicationContract(flowSpec);

  const grantProvenance = {
    ...(context.authority === undefined ? {} : { authority: context.authority }),
    ...(context.delegationId === undefined ? {} : { delegationId: context.delegationId }),
  };

  const reject = async (reason: string): Promise<AuthorizationResolution> => {
    const decision: AuthorizationDecisionRecord = {
      id: runId,
      runId,
      principal,
      tenantId: context.tenant,
      authSession: context.session,
      delegation: context.delegation,
      ...grantProvenance,
      operation: request.operation,
      decision: 'rejected',
      reason,
      createdAt,
    };
    await decisionCollection.put(decision, decision.id);
    return { allowed: false, reason, decision };
  };

  if (!authority) {
    return reject('missing .flow authority for requested operation');
  }

  if (request.github && authority.integration !== 'github') {
    return reject('GitHub parameters are not authorized for the requested operation');
  }
  if (authority.githubOperation === 'repositories.list' && request.github) {
    return reject('repositories.list does not accept caller-defined GitHub operation parameters');
  }

  const work = await workCollection.get(request.workId);
  if (!work) {
    return reject('missing FeltDB work state for requested workId');
  }

  if (work.status !== 'active') {
    return reject(`work ${request.workId} is not active`);
  }

  if (context.boundaryVerified && (!work.tenantId || work.tenantId !== context.tenant)) {
    return reject(`tenant ${context.tenant} is not authorized for work ${request.workId}`);
  }

  if (work.ownerPrincipal !== principal) {
    return reject(`principal ${principal} does not own work ${request.workId}`);
  }

  if (work.operation !== request.operation) {
    return reject(`work ${request.workId} is not authorized for operation ${request.operation}`);
  }

  if (!repositoriesMatch(work, request.repository)) {
    return reject('requested repository does not match authoritative work repository');
  }

  if (authority.mode === 'integration' && authority.integration === 'github' && !work.githubConnectionId) {
    return reject(`work ${request.workId} does not reference a GitHub connection`);
  }

  const requiredGitHubCapability = authority.githubOperation === 'repositories.list'
    ? 'github.repository.read'
    : authority.githubOperation === 'pull_request.merge'
      ? 'github.pull_request.merge'
      : undefined;
  if (authority.integration === 'github'
    && (!requiredGitHubCapability
      || authority.appportCapability !== requiredGitHubCapability
      || !authority.capabilities.includes(requiredGitHubCapability))) {
    return reject(`GitHub operation ${authority.githubOperation ?? 'unknown'} lacks its required .flow capability`);
  }
  if (context.boundaryVerified && requiredGitHubCapability
    && !context.authorizedCapabilities?.includes(requiredGitHubCapability)) {
    return reject(`AuthBoundry did not authorize ${requiredGitHubCapability}`);
  }

  if (authority.githubOperation === 'pull_request.merge'
    && (!Number.isInteger(request.github?.pullNumber) || (request.github?.pullNumber ?? 0) < 1)) {
    return reject('pull_request.merge requires a positive pullNumber');
  }

  if (!context.boundaryVerified && !authority.principals.includes(principal)) {
    return reject(`principal ${principal} is not delegated in .flow for operation ${request.operation}`);
  }

  /*
   * The application an Action executes in is the one AuthBoundry authorized.
   *
   * `.flow` declares which application Factory *is*; that declaration is a
   * contract identity, not a grant, so it cannot stand in for the authority's
   * answer. A Factory service principal therefore executes only inside a
   * resolved application context, and only when the authority's context and the
   * declared contract name the same application.
   */
  const authorizedApplication = applicationAuthority?.authorized ?? null;
  if (applicationAuthority && isFactoryAgentPrincipal(principal, applicationAuthority.association)) {
    if (!authorizedApplication) {
      return reject(`AuthBoundry authorized no application context for ${principal}`);
    }
    if (authorizedApplication.tenantId !== context.tenant) {
      return reject(`the authorized application context is not held in tenant ${context.tenant}`);
    }
    if (authorizedApplication.applicationId !== application.authorization.applicationId) {
      return reject(
        `AuthBoundry authorized application ${authorizedApplication.applicationId}, not ${application.authorization.applicationId}`,
      );
    }
  }

  const decision: AuthorizationDecisionRecord = {
    id: runId,
    runId,
    principal,
    tenantId: context.tenant,
    authSession: context.session,
    delegation: context.delegation,
    ...grantProvenance,
    operation: request.operation,
    decision: 'granted',
    reason: 'authorized by .flow capability and FeltDB work state',
    createdAt,
  };
  await decisionCollection.put(decision, decision.id);

  const contract = {
      runId,
      workId: request.workId,
      principal,
      tenantId: context.tenant,
      authorizationDecisionId: decision.id,
      ...(authorizedApplication ? {
        authorizedApplication: {
          applicationId: authorizedApplication.applicationId,
          resource: authorizedApplication.resource,
          tenantId: authorizedApplication.tenantId,
          principalId: authorizedApplication.principalId,
          delegationId: authorizedApplication.delegationId,
        },
      } : {}),
      applicationContract: {
        id: application.identity.id,
        version: application.identity.version,
        fingerprint: application.fingerprint,
      },
      appBoundry: {
        contractFingerprint: application.appBoundry.contractFingerprint,
        executionMode: authority.mode,
        permissions: authority.capabilities,
      },
      repository: {
        provider: work.repositoryProvider,
        owner: work.repositoryOwner,
        name: work.repositoryName,
        ref: work.repositoryRef,
        // The revision the Action asked to reach; recorded as requested, and
        // reality is whatever the checkout then reports.
        ...(request.repository.commit ? { commit: request.repository.commit } : {}),
      },
      operation: request.operation,
      capabilities: authority.capabilities,
      appport: {
        protocol: 'appport' as const,
        applicationId: application.identity.id,
        applicationVersion: application.identity.version,
        applicationFingerprint: application.fingerprint,
        operation: authority.appportOperation ?? request.operation,
        service: authority.appportService ?? 'execution',
        capability: authority.appportCapability ?? authority.capabilities[0] ?? 'execution.run',
      },
      execution: {
        mode: authority.mode,
        operation: authority.paxOperation,
        target: authority.paxTarget,
        args: [],
      },
      ...(authority.integration === 'github' ? {
        github: {
          package: '@rkendel1/github-integration' as const,
          packageVersion: '1.0.1' as const,
          connectionId: work.githubConnectionId!,
          operation: authority.githubOperation as 'repositories.list' | 'pull_request.merge',
          capability: authority.appportCapability as 'github.repository.read' | 'github.pull_request.merge',
          resource: {
            owner: work.repositoryOwner,
            repository: work.repositoryName,
            identifier: authority.githubOperation === 'pull_request.merge'
              ? String(request.github?.pullNumber)
              : work.repositoryOwner,
            ...(request.github?.pullNumber ? { pullNumber: request.github.pullNumber } : {}),
          },
          ...(request.github?.mergeMethod ? { mergeMethod: request.github.mergeMethod } : {}),
        },
      } : {}),
      command: authority.command,
      ...(providerExecution ? { provider: providerExecution } : {}),
      limits: { timeoutMs: authority.timeoutMs },
      evidence: { required: true },
    };

  return {
    allowed: true,
    reason: decision.reason,
    decision,
    contract: withContractFingerprint(contract),
  };
}
