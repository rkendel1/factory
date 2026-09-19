export type RunStatus =
  | 'accepted'
  | 'authorized'
  | 'allocated'
  | 'preparing'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DeterministicResult = 'PASS' | 'FAIL';
export type JevStatus = 'DRIFT' | 'ALIGNED' | 'UNAVAILABLE';

export interface RepositoryRef {
  provider: string;
  owner: string;
  name: string;
  ref: string;
  commit?: string;
  path?: string;
}

export interface RunRequest {
  workId: string;
  repository: RepositoryRef;
  operation: string;
  idempotencyKey?: string;
}

export interface WorkRecord {
  id: string;
  ownerPrincipal: string;
  operation: string;
  repositoryProvider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryRef: string;
  status: string;
  __version?: number;
}

export interface AuthorizationDecisionRecord {
  id: string;
  runId: string;
  principal: string;
  operation: string;
  decision: 'granted' | 'rejected';
  reason: string;
  createdAt: string;
  __version?: number;
}

export interface ExecutionContract {
  runId: string;
  workId: string;
  principal: string;
  repository: RepositoryRef;
  operation: string;
  capabilities: string[];
  command: string[];
  limits: {
    timeoutMs: number;
  };
  evidence: {
    required: boolean;
  };
}

export interface RunRecord {
  id: string;
  operationId: string;
  operationVersion: number;
  workId: string;
  principal: string;
  operation: string;
  status: RunStatus;
  idempotencyKey: string;
  repository: RepositoryRef;
  authorizationDecisionId?: string;
  contractId?: string;
  evidenceId?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  status: RunStatus;
  detail: string;
  createdAt: string;
}

export interface ExecutionRequestRecord {
  id: string;
  runId: string;
  workId: string;
  operation: string;
  principal: string;
  request: RunRequest;
  createdAt: string;
}

export interface ExecutionContractRecord {
  id: string;
  runId: string;
  principal: string;
  operation: string;
  commandJson: string;
  contract: ExecutionContract;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  path: string;
  kind: string;
  createdAt: string;
}

export interface InvariantEvidence {
  name?: string;
  expected?: string;
  observed?: string;
}

export interface JevEvaluation {
  status: JevStatus;
  explanation?: string;
}

export interface StructuredEvidence {
  id: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  repository: {
    owner: string;
    name: string;
    commit?: string;
  };
  stdout: string;
  stderr: string;
  artifacts: string[];
  deterministicResult: DeterministicResult;
  finalResult: DeterministicResult;
  invariant?: InvariantEvidence;
  jev: JevEvaluation;
  __version?: number;
}

export interface FactoryDBConfig {
  namespace?: string;
  flowPath?: string;
  mode?: 'local' | 'remote';
  serverUrl?: string;
  serverToken?: string;
  environmentId?: string;
  tenantId?: string;
  workingDirectory?: string;
}

export interface FactoryServiceConfig extends FactoryDBConfig {
  repositoryRoot?: string;
  workspaceRoot?: string;
}
