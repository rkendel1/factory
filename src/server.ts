import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadFactoryFlow, createFactoryDB, COLLECTIONS } from './felt.js';
import { authorizeExecution } from './authority.js';
import { buildFailureEvidence } from './evidence.js';
import { executeContract, type ExecutionHandle } from './execution.js';
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

function parsePrincipal(request: IncomingMessage): string | null {
  const bearer = request.headers.authorization;
  if (bearer?.startsWith('Bearer ')) {
    return bearer.slice('Bearer '.length).trim();
  }

  const principal = request.headers['x-factory-principal'];
  return typeof principal === 'string' && principal.trim() ? principal.trim() : null;
}

export class FactoryService {
  private readonly flowSpec;

  private readonly activeExecutions = new Map<string, ExecutionHandle>();

  private constructor(
    private readonly config: FactoryServiceConfig,
    private readonly db: Awaited<ReturnType<typeof createFactoryDB>>,
  ) {
    this.flowSpec = loadFactoryFlow(config.flowPath);
  }

  static async create(config: FactoryServiceConfig): Promise<FactoryService> {
    const db = await createFactoryDB(config);
    const service = new FactoryService(config, db);
    await service.recoverInterruptedRuns();
    return service;
  }

  async health(): Promise<Record<string, unknown>> {
    const runtime = this.db.runtime();
    return {
      ok: true,
      runtime,
      authority: '.flow -> FeltDB',
    };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.db.collection<RunRecord>(COLLECTIONS.runs).get(runId);
  }

