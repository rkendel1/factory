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
  FACTORY_BROWSER_APPLICATION_ID,
  FACTORY_BROWSER_CALLBACK_PATH,
  AuthBoundryAuthenticationError,
  AuthBoundryAuthorizationError,
  type AuthenticatedContext,
} from './auth.js';
import { BrowserAdapterError, type BrowserRedirectResult } from '@authboundry/core/server';
import { createAppPortAdapter, type FactoryAppPortAdapter } from './appport.js';
import { createCanonicalApplicationContract } from './application-contract.js';
import { createFactoryGitHubAdapter, type FactoryGitHubAdapter } from './integrations/github.js';
import { createFactoryAppPortServices, type FactoryAppPortServices } from './appport-services.js';
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
  ExecutionContractRecord,
  ExecutionRequestRecord,
  FactoryServiceConfig,
  RunEventRecord,
  RunRecord,
  RunRequest,
  StructuredEvidence,
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

export class FactoryService {
  private readonly flowSpec;

  private readonly activeExecutions = new Map<string, ExecutionHandle>();
  private readonly appPort: FactoryAppPortAdapter;
  private readonly appPortServices: FactoryAppPortServices;
  private readonly github: FactoryGitHubAdapter;
  private readonly uiContributors: readonly UiContributor[];
  private readonly applicationId: string;
  private readonly environmentId: string;
  private paxVersion?: string;
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
    this.appPortServices = createFactoryAppPortServices({
      ...(config.appPortServices ? { services: config.appPortServices } : {}),
      deployment: config.mode === 'remote'
        ? {
            mode: 'remote',
            namespace: `${config.namespace ?? 'software-factory'}-appport-services`,
            url: config.serverUrl,
            token: config.serverToken,
            applicationId: application.identity.id,
            environment: this.environmentId,
          }
        : {
            mode: 'local',
            namespace: `${config.namespace ?? 'software-factory'}-appport-services`,
            path: config.appportPath ?? `${config.workingDirectory ?? process.cwd()}/appport-services`,
          },
      authenticator: () => config.authenticator ?? createAuthBoundryAuthenticator(config),
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

  static async create(config: FactoryServiceConfig): Promise<FactoryService> {
    if (config.mode === 'remote') {
      resolveRemoteAuthorityBootstrap(config);
    }
    const db = await createFactoryDB(config);
    const service = new FactoryService(config, db);
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
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
        authBoundry: this.config.mode === 'remote' ? 'configured' : 'development',
        feltDb: this.config.mode === 'remote' ? 'initialized' : 'development',
        appPort: 'initialized',
        appPortServices: 'initialized',
      },
    };
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

  async startRun(request: RunRequest, principalOrContext: string | AuthenticatedContext): Promise<RunRecord> {
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

    const authorization = await authorizeExecution(this.db, this.flowSpec, context, request, run.id);
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

export async function createHttpServer(config: FactoryServiceConfig): Promise<{ service: FactoryService; server: Server; }> {
  const service = await FactoryService.create(config);
  const authenticator = config.authenticator;
  const getAuthenticator = () => authenticator ?? createAuthBoundryAuthenticator(config);
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
          response.writeHead(302, { location: '/configuration' });
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

  const shutdown = async () => {
    await service.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  };
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
}
