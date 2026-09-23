import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadFactoryFlow, createFactoryDB, COLLECTIONS } from './felt.js';
import { authorizeExecution, getOperationAuthorities } from './authority.js';
import { buildFailureEvidence } from './evidence.js';
import { CredentialUnavailableError, executeContract, processCredentialResolver, SpawnFailedError, verifyPax, type CredentialResolver, type ExecutionHandle } from './execution.js';
import { assertContractIntegrity } from './contract.js';
import {
  createFactoryBrowserAdapter,
  createAuthBoundryAuthenticator,
  createServiceSession,
  factoryReturnPath,
  FACTORY_BROWSER_APPLICATION_ID,
  FACTORY_BROWSER_CALLBACK_PATH,
  AuthBoundryAuthenticationError,
  AuthBoundryAuthorizationError,
  type AuthenticatedContext,
  type Authenticator,
  type CapabilityProbe,
} from './auth.js';
import { BrowserAdapterError, type BrowserRedirectResult } from '@authboundry/core/server';
import { createAppPortAdapter, type FactoryAppPortAdapter } from './appport.js';
import { createCanonicalApplicationContract } from './application-contract.js';
import { createFactoryGitHubAdapter, type FactoryGitHubAdapter } from './integrations/github.js';
import { DomainValidationError, FactoryDomain } from './domain.js';
import { handleProductRoute, matchProductRoute } from './product-api.js';
import {
  actionPage,
  actionsPage,
  graphPage,
  graphsPage,
  overviewPage,
  projectPage,
  projectsPage,
  providersPage,
  runPage,
  runsPage,
  settingsPage,
  workListPage,
  workPage,
} from './product-ui.js';
import { discoverRepository, planFromDiscovery } from './discovery.js';
import { repositoryRemoteUrl, verifyRepositoryConnection } from './repository-connection.js';
import { executionProviders, providerForOperation, type ExecutionProvider } from './providers.js';
import { createReconciliationScheduler, type SchedulerHandle } from './scheduler.js';
import {
  interpretOperation,
  observeEnvironmentLive,
  planOperation,
  providerExecution,
  ProviderRegistry,
  resolveProvider,
  verifyOperation,
  type ProviderContext,
  type ProviderResolution,
  type ResourceBinding,
} from './adapters.js';
import { capabilityResourceKind, isOperationalCapability, OPERATIONAL_CAPABILITIES, REQUIRED_VERIFICATION, type OperationalCapability } from './capabilities.js';
import {
  blockingDependencies,
  graphStatus,
  GraphValidationError,
  nodeStatus,
  orderPlan,
  runnableActions,
  type PlannedAction,
} from './graph.js';
import { compareReality, observeEnvironment, reconciledState, type DriftReport } from './reality.js';
import {
  describeSchedule,
  desiredStateRevision,
  IntervalError,
  nextDueAt,
  observedStateRevision,
  parseInterval,
  reconciliationFingerprint,
} from './reconciliation.js';
import {
  assertFactoryAssociation,
  authorizedApplicationContext,
  AUTONOMOUS_EXECUTION_CAPABILITY,
  factoryAssociation,
  FactoryAssociationError,
  type FactoryAssociation,
  type FactoryConnectionState,
} from './association.js';
import {
  createAuthBoundryControlPlane,
  provisionFactoryAssociation,
  resolveFactoryAssociation,
  type AuthBoundryControlPlane,
} from './provisioning.js';
import {
  FACTORY_REQUIRED_CAPABILITIES,
  reconcileFactoryAuthority,
  type FactoryAuthorityHealth,
  type FactoryAuthorityReconciliation,
} from './authority-reconciliation.js';
import {
  createFactoryAppPortServices,
  resolveAppPortServicesDeployment,
  type FactoryAppPortServices,
} from './appport-services.js';
import { composeProductUi, factoryUiContribution, factoryUiContributor, type UiContributor } from './ui.js';
import type { AppPortUiContext, ComposedUi } from '@appport/client';
import { filterUiContribution, type AppRequest, type AppResponse, type UiDiscoveryDocument } from '@appport/protocol';
import { AppPortApplication, permissionAuthorizer } from '@appport/sdk';
import {
  OPERATIONAL_WORK_TERMINAL_EVENTS,
  operationalWorkCapability,
  operationalWorkFingerprint,
  operationalWorkId,
  operationalWorkResult,
  operationalWorkStatus,
  OperationalWorkConflictError,
  OperationalWorkRequestError,
  parseOperationalWorkRequest,
  plannedActions,
  planOperationalWork,
  toAppPortError,
  type OperationalWorkResult,
} from './operational-work.js';
import {
  formatDeploymentConfigDiagnostics,
  readDeploymentConfig,
  resolveRemoteAuthorityBootstrap,
  validateDeploymentConfig,
} from './bootstrap.js';
import type {
  ActionCancellation,
  ActionFailurePhase,
  ActionGraphOrigin,
  ActionGraphRecord,
  ExecutionCheckpoint,
  OperationalWorkRecord,
  OperationalWorkStatus,
  ActionOutcome,
  ActionRecord,
  ProviderExecution,
  ProviderExecutionResult,
  AuthorityContextRecord,
  AutonomyDecision,
  ReconciliationOutcome,
  ReconciliationRecord,
  ReconciliationResult,
  ReconciliationRetryState,
  EnvironmentObservation,
  EnvironmentRecord,
  ExecutionContractRecord,
  ExecutionRequestRecord,
  RepositoryDiscovery,
  RepositoryRecord,
  VerificationCheck,
  FactoryServiceConfig,
  RunEventRecord,
  RunRecord,
  DesiredStateRecord,
  RunRequest,
  StructuredEvidence,
  WorkRecord,
} from './types.js';

/** Namespaced AppPort extension carrying Factory's own invocation token. */
const INVOCATION_EXTENSION = 'factory.invocation';