  async getEvidence(runId: string): Promise<StructuredEvidence | null> {
    return this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
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

    return this.patchRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Run cancelled by caller',
    });
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

  async startRun(request: RunRequest, principal: string): Promise<RunRecord> {
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
      run = {
        id: runId,
        operationId: admission.operationId,
        operationVersion: admission.operation.version,
        workId: request.workId,
        principal,
        operation: request.operation,
        status: 'accepted',
        idempotencyKey,
        repository: { ...request.repository },
        createdAt: new Date(admission.operation.createdAt).toISOString(),
        updatedAt: new Date(admission.operation.createdAt).toISOString(),
      };
      await runs.put(run, run.id);
      await this.appendEvent(run.id, 'accepted', 'Durably admitted run request');
      if (!admission.admitted) {
        return run;
      }
    } else if (!admission.admitted || isTerminal(run.status)) {
      return run;
    }

    await this.recordRequest(run.id, request, principal);

    const authorization = await authorizeExecution(this.db, this.flowSpec, principal, request, run.id);
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
    run = await this.patchRun(run.id, {
      status: 'authorized',
      contractId: run.id,
    });
    await this.appendEvent(run.id, 'authorized', authorization.reason);
    run = await this.patchRun(run.id, { status: 'allocated' });
    await this.appendEvent(run.id, 'allocated', 'Allocated ephemeral runner workspace');
    run = await this.patchRun(run.id, { status: 'preparing' });
    await this.appendEvent(run.id, 'preparing', 'Preparing repository workspace');

    const startedAt = new Date().toISOString();
    const operation = await this.db.transitionOperation({
      operationId: run.operationId,
      expectedVersion: run.operationVersion,
      to: 'executing',
    });
    run = await this.patchRun(run.id, {
      status: 'executing',
      operationVersion: operation.operation.version,
      startedAt,
    });
    const activeRunId = run.id;
    await this.appendEvent(activeRunId, 'executing', authorization.contract.command.join(' '));

    try {
      const outcome = await executeContract(authorization.contract, {
        repositoryRoot: this.config.repositoryRoot,
        workspaceRoot: this.config.workspaceRoot,
        onHandle: (handle) => {
          this.activeExecutions.set(activeRunId, handle);
        },
      });

      this.activeExecutions.delete(activeRunId);
      run = await this.patchRun(activeRunId, { status: 'verifying' });
      await this.appendEvent(activeRunId, 'verifying', 'Persisting structured evidence');
      await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(outcome.evidence, outcome.evidence.id);

      const terminalStatus = outcome.evidence.status === 'completed' ? 'completed' : outcome.evidence.status;
      const transition = await this.db.transitionOperation({
        operationId: run.operationId,
        expectedVersion: run.operationVersion,
        to: terminalStatus === 'completed' ? 'completed' : terminalStatus,
        resultSnapshot: outcome.evidence,
        error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
      });

      run = await this.patchRun(activeRunId, {
        status: terminalStatus,
        completedAt: outcome.evidence.completedAt,
        operationVersion: transition.operation.version,
        evidenceId: outcome.evidence.id,
        error: terminalStatus === 'failed' || terminalStatus === 'cancelled' ? outcome.evidence.stderr : undefined,
      });
      await this.appendEvent(activeRunId, terminalStatus, `Final deterministic result: ${outcome.evidence.finalResult}`);
      return run;
    } catch (error) {
      this.activeExecutions.delete(activeRunId);
      const completedAt = new Date().toISOString();
      const evidence = buildFailureEvidence(
        authorization.contract,
        error instanceof Error ? error : new Error(String(error)),
        run.startedAt ?? startedAt,
        completedAt,
      );
      await this.db.collection<StructuredEvidence>(COLLECTIONS.evidence).put(evidence, evidence.id);
      const transition = await this.db.transitionOperation({
        operationId: run.operationId,
        expectedVersion: run.operationVersion,
        to: 'failed',
        error: evidence.stderr,
        resultSnapshot: evidence,
      });
      run = await this.patchRun(activeRunId, {
        status: 'failed',
        completedAt,
        operationVersion: transition.operation.version,
        evidenceId: evidence.id,
        error: evidence.stderr,
      });
      await this.appendEvent(activeRunId, 'failed', evidence.stderr);
      return run;
    }
  }

  private fingerprint(request: RunRequest, principal: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ request, principal }))
      .digest('hex');
  }

  private async recordRequest(runId: string, request: RunRequest, principal: string): Promise<void> {
    const record: ExecutionRequestRecord = {
      id: runId,
      runId,
      workId: request.workId,
      operation: request.operation,
      principal,
      request,
      createdAt: new Date().toISOString(),
    };
    await this.db.collection<ExecutionRequestRecord>(COLLECTIONS.executionRequests).put(record, record.id);
  }

  private async recordContract(contract: ExecutionContractRecord['contract']): Promise<void> {
    const record: ExecutionContractRecord = {
      id: contract.runId,
      runId: contract.runId,
      principal: contract.principal,
      operation: contract.operation,
      commandJson: JSON.stringify(contract.command),
      contract,
      createdAt: new Date().toISOString(),
    };
    await this.db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).put(record, record.id);
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

    const result = await runs.updateIfVersion(runId, current.__version ?? 1, {
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, await service.health());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const principal = parsePrincipal(request);
        if (!principal) {
          writeJson(response, 401, { error: 'Missing authenticated principal' });
          return;
        }
        const payload = await readJson<RunRequest>(request);
        const run = await service.startRun(payload, principal);
        writeJson(response, 201, run);
        return;
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runMatch) {
        const run = await service.getRun(runMatch[1]);
        writeJson(response, run ? 200 : 404, run ?? { error: 'Run not found' });
        return;
      }

      const evidenceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && evidenceMatch) {
        const evidence = await service.getEvidence(evidenceMatch[1]);
        writeJson(response, evidence ? 200 : 404, evidence ?? { error: 'Evidence not found' });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelMatch) {
        const principal = parsePrincipal(request);
        if (!principal) {
          writeJson(response, 401, { error: 'Missing authenticated principal' });
          return;
        }
        const existing = await service.getRun(cancelMatch[1]);
        if (!existing) {
          writeJson(response, 404, { error: 'Run not found' });
          return;
        }
        if (existing.principal !== principal) {
          writeJson(response, 403, { error: 'Forbidden' });
          return;
        }
        const run = await service.cancelRun(cancelMatch[1]);
        writeJson(response, 202, run);
        return;
      }

      writeJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Software Factory Runner error: ${message}\n`);
      writeJson(response, 500, { error: 'Internal server error' });
    }
  });

  return { service, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FACTORY_PORT ?? 3000);
  const { server } = await createHttpServer({
    mode: (process.env.FACTORY_FELTDB_MODE as 'local' | 'remote' | undefined) ?? 'local',
    flowPath: process.env.FACTORY_FLOW_PATH,
    repositoryRoot: process.env.FACTORY_REPOSITORY_ROOT,
    workspaceRoot: process.env.FACTORY_WORKSPACE_ROOT,
    serverUrl: process.env.FELTDB_URL,
    serverToken: process.env.FELTDB_TOKEN,
    namespace: process.env.FACTORY_NAMESPACE,
    environmentId: process.env.FACTORY_ENVIRONMENT_ID,
  });

  server.listen(port, () => {
    process.stdout.write(`Software Factory Runner listening on ${port}\n`);
  });
}
