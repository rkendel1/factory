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
  /**
   * Provenance of the AuthBoundry grant behind this decision: the authority
   * basis and the delegation that carried it. Recording both is what lets the
   * durable chain answer which application association authorized a run,
   * rather than only that something did.
   */
  authority?: string;
  delegationId?: string | null;
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
  /**
   * The application context AuthBoundry authorized this principal to act in.
   *
   * It is the authority's answer, not `.flow`'s declaration, and it is required
   * for a Factory service principal: an Action executes in the application the
   * authority named or it does not execute.
   */
  authorizedApplication?: {
    applicationId: string;
    resource: string;
    tenantId: string;
    principalId: string;
    delegationId: string;
  };
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
    packageVersion: '1.0.1';
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
  /** Provider-backed execution, derived server-side; never from the request. */
  provider?: ProviderExecution;
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
  /* Product linkage. One Run concept: the Action's run is the execution run. */
  actionId?: string;
  projectId?: string;
  environmentId?: string;
  applicationId?: string;
  delegationId?: string;
  executionProvider?: string;
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

/* -------------------------------------------------------------------------
 * Factory product model.
 *
 * Desired State is what should be true, an Action is what Factory will do to
 * make it true, a Run is what happened, and Evidence is what proves it. They
 * stay four records because collapsing them loses exactly the questions the
 * product exists to answer.
 * ---------------------------------------------------------------------- */

export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

export interface RepositoryRecord {
  id: string;
  projectId: string;
  tenantId: string;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  repositoryUrl?: string;
  createdAt: string;
  __version?: number;
}

/**
 * What an environment actually looks like, as Factory last observed it.
 *
 * This is written by reconciliation from durable run evidence, never copied
 * from desired state.
 */
export interface EnvironmentCurrentState {
  observedAt: string;
  sourceCommit?: string;
  sourceBranch?: string;
  provider?: string;
  deployment?: 'enabled' | 'disabled';
  health?: 'healthy' | 'unhealthy' | 'unknown';
  reconciledRunId?: string;
  reconciledEvidenceId?: string;
}

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  tenantId: string;
  name: string;
  provider?: string;
  configuration?: Record<string, unknown>;
  currentState?: EnvironmentCurrentState;
  desiredState?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

