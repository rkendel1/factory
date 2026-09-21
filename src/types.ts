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

export type DeterministicResult = 'PASS' | 'FAIL' | 'CANCELLED';
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
  github?: {
    pullNumber?: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
  };
}

export interface WorkRecord {
  id: string;
  ownerPrincipal: string;
  tenantId?: string;
  operation: string;
  repositoryProvider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryRef: string;
  status: string;
  githubConnectionId?: string;
  __version?: number;
}

export interface AuthorizationDecisionRecord {
  id: string;
  runId: string;
  principal: string;
  tenantId?: string;
  authSession?: Record<string, unknown> | null;
  delegation?: Record<string, unknown> | null;
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
  tenantId?: string;
  authorizationDecisionId: string;
  fingerprint: string;
  applicationContract?: {
    id: string;
    version: string;
    fingerprint: string;
  };
  appBoundry?: {
    contractFingerprint: string;
    executionMode: 'pax' | 'native' | 'integration';
    permissions: string[];
  };
  repository: RepositoryRef;
  operation: string;
  capabilities: string[];
  appport?: import('./appport.js').AppPortContract;
  execution: {
    mode: 'pax' | 'native' | 'integration';
    operation?: string;
    target?: string;
    args: string[];
  };
  github?: {
    package: '@rkendel1/github-integration';
    packageVersion: '1.0.0';
    connectionId: string;
    operation: 'repositories.list' | 'pull_request.merge';
    capability: 'github.repository.read' | 'github.pull_request.merge';
    resource: {
      owner: string;
      repository: string;
      identifier: string;
      pullNumber?: number;
    };
    mergeMethod?: 'merge' | 'squash' | 'rebase';
  };
  command?: string[];
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
  tenantId?: string;
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
  tenantId?: string;
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
  fingerprint: string;
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
  requestId?: string;
  contractId?: string;
  contractFingerprint: string;
  applicationContractFingerprint?: string;
  principal?: string;
  tenantId?: string;
  operation?: string;
  appport?: import('./appport.js').AppPortContract;
  ref?: string;
  executionMode?: 'pax' | 'native' | 'integration';
  github?: {
    package: '@rkendel1/github-integration';
    packageVersion: '1.0.0';
    connectionId: string;
    operation: 'repositories.list' | 'pull_request.merge';
    capability: 'github.repository.read' | 'github.pull_request.merge';
    resource: {
      owner: string;
      repository: string;
      identifier: string;
      pullNumber?: number;
    };
    result?: unknown;
  };
  authorizationDecisionId: string;
  authorizationDecision: 'granted' | 'rejected';
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
  pax?: {
    version: string;
    operation: string;
    target?: string;
    args: string[];
    invocation: string[];
  };
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
  paxExecutable?: string;
  authBoundryUrl?: string;
  authenticator?: import('./auth.js').Authenticator;
  githubIntegration?: import('@rkendel1/github-integration').GitHubIntegration;
}