function isTerminal(status: RunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

const requestKeys = new Set(['workId', 'repository', 'operation', 'idempotencyKey', 'github']);
const repositoryKeys = new Set(['provider', 'owner', 'name', 'ref', 'commit', 'url']);
const githubKeys = new Set(['pullNumber', 'mergeMethod']);
const validTransitions: Record<RunRecord['status'], RunRecord['status'][]> = {
  accepted: ['authorized', 'failed', 'cancelled'],
  authorized: ['allocated', 'failed', 'cancelled'],
  allocated: ['preparing', 'failed', 'cancelled'],
  preparing: ['executing', 'failed', 'cancelled'],
  executing: ['verifying', 'completed', 'failed', 'cancelled', 'unknown'],
  verifying: ['completed', 'failed', 'cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  // Reality resolves an unknown run; a retry resolves it by superseding it.
  unknown: ['completed', 'failed', 'cancelled'],
};

function validateRunRequest(request: RunRequest): void {
  if (!request || typeof request !== 'object') {
    throw new Error('Invalid run request');
  }
  const unexpected = Object.keys(request as object).filter((key) => !requestKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Execution fields are not accepted in a run request: ${unexpected.join(', ')}`);
  }
  if (typeof request.workId !== 'string' || typeof request.operation !== 'string' || !request.repository) {
    throw new Error('Run request requires workId, operation, and repository');
  }
  const repositoryUnexpected = Object.keys(request.repository as object).filter((key) => !repositoryKeys.has(key));
  if (repositoryUnexpected.length > 0) {
    throw new Error(`Repository fields are not accepted in a run request: ${repositoryUnexpected.join(', ')}`);
  }
  const githubUnexpected = request.github
    ? Object.keys(request.github).filter((key) => !githubKeys.has(key))
    : [];
  if (githubUnexpected.length > 0) {
    throw new Error(`GitHub execution fields are not accepted in a run request: ${githubUnexpected.join(', ')}`);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body, null, 2));
}

function writeAuthError(response: ServerResponse, error: unknown): void {
  if (error instanceof FactoryAssociationError) {
    writeJson(response, 403, { error: error.message, code: 'FORBIDDEN', reason: error.reason });
    return;
  }
  if (error instanceof AuthBoundryAuthorizationError) {
    writeJson(response, 403, { error: error.message, code: 'FORBIDDEN' });
    return;
  }
  const message = error instanceof AuthBoundryAuthenticationError
    ? error.message
    : 'AuthBoundry authentication failed';
  writeJson(response, 401, { error: message, code: 'UNAUTHENTICATED' });
}

function writeBrowserRedirect(response: ServerResponse, result: BrowserRedirectResult): void {
  response.writeHead(302, { location: result.redirectTo, 'set-cookie': result.setCookies });
  response.end();
}

function isAuthorityUnavailable(reason: string | undefined): boolean {
  return /unavailable|unreachable|could not|no AuthBoundry session/i.test(reason ?? '');
}

/**
 * How a pass's result reads on the reconciliation record.
 *
 * Several distinct results share the `drifted` status because the environment
 * really is drifted in all of them; the result on the outcome says which one,
 * so the distinction is never lost.
 */
const RECONCILIATION_STATUS: Record<ReconciliationResult, ReconciliationRecord['status']> = {
  converged: 'healthy',
  executed: 'healthy',
  unobserved: 'enabled',
  // Not seeing the environment is not the environment being wrong.
  unavailable: 'enabled',
  'drift-detected': 'drifted',
  'awaiting-approval': 'drifted',
  'autonomy-denied': 'drifted',
  'duplicate-suppressed': 'drifted',
  executing: 'drifted',
  unknown: 'drifted',
  'retry-suspended': 'drifted',
  'authority-unavailable': 'failed',
  'execution-failed': 'failed',
  'verification-failed': 'failed',
  'provider-unavailable': 'failed',
  error: 'failed',
};

/** Failures of the same drift back off: interval × 2^attempt, capped, then suspended. */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_MAX_BACKOFF_MS = 24 * 60 * 60_000;
const RETRYABLE: ReadonlySet<ReconciliationResult> = new Set(['execution-failed', 'verification-failed', 'provider-unavailable', 'error']);

export class FactoryService {
  private readonly flowSpec;

  private readonly activeExecutions = new Map<string, ExecutionHandle>();
  private readonly appPort: FactoryAppPortAdapter;
  private readonly appPortServices: FactoryAppPortServices;
  private readonly github: FactoryGitHubAdapter;
  private readonly uiContributors: readonly UiContributor[];
  private readonly applicationId: string;
  private readonly environmentId: string;
  private readonly association: FactoryAssociation;
  private readonly domain: FactoryDomain;
  private readonly registry: ProviderRegistry;
  /** Resolves credential values by name, inside the execution boundary only. */
  private readonly credentialResolver: CredentialResolver;
  /** This worker's durable identity in Run ownership. */
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly controlPlane: AuthBoundryControlPlane | null;
  private authorityReconciliation: FactoryAuthorityReconciliation | null = null;
  /**
   * The AppPort runtime for capabilities other systems call on Factory. Attn
   * reaches the operational work contract through it, over the same protocol
   * as every other AppPort application, with the caller already authenticated
   * by AuthBoundry before any envelope is opened.
   */
  private readonly appPortRuntime: AppPortApplication;
  private readonly invocations = new Map<string, { context: AuthenticatedContext; probe?: CapabilityProbe }>();
  private connection: FactoryConnectionState = {
    status: 'unverified',
    reason: 'the Factory application association has not been checked yet',
  };
  private paxVersion?: string;
  private scheduler: SchedulerHandle | null = null;
  private shuttingDown = false;

  private constructor(
    private readonly config: FactoryServiceConfig,
    private readonly db: Awaited<ReturnType<typeof createFactoryDB>>,
  ) {
    this.flowSpec = loadFactoryFlow(config.flowPath);
    const application = createCanonicalApplicationContract(this.flowSpec);
    this.applicationId = application.identity.id;
    this.environmentId = config.environmentId ?? (config.mode === 'remote' ? 'production' : 'development');
    this.appPort = createAppPortAdapter({
      application,
    });
    this.association = factoryAssociation(this.flowSpec);
    this.domain = new FactoryDomain(db);
    this.appPortRuntime = new AppPortApplication({
      application: { id: application.identity.id, name: application.identity.name, version: application.identity.version },
      capabilities: [operationalWorkCapability(async (input, capabilityContext) => {
        // The authenticated context is found by a token Factory itself put on
        // the envelope, never by the caller's requestId, which two callers
        // may share.
        const token = capabilityContext.extensions[INVOCATION_EXTENSION];
        const invocation = typeof token === 'string' ? this.invocations.get(token) : undefined;
        if (!invocation) throw new AuthBoundryAuthenticationError('AppPort request has no authenticated Factory context');
        try {
          return (await this.createOperationalWork(invocation.context, input, invocation.probe)).result;
        } catch (error) {
          return toAppPortError(error, capabilityContext);
        }
      })],
      authorizer: permissionAuthorizer(),
      mode: 'production',
      builtins: false,
    });
    this.registry = new ProviderRegistry(this.flowSpec, config.providerAdapters);
    this.credentialResolver = config.credentialResolver ?? processCredentialResolver;
    this.workerId = config.workerId ?? `worker_${process.pid}_${randomUUID().slice(0, 8)}`;
    this.leaseMs = Math.max(1000, config.executionLeaseMs ?? 60_000);
    this.controlPlane = config.authBoundryControlPlane
      ?? ((config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL)
        && (config.factoryServiceCredential ?? process.env.FACTORY_SERVICE_CREDENTIAL)
        ? createAuthBoundryControlPlane({
            baseUrl: (config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL)!,
            serviceCredential: (config.factoryServiceCredential
              ?? process.env.FACTORY_SERVICE_CREDENTIAL)!,
            ...((config.authBoundryOperatorCredential ?? process.env.AUTHBOUNDRY_OPERATOR_CREDENTIAL)
              ? { operatorCredential: (config.authBoundryOperatorCredential
                  ?? process.env.AUTHBOUNDRY_OPERATOR_CREDENTIAL)! }
              : {}),
          })
        : null);
    this.appPortServices = createFactoryAppPortServices({
      ...(config.appPortServices ? { services: config.appPortServices } : {}),
      deployment: resolveAppPortServicesDeployment({
        mode: config.mode === 'remote' ? 'remote' : 'local',
        namespace: `${config.namespace ?? 'software-factory'}-appport-services`,
        environment: this.environmentId,
        serverUrl: config.serverUrl,
        serverToken: config.serverToken,
        path: config.appportPath ?? `${config.workingDirectory ?? process.cwd()}/appport-services`,
      }),
      authenticator: () => this.boundAuthenticator(),
      applicationId: application.identity.id,
      environment: this.environmentId,
    });
    this.uiContributors = [factoryUiContributor, this.appPortServices.ui];
    this.github = createFactoryGitHubAdapter({
      integration: config.githubIntegration,
      namespace: `${config.namespace ?? 'software-factory'}-github`,
      path: `${config.workingDirectory ?? process.cwd()}/github-integration`,
    });
  }

  /**
   * Every protected operation passes through here, so the association is
   * enforced once rather than at each call site.
   *
   * AuthBoundry stays the authority: Factory adds no capability and reverses no
   * denial. It only refuses to let one of its own service principals act on a
   * grant that did not come from the Factory application association.
   */
  private boundAuthenticator(): Authenticator {
    const delegate = this.config.authenticator ?? createAuthBoundryAuthenticator(this.config);
    const verified = () => this.connection.status === 'associated' ? this.connection.association : null;
    return {
      ...(delegate.session ? { session: (request) => delegate.session!(request) } : {}),
      authenticate: async (request, operation) => {
        const context = await delegate.authenticate(request, operation);
        assertFactoryAssociation(
          { principal: context.principal, tenant: context.tenant },
          this.association,
          verified(),
        );
        return context;
      },
    };
  }

  authenticator(): Authenticator {
    return this.boundAuthenticator();
  }

  /**
   * Record the Factory application association in AuthBoundry, then keep only
   * what AuthBoundry reports back.
   *
   * Safe to run on every boot: provisioning reads before it writes, and the
   * delegation id is derived from the tenant, application, and agent, so a
   * restart or redeployment re-asserts one association instead of adding
   * another.
   */
  async provisionAuthority(): Promise<FactoryConnectionState> {
    return this.resolveAuthority(true);
  }

  /**
   * Re-read the association without changing it. This is what the connection
   * endpoint reports: AuthBoundry's answer, never Factory's configuration.
   */
  async refreshConnection(): Promise<FactoryConnectionState> {
    return this.resolveAuthority(false);
  }

  private async resolveAuthority(register: boolean): Promise<FactoryConnectionState> {
    if (!this.controlPlane) {
      this.connection = {
        status: 'unverified',
        reason: 'no AuthBoundry operator credential is configured for control-plane access',
      };
      return this.connection;
    }
    const tenantId = this.config.authBoundryTenantId ?? this.config.tenantId ?? 'default';
    if (this.controlPlane.listProjects) {
      try {
        this.authorityReconciliation = await reconcileFactoryAuthority({
          controlPlane: this.controlPlane,
          db: this.db,
          tenantId,
          serviceCredentialPresent: Boolean(
            this.config.factoryServiceCredential ?? process.env.FACTORY_SERVICE_CREDENTIAL,
          ),
          semanticDecisions: this.config.mode === 'remote',
        });
        this.connection = this.authorityReconciliation.association
          && this.authorityReconciliation.health.reconciliation.healthy
          ? { status: 'associated', association: this.authorityReconciliation.association }
          : {
              status: this.authorityReconciliation.health.authBoundry.reachable ? 'unassociated' : 'unverified',
              reason: this.authorityReconciliation.health.reconciliation.reason
                ?? 'Factory authority reconciliation is incomplete',
            };
      } catch (error) {
        this.connection = {
          status: 'unverified',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      return this.connection;
    }
    const request = { controlPlane: this.controlPlane, association: this.association, tenantId };
    try {
      const resolved = register
        ? await provisionFactoryAssociation(request)
        : await resolveFactoryAssociation(request);
      this.connection = resolved.association
        ? { status: 'associated', association: resolved.association }
        : {
            status: 'unassociated',
            reason: resolved.reason
              ?? `AuthBoundry holds no ${this.association.applicationId} application association in tenant ${tenantId}`,
          };
    } catch (error) {
      this.connection = {
        status: 'unverified',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return this.connection;
  }

  /** The product model store. Every read is tenant- and project-scoped. */
  projects(): FactoryDomain {
    return this.domain;
  }

  providers(): ExecutionProvider[] {
    return executionProviders(this.flowSpec, {
      ...(this.paxVersion ? { paxVersion: this.paxVersion } : {}),
      githubConfigured: Boolean(this.config.githubIntegration),
    });
  }

  /**
   * The authority context an Action or Run acts under, as AuthBoundry resolved
   * it. There is no manufactured fallback: an unassociated or unverified
   * authority yields no context, and the caller fails closed on it.
   */
  authorityContext(context: AuthenticatedContext): AuthorityContextRecord | null {
    const authorized = authorizedApplicationContext(
      this.connection.status === 'associated' ? this.connection.association : null,
      context.principal,
    );
    if (!authorized) return null;
    return {
      application: authorized.applicationId,
      resource: authorized.resource,
      tenant: authorized.tenantId,
      principal: authorized.principalId,
      delegation: authorized.delegationId,
      ...(context.authority ? { authority: context.authority } : {}),
    };
  }

  /**
   * Observe what an environment actually looks like and compare it with what
   * desired state says it should.
   *
   * Nothing here changes anything. Reality is read from the repository and from
   * the durable evidence of the runs that reconciled this environment, so the
   * same answer is available to anyone reading FeltDB.
   */
  async observeReality(context: AuthenticatedContext, projectId: string): Promise<DriftReport[]> {
    const tenantId = context.tenant;
    const project = await this.domain.getProject(tenantId, projectId);
    if (!project) throw new DomainValidationError(`project ${projectId} was not found`);

    const [environments, repositories, desiredState] = await Promise.all([
      this.domain.listEnvironments(tenantId, projectId),
      this.domain.listRepositories(tenantId, projectId),
      this.domain.getDesiredState(tenantId, projectId),
    ]);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId)
      ?? repositories[0] ?? null;
    const discovery = await this.discover(repository);

    return environments.map((environment) => compareReality({
      project,
      environment,
      desiredState,
      repository,
      discovery,
      current: observeEnvironment(environment),
    }));
  }

  /**
   * Turn observed drift into an Action that explains itself.
   *
   * The Action's intent is the drift, in the words the comparison produced, so
   * a reviewer reads why Factory wants to act before reading what it will do.
   * An environment that already matches produces no Action: reconciliation is
   * the absence of work, not a run that confirms nothing changed.
   */
  async planReconciliation(
    context: AuthenticatedContext,
    projectId: string,
    environmentId: string,
    options: { operation?: string; probe?: CapabilityProbe } = {},
  ): Promise<{ drift: DriftReport; action: ActionRecord | null }> {
    const reports = await this.observeReality(context, projectId);
    const drift = reports.find((report) => report.environmentId === environmentId);
    if (!drift) throw new DomainValidationError(`environment ${environmentId} was not found`);
    if (drift.status !== 'drifted' || !drift.proposal) {
      return { drift, action: null };
    }

    const action = await this.createAction(context, projectId, {
      type: options.operation ?? 'repo-echo',
      intent: drift.proposal.intent,
      environmentId,
      ...(options.operation ? { operation: options.operation } : {}),
    }, options.probe);

    const explained = await this.domain.patchAction(context.tenant, action.id, {
      drift: {
        status: drift.status,
        observedAt: drift.observedAt,
        explanation: drift.explanation,
        fields: drift.fields.filter((field) => field.drifted),
      },
    });
    return { drift, action: explained ?? action };
  }

  /**
   * Record what a run made true, so the next observation reads reality.
   *
   * Current state is written from the run's durable evidence and never copied
   * from desired state: an environment that reports what was wanted rather than
   * what happened could never drift again.
   */
  private async recordReconciledState(
    tenantId: string,
    projectId: string,
    environmentId: string,
    runId: string,
    verification: readonly VerificationCheck[] = [],
  ): Promise<void> {
    const environment = await this.domain.getEnvironment(tenantId, projectId, environmentId);
    const run = await this.domain.getRun(tenantId, runId);
    if (!environment || !run || run.status !== 'completed') return;
    const evidence = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
    await this.domain.setEnvironmentState(tenantId, projectId, environmentId, reconciledState({
      environment,
      run,
      evidence: evidence ?? null,
      desiredState: await this.domain.getDesiredState(tenantId, projectId),
      verification,
    }));
  }

  /**
   * One reconciliation pass over one environment.
   *
   * This is the whole engine, and the manual "Reconcile Now" button and the
   * scheduler both call exactly this: a manual pass is not a shortcut past the
   * comparison, it is the same comparison run sooner.
   *
   * The pass is safe to repeat. A converged environment plans nothing, an
   * unobserved one invents nothing, and drift that already has an open Action
   * adopts it rather than planning a second. Work only happens when desire and
   * reality actually disagree and nothing is already closing the gap.
   */
  async reconcileEnvironment(
    context: AuthenticatedContext,
    projectId: string,
    environmentId: string,
    options: { probe?: CapabilityProbe; operation?: string } = {},
  ): Promise<ReconciliationOutcome> {
    const tenantId = context.tenant;
    const explanation: string[] = [];
    const finish = (
      result: ReconciliationResult,
      extra: Partial<ReconciliationOutcome> = {},
    ): ReconciliationOutcome => ({
      result,
      observedAt: new Date().toISOString(),
      explanation,
      ...extra,
    });

    const project = await this.domain.getProject(tenantId, projectId);
    if (!project) throw new DomainValidationError(`project ${projectId} was not found`);
    const environment = await this.domain.getEnvironment(tenantId, projectId, environmentId);
    if (!environment) throw new DomainValidationError(`environment ${environmentId} was not found`);

    const desiredState = await this.domain.getDesiredState(tenantId, projectId);
    /*
     * Observe first. Reconciliation is the one writer of current state, and it
     * writes what the resource itself reported when the environment can be
     * observed live; when it cannot, the recorded state of the last verified
     * operation stands, marked as such. A failed observation is recorded as a
     * failed observation, never as drift.
     */
    if (!this.config.repositoryRoot) {
      // Desired state names a branch; what that branch is at is what the
      // remote says now, not what a record said when it was added.
      const repositories = await this.domain.listRepositories(tenantId, projectId);
      const source = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId) ?? repositories[0];
      if (source) await this.connectRepository(context, projectId, source.id);
    }
    const observation = await this.observeEnvironmentNow(tenantId, projectId, environment, desiredState);
    const reports = await this.observeReality(context, projectId);
    const drift = reports.find((report) => report.environmentId === environmentId);
    if (!drift) throw new DomainValidationError(`environment ${environmentId} was not observed`);

    const current = observeEnvironment((await this.domain.getEnvironment(tenantId, projectId, environmentId)) ?? environment);
    const revisions = {
      desiredStateRevision: desiredStateRevision(desiredState),
      observedStateRevision: observedStateRevision(current),
    };
    const driftSummary = {
      status: drift.status,
      fields: drift.fields.map((field) => ({ field: field.field, desired: field.desired, current: field.current, drifted: field.drifted })),
    };
    explanation.push(...drift.explanation);

    // An environment Factory has not observed is not a drifted one, and one
    // it could not observe this time is not one either.
    if (drift.status === 'unknown') {
      return finish('unobserved', { ...revisions, observation, drift: driftSummary });
    }
    if (drift.status === 'unavailable') {
      return finish('unavailable', { ...revisions, observation, drift: driftSummary });
    }
    if (drift.status === 'reconciled') {
      /*
       * Reality matches. An Action whose outcome was unknown is resolved from
       * that fact rather than left uncertain forever: the provider is never
       * asked again, only reality, which has just answered.
       */
      for (const uncertain of await this.domain.unknownActionsForEnvironment(tenantId, environmentId)) {
        const resolved = await this.resolveUncertainAction(context, uncertain.id);
        explanation.push(`Action ${uncertain.id} had an unknown outcome; reality now matches, and it was resolved by observation as ${resolved.status}.`);
      }
      return finish('converged', { ...revisions, observation, drift: driftSummary });
    }

    const actionType = options.operation ?? 'repo-echo';
    const fingerprint = reconciliationFingerprint({
      projectId,
      environmentId,
      ...revisions,
      actionType,
    });

    // Identical drift already has work in flight; adopt it rather than fork it.
    const existing = await this.domain.findOpenActionByFingerprint(tenantId, fingerprint);
    if (existing) {
      const adopted = {
        ...revisions,
        observation,
        drift: driftSummary,
        fingerprint,
        actionId: existing.id,
        ...(existing.graphId ? { graphId: existing.graphId } : {}),
        ...(existing.autonomy ? { autonomy: existing.autonomy } : {}),
        ...(existing.runId ? { runId: existing.runId } : {}),
      };
      if (existing.status === 'unknown') {
        // Reality, not the provider, is asked about an unknown outcome.
        const resolved = await this.resolveUncertainAction(context, existing.id);
        explanation.push(`Action ${existing.id} has an unknown outcome; reality was observed before any retry: ${resolved.failure?.reason ?? resolved.status}.`);
        if (resolved.status === 'succeeded') {
          const reobservation = await this.observeEnvironmentNow(tenantId, projectId, environment, desiredState);
          const after = (await this.observeReality(context, projectId)).find((report) => report.environmentId === environmentId);
          return finish(after?.status === 'reconciled' ? 'executed' : 'drift-detected', { ...adopted, reobservation });
        }
        return finish(resolved.status === 'unknown' ? 'unknown' : resolved.status === 'planned' ? 'duplicate-suppressed' : 'execution-failed', adopted);
      }
      explanation.push(`Action ${existing.id} is already open for this drift.`);
      const inFlight = existing.status === 'running' || existing.status === 'authorized' || existing.status === 'executed' || existing.status === 'verifying';
      return finish(
        existing.status === 'awaiting-approval' ? 'awaiting-approval' : inFlight ? 'executing' : 'duplicate-suppressed',
        adopted,
      );
    }

    /*
     * An Action on this environment whose outcome is unknown means the
     * provider may already have acted. Reality is asked about it first, and
     * while reality cannot say, no new operation is started against the same
     * environment: that would be the blind duplicate the uncertainty exists
     * to prevent.
     */
    for (const uncertain of await this.domain.unknownActionsForEnvironment(tenantId, environmentId)) {
      const resolved = await this.resolveUncertainAction(context, uncertain.id);
      explanation.push(`Action ${uncertain.id} has an unknown outcome; reality was observed before any new operation: ${resolved.status}.`);
      if (resolved.status === 'unknown') {
        return finish('unknown', { ...revisions, observation, drift: driftSummary, fingerprint, actionId: uncertain.id, ...(uncertain.runId ? { runId: uncertain.runId } : {}) });
      }
    }

    /*
     * The same drift failing again and again is not remediated by planning
     * again and again. The durable retry state on the reconciliation record
     * decides whether this drift is eligible for another attempt now.
     */
    const record = await this.domain.getReconciliation(tenantId, projectId, environmentId);
    const retry = record?.retry;
    if (retry && retry.fingerprint === fingerprint) {
      const now = Date.now();
      if (retry.suspended) {
        explanation.push(`This drift has failed ${retry.attempts} time(s) (last: ${retry.lastResult}); no new Action until desired state or reality changes.`);
        return finish('retry-suspended', { ...revisions, observation, drift: driftSummary, fingerprint, ...(retry.lastActionId ? { actionId: retry.lastActionId } : {}) });
      }
      if (Date.parse(retry.nextEligibleAt) > now) {
        explanation.push(`This drift failed ${retry.attempts} time(s) (last: ${retry.lastResult}); the next attempt is eligible at ${retry.nextEligibleAt}.`);
        return finish('retry-suspended', { ...revisions, observation, drift: driftSummary, fingerprint, ...(retry.lastActionId ? { actionId: retry.lastActionId } : {}) });
      }
    }

    /*
     * Reconciliation plans a one-node graph. It behaves exactly as the lone
     * Action did, and gives drift a path into multi-step coordination later
     * without changing what reconciliation means now.
     */
    const graphTimestamp = new Date().toISOString();
    const graph = await this.domain.createGraph({
      id: `graph_${randomUUID()}`,
      tenantId,
      projectId,
      environmentId,
      origin: { kind: 'continuous-reconciliation' },
      status: 'planned',
      requestedBy: context.principal,
      reconciliationFingerprint: fingerprint,
      createdAt: graphTimestamp,
      updatedAt: graphTimestamp,
    });

    const planned = await this.createAction(context, projectId, {
      type: actionType,
      intent: drift.proposal?.intent ?? `Reconcile ${environment.name}`,
      environmentId,
      ...(options.operation ? { operation: options.operation } : {}),
      graph: { id: graph.id, dependsOn: [], sequence: 0 },
    }, options.probe);

    const action = await this.domain.patchAction(tenantId, planned.id, {
      origin: 'continuous-reconciliation',
      reconciliationFingerprint: fingerprint,
      ...revisions,
      drift: {
        status: drift.status,
        observedAt: drift.observedAt,
        explanation: drift.explanation,
        fields: drift.fields.filter((field) => field.drifted),
      },
    }) ?? planned;

    explanation.push(`Factory prepared: ${action.intent}`);
    const autonomy = action.autonomy;

    /*
     * The authority decides whether this runs without a person, and an
     * authority Factory cannot reach is a denial rather than a default. Both
     * leave the Action for a human; they are reported apart because they call
     * for different responses.
     */
    if (!autonomy?.allowed) {
      const unreachable = /unavailable|unreachable|could not|no AuthBoundry session/i.test(autonomy?.reason ?? '');
      explanation.push(unreachable
        ? 'AuthBoundry could not be reached, so Factory did not act.'
        : 'AuthBoundry denied autonomous execution, so this waits for a person.');
      await this.domain.patchGraph(tenantId, graph.id, { status: 'blocked' });
      return finish(unreachable ? 'authority-unavailable' : 'autonomy-denied', {
        ...revisions,
        observation,
        drift: driftSummary,
        fingerprint,
        actionId: action.id,
        graphId: graph.id,
        ...(autonomy ? { autonomy } : {}),
      });
    }

    explanation.push('AuthBoundry authorized autonomous execution.');
    // Through the graph coordinator, which calls the same runAction path.
    await this.coordinateGraph(context, graph.id, {
      ...(options.probe ? { probe: options.probe } : {}),
      autonomous: true,
    });
    const executed = (await this.domain.getAction(tenantId, action.id)) ?? action;

    const failedVerification = executed.verification?.some((check) => check.status === 'failed') ?? false;
    const run = executed.runId ? await this.domain.getRun(tenantId, executed.runId) : null;
    const evidence = executed.runId
      ? await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(executed.runId)
      : null;

    const base: Partial<ReconciliationOutcome> = {
      ...revisions,
      observation,
      drift: driftSummary,
      fingerprint,
      actionId: executed.id,
      graphId: graph.id,
      ...(executed.runId ? { runId: executed.runId } : {}),
      ...(executed.autonomy ? { autonomy: executed.autonomy } : {}),
      ...(executed.authority ? { authority: executed.authority } : {}),
      ...(evidence ? { evidenceId: evidence.id } : {}),
    };

    if (executed.status === 'succeeded') {
      /*
       * Completion is not convergence. Reality is observed again — live, when
       * the environment can be observed — and only a comparison that finds no
       * drift lets the pass say the environment was reconciled.
       */
      const reobservation = await this.observeEnvironmentNow(tenantId, projectId, environment, desiredState);
      const after = (await this.observeReality(context, projectId)).find((report) => report.environmentId === environmentId);
      if (after?.status === 'reconciled') {
        explanation.push(`${environment.name} re-observed after execution: it matches the declared state.`);
        return finish('executed', { ...base, reobservation });
      }
      explanation.push(`${environment.name} re-observed after execution: ${after?.explanation.join(' ') ?? 'it could not be observed'}`);
      return finish(after?.status === 'unavailable' ? 'unavailable' : 'drift-detected', { ...base, reobservation });
    }
    if (executed.status === 'unknown') {
      explanation.push('The external outcome is unknown; reality will be observed before any retry.');
      return finish('unknown', base);
    }
    if (executed.outcome === 'provider-unavailable' || executed.outcome === 'resource-unavailable' || executed.outcome === 'credential-unavailable') {
      explanation.push(`The provider could not be used: ${executed.failure?.reason ?? executed.outcome}.`);
      return finish('provider-unavailable', base);
    }
    if (run && run.status !== 'completed') {
      explanation.push(`Execution failed: ${executed.failure?.reason ?? run.error ?? 'the run did not complete'}.`);
      return finish('execution-failed', base);
    }
    if (failedVerification || executed.outcome === 'verification-unavailable') {
      explanation.push(`Execution completed but verification did not establish the desired state: ${executed.failure?.reason ?? 'verification did not pass'}.`);
      // Reality is what decides; it is re-observed so the next pass compares
      // against what is, not against what the run said.
      const reobservation = await this.observeEnvironmentNow(tenantId, projectId, environment, desiredState);
      return finish('verification-failed', { ...base, reobservation });
    }
    explanation.push('Reconciliation did not converge.');
    return finish('error', base);
  }

  /**
   * Observe the environment now, and record what was seen.
   *
   * This is the one writer of current state. A live answer from the resource
   * replaces health and, when the resource reports it, the running revision;
   * a failed observation is recorded as such and changes no fact about the
   * environment; an environment nothing can observe keeps the recorded state
   * of the last verified operation, marked `recorded`.
   */
  private async observeEnvironmentNow(
    tenantId: string,
    projectId: string,
    environment: EnvironmentRecord,
    desiredState: DesiredStateRecord | null,
  ): Promise<EnvironmentObservation> {
    const repositories = await this.domain.listRepositories(tenantId, projectId);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId) ?? repositories[0] ?? null;
    const providerId = environment.provider ?? desiredState?.targetProvider ?? null;
    const adapter = providerId ? this.registry.adapter(providerId) : null;
    const live = await observeEnvironmentLive(adapter, { repository, environment, desiredState, discovery: null, idempotencyKey: `observe:${environment.id}` });
    const at = new Date().toISOString();
    const previous = (await this.domain.getEnvironment(tenantId, projectId, environment.id))?.currentState ?? environment.currentState;
    const observation: EnvironmentObservation = live.kind === 'unsupported' && previous
      ? { kind: 'recorded', at, detail: `${live.detail}; current state is the evidence of run ${previous.reconciledRunId ?? 'unknown'}` }
      : { kind: live.kind, at, detail: live.detail, ...(live.source ? { source: live.source } : {}), ...(live.reported ? { reported: live.reported } : {}) };

    if (live.kind === 'observed') {
      await this.domain.setEnvironmentState(tenantId, projectId, environment.id, {
        ...(previous ?? {}),
        observedAt: at,
        ...(live.reported?.revision ? { sourceCommit: live.reported.revision } : {}),
        ...(desiredState?.targetProvider ?? environment.provider ? { provider: desiredState?.targetProvider ?? environment.provider! } : {}),
        health: live.reported?.health ?? 'unknown',
        observation,
      });
    } else if (previous) {
      await this.domain.setEnvironmentState(tenantId, projectId, environment.id, { ...previous, observation });
    } else if (live.kind !== 'unsupported') {
      // Nothing recorded and nothing observable now: the state says only that.
      await this.domain.setEnvironmentState(tenantId, projectId, environment.id, { observedAt: at, health: 'unknown', observation });
    }
    return observation;
  }

  /** Apply the durable retry policy to a pass's outcome. */
  private retryStateAfter(record: ReconciliationRecord, outcome: ReconciliationOutcome, now: number): ReconciliationRetryState | undefined {
    if (!outcome.fingerprint) return record.retry;
    const previous = record.retry?.fingerprint === outcome.fingerprint ? record.retry : undefined;
    if (RETRYABLE.has(outcome.result)) {
      const attempts = (previous?.attempts ?? 0) + 1;
      const backoff = Math.min(RETRY_MAX_BACKOFF_MS, Math.max(record.intervalMs, 60_000) * 2 ** Math.max(0, attempts - 1));
      return {
        fingerprint: outcome.fingerprint,
        attempts,
        lastResult: outcome.result,
        ...(outcome.actionId ? { lastActionId: outcome.actionId } : {}),
        lastAttemptAt: new Date(now).toISOString(),
        nextEligibleAt: new Date(now + backoff).toISOString(),
        suspended: attempts >= RETRY_MAX_ATTEMPTS,
      };
    }
    if (outcome.result === 'converged' || outcome.result === 'executed') return undefined;
    return previous;
  }

  /**
   * Run a pass and record what it found on the durable reconciliation record.
   *
   * The scheduler and the manual button both land here, so the record always
   * reflects the last pass whoever asked for it.
   */
  async runReconciliationPass(
    context: AuthenticatedContext,
    record: ReconciliationRecord,
    options: { probe?: CapabilityProbe; now?: number } = {},
  ): Promise<{ record: ReconciliationRecord; outcome: ReconciliationOutcome }> {
    const now = options.now ?? Date.now();
    let outcome: ReconciliationOutcome;
    try {
      outcome = await this.reconcileEnvironment(context, record.projectId, record.environmentId, {
        ...(options.probe ? { probe: options.probe } : {}),
      });
    } catch (error) {
      outcome = {
        result: 'error',
        observedAt: new Date(now).toISOString(),
        explanation: [error instanceof Error ? error.message : String(error)],
      };
    }

    const status = RECONCILIATION_STATUS[outcome.result];
    const retry = this.retryStateAfter(record, outcome, now);
    const released = await this.domain.releaseReconciliation(record.id, {
      status,
      lastObservedAt: outcome.observedAt,
      ...(outcome.result === 'executed' || outcome.result === 'converged' ? { lastReconciledAt: outcome.observedAt } : {}),
      ...(outcome.actionId ? { lastActionId: outcome.actionId } : {}),
      ...(outcome.runId ? { lastRunId: outcome.runId } : {}),
      ...(outcome.fingerprint ? { lastFingerprint: outcome.fingerprint } : {}),
      lastOutcome: outcome,
      lastError: status === 'failed' ? outcome.explanation[outcome.explanation.length - 1] ?? 'unknown error' : '',
      nextDueAt: nextDueAt(record, now),
      retry,
    });
    await this.domain.appendReconciliationCycle({
      reconciliationId: record.id, tenantId: record.tenantId, projectId: record.projectId, environmentId: record.environmentId,
      workerId: record.leaseOwner ?? this.workerId, outcome,
    });
    return { record: released ?? record, outcome };
  }

  /**
   * The Factory-wide reconciliation view: what Factory is keeping in sync.
   *
   * Everything here is read from the durable records, so there is no worker
   * whose state exists only in a process. If Factory is reconciling something,
   * this says so, and if a pass failed it says why.
   */
  async reconciliationView(context: AuthenticatedContext, projectId?: string): Promise<{
    environments: Record<string, unknown>[];
    summary: Record<string, number>;
  }> {
    const tenantId = context.tenant;
    const records = await this.domain.listReconciliations(tenantId, projectId);
    const environments: Record<string, unknown>[] = [];
    const summary = { total: 0, healthy: 0, drifted: 0, awaitingApproval: 0, failed: 0, disabled: 0 };

    for (const record of records) {
      const [project, environment] = await Promise.all([
        this.domain.getProject(tenantId, record.projectId),
        this.domain.getEnvironment(tenantId, record.projectId, record.environmentId),
      ]);
      const action = record.lastActionId
        ? await this.domain.getAction(tenantId, record.lastActionId)
        : null;

      summary.total += 1;
      if (!record.enabled) summary.disabled += 1;
      else if (record.status === 'healthy') summary.healthy += 1;
      else if (record.status === 'failed') summary.failed += 1;
      else if (record.status === 'drifted') summary.drifted += 1;
      if (action?.status === 'awaiting-approval') summary.awaitingApproval += 1;

      environments.push({
        id: record.id,
        projectId: record.projectId,
        projectName: project?.name ?? null,
        environmentId: record.environmentId,
        environmentName: environment?.name ?? null,
        status: record.status,
        enabled: record.enabled,
        interval: record.interval,
        schedule: describeSchedule(record),
        lastObservedAt: record.lastObservedAt ?? null,
        lastReconciledAt: record.lastReconciledAt ?? null,
        nextDueAt: record.nextDueAt ?? null,
        lastError: record.lastError || null,
        result: record.lastOutcome?.result ?? null,
        explanation: record.lastOutcome?.explanation ?? [],
        graphId: record.lastOutcome?.graphId ?? null,
        currentState: environment?.currentState ?? null,
        observation: environment?.currentState?.observation ?? record.lastOutcome?.observation ?? null,
        retry: record.retry ?? null,
        lastVerification: action?.verification ?? null,
        run: action?.runId ? await this.domain.getRun(tenantId, action.runId) : null,
        action: action
          ? {
              id: action.id,
              intent: action.intent,
              status: action.status,
              origin: action.origin ?? 'manual',
              autonomy: action.autonomy ?? null,
            }
          : null,
      });
    }
    return { environments, summary };
  }

  /**
   * Write a pass's result onto its reconciliation record.
   *
   * Used when a pass was requested directly rather than claimed by the worker,
   * so a manual pass leaves the same durable trail a scheduled one does.
   */
  async recordReconciliationOutcome(
    record: ReconciliationRecord,
    outcome: ReconciliationOutcome,
    now = Date.now(),
  ): Promise<ReconciliationRecord | null> {
    const status = RECONCILIATION_STATUS[outcome.result];
    await this.domain.appendReconciliationCycle({
      reconciliationId: record.id, tenantId: record.tenantId, projectId: record.projectId, environmentId: record.environmentId,
      workerId: this.workerId, outcome,
    });
    return this.domain.patchReconciliation(record.tenantId, record.id, {
      status,
      lastObservedAt: outcome.observedAt,
      ...(outcome.result === 'executed' || outcome.result === 'converged' ? { lastReconciledAt: outcome.observedAt } : {}),
      ...(outcome.actionId ? { lastActionId: outcome.actionId } : {}),
      ...(outcome.runId ? { lastRunId: outcome.runId } : {}),
      ...(outcome.fingerprint ? { lastFingerprint: outcome.fingerprint } : {}),
      lastOutcome: outcome,
      lastError: status === 'failed'
        ? outcome.explanation[outcome.explanation.length - 1] ?? 'unknown error'
        : '',
      nextDueAt: nextDueAt(record, now),
      retry: this.retryStateAfter(record, outcome, now),
    });
  }

  /** Configure continuous reconciliation for one environment. */
  async configureReconciliation(context: AuthenticatedContext, projectId: string, environmentId: string, input: {
    enabled?: boolean;
    interval?: string;
  }): Promise<ReconciliationRecord> {
    const tenantId = context.tenant;
    if (!await this.domain.getProject(tenantId, projectId)) {
      throw new DomainValidationError(`project ${projectId} was not found`);
    }
    if (!await this.domain.getEnvironment(tenantId, projectId, environmentId)) {
      throw new DomainValidationError(`environment ${environmentId} was not found`);
    }
    const existing = await this.domain.getReconciliation(tenantId, projectId, environmentId);
    const schedule = parseInterval(input.interval ?? existing?.interval);
    return this.domain.putReconciliation({
      tenantId,
      projectId,
      environmentId,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...schedule,
    });
  }

  /**
   * Create a durable Action Graph from a typed plan.
   *
   * Every action is validated against `.flow` as it is planned, and every
   * dependency must name an action in the same request with no cycle. The
   * graph is durable state only: nothing here authorizes or executes.
   */
  async createActionGraph(context: AuthenticatedContext, input: {
    /** A caller-derived identity, when the graph must be found again after a restart. */
    id?: string;
    projectId: string;
    environmentId?: string;
    origin?: Partial<ActionGraphOrigin>;
    actions: PlannedAction[];
  }, probe?: CapabilityProbe): Promise<{ graph: ActionGraphRecord; actions: ActionRecord[] }> {
    const tenantId = context.tenant;
    if (!await this.domain.getProject(tenantId, input.projectId)) {
      throw new DomainValidationError(`project ${input.projectId} was not found`);
    }
    if (input.environmentId && !await this.domain.getEnvironment(tenantId, input.projectId, input.environmentId)) {
      throw new DomainValidationError(`environment ${input.environmentId} was not found`);
    }
    const ordered = orderPlan(input.actions);
    const authorities = getOperationAuthorities(this.flowSpec);
    for (const entry of ordered) {
      const capability = entry.action.capability ?? (isOperationalCapability(entry.action.type) ? entry.action.type : undefined);
      if (capability) {
        if (!isOperationalCapability(capability)) {
          throw new GraphValidationError(`action ${entry.key}: ${capability} is not an operational capability Factory knows`);
        }
        if (this.registry.providersFor(capability).length === 0) {
          throw new GraphValidationError(`action ${entry.key}: no .flow operation declares ${capability}`);
        }
        continue;
      }
      const operation = entry.action.operation ?? entry.action.type;
      if (!authorities.has(operation)) {
        throw new GraphValidationError(
          `action ${entry.key}: no .flow operation named ${operation}; declared operations are ${[...authorities.keys()].sort().join(', ')}`,
        );
      }
    }

    const timestamp = new Date().toISOString();
    const graph = await this.domain.createGraph({
      id: input.id ?? `graph_${randomUUID()}`,
      tenantId,
      projectId: input.projectId,
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      origin: { kind: 'manual', ...input.origin } as ActionGraphOrigin,
      status: 'planned',
      requestedBy: context.principal,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const ids = new Map<string, string>();
    const actions: ActionRecord[] = [];
    for (const [sequence, entry] of ordered.entries()) {
      const action = await this.createAction(context, input.projectId, {
        type: entry.action.type,
        ...(entry.action.intent ? { intent: entry.action.intent } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(entry.action.operation ? { operation: entry.action.operation } : {}),
        ...(entry.action.capability ? { capability: entry.action.capability } : {}),
        ...(entry.action.parameters ? { parameters: entry.action.parameters } : {}),
        graph: {
          id: graph.id,
          dependsOn: entry.dependsOn.map((key) => ids.get(key)!),
          sequence,
        },
      }, probe);
      ids.set(entry.key, action.id);
      actions.push(action);
    }

    const status = graphStatus(graph, actions);
    return { graph: (await this.domain.patchGraph(tenantId, graph.id, { status })) ?? graph, actions };
  }

  /**
   * Coordinate a graph: run what is ready, block what cannot proceed, and
   * write back what happened.
   *
   * This is coordination, not execution. Every node still goes through
   * `runAction` — the same authority question, the same Run, the same Evidence
   * as an Action planned alone — and each is authorized separately, because a
   * grant that holds for one node need not hold for the next.
   *
   * It is safe to call repeatedly: completed nodes are never re-run, running
   * nodes are never duplicated, blocked nodes stay blocked, and failed nodes
   * stay failed until someone explicitly retries them.
   */
  async coordinateGraph(
    context: AuthenticatedContext,
    graphId: string,
    options: { probe?: CapabilityProbe; autonomous?: boolean } = {},
  ): Promise<{ graph: ActionGraphRecord; actions: ActionRecord[] }> {
    const tenantId = context.tenant;
    let graph = await this.domain.getGraph(tenantId, graphId);
    if (!graph) throw new DomainValidationError(`action graph ${graphId} was not found`);
    if (graph.status === 'cancelled') {
      return { graph, actions: await this.domain.graphActions(tenantId, graphId) };
    }
    if (!graph.startedAt) {
      graph = (await this.domain.patchGraph(tenantId, graphId, { startedAt: new Date().toISOString() })) ?? graph;
    }

    // Each node runs against a fresh read of the graph, so a node that just
    // finished unlocks its dependents within the same pass. A node the
    // authority declines is asked once per pass, not forever.
    const attempted = new Set<string>();
    for (;;) {
      const actions = await this.domain.graphActions(tenantId, graphId);
      const byId = new Map(actions.map((action) => [action.id, action]));

      // Persist why a node cannot run, so a restart still knows.
      for (const action of actions) {
        const blocking = blockingDependencies(action, byId);
        const recorded = action.blockedBy ?? [];
        if (blocking.join() !== recorded.join() && action.status !== 'succeeded') {
          await this.domain.patchAction(tenantId, action.id, { blockedBy: blocking });
        }
      }

      // An unknown node is asked of reality once per pass, never re-run.
      const uncertain = actions.find((action) => action.status === 'unknown' && !attempted.has(action.id));
      if (uncertain) {
        attempted.add(uncertain.id);
        await this.resolveUncertainAction(context, uncertain.id);
        continue;
      }

      const next = runnableActions(actions).find((action) => !attempted.has(action.id));
      if (!next) break;
      attempted.add(next.id);

      try {
        await this.runAction(context, next.id, {
          ...(options.probe ? { probe: options.probe } : {}),
          ...(options.autonomous ? { autonomous: true } : {}),
        });
      } catch (error) {
        // A refusal to run autonomously is recorded on the Action by runAction;
        // it leaves the node awaiting a person and the pass moves on.
        if (!(error instanceof DomainValidationError)) throw error;
        const refused = await this.domain.getAction(tenantId, next.id);
        if (refused?.status !== 'awaiting-approval') throw error;
      }
    }

    const actions = await this.domain.graphActions(tenantId, graphId);
    const byId = new Map(actions.map((action) => [action.id, action]));
    const status = graphStatus(graph, actions);
    const failed = actions.find((action) => nodeStatus(action, byId) === 'failed');
    graph = (await this.domain.patchGraph(tenantId, graphId, {
      status,
      ...(status === 'completed' || status === 'failed' ? { completedAt: new Date().toISOString() } : {}),
      ...(failed ? {
        failure: {
          actionId: failed.id,
          outcome: failed.outcome ?? 'execution-failed',
          // The Action's own recorded reason, then the check that failed.
          reason: failed.failure?.reason
            ?? failed.verification?.find((check) => check.status === 'failed')?.detail
            ?? `${failed.type} ${failed.outcome ?? 'failed'}`,
        },
      } : {}),
    })) ?? graph;
    return { graph, actions };
  }

  /** Stop coordinating. Nodes that never ran are cancelled; history is kept. */
  async cancelActionGraph(context: AuthenticatedContext, graphId: string): Promise<ActionGraphRecord> {
    const tenantId = context.tenant;
    const graph = await this.domain.getGraph(tenantId, graphId);
    if (!graph) throw new DomainValidationError(`action graph ${graphId} was not found`);
    for (const action of await this.domain.graphActions(tenantId, graphId)) {
      if (action.status === 'planned' || action.status === 'awaiting-approval') {
        await this.domain.patchAction(tenantId, action.id, { outcome: 'cancelled' });
      }
    }
    return (await this.domain.patchGraph(tenantId, graphId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })) ?? graph;
  }

  /**
   * Retry a failed Action explicitly.
   *
   * The Action is returned to planned and its next run is admitted as a new
   * Run; the earlier Run and its Evidence are kept untouched and listed on the
   * Action. Nothing retries on its own.
   */
  async retryAction(context: AuthenticatedContext, actionId: string): Promise<ActionRecord> {
    const tenantId = context.tenant;
    const action = await this.domain.getAction(tenantId, actionId);
    if (!action) throw new DomainValidationError(`action ${actionId} was not found`);
    if (action.status === 'unknown') {
      const run = action.runId ? await this.domain.getRun(tenantId, action.runId) : null;
      if (!run?.uncertainty?.retrySafe) {
        throw new DomainValidationError(
          `action ${actionId} has an unknown outcome and repeating it is not known to be safe; resolve it through observation first`,
        );
      }
    } else if (action.status !== 'failed') {
      throw new DomainValidationError(`action ${actionId} is ${action.status}, and only a failed action can be retried`);
    }
    const retried = await this.domain.patchAction(tenantId, actionId, {
      status: 'planned',
      retries: (action.retries ?? 0) + 1,
      previousRunIds: [...(action.previousRunIds ?? []), ...(action.runId ? [action.runId] : [])],
      runId: undefined,
      verification: undefined,
      outcome: undefined,
      failure: undefined,
      execution: undefined,
      blockedBy: [],
    });
    if (retried?.graphId) {
      const graph = await this.domain.getGraph(tenantId, retried.graphId);
      if (graph && graph.status !== 'cancelled') {
        await this.domain.patchGraph(tenantId, graph.id, {
          status: graphStatus({ ...graph, status: 'planned' }, await this.domain.graphActions(tenantId, graph.id)),
          failure: undefined,
          completedAt: undefined,
        });
      }
    }
    return retried ?? action;
  }

  /** A graph with its nodes and their derived statuses, for the API and UI. */
  async graphView(context: AuthenticatedContext, graphId: string): Promise<Record<string, unknown> | null> {
    const tenantId = context.tenant;
    const graph = await this.domain.getGraph(tenantId, graphId);
    if (!graph) return null;
    const actions = await this.domain.graphActions(tenantId, graphId);
    const byId = new Map(actions.map((action) => [action.id, action]));
    return {
      ...graph,
      status: graphStatus(graph, actions),
      nodes: actions.map((action) => ({
        actionId: action.id,
        type: action.type,
        intent: action.intent,
        status: nodeStatus(action, byId),
        actionStatus: action.status,
        outcome: action.outcome ?? null,
        dependsOn: action.dependsOn ?? [],
        blockedBy: action.blockedBy ?? [],
        sequence: action.sequence ?? 0,
        autonomy: action.autonomy ?? null,
        authority: action.authority ?? null,
        runId: action.runId ?? null,
        previousRunIds: action.previousRunIds ?? [],
        verification: action.verification ?? [],
        executionProvider: action.executionProvider ?? null,
        capability: action.capability ?? null,
        provider: action.provider ?? null,
        resource: action.resource ?? null,
        // The specific reason, from durable state, never a generic "failed".
        reason: (action.blockedBy ?? []).length
          ? (action.blockedBy ?? []).map((id) => {
              const dependency = byId.get(id);
              return `${dependency?.type ?? id} — ${dependency?.outcome ?? 'failed'}`;
            }).join('; ')
          : action.status === 'unknown'
            ? 'outcome uncertain — Factory is verifying external state before retrying'
          : action.outcome && action.outcome !== 'succeeded'
            ? `${action.outcome}${action.verification?.find((check) => check.status === 'failed')?.detail
                ? ': ' + action.verification.find((check) => check.status === 'failed')!.detail : ''}`
            : null,
      })),
    };
  }

  /* -----------------------------------------------------------------------
   * Operational work: the Attn ↔ Factory boundary.
   * -------------------------------------------------------------------- */

  /**
   * Accept operational work from another system and act on it.
   *
   * The request is validated against the contract, translated into Factory's
   * own Action Graph, and coordinated through the same path as any graph:
   * each node asks AuthBoundry whether it may run, and the answer decides.
   * The origin on the request is recorded as provenance and nothing more.
   *
   * The same origin and idempotency key always name the same work. A retry —
   * from the caller, or from this process after a restart — finds the work
   * already created, finishes whatever step was interrupted, and returns
   * the same identifiers rather than creating anything twice.
   */
  async createOperationalWork(
    context: AuthenticatedContext,
    input: unknown,
    probe?: CapabilityProbe,
    options: { coordinate?: boolean } = {},
  ): Promise<{ created: boolean; result: OperationalWorkResult }> {
    const request = parseOperationalWorkRequest(input);
    const tenantId = context.tenant;
    const id = operationalWorkId(tenantId, request);
    const fingerprint = operationalWorkFingerprint(request);

    let work = await this.domain.getOperationalWork(tenantId, id);
    let created = false;
    if (work) {
      if (work.requestFingerprint !== fingerprint) {
        throw new OperationalWorkConflictError(
          `idempotency key ${request.idempotencyKey} from ${request.origin.system} ${request.origin.type} ${request.origin.id} `
          + 'already names different work; a new request needs a new key',
        );
      }
    } else {
      // Tenant-scoped reads: a project or environment another tenant owns is
      // simply not found, so nothing can be requested against it.
      if (!await this.domain.getProject(tenantId, request.project)) {
        throw new DomainValidationError(`project ${request.project} was not found`);
      }
      if (request.environment && !await this.domain.getEnvironment(tenantId, request.project, request.environment)) {
        throw new DomainValidationError(`environment ${request.environment} was not found`);
      }
      const timestamp = new Date().toISOString();
      const record: OperationalWorkRecord = {
        id,
        tenantId,
        projectId: request.project,
        ...(request.environment ? { environmentId: request.environment } : {}),
        contract: request.contract,
        origin: request.origin,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        requestedBy: context.principal,
        ...(request.intent ? { intent: request.intent } : {}),
        requested: request.actions,
        plan: planOperationalWork(request),
        status: 'accepted',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        work = await this.domain.createOperationalWork(record);
        created = true;
        await this.domain.appendOperationalWorkEvent({
          workId: id, tenantId, type: 'OperationalWorkAccepted', status: 'accepted', origin: record.origin,
        });
      } catch (error) {
        // Two identical requests at once: the one that lost the insert
        // continues with the record the other wrote.
        const existing = await this.domain.getOperationalWork(tenantId, id);
        if (!existing) throw error;
        work = existing;
      }
    }

    if (!work.graphId && work.status !== 'cancelled') {
      work = (await this.domain.patchOperationalWork(tenantId, id, { status: 'planning' })) ?? work;
      // The graph's identity is derived from the work's, so a restart between
      // creating the graph and recording it adopts the graph instead of
      // creating a second one.
      const graphId = `graph_${id.slice('owk_'.length)}`;
      let graph = await this.domain.getGraph(tenantId, graphId);
      if (!graph) {
        graph = (await this.createActionGraph(context, {
          id: graphId,
          projectId: work.projectId,
          ...(work.environmentId ? { environmentId: work.environmentId } : {}),
          origin: { kind: 'external', sourceSystem: work.origin.system, sourceType: work.origin.type, sourceId: work.origin.id },
          actions: plannedActions(work),
        }, probe)).graph;
      }
      work = (await this.domain.patchOperationalWork(tenantId, id, { graphId: graph.id })) ?? work;
      await this.domain.appendOperationalWorkEvent({
        workId: id, tenantId, type: 'OperationalWorkPlanned', status: 'ready', origin: work.origin, graphId: graph.id,
      });
    }

    if (options.coordinate !== false && work.graphId && work.status !== 'cancelled') {
      // Another system asked, so Factory acts on its own behalf here: every
      // node needs AuthBoundry's permission to run autonomously, and a node
      // it refuses waits for a person exactly as it would in any graph.
      await this.coordinateGraph(context, work.graphId, { ...(probe ? { probe } : {}), autonomous: true });
    }

    return { created, result: (await this.operationalWorkView(context, id))! };
  }

  /** The current result, derived from the graph, with state transitions recorded once. */
  async operationalWorkView(context: AuthenticatedContext, workId: string): Promise<OperationalWorkResult | null> {
    const tenantId = context.tenant;
    const work = await this.domain.getOperationalWork(tenantId, workId);
    if (!work) return null;
    return this.syncOperationalWork(work);
  }

  async listOperationalWork(context: AuthenticatedContext, projectId?: string): Promise<OperationalWorkResult[]> {
    const records = await this.domain.listOperationalWork(context.tenant, projectId);
    return Promise.all(records.map((work) => this.syncOperationalWork(work)));
  }

  async operationalWorkEvents(context: AuthenticatedContext, workId: string) {
    return this.domain.listOperationalWorkEvents(context.tenant, workId);
  }

  /** Stop the work: its graph is cancelled and nodes that never ran stay that way. */
  async cancelOperationalWork(context: AuthenticatedContext, workId: string): Promise<OperationalWorkResult | null> {
    const tenantId = context.tenant;
    const work = await this.domain.getOperationalWork(tenantId, workId);
    if (!work) return null;
    if (work.status === 'cancelled' || work.status === 'completed' || work.status === 'failed') {
      return this.syncOperationalWork(work);
    }
    if (work.graphId) {
      // The graph is the state; cancelling it is what makes the work cancelled,
      // and the sync below records that transition once.
      await this.cancelActionGraph(context, work.graphId);
      return this.syncOperationalWork(work);
    }
    const cancelled = (await this.domain.patchOperationalWork(tenantId, workId, {
      status: 'cancelled', completedAt: new Date().toISOString(),
    })) ?? work;
    await this.domain.appendOperationalWorkEvent({
      workId, tenantId, type: 'OperationalWorkCancelled', status: 'cancelled', outcome: 'cancelled', origin: work.origin,
    });
    return this.syncOperationalWork(cancelled);
  }

  /**
   * Handle the contract as an AppPort request envelope.
   *
   * The caller was authenticated by AuthBoundry before this is reached; the
   * envelope is dispatched through Factory's AppPort runtime, which validates
   * it against the capability's typed schema and answers with a protocol
   * envelope. There is no Attn-specific transport.
   */
  async handleOperationalWorkEnvelope(
    context: AuthenticatedContext,
    envelope: AppRequest,
    probe?: CapabilityProbe,
  ): Promise<AppResponse> {
    if (envelope.idempotencyKey && envelope.input && typeof envelope.input === 'object'
      && !Array.isArray(envelope.input) && (envelope.input as Record<string, unknown>).idempotencyKey === undefined) {
      envelope = { ...envelope, input: { ...(envelope.input as Record<string, unknown>), idempotencyKey: envelope.idempotencyKey } };
    }
    const token = randomUUID();
    this.invocations.set(token, { context, ...(probe ? { probe } : {}) });
    try {
      const now = new Date().toISOString();
      return await this.appPortRuntime.handleRequest({
        ...envelope,
        extensions: { ...envelope.extensions, [INVOCATION_EXTENSION]: token },
      }, {
        principal: { id: context.principal, type: 'service' },
        session: {
          id: `factory:${envelope.requestId}`,
          principal: { id: context.principal, type: 'service' },
          applicationId: this.applicationId,
          createdAt: now,
          // The one permission this route was authenticated for. AppPort
          // re-checks it; it does not widen it.
          permissions: ['factory.run'],
        },
        transport: 'http',
      });
    } finally {
      this.invocations.delete(token);
    }
  }

  private async syncOperationalWork(work: OperationalWorkRecord): Promise<OperationalWorkResult> {
    const tenantId = work.tenantId;
    const graph = work.graphId ? await this.domain.getGraph(tenantId, work.graphId) : null;
    const actions = graph ? await this.domain.graphActions(tenantId, graph.id) : [];
    const evidence = new Map<string, StructuredEvidence>();
    for (const action of actions) {
      if (!action.runId) continue;
      const record = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(action.runId);
      if (record) evidence.set(action.runId, record);
    }
    const status: OperationalWorkStatus = operationalWorkStatus(work, graph, actions);
    let current = work;
    if (status !== work.status) {
      const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      current = (await this.domain.patchOperationalWork(tenantId, work.id, {
        status,
        ...(terminal && !work.completedAt ? { completedAt: new Date().toISOString() } : {}),
      })) ?? work;
      const type = OPERATIONAL_WORK_TERMINAL_EVENTS[status];
      if (type) {
        const result = operationalWorkResult({ work: current, graph, actions, evidence, status });
        await this.domain.appendOperationalWorkEvent({
          workId: work.id, tenantId, type, status, outcome: result.outcome, origin: work.origin,
          ...(work.graphId ? { graphId: work.graphId } : {}),
          summary: {
            completedActions: result.completedActions,
            blockedActions: result.blockedActions,
            failedActions: result.failedActions,
          },
        });
      }
    }
    return operationalWorkResult({ work: current, graph, actions, evidence, status });
  }

  /**
   * What the repository looks like: from the local mirror when one is
   * configured, else from what the connected remote last reported. Nothing
   * is invented for a repository Factory cannot reach.
   */
  private async discover(repository: RepositoryRecord | null): Promise<RepositoryDiscovery | null> {
    if (this.config.repositoryRoot) return discoverRepository(this.config.repositoryRoot, repository ?? undefined);
    const connection = repository?.connection;
    if (!repository || !connection || connection.status !== 'connected') return null;
    const headCommit = connection.branchCommit ?? connection.headCommit;
    return { inspectedAt: connection.checkedAt, repositoryId: repository.id, files: [], signals: { ...(headCommit ? { headCommit } : {}) } };
  }

  /**
   * Verify that a repository can be reached and record what the remote
   * reports. Called when a repository is added, on demand, and by each
   * reconciliation cycle so drift compares against the remote's real tip.
   */
  async connectRepository(context: AuthenticatedContext, projectId: string, repositoryId: string): Promise<RepositoryRecord | null> {
    const tenantId = context.tenant;
    const repository = (await this.domain.listRepositories(tenantId, projectId)).find((candidate) => candidate.id === repositoryId);
    if (!repository) return null;
    const connection = await verifyRepositoryConnection(repository, this.credentialResolver);
    return this.domain.setRepositoryConnection(tenantId, projectId, repositoryId, connection);
  }

  private async providerContext(
    tenantId: string,
    action: ActionRecord,
    repository: RepositoryRecord | null,
    desiredState: DesiredStateRecord | null,
    idempotencyKey: string,
  ): Promise<ProviderContext> {
    const environment = action.environmentId
      ? await this.domain.getEnvironment(tenantId, action.projectId, action.environmentId)
      : null;
    const discovery = await this.discover(repository);
    return { repository, environment, desiredState, discovery, idempotencyKey };
  }

  providerRegistry(): ProviderRegistry {
    return this.registry;
  }

  /**
   * What each provider can do from here, and whether it can do it now.
   *
   * `unsupported` means `.flow` declares nothing for it; `unavailable` means
   * the adapter cannot reach its system from this process. Neither is an
   * authorization: whether Factory may perform an operation is AuthBoundry's
   * answer, asked per Action, and nothing on this page stands in for it.
   */
  async operationalProviders(context?: AuthenticatedContext): Promise<Record<string, unknown>[]> {
    const tenantId = context?.tenant;
    const environments = tenantId
      ? (await Promise.all((await this.domain.listProjects(tenantId)).map(async (project) => ({
          project,
          environments: await this.domain.listEnvironments(tenantId, project.id),
          desiredState: await this.domain.getDesiredState(tenantId, project.id),
        }))))
      : [];
    const actions = tenantId ? await this.domain.listActions(tenantId) : [];

    return Promise.all(this.registry.adapters.map(async (adapter) => {
      const declared = this.registry.capabilitiesOf(adapter.id);
      const unimplemented = this.registry.unimplementedOf(adapter.id);
      const availability = await adapter.availability();
      const availabilityOf = new Map<string, { state: 'available' | 'unavailable'; detail: string }>();
      for (const capability of adapter.capabilities) availabilityOf.set(capability, await adapter.availability(capability));
      const projects = environments
        .filter(({ environments: list, desiredState }) =>
          list.some((environment) => environment.provider === adapter.id) || desiredState?.targetProvider === adapter.id)
        .map(({ project, environments: list }) => ({
          id: project.id,
          name: project.name,
          environments: list.filter((environment) => environment.provider === adapter.id).map((environment) => environment.name),
        }));
      const recent = actions.filter((action) => action.provider === adapter.id).slice(0, 10);
      // Presence by name. Values are never read here.
      const credentials = Object.fromEntries(adapter.credentials.map((name) => [name, Boolean(this.credentialResolver(name))]));
      const credentialsPresent = Object.values(credentials).every(Boolean);
      const configured = projects.length > 0 || adapter.credentials.length === 0 && declared.length > 0
        && declared.every((entry) => capabilityResourceKind(entry.capability) === 'repository');
      const status = declared.length === 0 ? 'unsupported' : availability.state;

      /*
       * Honest per-capability status. `executable` is true only when every
       * requirement holds from this process: implemented by the adapter,
       * declared by .flow, the mechanism reachable, credentials present, and
       * something configured to run it against. None of it is authorization.
       */
      const describe = (entry: { capability: OperationalCapability; operation: string | null; authority?: { capabilities: string[] } }, implemented: boolean) => {
        const declaredHere = entry.operation !== null;
        const reachable = availabilityOf.get(entry.capability) ?? availability;
        const reasons = [
          ...(implemented ? [] : [`the ${adapter.id} adapter does not implement ${entry.capability}`]),
          ...(declaredHere ? [] : [`no .flow operation declares ${entry.capability} for ${adapter.id}`]),
          ...(reachable.state === 'available' ? [] : [reachable.detail]),
          ...(credentialsPresent ? [] : [`credential ${Object.entries(credentials).filter(([, present]) => !present).map(([name]) => name).join(', ')} is not configured`]),
          ...(configured || capabilityResourceKind(entry.capability) === 'repository' ? [] : [`no environment or desired state names ${adapter.id}`]),
        ];
        return {
          capability: entry.capability,
          operation: entry.operation,
          implementation: implemented,
          declared: declaredHere,
          available: reachable.state === 'available',
          availability: reachable.detail,
          credential: credentialsPresent,
          configuration: configured || capabilityResourceKind(entry.capability) === 'repository',
          executable: reasons.length === 0,
          reasons,
          requiredAuthority: entry.authority ? [...entry.authority.capabilities] : [],
          verificationRequires: REQUIRED_VERIFICATION[entry.capability] ?? null,
          idempotency: implemented ? adapter.idempotency(entry.capability) : null,
          recent: recent.filter((action) => action.capability === entry.capability).map((action) => ({
            id: action.id, status: action.status, outcome: action.outcome ?? null, updatedAt: action.updatedAt,
          })),
        };
      };
      const implementedOnly = adapter.capabilities
        .filter((capability) => !declared.some((entry) => entry.capability === capability))
        .map((capability) => ({ capability, operation: null }));

      return {
        id: adapter.id,
        name: adapter.displayName,
        status,
        detail: declared.length === 0 ? 'no .flow operation declares a capability this adapter implements' : availability.detail,
        configured,
        credentials: [...adapter.credentials],
        credentialsPresent: credentials,
        executable: status === 'available' && credentialsPresent && declared.length > 0,
        note: 'implemented, declared, available, credential and configuration describe whether Factory can reach the provider; authorization is decided per Action by AuthBoundry',
        capabilities: [
          ...declared.map((entry) => describe(entry, true)),
          ...unimplemented.map((entry) => describe(entry, false)),
          ...implementedOnly.map((entry) => describe(entry, true)),
        ],
        vocabulary: OPERATIONAL_CAPABILITIES.filter((capability) =>
          !adapter.capabilities.includes(capability) && !declared.some((entry) => entry.capability === capability)),
        projects,
        recentActions: recent.map((action) => ({
          id: action.id, capability: action.capability ?? null, resource: action.resource ?? null,
          status: action.status, outcome: action.outcome ?? null, updatedAt: action.updatedAt,
        })),
      };
    }));
  }

  /**
   * Ask AuthBoundry whether an Action may execute without a person.
   *
   * Factory does not decide this. It asks, with the caller's own credentials,
   * and takes the answer: a denial means a human has to approve, which is the
   * default whenever nobody has granted autonomy.
   */
  async autonomyDecision(probe?: CapabilityProbe): Promise<AutonomyDecision> {
    if (!probe) {
      return {
        capability: AUTONOMOUS_EXECUTION_CAPABILITY,
        allowed: false,
        reason: 'no AuthBoundry session was available to ask',
      };
    }
    const decision = await probe(AUTONOMOUS_EXECUTION_CAPABILITY);
    if (this.config.mode === 'remote') {
      try {
        const semantic = await this.db.semanticDecisions.execute({
          definition: { kind: 'binary', predicate: AUTONOMOUS_EXECUTION_CAPABILITY },
          context: {
            authBoundryAllowed: decision.allowed,
            authBoundryReason: decision.reason,
            authorityReconciliationHealthy: this.authorityReconciliation?.health.reconciliation.healthy === true,
          },
          options: {
            application_id: this.authorityReconciliation?.health.application.id ?? this.applicationId,
            schema_version: 'factory-action-autonomy/1',
          },
          runtime: {
            kind: 'recording',
            metadata: {
              runtime: 'factory-autonomy-projection',
              model_revision: 'authboundry-projection/1',
              decision_schema_revision: 'factory-action-autonomy/1',
              execution_method: 'structured',
            },
            result: {
              kind: 'binary',
              decision: decision.allowed,
              option_mass: 1,
              supporting_fields: ['authBoundryAllowed', 'authBoundryReason', 'authorityReconciliationHealthy'],
            },
          },
        });
        return {
          capability: AUTONOMOUS_EXECUTION_CAPABILITY,
          allowed: decision.allowed,
          reason: decision.reason,
          ...(semantic.evaluation.evidence[0]?.decision_id
            ? { semanticDecisionId: semantic.evaluation.evidence[0].decision_id }
            : {}),
        };
      } catch (error) {
        return {
          capability: AUTONOMOUS_EXECUTION_CAPABILITY,
          allowed: false,
          reason: `FeltDB semantic decision unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return {
      capability: AUTONOMOUS_EXECUTION_CAPABILITY,
      allowed: decision.allowed,
      reason: decision.reason,
    };
  }

  /**
   * Plan an Action against a project's desired state.
   *
   * The plan is derived from what the repository actually contains, so an
   * operator states the outcome and Factory works out the steps. The Action is
   * only planned here: nothing is authorized and nothing executes.
   */
  async createAction(context: AuthenticatedContext, projectId: string, input: {
    type?: string;
    intent?: string;
    environmentId?: string;
    repositoryId?: string;
    operation?: string;
    capability?: string;
    parameters?: Record<string, unknown>;
    graph?: { id: string; dependsOn: string[]; sequence: number };
  }, probe?: CapabilityProbe): Promise<ActionRecord> {
    const tenantId = context.tenant;
    const project = await this.domain.getProject(tenantId, projectId);
    if (!project) throw new DomainValidationError(`project ${projectId} was not found`);
    const authorities = getOperationAuthorities(this.flowSpec);

    /*
     * An Action names what it needs done. When that is an operational
     * capability, the provider and the `.flow` operation are resolved from
     * durable configuration rather than named by the caller; when it is an
     * operation, the operation is checked against `.flow` as before.
     */
    const capability = input.capability ?? (isOperationalCapability(input.type) ? input.type : undefined);
    if (capability !== undefined && !isOperationalCapability(capability)) {
      throw new DomainValidationError(`${capability} is not an operational capability Factory knows`);
    }
    const type = input.type ?? capability;
    if (!type) throw new DomainValidationError('an action needs a type or a capability');
    let operation = input.operation ?? type;
    if (!capability && !authorities.has(operation)) {
      throw new DomainValidationError(
        `no .flow operation named ${operation}; declared operations are ${[...authorities.keys()].sort().join(', ')}`,
      );
    }

    const repositories = await this.domain.listRepositories(tenantId, projectId);
    const desiredState = await this.domain.getDesiredState(tenantId, projectId);
    const repository = input.repositoryId
      ? repositories.find((candidate) => candidate.id === input.repositoryId) ?? null
      : repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId) ?? repositories[0] ?? null;

    let environment: EnvironmentRecord | null = null;
    if (input.environmentId) {
      environment = await this.domain.getEnvironment(tenantId, projectId, input.environmentId);
      if (!environment) throw new DomainValidationError(`environment ${input.environmentId} was not found`);
    }

    const discovery = await this.discover(repository);

    // Provider resolution is deterministic and never falls back. A capability
    // no `.flow` operation declares is refused; a capability whose configured
    // provider cannot satisfy it becomes a durable, explicit outcome.
    const providerContext: ProviderContext = { repository, environment, desiredState, discovery, idempotencyKey: '' };
    let resolved: ReturnType<typeof resolveProvider> | null = null;
    let unavailable: { outcome: 'provider-unavailable'; reason: string } | null = null;
    if (capability) {
      resolved = resolveProvider(this.registry, capability, providerContext);
      if (!resolved.ok && resolved.outcome === 'capability-unavailable') {
        throw new DomainValidationError(resolved.reason);
      }
      if (!resolved.ok) unavailable = { outcome: 'provider-unavailable', reason: resolved.reason };
      else operation = resolved.operation;
    } else {
      const authority = authorities.get(operation);
      if (authority?.provider && isOperationalCapability(authority.operationalCapability)) {
        // An operation names its own provider in .flow. It gains provider
        // execution only when that provider implements the capability; it is
        // never re-homed to another provider that happens to.
        resolved = resolveProvider(this.registry, authority.operationalCapability, providerContext);
        if (!resolved.ok || resolved.provider !== authority.provider || resolved.operation !== operation) resolved = null;
      }
    }
    const providerPlan = resolved?.ok ? planOperation(this.registry, resolved, providerContext) : null;

    const plan = planFromDiscovery({
      type,
      desiredState,
      discovery,
      repository,
      ...(environment ? { environmentName: environment.name } : {}),
    });

    if (providerPlan) {
      plan.splice(plan.length - 1, 0, {
        order: plan.length,
        summary: `${providerPlan.provider} performs ${providerPlan.capability} on ${providerPlan.resource}`,
        detail: providerPlan.expectedEffects.join('; '),
        basis: 'provider adapter plan',
      });
      plan.forEach((step, index) => { step.order = index + 1; });
    }

    const autonomy = await this.autonomyDecision(probe);
    const timestamp = new Date().toISOString();
    const action: ActionRecord = {
      id: `act_${randomUUID()}`,
      projectId,
      ...(environment ? { environmentId: environment.id } : {}),
      tenantId,
      type,
      intent: input.intent?.trim()
        || `Make ${project.name} match its desired state by running ${operation}`,
      plan,
      ...(discovery ? { discovery } : {}),
      ...(unavailable ? {} : { operation }),
      ...(!unavailable && providerForOperation(this.flowSpec, operation)
        ? { executionProvider: providerForOperation(this.flowSpec, operation)! }
        : {}),
      ...(capability ? { capability } : resolved?.ok ? { capability: resolved.capability } : {}),
      ...(resolved?.ok ? { provider: resolved.provider, resource: resolved.resource } : {}),
      ...(resolved?.ok && REQUIRED_VERIFICATION[resolved.capability]
        ? { verificationRequires: REQUIRED_VERIFICATION[resolved.capability]! }
        : {}),
      /*
       * Whether this waits for a person is the authority's answer, not a rule
       * Factory holds. An Action nobody is allowed to run autonomously is the
       * one a human is asked about.
       */
      status: unavailable ? 'failed' : autonomy.allowed ? 'planned' : 'awaiting-approval',
      ...(unavailable ? {
        outcome: unavailable.outcome,
        verification: [{ name: 'provider', status: 'failed' as const, detail: unavailable.reason }],
      } : {}),
      autonomy,
      ...(input.parameters ? { parameters: input.parameters } : {}),
      ...(input.graph ? {
        graphId: input.graph.id,
        dependsOn: input.graph.dependsOn,
        sequence: input.graph.sequence,
        relationships: input.graph.dependsOn.map((actionId) => ({ kind: 'depends_on' as const, actionId })),
      } : {}),
      createdBy: context.principal,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.domain.createAction(action);
  }

  /**
   * Authorize and execute a planned Action.
   *
   * Execution goes through the same authority, contract, and evidence path as
   * any other Factory run: the Action supplies intent and a durable work
   * record, and `.flow` plus AuthBoundry decide the rest. There is no separate
   * Action execution path and no demonstration path.
   */
  async runAction(
    context: AuthenticatedContext,
    actionId: string,
    options: { probe?: CapabilityProbe; autonomous?: boolean } = {},
  ): Promise<ActionRecord> {
    const tenantId = context.tenant;
    const action = await this.domain.getAction(tenantId, actionId);
    if (!action) throw new DomainValidationError(`action ${actionId} was not found`);
    /*
     * Terminal and in-flight Actions stop here, before anything below runs.
     * A finished Action is finished: running it again would reach the
     * provider boundary a second time, and a failed one comes back only
     * through an explicit retry, which returns it to planned first. A
     * cancelled one never runs.
     */
    if (action.status === 'running' || action.status === 'authorized'
      || action.status === 'executed' || action.status === 'verifying') return action;
    if (action.status === 'succeeded' || action.status === 'failed') return action;
    if (action.outcome === 'cancelled') return action;
    // An unknown outcome is never re-run blindly: reality resolves it first,
    // and only a resolution that finds a repeat safe returns it to planned.
    if (action.status === 'unknown') return action;

    /*
     * The authority is asked again here rather than trusting the answer stored
     * when the Action was planned: a grant can be given or revoked in between,
     * and the question that matters is whether this may run now.
     *
     * Factory acting on its own needs that answer to be yes. A person driving
     * the Action is the human judgement the authority asked for, and their
     * approval is recorded on the Action.
     */
    const autonomy = await this.autonomyDecision(options.probe);
    if (options.autonomous && !autonomy.allowed) {
      await this.domain.patchAction(tenantId, actionId, {
        status: 'awaiting-approval',
        autonomy,
        outcome: isAuthorityUnavailable(autonomy.reason) ? 'authority-unavailable' : 'autonomy-denied',
      });
      throw new DomainValidationError(
        `action ${actionId} may not execute autonomously: ${autonomy.reason}`,
      );
    }
    await this.domain.patchAction(tenantId, actionId, {
      autonomy,
      ...(options.autonomous ? {} : { approvedBy: context.principal }),
    });

    const repositories = await this.domain.listRepositories(tenantId, action.projectId);
    const desiredState = await this.domain.getDesiredState(tenantId, action.projectId);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId)
      ?? repositories[0];
    if (!repository) {
      throw new DomainValidationError(`project ${action.projectId} has no repository to act on`);
    }
    const requestedAt = new Date().toISOString();
    const idempotencyKey = action.retries ? `${action.id}:retry:${action.retries}` : action.id;
    const providerContext = await this.providerContext(tenantId, action, repository, desiredState, idempotencyKey);

    /*
     * Execution preflight. Every check is deterministic, every check is
     * recorded on the Action, and the provider is reached only after all of
     * them passed. A failure here is a durable, specific outcome — never a
     * provider side effect and never a generic error.
     */
    const checks: VerificationCheck[] = [];
    const failPreflight = async (outcome: ActionOutcome, reason: string, phase: ActionFailurePhase = 'preflight') => {
      const name = phase === 'preflight' ? outcome : phase;
      checks.push({ name, status: 'failed', detail: reason });
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'failed',
        outcome,
        failure: { phase, outcome, reason },
        preflight: { checks, failedAt: new Date().toISOString() },
        execution: { requestedAt },
        verification: [{ name, status: 'failed', detail: reason }],
      })) ?? action;
    };

    let resolution: Extract<ProviderResolution, { ok: true }> | null = null;
    let binding: Extract<ResourceBinding, { ok: true }> | null = null;
    if (action.capability) {
      if (!isOperationalCapability(action.capability) || this.registry.providersFor(action.capability).length === 0) {
        return failPreflight('capability-unavailable', `${action.capability} is not a capability Factory can perform`);
      }
      checks.push({ name: 'capability supported', status: 'passed', detail: `${action.capability} is declared by .flow and implemented by an adapter` });
      const resolved = resolveProvider(this.registry, action.capability, providerContext);
      if (!resolved.ok) return failPreflight(resolved.outcome, resolved.reason);
      if (resolved.provider !== action.provider) {
        return failPreflight('provider-unavailable', `provider ${action.provider} is no longer the configured provider; ${resolved.provider} is`);
      }
      checks.push({ name: 'provider resolved', status: 'passed', detail: `${resolved.provider} performs ${resolved.capability} as ${resolved.operation}` });
      const adapter = this.registry.adapter(resolved.provider)!;
      const availability = await adapter.availability(resolved.capability);
      if (availability.state !== 'available') return failPreflight('provider-unavailable', availability.detail);
      checks.push({ name: 'provider available', status: 'passed', detail: availability.detail });
      const bound = adapter.resource(resolved.capability, providerContext);
      if (!bound.ok) return failPreflight('resource-unavailable', bound.reason);
      checks.push({ name: 'resource bound', status: 'passed', detail: `${resolved.resource} → ${bound.id} (${bound.detail})` });
      checks.push({
        name: 'configuration present',
        status: 'passed',
        detail: Object.keys(bound.parameters).length ? Object.keys(bound.parameters).sort().join(', ') : 'no parameters required',
      });
      // Presence by name only. The value is read inside the boundary, later.
      const missing = adapter.credentials.filter((name) => !this.credentialResolver(name));
      if (missing.length > 0) {
        return failPreflight('credential-unavailable', `credential ${missing.join(', ')} is not available to the execution boundary`);
      }
      checks.push({
        name: 'credentials available',
        status: 'passed',
        detail: adapter.credentials.length ? `${adapter.credentials.join(', ')} present (names only)` : 'none required',
      });
      resolution = resolved;
      binding = bound;
    } else {
      checks.push({ name: 'capability supported', status: 'skipped', detail: `${action.operation ?? action.type} is a declared .flow operation rather than a provider capability` });
    }

    const authority = this.authorityContext(context);
    if (!authority) {
      const reason = this.connection.status === 'associated'
        ? `AuthBoundry authorized no application context for ${context.principal}`
        : this.connection.reason;
      return failPreflight('authority-unavailable', reason, 'authority');
    }
    checks.push({ name: 'authority available', status: 'passed', detail: `${authority.application ?? 'application'} via ${authority.delegation ?? 'claim'}` });
    await this.domain.patchAction(tenantId, actionId, {
      status: 'authorized',
      authority,
      preflight: { checks, passedAt: new Date().toISOString() },
      execution: { requestedAt },
    });

    const work = await this.ensureActionWork(action, repository, context, desiredState?.sourceBranch);
    const execution = resolution && binding ? providerExecution(this.registry, resolution, providerContext, binding) : undefined;

    // A checkout may name the revision it must reach. It is a parameter of the
    // Action, validated as a git object name, never a provider resource.
    const revision = typeof action.parameters?.revision === 'string' && /^[0-9a-f]{7,40}$/i.test(action.parameters.revision)
      ? action.parameters.revision.toLowerCase()
      : undefined;
    const run = await this.startRun({
      workId: work.id,
      repository: {
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
        ref: desiredState?.sourceBranch ?? repository.defaultBranch,
        ...(revision ? { commit: revision } : {}),
        ...(!this.config.repositoryRoot && repositoryRemoteUrl(repository) ? { url: repositoryRemoteUrl(repository)! } : {}),
      },
      operation: action.operation ?? action.type,
      // A retried Action is admitted as a new Run; the earlier Run is history.
      ...(action.retries ? { idempotencyKey } : {}),
    }, context, execution, {
      actionId,
      // The Run is on the Action as soon as it exists, so a cancel request
      // made while the provider is working finds the process to stop.
      onAdmitted: async (admitted) => {
        // Both records point at each other from the first moment, so a
        // recovery on another worker can settle the Action from the Run.
        await this.patchRun(admitted.id, {
          actionId: action.id,
          projectId: action.projectId,
          ...(action.environmentId ? { environmentId: action.environmentId } : {}),
        });
        await this.domain.patchAction(tenantId, actionId, { status: 'running', runId: admitted.id });
      },
    });

    await this.patchRun(run.id, {
      actionId: action.id,
      projectId: action.projectId,
      ...(action.environmentId ? { environmentId: action.environmentId } : {}),
      ...(authority.application ? { applicationId: authority.application } : {}),
      ...(authority.delegation ? { delegationId: authority.delegation } : {}),
      ...(action.executionProvider ? { executionProvider: action.executionProvider } : {}),
    });

    return this.settleAction(tenantId, action, run.id, authority, requestedAt, providerContext);
  }

  /**
   * Read what the Run and its evidence say, verify against reality, and write
   * the Action's final state. This runs after execution and again after a
   * restart that interrupted verification: everything it needs is durable.
   */
  private async settleAction(
    tenantId: string,
    action: ActionRecord,
    runId: string,
    authority: AuthorityContextRecord,
    requestedAt: string,
    providerContext: ProviderContext,
  ): Promise<ActionRecord> {
    const actionId = action.id;
    const settled = await this.getRun(runId);
    const current = (await this.domain.getAction(tenantId, actionId)) ?? action;
    const cancelRequestedAt = current.execution?.cancelRequestedAt;
    let evidenceRecord = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);

    // Authorization refused: nothing ran, and the Run says why.
    if (settled?.status === 'failed' && !evidenceRecord) {
      const reason = settled.error ?? 'AuthBoundry did not authorize the execution';
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'failed',
        outcome: 'execution-failed',
        failure: { phase: 'authorization', outcome: 'execution-failed', reason },
        runId,
        authority: { ...authority, ...(settled.authorizationDecisionId ? { authorizationDecisionId: settled.authorizationDecisionId } : {}) },
        verification: [{ name: 'authorization', status: 'failed', detail: reason }],
        execution: { requestedAt, ...(cancelRequestedAt ? { cancelRequestedAt } : {}) },
      })) ?? action;
    }

    // Another worker owns the Run; this worker records nothing about it.
    if (settled && !isTerminal(settled.status) && settled.status !== 'unknown') {
      return current;
    }

    /*
     * The outcome is unknown: the provider may have acted and Factory did not
     * see the result. The Action says so — not failed — and waits for reality.
     */
    if (settled?.status === 'unknown') {
      const reason = settled.uncertainty?.reason ?? 'the external outcome could not be determined';
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'unknown',
        outcome: 'unknown',
        failure: { phase: 'unknown', outcome: 'unknown', reason },
        runId,
        authority: { ...authority, ...(settled.authorizationDecisionId ? { authorizationDecisionId: settled.authorizationDecisionId } : {}) },
        verification: [{ name: 'outcome', status: 'skipped', detail: 'uncertain: Factory is verifying external state before retrying' }],
        execution: {
          requestedAt,
          ...(evidenceRecord ? { startedAt: evidenceRecord.startedAt, completedAt: evidenceRecord.completedAt, durationMs: evidenceRecord.durationMs } : {}),
          ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
        },
      })) ?? action;
    }

    if (settled?.status === 'completed' && current.status !== 'executed' && current.status !== 'verifying') {
      await this.domain.patchAction(tenantId, actionId, { status: 'executed' });
    }

    /*
     * The adapter reads the provider's answer back into a structured result,
     * which is recorded on the evidence; then verification asks reality. Both
     * read the durable evidence, so a later reader sees what verification saw.
     */
    let providerResult: ProviderExecutionResult | null = null;
    if (evidenceRecord && action.provider && isOperationalCapability(action.capability)) {
      providerResult = interpretOperation(this.registry, action, evidenceRecord, providerContext);
      if (providerResult) {
        evidenceRecord = { ...evidenceRecord, providerResult };
        await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(evidenceRecord, evidenceRecord.id);
        // The provider's own reference for the attempt lives on the Run too.
        await this.patchRun(runId, { providerOperationId: providerResult.providerOperationId });
      }
    }
    await this.domain.patchAction(tenantId, actionId, { status: 'verifying' });
    const operationChecks = evidenceRecord && settled?.status === 'completed'
      ? await verifyOperation(this.registry, action, evidenceRecord, providerContext)
      : [];
    const verification = await this.verifyRun(runId, providerContext.desiredState?.healthRequirement, operationChecks);
    verification.push(...operationChecks);
    await this.checkpoint('after-verification-before-completion', { runId, actionId });

    const persisted = await this.getRun(runId);
    const cancelled = persisted?.status === 'cancelled' || evidenceRecord?.status === 'cancelled' || Boolean(cancelRequestedAt && persisted?.status !== 'completed');
    const failedChecks = verification.filter((check) => check.status === 'failed');
    const unverified = operationChecks.filter((check) => check.status === 'skipped');
    const succeeded = !cancelled && persisted?.status === 'completed' && failedChecks.length === 0 && unverified.length === 0;

    let observedReality: EnvironmentRecord['currentState'] | undefined;
    if (succeeded && action.environmentId) {
      await this.recordReconciledState(tenantId, action.projectId, action.environmentId, runId, verification);
      observedReality = (await this.domain.getEnvironment(tenantId, action.projectId, action.environmentId))?.currentState;
    }

    let outcome: ActionOutcome;
    let failure: ActionRecord['failure'];
    if (cancelled) {
      outcome = 'cancelled';
      failure = { phase: 'execution', outcome, reason: persisted?.error ?? 'cancelled before the operation completed' };
    } else if (succeeded) {
      outcome = 'succeeded';
    } else if (persisted?.status === 'completed') {
      outcome = failedChecks.length ? 'verification-failed' : 'verification-unavailable';
      failure = { phase: 'verification', outcome, reason: (failedChecks[0] ?? unverified[0])?.detail ?? 'verification did not establish the required state' };
    } else if (evidenceRecord?.execution?.terminationReason === 'spawn-failed') {
      outcome = 'provider-unavailable';
      failure = { phase: 'provider', outcome, reason: evidenceRecord.stderr.trim() || 'the provider mechanism could not be started' };
    } else if (providerResult?.status === 'rejected') {
      outcome = 'execution-failed';
      failure = { phase: 'provider', outcome, reason: providerResult.summary };
    } else {
      outcome = 'execution-failed';
      const reason = evidenceRecord?.execution?.terminationReason === 'timeout'
        ? `timed out after ${evidenceRecord.execution.timeoutMs}ms`
        : persisted?.error?.trim() || providerResult?.summary || 'the operation did not complete';
      failure = { phase: 'execution', outcome, reason: reason.split('\n').pop()!.slice(0, 500) };
    }

    // The chain, on the evidence, so it can be reconstructed from there alone.
    if (evidenceRecord && persisted) {
      const work = action.graphId ? await this.domain.findOperationalWorkByGraph(tenantId, action.graphId) : null;
      evidenceRecord = {
        ...evidenceRecord,
        chain: {
          ...(work ? { operationalWorkId: work.id } : {}),
          ...(action.graphId ? { graphId: action.graphId } : {}),
          actionId,
          runId,
          attempt: persisted.attempt ?? 1,
          ...(persisted.executionOwner ? { executionOwner: persisted.executionOwner } : {}),
          authorizationDecisionId: persisted.authorizationDecisionId ?? evidenceRecord.authorizationDecisionId,
          ...(action.provider ? { provider: action.provider } : {}),
          ...(action.capability ? { capability: action.capability } : {}),
          ...(action.resource ? { resource: action.resource } : {}),
          ...(evidenceRecord.provider?.providerResource ? { providerResource: evidenceRecord.provider.providerResource } : {}),
          idempotencyKey: evidenceRecord.provider?.idempotency.key ?? persisted.idempotencyKey,
          providerOperationId: providerResult?.providerOperationId ?? null,
          verification,
          ...(observedReality ? { observedReality } : {}),
        },
      };
      await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(evidenceRecord, evidenceRecord.id);
    }

    return (await this.domain.patchAction(tenantId, actionId, {
      status: succeeded ? 'succeeded' : 'failed',
      outcome,
      ...(failure ? { failure } : {}),
      runId,
      authority: {
        ...authority,
        ...(persisted?.authorizationDecisionId ? { authorizationDecisionId: persisted.authorizationDecisionId } : {}),
      },
      verification,
      execution: {
        requestedAt,
        ...(evidenceRecord ? {
          startedAt: evidenceRecord.startedAt,
          completedAt: evidenceRecord.completedAt,
          durationMs: evidenceRecord.durationMs,
          exitCode: evidenceRecord.exitCode,
          ...(evidenceRecord.execution?.terminationReason ? { terminationReason: evidenceRecord.execution.terminationReason } : {}),
        } : {}),
        ...(providerResult ? {
          providerStatus: providerResult.status,
          providerOperationId: providerResult.providerOperationId,
          ...(providerResult.observed.revision ? { observedRevision: providerResult.observed.revision } : {}),
        } : {}),
        ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
      },
    })) ?? action;
  }

  /**
   * Resolve an Action whose outcome is unknown by observing reality.
   *
   * The provider is asked what is, never to do it again. An effect that is
   * observably in place makes the Action succeeded, with the observation as
   * its verification; an effect that observably did not happen makes it
   * failed; an operation with no external effect is returned to planned for
   * an explicit retry; and anything reality cannot settle stays unknown, with
   * the observation recorded.
   */
  async resolveUncertainAction(context: AuthenticatedContext, actionId: string): Promise<ActionRecord> {
    const tenantId = context.tenant;
    const action = await this.domain.getAction(tenantId, actionId);
    if (!action) throw new DomainValidationError(`action ${actionId} was not found`);
    if (action.status !== 'unknown' || !action.runId) return action;
    const run = await this.domain.getRun(tenantId, action.runId);
    if (!run || run.status !== 'unknown') return action;

    const repositories = await this.domain.listRepositories(tenantId, action.projectId);
    const desiredState = await this.domain.getDesiredState(tenantId, action.projectId);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId) ?? repositories[0] ?? null;
    const providerContext = await this.providerContext(tenantId, action, repository, desiredState, run.idempotencyKey);
    const adapter = action.provider ? this.registry.adapter(action.provider) : null;
    const recorded = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(run.id);
    // What the operation meant to leave behind: the revision the lost run
    // checked out when it is on record, else the repository head the desired
    // branch resolves to — the same revision a run of this Action deploys.
    const intendedRevision = recorded?.revision?.observed ?? recorded?.revision?.requested ?? recorded?.repository.commit
      ?? providerContext.discovery?.signals.headCommit;
    const observation = adapter && isOperationalCapability(action.capability)
      ? await adapter.observe(action.capability, providerContext, intendedRevision ? { revision: intendedRevision } : undefined)
      : run.uncertainty?.retrySafe
        ? { outcome: 'retry-safe' as const, detail: 'the operation has no external effect', checks: [], observed: {} }
        : { outcome: 'undetermined' as const, detail: 'no adapter can observe this operation', checks: [], observed: {} };
    const at = new Date().toISOString();
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    const observations = [...(run.uncertainty?.observations ?? []), { at, outcome: observation.outcome, detail: observation.detail }];
    const evidence = this.db.collection<StructuredEvidence>(COLLECTIONS.evidence);
    const record = await evidence.get(run.id);

    if (observation.outcome === 'established') {
      const resolved = await this.patchRun(run.id, {
        status: 'completed',
        completedAt: run.completedAt ?? at,
        finishedAt: at,
        error: undefined,
        result: { resolvedByObservation: true },
        uncertainty: { ...run.uncertainty!, observations, resolvedAt: at, resolvedBy: 'observation', resolution: 'succeeded' },
      });
      const verification: VerificationCheck[] = [
        { name: 'outcome resolved by observation', status: 'passed', detail: observation.detail },
        ...observation.checks,
      ];
      if (record) {
        await evidence.put({
          ...record,
          providerResult: {
            status: 'succeeded', providerOperationId: record.providerResult?.providerOperationId ?? null,
            startedAt: record.startedAt, completedAt: at, durationMs: record.durationMs,
            metadata: { resolvedByObservation: true }, observed: observation.observed, summary: observation.detail,
          },
          resolution: { resolvedAt: at, resolvedBy: 'observation', resolution: 'succeeded', checks: verification },
        }, record.id);
      }
      if (action.environmentId) {
        await this.recordReconciledState(tenantId, action.projectId, action.environmentId, resolved.id, verification);
      }
      await this.appendEvent(run.id, 'completed', `resolved by observation: ${observation.detail}`);
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'succeeded', outcome: 'succeeded', failure: undefined, verification,
        execution: { ...(action.execution ?? { requestedAt: at }), completedAt: at, providerStatus: 'succeeded' },
      })) ?? action;
    }

    if (observation.outcome === 'absent') {
      await this.patchRun(run.id, {
        status: 'failed', completedAt: at, finishedAt: at, error: observation.detail,
        uncertainty: { ...run.uncertainty!, observations, resolvedAt: at, resolvedBy: 'observation', resolution: 'failed' },
      });
      if (record) await evidence.put({ ...record, resolution: { resolvedAt: at, resolvedBy: 'observation', resolution: 'failed', checks: observation.checks } }, record.id);
      await this.appendEvent(run.id, 'failed', `resolved by observation: ${observation.detail}`);
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'failed', outcome: 'execution-failed',
        failure: { phase: 'execution', outcome: 'execution-failed', reason: observation.detail },
        verification: [{ name: 'outcome resolved by observation', status: 'failed', detail: observation.detail }, ...observation.checks],
      })) ?? action;
    }

    if (observation.outcome === 'retry-safe') {
      // Superseded by an explicit new attempt; the unknown Run stays as history.
      await runs.put({ ...run, uncertainty: { ...run.uncertainty!, observations, resolvedAt: at, resolvedBy: 'retry', resolution: 'retried' }, updatedAt: at }, run.id);
      await this.appendEvent(run.id, 'unknown', `resolved: ${observation.detail}; a new attempt is admitted`);
      return (await this.domain.patchAction(tenantId, actionId, {
        status: 'planned',
        retries: (action.retries ?? 0) + 1,
        previousRunIds: [...(action.previousRunIds ?? []), run.id],
        runId: undefined, verification: undefined, outcome: undefined, failure: undefined, blockedBy: [],
        execution: undefined,
      })) ?? action;
    }

    await runs.put({ ...run, uncertainty: { ...run.uncertainty!, observations }, updatedAt: at }, run.id);
    return (await this.domain.patchAction(tenantId, actionId, {
      verification: [
        { name: 'outcome', status: 'skipped', detail: 'uncertain: Factory is verifying external state before retrying' },
        ...observation.checks,
      ],
      failure: { phase: 'unknown', outcome: 'unknown', reason: observation.detail },
    })) ?? action;
  }

  /**
   * Recover execution state after this process (or another worker) stopped.
   *
   * Durable Runs decide everything. A Run whose lease another worker still
   * holds is left alone. An expired or unowned non-terminal Run is settled
   * from what it had reached: before invocation it is failed and known; in
   * flight it is unknown, never failed; past persistence its verification is
   * resumed. Nothing is replayed, and nothing is fabricated.
   */
  async recoverExecution(now = Date.now()): Promise<void> {
    const runs = await this.db.collection<RunRecord>(COLLECTIONS.runs).all();
    for (const run of runs) {
      if (isTerminal(run.status) || run.status === 'unknown') continue;
      if (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > now && run.executionOwner !== this.workerId) continue;
      if (this.activeExecutions.has(run.id)) continue;
      const action = run.actionId ? await this.db.collection<ActionRecord>(COLLECTIONS.actions).get(run.actionId) : null;
      const reason = 'Factory restarted before execution reached a terminal state';

      if (run.status === 'verifying' || (run.status === 'executing' && run.evidenceId)) {
        // The provider's answer is on record; only verification was interrupted.
        const persisted = await this.patchRun(run.id, { status: 'completed', completedAt: run.completedAt ?? new Date(now).toISOString(), finishedAt: new Date(now).toISOString() });
        await this.appendEvent(run.id, 'completed', 'recovered: evidence was persisted before the interruption; verification resumes');
        if (action) await this.resumeSettlement(action, persisted);
        continue;
      }
      if (run.status === 'executing') {
        const contract = (await this.db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).get(run.id))?.contract;
        const retrySafe = contract?.provider ? Boolean(contract.provider.idempotency.exactlyOnce) : contract?.execution.mode !== 'integration';
        await this.markRunUnknown(run.id, `${reason}; the provider had been invoked`, true, retrySafe, contract);
        if (action) await this.markActionUnknown(action, run.id, `${reason}; the provider had been invoked`, now);
        continue;
      }

      // accepted, authorized, allocated, preparing: nothing reached a provider.
      const stamp = new Date(now).toISOString();
      await this.patchRun(run.id, { status: 'failed', completedAt: stamp, finishedAt: stamp, error: reason });
      await this.appendEvent(run.id, 'failed', 'Recovered interrupted non-terminal run from durable FeltDB state');
      try {
        const transition = await this.db.transitionOperation({ operationId: run.operationId, expectedVersion: run.operationVersion, to: 'failed', error: reason });
        await this.patchRun(run.id, { operationVersion: transition.operation.version });
      } catch {
        // Durable run state is authoritative for recovery even if the operation was already terminal.
      }
      if (action) {
        await this.db.collection<ActionRecord>(COLLECTIONS.actions).put({
          ...action,
          status: 'failed',
          outcome: 'execution-failed',
          runId: run.id,
          failure: { phase: 'interrupted', outcome: 'execution-failed', reason },
          verification: [...(action.verification ?? []), { name: 'execution', status: 'failed', detail: reason }],
          updatedAt: stamp,
        }, action.id);
      }
    }

    // Actions that never got a Run, or whose Run is gone, cannot be running.
    for (const action of await this.db.collection<ActionRecord>(COLLECTIONS.actions).all()) {
      if (!['authorized', 'running', 'executed', 'verifying'].includes(action.status)) continue;
      const run = action.runId ? await this.db.collection<RunRecord>(COLLECTIONS.runs).get(action.runId) : null;
      if (run && !isTerminal(run.status) && run.status !== 'unknown') continue; // live elsewhere
      if (run && run.status === 'completed') { await this.resumeSettlement(action, run); continue; }
      if (run && run.status === 'unknown') {
        await this.markActionUnknown(action, run.id, run.uncertainty?.reason ?? 'the external outcome could not be determined', now);
        continue;
      }
      const reason = 'Factory restarted before execution reached a terminal state';
      await this.db.collection<ActionRecord>(COLLECTIONS.actions).put({
        ...action,
        status: 'failed',
        outcome: run?.status === 'cancelled' ? 'cancelled' : 'execution-failed',
        failure: { phase: 'interrupted', outcome: run?.status === 'cancelled' ? 'cancelled' : 'execution-failed', reason },
        verification: [...(action.verification ?? []), { name: 'execution', status: 'failed', detail: reason }],
        updatedAt: new Date(now).toISOString(),
      }, action.id);
    }
  }

  private async markActionUnknown(action: ActionRecord, runId: string, reason: string, now = Date.now()): Promise<void> {
    await this.db.collection<ActionRecord>(COLLECTIONS.actions).put({
      ...action,
      status: 'unknown',
      outcome: 'unknown',
      runId,
      failure: { phase: 'unknown', outcome: 'unknown', reason },
      verification: [{ name: 'outcome', status: 'skipped', detail: 'uncertain: Factory is verifying external state before retrying' }],
      authority: action.authority ?? {},
      updatedAt: new Date(now).toISOString(),
    }, action.id);
  }

  /** Verification interrupted by a restart resumes from the durable evidence. */
  private async resumeSettlement(action: ActionRecord, run: RunRecord): Promise<void> {
    const tenantId = action.tenantId;
    const repositories = await this.domain.listRepositories(tenantId, action.projectId);
    const desiredState = await this.domain.getDesiredState(tenantId, action.projectId);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId) ?? repositories[0] ?? null;
    const providerContext = await this.providerContext(tenantId, action, repository, desiredState, run.idempotencyKey);
    await this.settleAction(tenantId, action, run.id, action.authority ?? {}, action.execution?.requestedAt ?? run.createdAt, providerContext);
  }

  /**
   * Stop an Action.
   *
   * A planned Action is marked cancelled and never runs. A running one has its
   * process stopped through the Run it is on, and its outcome is `cancelled`
   * however the provider answers afterwards.
   */
  async cancelAction(context: AuthenticatedContext, actionId: string): Promise<ActionRecord> {
    const tenantId = context.tenant;
    const action = await this.domain.getAction(tenantId, actionId);
    if (!action) throw new DomainValidationError(`action ${actionId} was not found`);
    const requestedAt = new Date().toISOString();
    const record = (stage: ActionCancellation['stage'], effect: ActionCancellation['effect'], detail: string): ActionCancellation =>
      ({ requestedAt, requestedBy: context.principal, stage, effect, detail });

    if (action.status === 'succeeded' || action.status === 'failed' || action.outcome === 'cancelled') {
      if (action.cancellation) return action;
      // Nothing to stop. Recording the request keeps the history honest.
      return (await this.domain.patchAction(tenantId, actionId, {
        cancellation: record('after-completion', 'none', `the Action had already ended as ${action.outcome ?? action.status}; nothing was cancelled and no effect was reversed`),
      })) ?? action;
    }
    if (action.status === 'planned' || action.status === 'awaiting-approval' || action.status === 'unknown') {
      const detail = action.status === 'unknown'
        ? `cancelled by ${context.principal} while the outcome was unknown; the provider may already have acted and nothing was reversed`
        : `cancelled by ${context.principal} before it ran; nothing reached a provider`;
      if (action.status === 'unknown' && action.runId) {
        const run = await this.domain.getRun(tenantId, action.runId);
        if (run?.uncertainty) {
          await this.db.collection<RunRecord>(COLLECTIONS.runs).put({
            ...run, uncertainty: { ...run.uncertainty, resolvedAt: requestedAt, resolvedBy: 'cancellation', resolution: 'cancelled' }, updatedAt: requestedAt,
          }, run.id);
        }
      }
      return (await this.domain.patchAction(tenantId, actionId, {
        outcome: 'cancelled',
        ...(action.status === 'unknown' ? { status: 'failed' } : {}),
        failure: { phase: action.status === 'unknown' ? 'unknown' : 'preflight', outcome: 'cancelled', reason: detail },
        cancellation: record('before-invocation', action.status === 'unknown' ? 'submitted' : 'not-started', detail),
      })) ?? action;
    }

    const run = action.runId ? await this.domain.getRun(tenantId, action.runId) : null;
    const external = action.provider ? !(this.registry.adapter(action.provider)?.idempotency(action.capability as never).exactlyOnce ?? true) : false;
    let cancellation: ActionCancellation;
    if (!run || ['accepted', 'authorized', 'allocated', 'preparing'].includes(run.status)) {
      cancellation = record('before-invocation', 'not-started', 'cancelled before the provider was invoked; nothing reached it');
    } else if (run.status === 'executing') {
      cancellation = external
        ? record('after-external-submission', 'submitted', `the ${action.provider} operation had been submitted; Factory stopped waiting for it and did not reverse it`)
        : record('native-execution', 'stopped', 'the local process was stopped; it had no external effect');
    } else {
      cancellation = record('during-verification', external ? 'submitted' : 'stopped', 'the operation had completed; only verification was still running, and the recorded outcome is the verified one');
    }
    const patched = (await this.domain.patchAction(tenantId, actionId, {
      execution: { requestedAt: action.execution?.requestedAt ?? requestedAt, ...action.execution, cancelRequestedAt: requestedAt },
      cancellation,
    })) ?? action;
    if (action.runId && cancellation.stage !== 'during-verification') await this.cancelRunAs(action.runId);
    return patched;
  }

  /**
   * Verification reads the durable evidence rather than the process that wrote
   * it, so a check reports what a later reader of FeltDB would also see.
   */
  private async verifyRun(runId: string, healthRequirement?: string, operationChecks: readonly VerificationCheck[] = []): Promise<VerificationCheck[]> {
    const evidence = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
    const checks: VerificationCheck[] = [{
      name: 'evidence recorded',
      status: evidence ? 'passed' : 'failed',
      detail: evidence ? `evidence ${evidence.id}` : 'no durable evidence was written for this run',
    }];
    if (evidence) {
      checks.push({
        name: 'deterministic result',
        status: evidence.finalResult === 'PASS' ? 'passed' : 'failed',
        detail: `${evidence.deterministicResult} / ${evidence.finalResult}`,
      });
      checks.push({
        name: 'authorized application context',
        status: evidence.authorizedApplication ? 'passed' : 'failed',
        detail: evidence.authorizedApplication
          ? `${evidence.authorizedApplication.resource} via ${evidence.authorizedApplication.delegationId}`
          : 'evidence carries no authorized application context',
      });
    }
    if (healthRequirement) {
      // Only a probe that actually ran can say the environment is healthy.
      const probe = operationChecks.find((check) => check.name === 'environment responds healthy');
      checks.push({
        name: healthRequirement,
        status: probe ? probe.status : 'skipped',
        detail: probe ? probe.detail ?? '' : 'not probed by this Action; environment.health verifies it',
      });
    }
    return checks;
  }

  /**
   * Actions act through a durable work record, because `.flow` authorization is
   * evaluated against authoritative work state rather than a request body.
   */
  private async ensureActionWork(
    action: ActionRecord,
    repository: RepositoryRecord,
    context: AuthenticatedContext,
    branch?: string,
  ): Promise<WorkRecord> {
    const works = this.db.collection<WorkRecord>(COLLECTIONS.work);
    const id = `work_${action.id}`;
    const existing = await works.get(id);
    if (existing) return existing;
    const record: WorkRecord = {
      id,
      ownerPrincipal: context.principal,
      tenantId: context.tenant,
      operation: action.operation ?? action.type,
      repositoryProvider: repository.provider,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      repositoryRef: branch ?? repository.defaultBranch,
      status: 'active',
    };
    await works.put(record, record.id);
    return record;
  }

  /**
   * The dashboard answer: what exists, what is in flight, what needs a human,
   * and on whose authority Factory is acting.
   */
  async overview(context: AuthenticatedContext): Promise<Record<string, unknown>> {
    const tenantId = context.tenant;
    const [projects, actions, runs] = await Promise.all([
      this.domain.listProjects(tenantId),
      this.domain.listActions(tenantId),
      this.domain.listRuns(tenantId),
    ]);

    const environmentsByProject = new Map<string, EnvironmentRecord[]>();
    for (const project of projects) {
      environmentsByProject.set(project.id, await this.domain.listEnvironments(tenantId, project.id));
    }

    const active = actions.filter((action) =>
      action.status === 'running' || action.status === 'authorized');
    const attention = actions.filter((action) =>
      action.status === 'awaiting-approval' || action.status === 'failed');
    const authorityRequest = this.authorityReconciliation?.record.request;
    const authorityAttention = authorityRequest?.status === 'pending_approval'
      ? [{
          id: authorityRequest.id,
          projectId: this.authorityReconciliation!.record.projectId,
          status: 'awaiting-approval',
          intent: this.authorityReconciliation!.health.reconciliation.reason
            ?? 'AuthBoundry authority provisioning requires operator approval',
          type: 'authority-reconciliation',
        }]
      : [];

    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        environments: (environmentsByProject.get(project.id) ?? []).map((environment) => ({
          id: environment.id,
          name: environment.name,
          state: environment.currentState ?? null,
        })),
        activeActions: active.filter((action) => action.projectId === project.id).length,
        attentionRequired: attention.filter((action) => action.projectId === project.id).length,
      })),
      activeActions: active.map((action) => ({
        id: action.id,
        type: action.type,
        intent: action.intent,
        projectId: action.projectId,
        environmentId: action.environmentId ?? null,
        status: action.status,
        startedAt: action.updatedAt,
      })),
      recentActivity: runs.slice(0, 20).map((run) => ({
        id: run.id,
        actionId: run.actionId ?? null,
        projectId: run.projectId ?? null,
        operation: run.operation,
        status: run.status,
        evidenceId: run.evidenceId ?? null,
        completedAt: run.completedAt ?? null,
      })),
      attentionRequired: [
        ...authorityAttention,
        ...attention.map((action) => ({
          id: action.id,
          projectId: action.projectId,
          status: action.status,
          intent: action.intent,
        })),
      ],
      authority: {
        application: this.authorityReconciliation?.health.application.id ?? this.association.applicationId,
        principals: this.authorityReconciliation
          ? [this.authorityReconciliation.health.principal.id]
          : this.association.agents.map((agent) => agent.principalId),
        // The association state, never "connected because a URL exists".
        state: this.connection.status,
        ...(this.connection.status === 'associated'
          ? { tenant: this.connection.association.tenantId, resource: this.connection.association.resource }
          : { reason: this.connection.reason }),
        ...(this.authorityReconciliation ? {
          health: this.authorityReconciliation.health,
          request: this.authorityReconciliation.record.request ?? null,
        } : {}),
      },
    };
  }

  connectionState(): FactoryConnectionState {
    return this.connection;
  }

  authorityState(): FactoryAuthorityReconciliation | null {
    return this.authorityReconciliation;
  }

  autonomousReady(): boolean {
    return this.connection.status === 'associated'
      && (this.authorityReconciliation?.health.reconciliation.healthy ?? true);
  }

  declaredAssociation(): FactoryAssociation {
    return this.association;
  }

  static async create(config: FactoryServiceConfig): Promise<FactoryService> {
    if (config.mode === 'remote') {
      resolveRemoteAuthorityBootstrap(config);
    }
    const db = await createFactoryDB(config);
    const service = new FactoryService(config, db);
    await service.provisionAuthority();
    await service.recoverExecution();
    return service;
  }

  async verifyRuntime(): Promise<void> {
    if (this.config.mode !== 'remote') {
      return;
    }
    resolveRemoteAuthorityBootstrap(this.config);
    if (this.appPort.protocol !== 'appport' || !this.appPort.applicationFingerprint) {
      throw new Error('AppPort application projection failed to initialize');
    }
    this.paxVersion = await verifyPax(this.config.paxExecutable);
  }

  /**
   * Begin continuous reconciliation.
   *
   * Nothing is reconciled because Factory started. Each record carries its own
   * next-due time, so a restart resumes the schedule the durable records
   * describe rather than sweeping every environment at boot.
   */
  startReconciliation(options: {
    context: () => Promise<AuthenticatedContext>;
    probe?: CapabilityProbe;
    tickMs?: number;
    leaseMs?: number;
    now?: () => number;
  }): SchedulerHandle {
    this.scheduler?.stop();
    this.scheduler = createReconciliationScheduler({
      service: this,
      context: options.context,
      ...(options.probe ? { probe: options.probe } : {}),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.now ? { now: options.now } : {}),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Factory reconciliation worker error: ${message}\n`);
      },
    });
    this.scheduler.start();
    return this.scheduler;
  }

  reconciliationWorker(): SchedulerHandle | null {
    return this.scheduler;
  }

  async shutdown(): Promise<void> {
    // A stopped worker stops heartbeating; its leases lapse and another
    // worker may reclaim them. Nothing here touches the Runs themselves.
    for (const stop of [...this.heartbeats]) stop();
    this.shuttingDown = true;
    this.scheduler?.stop();
    for (const execution of this.activeExecutions.values()) {
      execution.cancel();
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const runtime = this.db.runtime();
    const canonical = this.authorityReconciliation?.health;
    return {
      ok: this.config.mode === 'remote' ? canonical?.reconciliation.healthy === true : true,
      service: 'factory-runner',
      pax: this.paxVersion ? { version: this.paxVersion } : { configured: false },
      appport: {
        protocol: this.appPort.protocol,
        applicationFingerprint: this.appPort.applicationFingerprint,
      },
      appportServices: {
        product: 'appport-services',
        version: '0.4.3',
        managementUi: true,
      },
      runtime,
      authorities: {
        // Derived from the association AuthBoundry reports, not from the fact
        // that a URL was configured: a configured authority that holds no
        // Factory delegation is not a connected one.
        authBoundry: this.connection.status,
        feltDb: this.config.mode === 'remote' ? 'initialized' : 'development',
        appPort: 'initialized',
        appPortServices: 'initialized',
      },
      ...(canonical ?? this.legacyAuthorityHealth()),
    };
  }

  private legacyAuthorityHealth(): FactoryAuthorityHealth {
    const associated = this.connection.status === 'associated';
    const associatedApplicationId = this.connection.status === 'associated'
      ? this.connection.association.applicationId
      : undefined;
    const serviceCredential = Boolean(
      this.config.factoryServiceCredential ?? process.env.FACTORY_SERVICE_CREDENTIAL,
    );
    const capabilities = new Set<string>();
    if (this.connection.status === 'associated') {
      for (const agent of this.connection.association.agents) {
        for (const capability of agent.capabilities) capabilities.add(capability);
      }
    }
    return {
      authBoundry: { reachable: this.connection.status !== 'unverified' },
      project: { discovered: false, expected: false },
      application: {
        discovered: associated,
        attached: false,
        ...(associatedApplicationId ? { project: 'unknown', id: associatedApplicationId } : {}),
      },
      manifest: { available: false },
      principal: {
        canonical: this.association.agents.some((agent) => agent.principalId === 'agent:factory-service'),
        present: associated,
        id: 'agent:factory-service',
      },
      policy: { complete: false, missing: [] },
      delegation: { complete: associated, missing: associated ? [] : ['factory-service'] },
      credentials: { service: serviceCredential },
      capabilities: {
        'factory.run': capabilities.has(FACTORY_REQUIRED_CAPABILITIES[0]),
        'factory.action.autonomous': capabilities.has(FACTORY_REQUIRED_CAPABILITIES[1]),
      },
      reconciliation: {
        healthy: false,
        reason: 'AuthBoundry canonical application discovery is unavailable',
      },
    };
  }

  /** The connection document: what AuthBoundry holds for this application. */
  connectionDocument(): Record<string, unknown> {
    if (this.authorityReconciliation) {
      return {
        status: this.connection.status,
        ...this.authorityReconciliation.health,
        discoveredManifest: this.authorityReconciliation.manifest,
        request: this.authorityReconciliation.record.request ?? null,
        ...(this.connection.status === 'associated'
          ? { authority: this.connection.association }
          : { reason: this.connection.reason }),
      };
    }
    const declared = {
      application: this.association.applicationId,
      capabilities: [...this.association.capabilities],
      agents: this.association.agents.map((agent) => agent.principalId),
    };
    return this.connection.status === 'associated'
      ? {
          status: 'associated',
          declared,
          authority: {
            tenant: this.connection.association.tenantId,
            application: this.connection.association.applicationId,
            agents: this.connection.association.agents.map((agent) => ({
              principal: agent.principalId,
              delegation: agent.delegationId,
              capabilities: [...agent.capabilities],
            })),
          },
        }
      : { status: this.connection.status, reason: this.connection.reason, declared };
  }

  requiredCapabilities(operation: string): string[] {
    return [...(getOperationAuthorities(this.flowSpec).get(operation)?.capabilities ?? [])];
  }

  composeUi(context: AuthenticatedContext): Promise<ComposedUi> {
    const uiContext: AppPortUiContext = {
      principal: { id: context.principal },
      tenant: context.tenant,
      application: this.applicationId,
      environment: this.environmentId,
      capabilities: context.authorizedCapabilities ?? [],
    };
    return composeProductUi(this.uiContributors, uiContext);
  }

  discoverUi(context: AuthenticatedContext): UiDiscoveryDocument {
    return filterUiContribution(factoryUiContribution, context.authorizedCapabilities ?? []);
  }

  handlesAppPortServices(pathname: string): boolean {
    return this.appPortServices.handles(pathname);
  }

  handleAppPortServices(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return this.appPortServices.handle(request, response);
  }

  async getRun(runId: string, context?: AuthenticatedContext): Promise<RunRecord | null> {
    const run = await this.db.collection<RunRecord>(COLLECTIONS.runs).get(runId);
    if (run && context && (run.principal !== context.principal || (run.tenantId && run.tenantId !== context.tenant))) {
      return null;
    }
    return run;
  }

  async getEvidence(runId: string, context?: AuthenticatedContext): Promise<StructuredEvidence | null> {
    const evidence = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
    if (evidence && context && (evidence.principal !== context.principal
      || (evidence.tenantId && evidence.tenantId !== context.tenant))) {
      return null;
    }
    return evidence;
  }

  async cancelRun(runId: string): Promise<RunRecord | null> {
    return this.cancelRunAs(runId);
  }

  async cancelRunAs(runId: string, principal?: string): Promise<RunRecord | null> {
    const run = await this.getRun(runId);
    if (!run) {
      return null;
    }

    if (principal && run.principal !== principal) {
      throw new Error(`principal ${principal} is not authorized to cancel run ${runId}`);
    }

    const active = this.activeExecutions.get(runId);
    if (active) {
      active.cancel();
    }

    if (isTerminal(run.status)) {
      return run;
    }

    const transition = await this.db.transitionOperation({
      operationId: run.operationId,
      expectedVersion: run.operationVersion,
      to: 'cancelled',
      error: 'Run cancelled by caller',
    });

    const cancelledRun = await this.patchRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Run cancelled by caller',
      operationVersion: transition.operation.version,
    });
    await this.appendEvent(runId, 'cancelled', 'Run cancelled by caller');
    return cancelledRun;
  }

  /** Kept for callers of the earlier name; recovery is one procedure. */
  async recoverInterruptedRuns(): Promise<void> {
    await this.recoverExecution();
  }

  /** Test-only failure injection. Production configures no hooks, so this is a no-op. */
  private async checkpoint(point: ExecutionCheckpoint, detail: { runId: string; actionId?: string }): Promise<void> {
    await this.config.executionHooks?.checkpoint(point, detail);
  }

  workerIdentity(): string {
    return this.workerId;
  }

  /**
   * Acquire durable ownership of a Run by compare-and-swap.
   *
   * Exactly one live worker owns a Run. A lease still held by another worker
   * refuses the acquisition; an expired one is reclaimed with the attempt
   * count advanced, and the record — not the reclaim — decides what the new
   * owner may do with it.
   */
  async acquireRunOwnership(runId: string, now = Date.now()): Promise<RunRecord | null> {
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    const current = await runs.get(runId);
    if (!current || isTerminal(current.status) || current.status === 'unknown') return null;
    const live = current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > now && current.executionOwner !== this.workerId;
    if (live) return null;
    const result = await runs.updateIfVersion(runId, current.__version ?? 1, {
      executionOwner: this.workerId,
      leaseExpiresAt: new Date(now + this.leaseMs).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      attempt: (current.attempt ?? 0) + 1,
      updatedAt: new Date(now).toISOString(),
    });
    return result.updated ? (result.item ?? (await runs.get(runId))) : null;
  }

  private readonly heartbeats = new Set<() => void>();

  private startHeartbeat(runId: string): () => void {
    const timer = setInterval(() => {
      const now = Date.now();
      void this.patchRun(runId, {
        heartbeatAt: new Date(now).toISOString(),
        leaseExpiresAt: new Date(now + this.leaseMs).toISOString(),
      }).catch(() => { /* the lease simply lapses */ });
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    const stop = () => { clearInterval(timer); this.heartbeats.delete(stop); };
    this.heartbeats.add(stop);
    return stop;
  }

  private async releaseRunOwnership(runId: string): Promise<void> {
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    const current = await runs.get(runId);
    if (!current || current.executionOwner !== this.workerId) return;
    const released: RunRecord = { ...current, finishedAt: current.finishedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    delete released.leaseExpiresAt;
    await runs.put(released, runId);
  }

  /**
   * The Run's outcome cannot be determined. This is not a failure and is
   * never written as one: it is recorded with why, whether the provider may
   * already have acted, and whether the provider's own semantics make a
   * repeat safe. Reality, not a retry, resolves it.
   */
  private async markRunUnknown(
    runId: string,
    reason: string,
    invocationMayHaveOccurred: boolean,
    retrySafe: boolean,
    contract?: ExecutionContractRecord['contract'],
  ): Promise<RunRecord | null> {
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    const current = await runs.get(runId);
    if (!current || isTerminal(current.status) || current.status === 'unknown') return current;
    const since = new Date().toISOString();
    const evidence = this.db.collection<StructuredEvidence>(COLLECTIONS.evidence);
    if (!(await evidence.get(runId))) {
      const stored = contract ?? (await this.db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).get(runId))?.contract;
      if (stored) {
        const unknown = buildFailureEvidence(stored, new Error(reason), current.startedAt ?? since, since, 'unknown', 'not-started');
        await evidence.put(unknown, unknown.id);
      }
    }
    const marked: RunRecord = {
      ...current,
      status: 'unknown',
      error: reason,
      uncertainty: { reason, since, invocationMayHaveOccurred, retrySafe, observations: [] },
      updatedAt: since,
    };
    delete marked.leaseExpiresAt;
    await runs.put(marked, runId);
    await this.appendEvent(runId, 'unknown', reason);
    try {
      await this.db.transitionOperation({ operationId: current.operationId, expectedVersion: current.operationVersion, to: 'failed', error: `unknown: ${reason}` });
    } catch { /* the durable run record is authoritative for uncertainty */ }
    return marked;
  }

  async startRun(
    request: RunRequest,
    principalOrContext: string | AuthenticatedContext,
    execution?: ProviderExecution,
    options: { onAdmitted?: (run: RunRecord) => Promise<void>; actionId?: string; retrySafe?: boolean } = {},
  ): Promise<RunRecord> {
    if (this.shuttingDown) {
      throw new Error('Factory service is shutting down');
    }
    validateRunRequest(request);
    const context: AuthenticatedContext = typeof principalOrContext === 'string'
      ? {
        principal: principalOrContext,
        tenant: this.config.tenantId ?? this.config.namespace ?? 'local',
        claims: {},
        session: null,
        delegation: null,
        boundaryVerified: false,
      }
      : principalOrContext;
    const principal = context.principal;
    if (!principal.trim()) {
      throw new Error('Authenticated principal is required');
    }
    const fingerprint = this.fingerprint(request, principal);
    const idempotencyKey = request.idempotencyKey ?? fingerprint;
    const admission = await this.db.admitOperation({
      idempotencyKey,
      kind: 'factory.run',
      operationFingerprint: fingerprint,
    });

    const runId = admission.operationId;
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    let run = await runs.get(runId);

    if (!run) {
      const initialRun: RunRecord = {
        id: runId,
        operationId: admission.operationId,
        operationVersion: admission.operation.version,
        workId: request.workId,
        principal,
        ...(context.boundaryVerified ? { tenantId: context.tenant } : {}),
        operation: request.operation,
        status: 'accepted',
        idempotencyKey,
        repository: { ...request.repository },
        createdAt: new Date(admission.operation.createdAt).toISOString(),
        updatedAt: new Date(admission.operation.createdAt).toISOString(),
      };
      try {
        await runs.insert(initialRun, initialRun.id);
        run = initialRun;
        await this.appendEvent(run.id, 'accepted', 'Durably admitted run request');
      } catch {
        run = await runs.get(runId);
        if (!run) {
          throw new Error(`Run ${runId} could not be created after durable admission`);
        }
      }
    } else if (isTerminal(run.status) || run.status !== 'accepted' || this.activeExecutions.has(run.id)) {
      return run;
    }
    await options.onAdmitted?.(run);
    const detail = { runId: run.id, ...(options.actionId ? { actionId: options.actionId } : {}) };
    await this.checkpoint('after-run-created', detail);

    await this.recordRequest(run.id, request, principal, context.tenant);

    await this.checkpoint('before-authorization', detail);
    const authorization = await authorizeExecution(this.db, this.flowSpec, context, request, run.id, {
      association: this.association,
      authorized: authorizedApplicationContext(
        this.connection.status === 'associated' ? this.connection.association : null,
        context.principal,
      ),
    }, execution);
    run = await this.patchRun(run.id, { authorizationDecisionId: authorization.decision.id });

    if (!authorization.allowed || !authorization.contract) {
      run = await this.patchRun(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: authorization.reason,
      });
      await this.appendEvent(run.id, 'failed', authorization.reason);
      return run;
    }

    const contract = authorization.contract;
    await this.recordContract(contract);
    this.appPort.bindContract(contract);
    run = await this.patchRun(run.id, {
      status: 'authorized',
      contractId: run.id,
    });
    await this.appendEvent(run.id, 'authorized', authorization.reason);
    await this.checkpoint('after-authorization', detail);

    // Durable ownership before anything is allocated. Another worker's live
    // lease means this worker does nothing with the Run.
    const owned = await this.acquireRunOwnership(run.id);
    if (!owned) return (await this.getRun(run.id)) ?? run;
    run = owned;
    await this.appendEvent(run.id, 'authorized', `execution owned by ${this.workerId}, attempt ${run.attempt ?? 1}`);
    await this.checkpoint('after-ownership', detail);
    const stopHeartbeat = this.startHeartbeat(run.id);
    const retrySafe = options.retrySafe ?? (execution ? execution.idempotency.exactlyOnce : contract.execution.mode !== 'integration');
    const activeRunId = run.id;
    // Set once the provider process exists. From then on a lost result is
    // unknown, not failed — unless the process was cancelled, which is known.
    let invoked = false;
    let executedStatus: StructuredEvidence['status'] | undefined;

    try {
      const startedAt = new Date().toISOString();
      const operation = await this.db.transitionOperation({
        operationId: run.operationId,
        expectedVersion: run.operationVersion,
        to: 'executing',
      });
      run = await this.patchRun(run.id, {
        status: 'allocated',
        operationVersion: operation.operation.version,
      });
      await this.appendEvent(run.id, 'allocated', 'Allocated ephemeral runner workspace');
      run = await this.patchRun(run.id, { status: 'preparing' });
      await this.appendEvent(run.id, 'preparing', 'Preparing repository workspace');
      await this.checkpoint('before-invocation', detail);
      run = await this.patchRun(run.id, {
        status: 'executing',
        startedAt,
      });
      const executionDetail = contract.execution.mode === 'pax'
        ? ['pax', '--json', contract.execution.operation, contract.execution.target, ...contract.execution.args].join(' ')
        : contract.command?.join(' ') ?? 'native execution';
      await this.appendEvent(activeRunId, 'executing', executionDetail);

      try {
        // A cancel that landed between admission and here stops the run before
        // any process exists. Nothing is spawned for a cancelled run.
        const beforeSpawn = await this.getRun(activeRunId);
        if (beforeSpawn?.status === 'cancelled') return beforeSpawn;

        // The GitHub integration answers or throws: a thrown error is the
        // provider's own refusal, known and final. Only a result that arrives
        // and then cannot be recorded is uncertain.
        const executed = contract.execution.mode === 'integration'
          ? await (async () => { const result = await this.github.execute(contract); invoked = true; return result; })()
          : await executeContract(contract, {
            repositoryRoot: this.config.repositoryRoot,
            workspaceRoot: this.config.workspaceRoot,
            onHandle: (handle) => {
              this.activeExecutions.set(activeRunId, handle);
            },
            paxExecutable: this.config.paxExecutable,
            credentialResolver: this.credentialResolver,
            onSpawned: async () => {
              invoked = true;
              await this.checkpoint('after-invocation', detail);
            },
          });

        this.activeExecutions.delete(activeRunId);
        executedStatus = executed.evidence.status;
        await this.checkpoint('after-result-before-persistence', detail);
        // A late provider result never un-cancels a run: what was cancelled
        // stays cancelled, and the evidence says so.
        const persistedAfter = await this.getRun(activeRunId);
        const outcome = persistedAfter?.status === 'cancelled' && executed.evidence.status !== 'cancelled'
          ? { ...executed, evidence: { ...executed.evidence, status: 'cancelled' as const, deterministicResult: 'CANCELLED' as const, finalResult: 'CANCELLED' as const } }
          : executed;
        executedStatus = outcome.evidence.status;
        if (outcome.evidence.status !== 'cancelled') {
          run = await this.patchRun(activeRunId, { status: 'verifying' });
          await this.appendEvent(activeRunId, 'verifying', 'Persisting structured evidence');
        } else {
          run = await this.getRun(activeRunId) ?? run;
        }
        await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(outcome.evidence, outcome.evidence.id);
        await this.checkpoint('after-persistence-before-verification', detail);

        const terminalStatus = outcome.evidence.status === 'completed' ? 'completed' : outcome.evidence.status;
        const transition = terminalStatus === 'cancelled' && (run.status === 'cancelled' || persistedAfter?.status === 'cancelled')
          ? null
          : await this.db.transitionOperation({
            operationId: run.operationId,
            expectedVersion: run.operationVersion,
            to: terminalStatus === 'completed' ? 'completed' : terminalStatus === 'unknown' ? 'failed' : terminalStatus,
            resultSnapshot: outcome.evidence,
            error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
          });

        run = await this.patchRun(activeRunId, {
          status: terminalStatus,
          completedAt: outcome.evidence.completedAt,
          finishedAt: new Date().toISOString(),
          operationVersion: transition?.operation.version ?? run.operationVersion,
          evidenceId: outcome.evidence.id,
          ...(outcome.evidence.providerResult?.providerOperationId !== undefined ? { providerOperationId: outcome.evidence.providerResult.providerOperationId } : {}),
          error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
        });
        await this.appendEvent(activeRunId, terminalStatus, `Final deterministic result: ${outcome.evidence.finalResult}`);
        await this.checkpoint('after-evidence', detail);
        return run;
      } catch (error) {
        this.activeExecutions.delete(activeRunId);
        const persistedRun = await this.getRun(activeRunId);
        if (persistedRun?.status !== 'cancelled' && executedStatus !== 'cancelled' && invoked) {
          /*
           * The provider was invoked and the result was lost — a persistence
           * failure after the process ran, or a boundary error after spawn.
           * Factory does not know what the provider did, and says exactly that.
           */
          const reason = `provider was invoked but its result could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
          return (await this.markRunUnknown(activeRunId, reason.slice(0, 500), true, retrySafe, contract)) ?? run;
        }
        const completedAt = new Date().toISOString();
        const terminalStatus = persistedRun?.status === 'cancelled' || executedStatus === 'cancelled' ? 'cancelled' : 'failed';
        const evidence = buildFailureEvidence(
          contract,
          error instanceof Error ? error : new Error(String(error)),
          run.startedAt ?? startedAt,
          completedAt,
          terminalStatus,
          terminalStatus === 'cancelled' ? 'cancelled'
            : error instanceof SpawnFailedError ? 'spawn-failed'
            : error instanceof CredentialUnavailableError ? 'not-started'
            : 'not-started',
        );
        await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(evidence, evidence.id);
        const transition = terminalStatus === 'cancelled' && persistedRun?.status === 'cancelled'
          ? null
          : await this.db.transitionOperation({
            operationId: run.operationId,
            expectedVersion: run.operationVersion,
            to: terminalStatus,
            error: evidence.stderr,
            resultSnapshot: evidence,
          });
        run = await this.patchRun(activeRunId, {
          status: terminalStatus,
          completedAt,
          finishedAt: completedAt,
          operationVersion: transition?.operation.version ?? run.operationVersion,
          evidenceId: evidence.id,
          error: evidence.stderr,
        });
        await this.appendEvent(activeRunId, terminalStatus, evidence.stderr);
        return run;
      }
    } finally {
      stopHeartbeat();
      await this.releaseRunOwnership(activeRunId);
    }
  }

  private fingerprint(request: RunRequest, principal: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ request, principal }))
      .digest('hex');
  }

  private async recordRequest(runId: string, request: RunRequest, principal: string, tenantId?: string): Promise<void> {
    const record: ExecutionRequestRecord = {
      id: runId,
      runId,
      workId: request.workId,
      operation: request.operation,
      principal,
      tenantId,
      request,
      createdAt: new Date().toISOString(),
    };
    await this.db.collection<ExecutionRequestRecord>(COLLECTIONS.executionRequests).put(record, record.id);
  }

  private async recordContract(contract: ExecutionContractRecord['contract']): Promise<void> {
    assertContractIntegrity(contract);
    const record: ExecutionContractRecord = {
      id: contract.runId,
      runId: contract.runId,
      principal: contract.principal,
      operation: contract.operation,
      commandJson: JSON.stringify(contract.command ?? []),
      contract,
      fingerprint: contract.fingerprint,
      createdAt: new Date().toISOString(),
    };
    const contracts = this.db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts);
    const existing = await contracts.get(record.id);
    if (existing) {
      if (existing.fingerprint !== record.fingerprint) {
        throw new Error(`Execution contract ${record.id} is immutable`);
      }
      return;
    }
    await contracts.insert(record, record.id);
  }

  private async appendEvent(runId: string, status: RunRecord['status'], detail: string): Promise<void> {
    const event: RunEventRecord = {
      id: `${runId}:${Date.now()}:${status}`,
      runId,
      status,
      detail,
      createdAt: new Date().toISOString(),
    };
    await this.db.collection<RunEventRecord>(COLLECTIONS.runEvents).put(event, event.id);
  }

  private async patchRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const runs = this.db.collection<RunRecord>(COLLECTIONS.runs);
    const current = await runs.get(runId);
    if (!current) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (patch.status && patch.status !== current.status
      && !validTransitions[current.status].includes(patch.status)) {
      throw new Error(`Invalid run transition ${current.status} -> ${patch.status}`);
    }

    if (current.__version === undefined) {
      await runs.update(runId, {
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      const updated = await runs.get(runId);
      if (!updated) {
        throw new Error(`Run ${runId} disappeared during patch`);
      }
      return updated;
    }

    const result = await runs.updateIfVersion(runId, current.__version, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });

    if (!result.updated || !result.item) {
      return this.patchRun(runId, patch);
    }

    return result.item as RunRecord;
  }
}

