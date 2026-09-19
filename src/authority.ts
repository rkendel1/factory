import type { FlowBlock, FlowSpec, StateFirstDB } from '@feltdb/core';
import { COLLECTIONS } from './felt.js';
import type {
  AuthorizationDecisionRecord,
  ExecutionContract,
  RepositoryRef,
  RunRequest,
  WorkRecord,
} from './types.js';
import { withContractFingerprint } from './contract.js';
import type { AuthenticatedContext } from './auth.js';

interface OperationAuthority {
  name: string;
  operation: string;
  principals: string[];
  mode: 'pax' | 'native';
  command?: string[];
  paxOperation?: string;
  paxTarget?: string;
  timeoutMs: number;
  capabilities: string[];
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

  if (!operation || (!commandJson && mode !== 'pax') || (mode === 'pax' && (!paxOperation || !paxTarget))) {
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
): Promise<AuthorizationResolution> {
  const principal = context.principal;
  const decisionCollection = db.collection<AuthorizationDecisionRecord>(COLLECTIONS.authorizationDecisions);
  const workCollection = db.collection<WorkRecord>(COLLECTIONS.work);
  const createdAt = new Date().toISOString();
  const authorities = getOperationAuthorities(flowSpec);
  const authority = authorities.get(request.operation);

  const reject = async (reason: string): Promise<AuthorizationResolution> => {
    const decision: AuthorizationDecisionRecord = {
      id: runId,
      runId,
      principal,
      tenantId: context.tenant,
      authSession: context.session,
      delegation: context.delegation,
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

  if (!context.boundaryVerified && !authority.principals.includes(principal)) {
    return reject(`principal ${principal} is not delegated in .flow for operation ${request.operation}`);
  }

  const decision: AuthorizationDecisionRecord = {
    id: runId,
    runId,
    principal,
    tenantId: context.tenant,
    authSession: context.session,
    delegation: context.delegation,
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
      repository: {
        provider: work.repositoryProvider,
        owner: work.repositoryOwner,
        name: work.repositoryName,
        ref: work.repositoryRef,
      },
      operation: request.operation,
      capabilities: authority.capabilities,
      execution: {
        mode: authority.mode,
        operation: authority.paxOperation,
        target: authority.paxTarget,
        args: [],
      },
      command: authority.command,
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