/** What Factory should keep true. Never implementation steps. */
export interface DesiredStateRecord {
  id: string;
  projectId: string;
  tenantId: string;
  sourceRepositoryId?: string;
  sourceBranch?: string;
  deploymentEnabled?: boolean;
  targetProvider?: string;
  healthRequirement?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

export type ActionStatus =
  | 'planned'
  | 'awaiting-approval'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface ActionPlanStep {
  order: number;
  summary: string;
  detail?: string;
  /** What in the repository or desired state produced this step. */
  basis?: string;
}

export interface RepositoryDiscovery {
  inspectedAt: string;
  repositoryId?: string;
  files: string[];
  signals: {
    packageManager?: string;
    scripts?: string[];
    containerized?: boolean;
    /** The commit the repository is actually at, when it is a git checkout. */
    headCommit?: string;
    flyConfigured?: boolean;
    /** The Fly app fly.toml names, when it names one. */
    flyApp?: string;
    vercelConfigured?: boolean;
    githubWorkflows?: string[];
  };
}

/** The authority context an Action or Run acted under, as AuthBoundry resolved it. */
export interface AuthorityContextRecord {
  application?: string;
  resource?: string;
  tenant?: string;
  principal?: string;
  delegation?: string | null;
  authorizationDecisionId?: string;
  authority?: string;
}

export interface VerificationCheck {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Whether AuthBoundry allows this Action to execute without a person, and why.
 *
 * `allowed: false` is not an error. It is the authority saying a human has to
 * decide, which is what puts the Action in front of one.
 */
export interface AutonomyDecision {
  capability: string;
  allowed: boolean;
  reason: string;
}

export interface ActionRecord {
  id: string;
  projectId: string;
  environmentId?: string;
  tenantId: string;
  type: string;
  intent: string;
  plan: ActionPlanStep[];
  discovery?: RepositoryDiscovery;
  operation?: string;
  executionProvider?: string;
  status: ActionStatus;
  runId?: string;
  verification?: VerificationCheck[];
  authority?: AuthorityContextRecord;
  autonomy?: AutonomyDecision;
  /** How this Action came to exist. Continuous reconciliation says so here. */
  origin?: 'manual' | 'continuous-reconciliation';
  desiredStateRevision?: string;
  observedStateRevision?: string;
  /** Deterministic identity of the drift this Action closes. */
  reconciliationFingerprint?: string;
  /* Operational identity: what is needed, who performs it, on what. */
  capability?: string;
  provider?: string;
  resource?: string;
  /** The capability that must also succeed for this one to count. */
  verificationRequires?: string;
  /* Graph coordination. The Action stays the unit of work. */
  graphId?: string;
  dependsOn?: string[];
  relationships?: ActionRelationship[];
  sequence?: number;
  /** Dependencies that failed or were denied, persisted so a restart still knows. */
  blockedBy?: string[];
  outcome?: ActionOutcome;
  parameters?: Record<string, unknown>;
  retries?: number;
  /** Runs of earlier attempts. Historical Runs are never mutated. */
  previousRunIds?: string[];
  /** The drift this Action exists to close, when reconciliation planned it. */
  drift?: {
    status: string;
    observedAt: string;
    explanation: string[];
    fields: { field: string; label: string; desired: string | null; current: string | null }[];
  };
  /** The person who approved an Action the authority would not run on its own. */
  approvedBy?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

/**
 * Continuous reconciliation of one environment.
 *
 * This record is the whole of the scheduler's state. There is no reconciliation
 * loop that exists only in process memory: a worker asks FeltDB which records
 * are due, and everything it learns is written back here, so a restart resumes
 * rather than starts over and a reader can always say why something happened.
 */
export type ReconciliationStatus =
  | 'enabled'
  | 'disabled'
  | 'running'
  | 'healthy'
  | 'drifted'
  | 'failed';

export interface ReconciliationRecord {
  id: string;
  projectId: string;
  environmentId: string;
  tenantId: string;
  status: ReconciliationStatus;
  /** Human-readable interval, e.g. `15m`. */
  interval: string;
  intervalMs: number;
  enabled: boolean;
  lastObservedAt?: string;
  lastReconciledAt?: string;
  lastActionId?: string;
  lastRunId?: string;
  lastError?: string;
  /** The drift identity of the last pass, used to avoid duplicate work. */
  lastFingerprint?: string;
  lastOutcome?: ReconciliationOutcome;
  nextDueAt?: string;
  /** Claim held by the worker currently running this pass. */
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

/**
 * Why a reconciliation pass ended where it did.
 *
 * These are deliberately not collapsed into one failure: "AuthBoundry said no",
 * "AuthBoundry could not be reached", "a human has to decide", "the run failed"
 * and "the run passed but verification did not" call for different responses,
 * and a single `failed` would hide which one happened.
 */
export type ReconciliationResult =
  | 'converged'
  | 'unobserved'
  | 'drift-detected'
  | 'awaiting-approval'
  | 'autonomy-denied'
  | 'authority-unavailable'
  | 'executed'
  | 'execution-failed'
  | 'verification-failed'
  | 'duplicate-suppressed'
  | 'error';

export interface ReconciliationOutcome {
  result: ReconciliationResult;
  observedAt: string;
  /** Plain sentences explaining what happened, in order. */
  explanation: string[];
  fingerprint?: string;
  desiredStateRevision?: string;
  observedStateRevision?: string;
  actionId?: string;
  graphId?: string;
  runId?: string;
  autonomy?: AutonomyDecision;
  authority?: AuthorityContextRecord;
  evidenceId?: string;
}

/**
 * An operational coordination graph.
 *
 * The graph coordinates Actions; it does not execute them. An Action in a
 * graph is the same Action, run through the same path, producing the same Run
 * and Evidence as one planned alone. The graph only says what must finish
 * before what.
 */
export type ActionGraphStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Where a graph came from. Attn and Eve are referenced, never read: Factory
 * can say "this exists because Attn requested it" without touching Attn's
 * state.
 */
export interface ActionGraphOrigin {
  kind: 'manual' | 'continuous-reconciliation' | 'external';
  sourceSystem?: string;
  sourceType?: string;
  sourceId?: string;
}

export interface ActionGraphRecord {
  id: string;
  tenantId: string;
  projectId: string;
  environmentId?: string;
  origin: ActionGraphOrigin;
  status: ActionGraphStatus;
  requestedBy?: string;
  failure?: { actionId: string; outcome: string; reason: string };
  reconciliationFingerprint?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

export type ActionRelationshipKind = 'depends_on' | 'produces' | 'verifies' | 'replaces' | 'triggered_by';

export interface ActionRelationship {
  kind: ActionRelationshipKind;
  actionId: string;
}

/** How an Action ended, kept apart so nothing is flattened into "failed". */
export type ActionOutcome =
  | 'succeeded'
  | 'capability-unavailable'
  | 'provider-unavailable'
  | 'autonomy-denied'
  | 'authority-unavailable'
  | 'awaiting-approval'
  | 'execution-failed'
  | 'verification-failed'
  | 'cancelled';

/**
 * What a provider adapter hands the execution boundary.
 *
 * `environment` carries non-secret parameters the operation needs. `credentials`
 * names the variables the boundary resolves from its own process at spawn time;
 * their values never enter a contract, an Action, or evidence.
 */
export interface ProviderExecution {
  provider: string;
  capability: string;
  operation: string;
  resource: string;
  environment: Record<string, string>;
  credentials: string[];
  idempotency: { key: string; exactlyOnce: boolean; note?: string };
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
  authorizedApplication?: {
    applicationId: string;
    resource: string;
    tenantId: string;
    principalId: string;
    delegationId: string;
  };
  /** What Factory asked the provider to do, and where. Names only, no values. */
  provider?: {
    id: string;
    capability: string;
    operation: string;
    resource: string;
    parameters: Record<string, string>;
    credentials: string[];
    idempotency: { key: string; exactlyOnce: boolean; note?: string };
  };
  principal?: string;
  tenantId?: string;
  operation?: string;
  appport?: import('./appport.js').AppPortContract;
  ref?: string;
  executionMode?: 'pax' | 'native' | 'integration';
  github?: {
    package: '@rkendel1/github-integration';
    packageVersion: '1.0.1';
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
  authBoundryBrowserCookieSecret?: string;
  authBoundryBrowserAdapter?: import('@authboundry/core/server').BrowserRelyingApplicationAdapter;
  authBoundryTenantId?: string;
  authenticator?: import('./auth.js').Authenticator;
  appportPath?: string;
  /**
   * Operator credential for AuthBoundry's control plane. Provisioning and
   * association verification need it; nothing else in Factory does, and Factory
   * never falls back to local authority when it is absent.
   */
  authBoundryOperatorCredential?: string;
  /** The principal whose authority the Factory application delegation narrows. */
  authBoundryDelegator?: string;
  /**
   * Credential the continuous reconciliation worker presents to AuthBoundry.
   * Absent, Factory runs no autonomous loop.
   */
  factoryServiceCredential?: string;
  reconciliationTickMs?: number;
  /** Provider adapters to register. Defaults to the built-in set. */
  providerAdapters?: readonly import('./adapters.js').ProviderAdapter[];
  authBoundryControlPlane?: import('./provisioning.js').AuthBoundryControlPlane;
  appPortServices?: import('@appport/services').AppPortServices;
  githubIntegration?: import('@rkendel1/github-integration').GitHubIntegration;
}

/* -------------------------------------------------------------------------
 * Operational work requested across the Attn ↔ Factory boundary.
 *
 * One record per request identity (tenant, origin, idempotency key). It
 * remembers what was asked and how Factory translated it; everything about
 * what then happened lives on the Action Graph, its Actions, their Runs and
 * their Evidence. Nothing is duplicated here.
 * ---------------------------------------------------------------------- */

export type OperationalWorkStatus =
  | 'accepted'
  | 'planning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface OperationalWorkPlanStep {
  key: string;
  verb: string;
  capability: string;
  /** Added by Factory's operational rules rather than requested. */
  implied: boolean;
  reason: string;
  dependsOn: string[];
  parameters?: Record<string, string | number | boolean>;
}

export interface OperationalWorkRecord {
  id: string;
  tenantId: string;
  projectId: string;
  environmentId?: string;
  contract: string;
  /** Provenance of the request. Referenced, never dereferenced. */
  origin: { system: string; type: string; id: string };
  idempotencyKey: string;
  /** Hash of the whole request, so a reused key with a different request is refused. */
  requestFingerprint: string;
  requestedBy: string;
  intent?: string;
  requested: { verb: string; target?: string; parameters?: Record<string, string | number | boolean> }[];
  plan: OperationalWorkPlanStep[];
  graphId?: string;
  status: OperationalWorkStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  __version?: number;
}

export type OperationalWorkEventType =
  | 'OperationalWorkAccepted'
  | 'OperationalWorkPlanned'
  | 'OperationalWorkCompleted'
  | 'OperationalWorkFailed'
  | 'OperationalWorkBlocked'
  | 'OperationalWorkCancelled';

/**
 * A durable notice that work changed state, for Attn to read through Factory's
 * API. It carries identifiers and outcomes only: no command, no log, no
 * credential, and nothing Attn would need Factory's database to interpret.
 */
export interface OperationalWorkEventRecord {
  id: string;
  workId: string;
  tenantId: string;
  type: OperationalWorkEventType;
  status: OperationalWorkStatus;
  outcome?: string | null;
  origin: { system: string; type: string; id: string };
  graphId?: string;
  summary?: { completedActions: string[]; blockedActions: string[]; failedActions: string[] };
  createdAt: string;
}
