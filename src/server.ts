import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadFactoryFlow, createFactoryDB, COLLECTIONS } from './felt.js';
import { authorizeExecution, getOperationAuthorities } from './authority.js';
import { buildFailureEvidence } from './evidence.js';
import { executeContract, verifyPax, type ExecutionHandle } from './execution.js';
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
} from './product-ui.js';
import { discoverRepository, planFromDiscovery } from './discovery.js';
import { executionProviders, providerForOperation, type ExecutionProvider } from './providers.js';
import { createReconciliationScheduler, type SchedulerHandle } from './scheduler.js';
import {
  planOperation,
  providerExecution,
  ProviderRegistry,
  resolveProvider,
  verifyOperation,
  type ProviderContext,
} from './adapters.js';
import { isOperationalCapability, REQUIRED_VERIFICATION } from './capabilities.js';
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
  createFactoryAppPortServices,
  resolveAppPortServicesDeployment,
  type FactoryAppPortServices,
} from './appport-services.js';
import { composeProductUi, factoryUiContribution, factoryUiContributor, type UiContributor } from './ui.js';
import type { AppPortUiContext, ComposedUi } from '@appport/client';
import { filterUiContribution, type UiDiscoveryDocument } from '@appport/protocol';
import {
  formatDeploymentConfigDiagnostics,
  readDeploymentConfig,
  resolveRemoteAuthorityBootstrap,
  validateDeploymentConfig,
} from './bootstrap.js';
import type {
  ActionGraphOrigin,
  ActionGraphRecord,
  ActionOutcome,
  ActionRecord,
  ProviderExecution,
  AuthorityContextRecord,
  AutonomyDecision,
  ReconciliationOutcome,
  ReconciliationRecord,
  ReconciliationResult,
  EnvironmentRecord,
  ExecutionContractRecord,
  ExecutionRequestRecord,
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

function isTerminal(status: RunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

const requestKeys = new Set(['workId', 'repository', 'operation', 'idempotencyKey', 'github']);
const repositoryKeys = new Set(['provider', 'owner', 'name', 'ref']);
const githubKeys = new Set(['pullNumber', 'mergeMethod']);
const validTransitions: Record<RunRecord['status'], RunRecord['status'][]> = {
  accepted: ['authorized', 'failed', 'cancelled'],
  authorized: ['allocated', 'failed', 'cancelled'],
  allocated: ['preparing', 'failed', 'cancelled'],
  preparing: ['executing', 'failed', 'cancelled'],
  executing: ['verifying', 'completed', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
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
  'drift-detected': 'drifted',
  'awaiting-approval': 'drifted',
  'autonomy-denied': 'drifted',
  'duplicate-suppressed': 'drifted',
  'authority-unavailable': 'failed',
  'execution-failed': 'failed',
  'verification-failed': 'failed',
  error: 'failed',
};

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
  private readonly controlPlane: AuthBoundryControlPlane | null;
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
    this.registry = new ProviderRegistry(this.flowSpec, config.providerAdapters);
    this.controlPlane = config.authBoundryControlPlane
      ?? ((config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL)
        && (config.authBoundryOperatorCredential ?? process.env.AUTHBOUNDRY_OPERATOR_CREDENTIAL)
        ? createAuthBoundryControlPlane({
            baseUrl: (config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL)!,
            operatorCredential: (config.authBoundryOperatorCredential
              ?? process.env.AUTHBOUNDRY_OPERATOR_CREDENTIAL)!,
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
    const discovery = this.config.repositoryRoot
      ? await discoverRepository(this.config.repositoryRoot, repository ?? undefined)
      : null;

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
    const reports = await this.observeReality(context, projectId);
    const drift = reports.find((report) => report.environmentId === environmentId);
    if (!drift) throw new DomainValidationError(`environment ${environmentId} was not observed`);

    const current = observeEnvironment(environment);
    const revisions = {
      desiredStateRevision: desiredStateRevision(desiredState),
      observedStateRevision: observedStateRevision(current),
    };
    explanation.push(...drift.explanation);

    // An environment Factory has not observed is not a drifted one.
    if (drift.status === 'unknown') {
      return finish('unobserved', revisions);
    }
    if (drift.status === 'reconciled') {
      return finish('converged', revisions);
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
      explanation.push(`Action ${existing.id} is already open for this drift.`);
      return finish(
        existing.status === 'awaiting-approval' ? 'awaiting-approval' : 'duplicate-suppressed',
        {
          ...revisions,
          fingerprint,
          actionId: existing.id,
          ...(existing.graphId ? { graphId: existing.graphId } : {}),
          ...(existing.autonomy ? { autonomy: existing.autonomy } : {}),
        },
      );
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
      fingerprint,
      actionId: executed.id,
      graphId: graph.id,
      ...(executed.runId ? { runId: executed.runId } : {}),
      ...(executed.autonomy ? { autonomy: executed.autonomy } : {}),
      ...(executed.authority ? { authority: executed.authority } : {}),
      ...(evidence ? { evidenceId: evidence.id } : {}),
    };

    if (executed.status === 'succeeded') {
      explanation.push(`${environment.name} reconciled to the declared state.`);
      return finish('executed', base);
    }
    if (run && run.status !== 'completed') {
      explanation.push(`Execution failed: ${run.error ?? 'the run did not complete'}.`);
      return finish('execution-failed', base);
    }
    if (failedVerification) {
      explanation.push('Execution completed but verification did not pass.');
      return finish('verification-failed', base);
    }
    explanation.push('Reconciliation did not converge.');
    return finish('error', base);
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
    const released = await this.domain.releaseReconciliation(record.id, {
      status,
      lastObservedAt: outcome.observedAt,
      ...(outcome.result === 'executed' ? { lastReconciledAt: outcome.observedAt } : {}),
      ...(outcome.actionId ? { lastActionId: outcome.actionId } : {}),
      ...(outcome.runId ? { lastRunId: outcome.runId } : {}),
      ...(outcome.fingerprint ? { lastFingerprint: outcome.fingerprint } : {}),
      lastOutcome: outcome,
      lastError: status === 'failed' ? outcome.explanation[outcome.explanation.length - 1] ?? 'unknown error' : '',
      nextDueAt: nextDueAt(record, now),
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
    return this.domain.patchReconciliation(record.tenantId, record.id, {
      status,
      lastObservedAt: outcome.observedAt,
      ...(outcome.result === 'executed' ? { lastReconciledAt: outcome.observedAt } : {}),
      ...(outcome.actionId ? { lastActionId: outcome.actionId } : {}),
      ...(outcome.runId ? { lastRunId: outcome.runId } : {}),
      ...(outcome.fingerprint ? { lastFingerprint: outcome.fingerprint } : {}),
      lastOutcome: outcome,
      lastError: status === 'failed'
        ? outcome.explanation[outcome.explanation.length - 1] ?? 'unknown error'
        : '',
      nextDueAt: nextDueAt(record, now),
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
      id: `graph_${randomUUID()}`,
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
          reason: failed.verification?.find((check) => check.status === 'failed')?.detail
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
    if (action.status !== 'failed') {
      throw new DomainValidationError(`action ${actionId} is ${action.status}, and only a failed action can be retried`);
    }
    const retried = await this.domain.patchAction(tenantId, actionId, {
      status: 'planned',
      retries: (action.retries ?? 0) + 1,
      previousRunIds: [...(action.previousRunIds ?? []), ...(action.runId ? [action.runId] : [])],
      runId: undefined,
      verification: undefined,
      outcome: undefined,
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
          : action.outcome && action.outcome !== 'succeeded'
            ? `${action.outcome}${action.verification?.find((check) => check.status === 'failed')?.detail
                ? ': ' + action.verification.find((check) => check.status === 'failed')!.detail : ''}`
            : null,
      })),
    };
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
    const discovery = this.config.repositoryRoot
      ? await discoverRepository(this.config.repositoryRoot, repository ?? undefined)
      : null;
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
      const capabilities = this.registry.capabilitiesOf(adapter.id);
      const availability = await adapter.availability();
      const projects = environments
        .filter(({ environments: list, desiredState }) =>
          list.some((environment) => environment.provider === adapter.id) || desiredState?.targetProvider === adapter.id)
        .map(({ project, environments: list }) => ({
          id: project.id,
          name: project.name,
          environments: list.filter((environment) => environment.provider === adapter.id).map((environment) => environment.name),
        }));
      const recent = actions.filter((action) => action.provider === adapter.id).slice(0, 10);
      return {
        id: adapter.id,
        name: adapter.displayName,
        status: capabilities.length === 0 ? 'unsupported' : availability.state,
        detail: capabilities.length === 0 ? 'no .flow operation declares a capability for this provider' : availability.detail,
        configured: projects.length > 0,
        credentials: [...adapter.credentials],
        note: 'configured and available describe reachability; authorization is decided per Action by AuthBoundry',
        capabilities: capabilities.map((entry) => ({
          capability: entry.capability,
          operation: entry.operation,
          requiredAuthority: [...entry.authority.capabilities],
          verificationRequires: REQUIRED_VERIFICATION[entry.capability] ?? null,
          idempotency: adapter.idempotency(entry.capability),
          recent: recent.filter((action) => action.capability === entry.capability).map((action) => ({
            id: action.id, status: action.status, outcome: action.outcome ?? null, updatedAt: action.updatedAt,
          })),
        })),
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

    const discovery = this.config.repositoryRoot
      ? await discoverRepository(this.config.repositoryRoot, repository ?? undefined)
      : null;

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
        resolved = resolveProvider(this.registry, authority.operationalCapability, providerContext);
        if (!resolved.ok) resolved = null;
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
    if (action.status === 'running') return action;
    // A finished Action is finished. Running it again would reach the provider
    // boundary a second time; a failed one comes back only through an explicit
    // retry, which returns it to planned first.
    if (action.status === 'succeeded' || action.status === 'failed') return action;

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

    const authority = this.authorityContext(context);
    if (!authority) {
      const reason = this.connection.status === 'associated'
        ? `AuthBoundry authorized no application context for ${context.principal}`
        : this.connection.reason;
      return await this.domain.patchAction(tenantId, actionId, {
        status: 'failed',
        verification: [{ name: 'authority', status: 'failed', detail: reason }],
      }) ?? action;
    }

    const repositories = await this.domain.listRepositories(tenantId, action.projectId);
    const desiredState = await this.domain.getDesiredState(tenantId, action.projectId);
    const repository = repositories.find((candidate) => candidate.id === desiredState?.sourceRepositoryId)
      ?? repositories[0];
    if (!repository) {
      throw new DomainValidationError(`project ${action.projectId} has no repository to act on`);
    }

    await this.domain.patchAction(tenantId, actionId, { status: 'authorized', authority });

    const work = await this.ensureActionWork(action, repository, context, desiredState?.sourceBranch);
    await this.domain.patchAction(tenantId, actionId, { status: 'running' });

    /*
     * Only now, after AuthBoundry has answered, does the provider adapter get
     * asked for what to run. The adapter hands over parameters and credential
     * names; the execution boundary resolves the values at spawn time.
     */
    const providerContext = await this.providerContext(tenantId, action, repository, desiredState,
      action.retries ? `${action.id}:retry:${action.retries}` : action.id);
    let execution: ProviderExecution | undefined;
    if (action.provider && isOperationalCapability(action.capability)) {
      const resolution = resolveProvider(this.registry, action.capability, providerContext);
      if (!resolution.ok || resolution.provider !== action.provider) {
        return await this.domain.patchAction(tenantId, actionId, {
          status: 'failed',
          outcome: 'provider-unavailable',
          verification: [{ name: 'provider', status: 'failed', detail: resolution.ok
            ? `provider ${action.provider} is no longer the configured provider` : resolution.reason }],
        }) ?? action;
      }
      execution = providerExecution(this.registry, resolution, providerContext);
    }

    const run = await this.startRun({
      workId: work.id,
      repository: {
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
        ref: desiredState?.sourceBranch ?? repository.defaultBranch,
      },
      operation: action.operation ?? action.type,
      // A retried Action is admitted as a new Run; the earlier Run is history.
      ...(action.retries ? { idempotencyKey: `${action.id}:retry:${action.retries}` } : {}),
    }, context, execution);

    await this.patchRun(run.id, {
      actionId: action.id,
      projectId: action.projectId,
      ...(action.environmentId ? { environmentId: action.environmentId } : {}),
      ...(authority.application ? { applicationId: authority.application } : {}),
      ...(authority.delegation ? { delegationId: authority.delegation } : {}),
      ...(action.executionProvider ? { executionProvider: action.executionProvider } : {}),
    });

    const settled = await this.getRun(run.id, context);
    const verification = await this.verifyRun(settled?.id ?? run.id, desiredState?.healthRequirement);
    // The adapter reads the operation's result back; Factory keeps the verdict.
    const evidenceRecord = await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(run.id);
    if (evidenceRecord && settled?.status === 'completed') {
      verification.push(...verifyOperation(this.registry, action, evidenceRecord, providerContext));
    }
    const succeeded = settled?.status === 'completed'
      && verification.every((check) => check.status !== 'failed');

    if (succeeded && action.environmentId) {
      await this.recordReconciledState(tenantId, action.projectId, action.environmentId, run.id);
    }

    const outcome: ActionOutcome = succeeded
      ? 'succeeded'
      : settled?.status === 'completed' ? 'verification-failed' : 'execution-failed';

    return await this.domain.patchAction(tenantId, actionId, {
      status: succeeded ? 'succeeded' : 'failed',
      outcome,
      runId: run.id,
      authority: {
        ...authority,
        ...(settled?.authorizationDecisionId ? { authorizationDecisionId: settled.authorizationDecisionId } : {}),
      },
      verification,
    }) ?? action;
  }

  /**
   * Verification reads the durable evidence rather than the process that wrote
   * it, so a check reports what a later reader of FeltDB would also see.
   */
  private async verifyRun(runId: string, healthRequirement?: string): Promise<VerificationCheck[]> {
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
      checks.push({
        name: healthRequirement,
        status: evidence?.finalResult === 'PASS' ? 'passed' : 'skipped',
        detail: 'derived from the run evidence; no external probe is performed',
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
      attentionRequired: attention.map((action) => ({
        id: action.id,
        projectId: action.projectId,
        status: action.status,
        intent: action.intent,
      })),
      authority: {
        application: this.association.applicationId,
        principals: this.association.agents.map((agent) => agent.principalId),
        // The association state, never "connected because a URL exists".
        state: this.connection.status,
        ...(this.connection.status === 'associated'
          ? { tenant: this.connection.association.tenantId, resource: this.connection.association.resource }
          : { reason: this.connection.reason }),
      },
    };
  }

  connectionState(): FactoryConnectionState {
    return this.connection;
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
    await service.recoverInterruptedRuns();
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
    this.shuttingDown = true;
    this.scheduler?.stop();
    for (const execution of this.activeExecutions.values()) {
      execution.cancel();
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const runtime = this.db.runtime();
    return {
      ok: true,
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
    };
  }

  /** The connection document: what AuthBoundry holds for this application. */
  connectionDocument(): Record<string, unknown> {
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

  async recoverInterruptedRuns(): Promise<void> {
    const runs = await this.db.collection<RunRecord>(COLLECTIONS.runs).all();
    for (const run of runs) {
      if (isTerminal(run.status)) {
        continue;
      }

      await this.patchRun(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Runner restarted before execution reached a terminal state',
      });
      await this.appendEvent(run.id, 'failed', 'Recovered interrupted non-terminal run from durable FeltDB state');

      try {
        const transition = await this.db.transitionOperation({
          operationId: run.operationId,
          expectedVersion: run.operationVersion,
          to: 'failed',
          error: 'Runner restarted before execution reached a terminal state',
        });
        await this.patchRun(run.id, { operationVersion: transition.operation.version });
      } catch {
        // Durable run state is authoritative for recovery even if the operation was already terminal.
      }
    }
  }

  async startRun(
    request: RunRequest,
    principalOrContext: string | AuthenticatedContext,
    execution?: ProviderExecution,
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

    await this.recordRequest(run.id, request, principal, context.tenant);

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

    await this.recordContract(authorization.contract);
    this.appPort.bindContract(authorization.contract);
    run = await this.patchRun(run.id, {
      status: 'authorized',
      contractId: run.id,
    });
    await this.appendEvent(run.id, 'authorized', authorization.reason);

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
    run = await this.patchRun(run.id, {
      status: 'executing',
      startedAt,
    });
    const activeRunId = run.id;
    const executionDetail = authorization.contract.execution.mode === 'pax'
      ? ['pax', '--json', authorization.contract.execution.operation, authorization.contract.execution.target, ...authorization.contract.execution.args].join(' ')
      : authorization.contract.command?.join(' ') ?? 'native execution';
    await this.appendEvent(activeRunId, 'executing', executionDetail);

    try {
      const outcome = authorization.contract.execution.mode === 'integration'
        ? await this.github.execute(authorization.contract)
        : await executeContract(authorization.contract, {
          repositoryRoot: this.config.repositoryRoot,
          workspaceRoot: this.config.workspaceRoot,
          onHandle: (handle) => {
            this.activeExecutions.set(activeRunId, handle);
          },
          paxExecutable: this.config.paxExecutable,
        });

      this.activeExecutions.delete(activeRunId);
      if (outcome.evidence.status !== 'cancelled') {
        run = await this.patchRun(activeRunId, { status: 'verifying' });
        await this.appendEvent(activeRunId, 'verifying', 'Persisting structured evidence');
      } else {
        run = await this.getRun(activeRunId) ?? run;
      }
      await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(outcome.evidence, outcome.evidence.id);

      const terminalStatus = outcome.evidence.status === 'completed' ? 'completed' : outcome.evidence.status;
      const transition = terminalStatus === 'cancelled' && run.status === 'cancelled'
        ? null
        : await this.db.transitionOperation({
          operationId: run.operationId,
          expectedVersion: run.operationVersion,
          to: terminalStatus === 'completed' ? 'completed' : terminalStatus,
          resultSnapshot: outcome.evidence,
          error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
        });

      run = await this.patchRun(activeRunId, {
        status: terminalStatus,
        completedAt: outcome.evidence.completedAt,
        operationVersion: transition?.operation.version ?? run.operationVersion,
        evidenceId: outcome.evidence.id,
        error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
      });
      await this.appendEvent(activeRunId, terminalStatus, `Final deterministic result: ${outcome.evidence.finalResult}`);
      return run;
    } catch (error) {
      this.activeExecutions.delete(activeRunId);
      const completedAt = new Date().toISOString();
      const persistedRun = await this.getRun(activeRunId);
      const terminalStatus = persistedRun?.status === 'cancelled' ? 'cancelled' : 'failed';
      const evidence = buildFailureEvidence(
        authorization.contract,
        error instanceof Error ? error : new Error(String(error)),
        run.startedAt ?? startedAt,
        completedAt,
        terminalStatus,
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
        operationVersion: transition?.operation.version ?? run.operationVersion,
        evidenceId: evidence.id,
        error: evidence.stderr,
      });
      await this.appendEvent(activeRunId, terminalStatus, evidence.stderr);
      return run;
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
  if (config.factoryServiceCredential) {
    const session = createServiceSession(service.authenticator(), config.factoryServiceCredential);
    service.startReconciliation({
      context: session.context,
      probe: session.probe,
      ...(config.reconciliationTickMs ? { tickMs: config.reconciliationTickMs } : {}),
    });
    process.stdout.write('Continuous reconciliation worker started\n');
  } else {
    process.stdout.write(
      'Continuous reconciliation is idle: FACTORY_SERVICE_CREDENTIAL is not configured\n',
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