function productSurface(pathname: string): string | null {
  if (pathname === '/factory') return overviewPage();
  if (pathname === '/factory/projects') return projectsPage();
  if (pathname === '/factory/actions') return actionsPage();
  if (pathname === '/factory/runs') return runsPage();
  if (pathname === '/factory/providers') return providersPage();
  if (pathname === '/factory/settings') return settingsPage();
  if (pathname === '/factory/graphs') return graphsPage();
  if (pathname === '/factory/work') return workListPage();
  const work = pathname.match(/^\/factory\/work\/([A-Za-z0-9._:-]{1,128})$/);
  if (work) return workPage(work[1]!);
  const graph = pathname.match(/^\/factory\/graphs\/([A-Za-z0-9._:-]{1,128})$/);
  if (graph) return graphPage(graph[1]!);
  const project = pathname.match(/^\/factory\/projects\/([A-Za-z0-9._:-]{1,128})$/);
  if (project) return projectPage(project[1]!);
  const action = pathname.match(/^\/factory\/actions\/([A-Za-z0-9._:-]{1,128})$/);
  if (action) return actionPage(action[1]!);
  const run = pathname.match(/^\/factory\/runs\/([A-Za-z0-9._:-]{1,128})$/);
  if (run) return runPage(run[1]!);
  return null;
}

export async function createHttpServer(config: FactoryServiceConfig): Promise<{ service: FactoryService; server: Server; }> {
  const service = await FactoryService.create(config);
  // Protected requests are authenticated by AuthBoundry and then held to the
  // Factory application association, so no route can bypass it.
  const getAuthenticator = () => service.authenticator();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const suppliedRequestId = request.headers['x-request-id'];
      const requestId = typeof suppliedRequestId === 'string'
        && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : `cfg_${randomUUID()}`;
      request.headers['x-request-id'] = requestId;
      response.setHeader('x-request-id', requestId);

      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
        try {
          const browserAuthenticator = getAuthenticator();
          if (browserAuthenticator.session) {
            await browserAuthenticator.session(request);
          } else {
            await browserAuthenticator.authenticate(request, 'factory.ui.read');
          }
          response.writeHead(302, { location: '/factory' });
        } catch {
          response.writeHead(302, { location: '/api/auth/login/github?return_to=%2F' });
        }
        response.end();
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/auth/login/github') {
        const adapter = createFactoryBrowserAdapter(config);
        writeBrowserRedirect(response, await adapter.beginLogin({
          application: FACTORY_BROWSER_APPLICATION_ID,
          provider: 'github',
          tenant: config.authBoundryTenantId ?? config.tenantId ?? 'default',
          returnTo: url.searchParams.get('return_to') ?? '/',
        }));
        return;
      }

      if (request.method === 'GET' && url.pathname === FACTORY_BROWSER_CALLBACK_PATH) {
        const adapter = createFactoryBrowserAdapter(config);
        writeBrowserRedirect(response, await adapter.completeLogin({
          application: FACTORY_BROWSER_APPLICATION_ID,
          handoff: url.searchParams.get('handoff') ?? '',
          cookieHeader: request.headers.cookie,
          callbackPath: url.pathname,
        }));
        return;
      }

      if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/auth/logout') {
        const adapter = createFactoryBrowserAdapter(config);
        writeBrowserRedirect(response, await adapter.logout({
          application: FACTORY_BROWSER_APPLICATION_ID,
          cookieHeader: request.headers.cookie,
          returnTo: url.searchParams.get('return_to') ?? '/',
        }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, await service.health());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/connection') {
        try {
          await getAuthenticator().authenticate(request, 'factory.ui.read');
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        const state = await service.refreshConnection();
        writeJson(response, state.status === 'associated' ? 200 : 503, service.connectionDocument());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/ui') {
        let context;
        try {
          context = await getAuthenticator().authenticate(request, 'factory.ui.read');
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        writeJson(response, 200, service.discoverUi(context));
        return;
      }

      // The Factory product surface. Each page is authorized for reading the
      // product UI before any of it is served.
      if (request.method === 'GET' && (url.pathname === '/factory' || url.pathname.startsWith('/factory/'))) {
        try {
          await getAuthenticator().authenticate(request, 'factory.ui.read');
        } catch (error) {
          /*
           * A person whose session has lapsed is sent to sign in and brought
           * back, the same as at `/`. Raw JSON on a page a browser reloaded is
           * an error message with no way forward. A client asking for JSON
           * still gets it, and a denial is still a denial.
           */
          if (error instanceof AuthBoundryAuthenticationError
            && !/application\/json/i.test(request.headers.accept ?? '')) {
            const returnTo = encodeURIComponent(factoryReturnPath(url.pathname));
            response.writeHead(302, { location: `/api/auth/login/github?return_to=${returnTo}` });
            response.end();
            return;
          }
          writeAuthError(response, error);
          return;
        }
        const page = productSurface(url.pathname);
        if (!page) {
          writeJson(response, 404, { error: 'Not found' });
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(page);
        return;
      }

      // Factory's own product surface. Every route is authenticated and
      // authorized through the same middleware as the rest of Factory.
      if (matchProductRoute(request.method ?? 'GET', url.pathname)) {
        let body: unknown;
        if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT') {
          const raw = await readBody(request);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              writeJson(response, 400, { error: 'A JSON body must be valid JSON', code: 'INVALID_REQUEST' });
              return;
            }
          }
          // An absent body is not an error: some actions take no input, and a
          // route that needs one says so itself.
        }
        try {
          await handleProductRoute({ service, authenticator: getAuthenticator, request, response, url, body });
        } catch (error) {
          if (error instanceof DomainValidationError || error instanceof IntervalError
            || error instanceof GraphValidationError) {
            writeJson(response, 400, { error: error.message, code: 'INVALID_REQUEST' });
            return;
          }
          if (error instanceof OperationalWorkRequestError || error instanceof OperationalWorkConflictError) {
            writeJson(response, error.status, { error: error.message, code: error.code });
            return;
          }
          if (error instanceof FactoryAssociationError
            || error instanceof AuthBoundryAuthorizationError
            || error instanceof AuthBoundryAuthenticationError) {
            writeAuthError(response, error);
            return;
          }
          throw error;
        }
        return;
      }

      if (service.handlesAppPortServices(url.pathname)) {
        await service.handleAppPortServices(request, response);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const payload = await readJson<RunRequest>(request);
        let context;
        try {
          context = await getAuthenticator().authenticate(request, 'factory.run');
          const githubCapabilities = service.requiredCapabilities(payload.operation)
            .filter((capability) => capability.startsWith('github.'));
          for (const capability of githubCapabilities) {
            await getAuthenticator().authenticate(request, capability);
          }
          context.authorizedCapabilities = githubCapabilities;
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        const run = await service.startRun(payload, context);
        writeJson(response, 201, run);
        return;
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runMatch) {
        let context;
        try {
          context = await getAuthenticator().authenticate(request, 'factory.run.read');
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        const run = await service.getRun(runMatch[1], context);
        writeJson(response, run ? 200 : 404, run ?? { error: 'Run not found' });
        return;
      }

      const evidenceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && evidenceMatch) {
        let context;
        try {
          context = await getAuthenticator().authenticate(request, 'factory.run.evidence');
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        const evidence = await service.getEvidence(evidenceMatch[1], context);
        writeJson(response, evidence ? 200 : 404, evidence ?? { error: 'Evidence not found' });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelMatch) {
        let context;
        try {
          context = await getAuthenticator().authenticate(request, 'factory.run.cancel');
        } catch (error) {
          writeAuthError(response, error);
          return;
        }
        const existing = await service.getRun(cancelMatch[1], context);
        if (!existing) {
          writeJson(response, 404, { error: 'Run not found' });
          return;
        }
        const run = await service.cancelRunAs(cancelMatch[1], context.principal);
        writeJson(response, 202, run);
        return;
      }

      writeJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof BrowserAdapterError) {
        writeJson(response, error.status, { error: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Software Factory Runner error: ${message}\n`);
      const clientError = /invalid run request|requires workId|not accepted in a run request|not accepted in a repository|authenticated principal is required|Execution fields/.test(message);
      writeJson(response, clientError ? 400 : 500, { error: clientError ? message : 'Internal server error' });
    }
  });

  return { service, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const production = process.env.NODE_ENV === 'production';
  const host = process.env.FACTORY_HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
  const port = Number(process.env.FACTORY_PORT ?? 3000);
  const config: FactoryServiceConfig = {
    mode: production ? 'remote' : (process.env.FACTORY_FELTDB_MODE as 'local' | 'remote' | undefined) ?? 'local',
    flowPath: process.env.FACTORY_FLOW_PATH,
    repositoryRoot: process.env.FACTORY_REPOSITORY_ROOT,
    workspaceRoot: process.env.FACTORY_WORKSPACE_ROOT,
    serverUrl: process.env.FELTDB_URL,
    serverToken: process.env.FELTDB_TOKEN,
    namespace: process.env.FACTORY_NAMESPACE,
    environmentId: process.env.FACTORY_ENVIRONMENT_ID,
    appportPath: process.env.APPPORT_SERVICES_PATH,
    paxExecutable: process.env.PAX_BIN,
    authBoundryUrl: process.env.AUTHBOUNDRY_URL,
    authBoundryBrowserCookieSecret: process.env.AUTHBOUNDRY_BROWSER_COOKIE_SECRET,
    authBoundryTenantId: process.env.AUTHBOUNDRY_TENANT_ID,
    authBoundryOperatorCredential: process.env.AUTHBOUNDRY_OPERATOR_CREDENTIAL,
    factoryServiceCredential: process.env.FACTORY_SERVICE_CREDENTIAL,
    ...(process.env.FACTORY_RECONCILE_TICK_MS
      ? { reconciliationTickMs: Number(process.env.FACTORY_RECONCILE_TICK_MS) }
      : {}),
  };
  if (production) {
    const deploymentConfig = readDeploymentConfig(config);
    process.stdout.write(`${formatDeploymentConfigDiagnostics(deploymentConfig)}\n`);
    validateDeploymentConfig(deploymentConfig);
  }
  const { service, server } = await createHttpServer(config);
  if (production) {
    await service.verifyRuntime();
  }

  if (production) {
    process.stdout.write('Factory starting...\n');
  }
  server.listen(port, host, () => {
    process.stdout.write(`Software Factory Runner listening on ${host}:${port}\n`);
  });

  /*
   * Continuous reconciliation runs only when Factory has a credential to act
   * under. Without one there is no authority to ask whether it may act, and an
   * autonomous loop acting on nobody's behalf is the thing this design exists
   * to prevent. Configuration and history stay durable either way, so enabling
   * the credential later resumes rather than restarts.
   */
  if (config.factoryServiceCredential && service.autonomousReady()) {
    const session = createServiceSession(service.authenticator(), config.factoryServiceCredential);
    try {
      // Validate the service credential and its factory.run authorization before
      // admitting any autonomous work. The worker never falls back to the
      // operator credential.
      await session.context();
      service.startReconciliation({
        context: session.context,
        probe: session.probe,
        ...(config.reconciliationTickMs ? { tickMs: config.reconciliationTickMs } : {}),
      });
      process.stdout.write('Continuous reconciliation worker started\n');
    } catch (error) {
      process.stderr.write(
        `Continuous reconciliation is blocked: invalid Factory service authorization evidence: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  } else {
    process.stdout.write(
      `Continuous reconciliation is idle: ${config.factoryServiceCredential
        ? 'Factory authority reconciliation is incomplete'
        : 'FACTORY_SERVICE_CREDENTIAL is not configured'}\n`,
    );
  }

  const shutdown = async () => {
    await service.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  };
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
}
