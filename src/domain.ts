import { randomUUID } from 'node:crypto';
import type { StateFirstDB } from '@feltdb/core';
import { COLLECTIONS } from './felt.js';
import type {
  ActionGraphRecord,
  ActionRecord,
  ActionStatus,
  DesiredStateRecord,
  EnvironmentCurrentState,
  EnvironmentRecord,
  OperationalWorkEventRecord,
  OperationalWorkRecord,
  ProjectRecord,
  ReconciliationRecord,
  ReconciliationStatus,
  RepositoryRecord,
  RunRecord,
} from './types.js';

/**
 * The Factory product model, stored in FeltDB.
 *
 * Every read here is tenant-scoped and every child read is also project-scoped.
 * Isolation is a property of the query, not of the caller remembering to check:
 * a record belonging to another tenant or another project is not returned, so
 * there is no path where a caller can act on one by knowing its id.
 *
 * Nothing is cached in process memory. A restart re-reads FeltDB and sees the
 * same projects, environments, actions, and runs.
 */
export class FactoryDomain {
  constructor(private readonly db: StateFirstDB) {}

  private projects() { return this.db.collection<ProjectRecord>(COLLECTIONS.projects); }
  private repositories() { return this.db.collection<RepositoryRecord>(COLLECTIONS.repositories); }
  private environments() { return this.db.collection<EnvironmentRecord>(COLLECTIONS.environments); }
  private desired() { return this.db.collection<DesiredStateRecord>(COLLECTIONS.desiredState); }
  private actionRecords() { return this.db.collection<ActionRecord>(COLLECTIONS.actions); }
  private runRecords() { return this.db.collection<RunRecord>(COLLECTIONS.runs); }
  private operationalWork() { return this.db.collection<OperationalWorkRecord>(COLLECTIONS.operationalWork); }
  private operationalWorkEvents() { return this.db.collection<OperationalWorkEventRecord>(COLLECTIONS.operationalWorkEvents); }

  // -- Projects ------------------------------------------------------------

  async listProjects(tenantId: string): Promise<ProjectRecord[]> {
    const projects = await this.projects().find({ tenantId });
    return projects.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getProject(tenantId: string, id: string): Promise<ProjectRecord | null> {
    const project = await this.projects().get(id);
    return project && project.tenantId === tenantId ? project : null;
  }

  async createProject(input: {
    tenantId: string;
    name: string;
    description?: string;
    status?: ProjectRecord['status'];
  }): Promise<ProjectRecord> {
    const name = input.name?.trim();
    if (!name) throw new DomainValidationError('project name is required');
    const timestamp = new Date().toISOString();
    const record: ProjectRecord = {
      id: `prj_${randomUUID()}`,
      tenantId: input.tenantId,
      name,
      ...(input.description ? { description: input.description } : {}),
      status: input.status ?? 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.projects().insert(record, record.id);
    return record;
  }

  async updateProject(tenantId: string, id: string, patch: {
    name?: string;
    description?: string;
    status?: ProjectRecord['status'];
  }): Promise<ProjectRecord | null> {
    const current = await this.getProject(tenantId, id);
    if (!current) return null;
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new DomainValidationError('project name cannot be emptied');
    }
    const next: ProjectRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.projects().put(next, next.id);
    return next;
  }

  // -- Repositories --------------------------------------------------------

  async listRepositories(tenantId: string, projectId: string): Promise<RepositoryRecord[]> {
    return (await this.repositories().find({ tenantId, projectId }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async addRepository(tenantId: string, projectId: string, input: {
    provider?: string;
    owner: string;
    name: string;
    defaultBranch?: string;
    repositoryUrl?: string;
  }): Promise<RepositoryRecord> {
    if (!input.owner?.trim() || !input.name?.trim()) {
      throw new DomainValidationError('repository owner and name are required');
    }
    const record: RepositoryRecord = {
      id: `repo_${randomUUID()}`,
      projectId,
      tenantId,
      provider: input.provider?.trim() || 'github',
      owner: input.owner.trim(),
      name: input.name.trim(),
      defaultBranch: input.defaultBranch?.trim() || 'main',
      ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.repositories().insert(record, record.id);
    return record;
  }

  async getRepository(tenantId: string, projectId: string, id: string): Promise<RepositoryRecord | null> {
    const record = await this.repositories().get(id);
    return record && record.tenantId === tenantId && record.projectId === projectId ? record : null;
  }

  async removeRepository(tenantId: string, projectId: string, id: string): Promise<boolean> {
    const record = await this.getRepository(tenantId, projectId, id);
    if (!record) return false;
    await this.repositories().delete(id);
    return true;
  }

  // -- Environments --------------------------------------------------------

  async listEnvironments(tenantId: string, projectId: string): Promise<EnvironmentRecord[]> {
    return (await this.environments().find({ tenantId, projectId }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getEnvironment(tenantId: string, projectId: string, id: string): Promise<EnvironmentRecord | null> {
    const record = await this.environments().get(id);
    return record && record.tenantId === tenantId && record.projectId === projectId ? record : null;
  }

  async createEnvironment(tenantId: string, projectId: string, input: {
    name: string;
    provider?: string;
    configuration?: Record<string, unknown>;
    desiredState?: Record<string, unknown>;
  }): Promise<EnvironmentRecord> {
    const name = input.name?.trim();
    if (!name) throw new DomainValidationError('environment name is required');
    const timestamp = new Date().toISOString();
    const record: EnvironmentRecord = {
      id: `env_${randomUUID()}`,
      projectId,
      tenantId,
      name,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.desiredState ? { desiredState: input.desiredState } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.environments().insert(record, record.id);
    return record;
  }

  /**
   * Record what Factory observed an environment to be. Written only by
   * reconciliation, from durable run evidence.
   */
  async setEnvironmentState(
    tenantId: string,
    projectId: string,
    id: string,
    currentState: EnvironmentCurrentState,
  ): Promise<EnvironmentRecord | null> {
    const current = await this.getEnvironment(tenantId, projectId, id);
    if (!current) return null;
    const next: EnvironmentRecord = { ...current, currentState, updatedAt: new Date().toISOString() };
    await this.environments().put(next, next.id);
    return next;
  }

  // -- Desired state -------------------------------------------------------

  async getDesiredState(tenantId: string, projectId: string): Promise<DesiredStateRecord | null> {
    const records = await this.desired().find({ tenantId, projectId });
    return records[0] ?? null;
  }

  async putDesiredState(tenantId: string, projectId: string, input: {
    sourceRepositoryId?: string;
    sourceBranch?: string;
    deploymentEnabled?: boolean;
    targetProvider?: string;
    healthRequirement?: string;
    updatedBy?: string;
  }): Promise<DesiredStateRecord> {
    const current = await this.getDesiredState(tenantId, projectId);
    const timestamp = new Date().toISOString();
    const record: DesiredStateRecord = {
      id: current?.id ?? `dst_${randomUUID()}`,
      projectId,
      tenantId,
      ...(input.sourceRepositoryId !== undefined ? { sourceRepositoryId: input.sourceRepositoryId } : {}),
      ...(input.sourceBranch !== undefined ? { sourceBranch: input.sourceBranch } : {}),
      ...(input.deploymentEnabled !== undefined ? { deploymentEnabled: input.deploymentEnabled } : {}),
      ...(input.targetProvider !== undefined ? { targetProvider: input.targetProvider } : {}),
      ...(input.healthRequirement !== undefined ? { healthRequirement: input.healthRequirement } : {}),
      ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.desired().put(record, record.id);
    return record;
  }

  // -- Actions -------------------------------------------------------------

  async listActions(tenantId: string, projectId?: string): Promise<ActionRecord[]> {
    const actions = await this.actionRecords()
      .find(projectId ? { tenantId, projectId } : { tenantId });
    return actions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getAction(tenantId: string, id: string): Promise<ActionRecord | null> {
    const record = await this.actionRecords().get(id);
    return record && record.tenantId === tenantId ? record : null;
  }

  async createAction(record: ActionRecord): Promise<ActionRecord> {
    await this.actionRecords().insert(record, record.id);
    return record;
  }

  async patchAction(tenantId: string, id: string, patch: Partial<ActionRecord>): Promise<ActionRecord | null> {
    const current = await this.getAction(tenantId, id);
    if (!current) return null;
    const next: ActionRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.actionRecords().put(next, next.id);
    return next;
  }

  async setActionStatus(tenantId: string, id: string, status: ActionStatus): Promise<ActionRecord | null> {
    return this.patchAction(tenantId, id, { status });
  }

  // -- Reconciliation ------------------------------------------------------

  private reconciliations() {
    return this.db.collection<ReconciliationRecord>(COLLECTIONS.reconciliations);
  }

  async listReconciliations(tenantId: string, projectId?: string): Promise<ReconciliationRecord[]> {
    const records = await this.reconciliations()
      .find(projectId ? { tenantId, projectId } : { tenantId });
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getReconciliation(
    tenantId: string,
    projectId: string,
    environmentId: string,
  ): Promise<ReconciliationRecord | null> {
    const records = await this.reconciliations().find({ tenantId, projectId, environmentId });
    return records[0] ?? null;
  }

  /**
   * One reconciliation record per environment, created or updated in place.
   *
   * Configuration is durable state, not scheduler memory, so enabling
   * reconciliation twice configures the same record rather than starting a
   * second loop over the same environment.
   */
  async putReconciliation(input: {
    tenantId: string;
    projectId: string;
    environmentId: string;
    enabled?: boolean;
    interval?: string;
    intervalMs?: number;
  }): Promise<ReconciliationRecord> {
    const current = await this.getReconciliation(input.tenantId, input.projectId, input.environmentId);
    const timestamp = new Date().toISOString();
    const enabled = input.enabled ?? current?.enabled ?? true;
    const intervalMs = input.intervalMs ?? current?.intervalMs ?? 0;
    const record: ReconciliationRecord = {
      id: current?.id ?? `rec_${randomUUID()}`,
      projectId: input.projectId,
      environmentId: input.environmentId,
      tenantId: input.tenantId,
      status: enabled ? (current && current.enabled ? current.status : 'enabled') : 'disabled',
      interval: input.interval ?? current?.interval ?? '15m',
      intervalMs,
      enabled,
      ...(current?.lastObservedAt ? { lastObservedAt: current.lastObservedAt } : {}),
      ...(current?.lastReconciledAt ? { lastReconciledAt: current.lastReconciledAt } : {}),
      ...(current?.lastActionId ? { lastActionId: current.lastActionId } : {}),
      ...(current?.lastRunId ? { lastRunId: current.lastRunId } : {}),
      ...(current?.lastError ? { lastError: current.lastError } : {}),
      ...(current?.lastFingerprint ? { lastFingerprint: current.lastFingerprint } : {}),
      ...(current?.lastOutcome ? { lastOutcome: current.lastOutcome } : {}),
      // A newly enabled record is due now; an existing one keeps its schedule.
      ...(enabled
        ? { nextDueAt: current?.nextDueAt ?? timestamp }
        : {}),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(current?.__version === undefined ? {} : { __version: current.__version }),
    };
    await this.reconciliations().put(record, record.id);
    return record;
  }

  async patchReconciliation(
    tenantId: string,
    id: string,
    patch: Partial<ReconciliationRecord>,
  ): Promise<ReconciliationRecord | null> {
    const current = await this.reconciliations().get(id);
    if (!current || current.tenantId !== tenantId) return null;
    const next: ReconciliationRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.reconciliations().put(next, next.id);
    return next;
  }

  async deleteReconciliation(tenantId: string, projectId: string, environmentId: string): Promise<boolean> {
    const current = await this.getReconciliation(tenantId, projectId, environmentId);
    if (!current) return false;
    await this.reconciliations().delete(current.id);
    return true;
  }

  /** Every enabled record across every tenant, for the scheduler to filter. */
  async dueReconciliations(now: number): Promise<ReconciliationRecord[]> {
    const records = await this.reconciliations().all();
    return records
      .filter((record) => record.enabled)
      .filter((record) => !record.nextDueAt || Date.parse(record.nextDueAt) <= now)
      .filter((record) => !isLeased(record, now))
      .sort((left, right) => (left.nextDueAt ?? '').localeCompare(right.nextDueAt ?? ''));
  }

  /**
   * Claim a reconciliation for one worker.
   *
   * The claim is a compare-and-set on the record's version, so two workers that
   * read the same due record cannot both win: the second write is refused and
   * that worker moves on. An expired lease is reclaimable, so a worker that
   * died mid-pass does not block the environment forever.
   */
  async claimReconciliation(
    id: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ReconciliationRecord | null> {
    const current = await this.reconciliations().get(id);
    if (!current || !current.enabled || isLeased(current, now)) return null;
    const claimed: ReconciliationRecord = {
      ...current,
      status: 'running',
      leaseOwner: owner,
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    const result = await this.reconciliations()
      .updateIfVersion(id, current.__version ?? 1, claimed);
    return result.updated ? (result.item ?? claimed) : null;
  }

  async releaseReconciliation(
    id: string,
    patch: Partial<ReconciliationRecord>,
  ): Promise<ReconciliationRecord | null> {
    const current = await this.reconciliations().get(id);
    if (!current) return null;
    const released: ReconciliationRecord = {
      ...current,
      ...patch,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    delete released.leaseOwner;
    delete released.leaseExpiresAt;
    await this.reconciliations().put(released, released.id);
    return released;
  }

  /** An Action already doing this work, so reconciliation does not duplicate it. */
  async findOpenActionByFingerprint(
    tenantId: string,
    fingerprint: string,
  ): Promise<ActionRecord | null> {
    const open: ActionStatus[] = ['planned', 'awaiting-approval', 'authorized', 'running', 'executed', 'verifying'];
    const actions = await this.actionRecords().find({ tenantId, reconciliationFingerprint: fingerprint });
    return actions.find((action) => open.includes(action.status)) ?? null;
  }

  // -- Action graphs -------------------------------------------------------

  private graphs() { return this.db.collection<ActionGraphRecord>(COLLECTIONS.actionGraphs); }

  async listGraphs(tenantId: string, projectId?: string): Promise<ActionGraphRecord[]> {
    const graphs = await this.graphs().find(projectId ? { tenantId, projectId } : { tenantId });
    return graphs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getGraph(tenantId: string, id: string): Promise<ActionGraphRecord | null> {
    const graph = await this.graphs().get(id);
    return graph && graph.tenantId === tenantId ? graph : null;
  }

  async createGraph(record: ActionGraphRecord): Promise<ActionGraphRecord> {
    await this.graphs().insert(record, record.id);
    return record;
  }

  async patchGraph(tenantId: string, id: string, patch: Partial<ActionGraphRecord>): Promise<ActionGraphRecord | null> {
    const current = await this.getGraph(tenantId, id);
    if (!current) return null;
    const next: ActionGraphRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.graphs().put(next, next.id);
    return next;
  }

  /** The graph's nodes, in a stable order, read from FeltDB every time. */
  async graphActions(tenantId: string, graphId: string): Promise<ActionRecord[]> {
    const actions = await this.actionRecords().find({ tenantId, graphId });
    return actions.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id));
  }

  // -- Operational work (Attn ↔ Factory) -----------------------------------

  async listOperationalWork(tenantId: string, projectId?: string): Promise<OperationalWorkRecord[]> {
    const records = await this.operationalWork().find(projectId ? { tenantId, projectId } : { tenantId });
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getOperationalWork(tenantId: string, id: string): Promise<OperationalWorkRecord | null> {
    const record = await this.operationalWork().get(id);
    return record && record.tenantId === tenantId ? record : null;
  }

  async createOperationalWork(record: OperationalWorkRecord): Promise<OperationalWorkRecord> {
    await this.operationalWork().insert(record, record.id);
    return record;
  }

  async patchOperationalWork(tenantId: string, id: string, patch: Partial<OperationalWorkRecord>): Promise<OperationalWorkRecord | null> {
    const current = await this.getOperationalWork(tenantId, id);
    if (!current) return null;
    const next: OperationalWorkRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.operationalWork().put(next, next.id);
    return next;
  }

  async appendOperationalWorkEvent(record: Omit<OperationalWorkEventRecord, 'id' | 'createdAt'>): Promise<OperationalWorkEventRecord> {
    const event: OperationalWorkEventRecord = { id: `owe_${randomUUID()}`, createdAt: new Date().toISOString(), ...record };
    await this.operationalWorkEvents().insert(event, event.id);
    return event;
  }

  async listOperationalWorkEvents(tenantId: string, workId: string): Promise<OperationalWorkEventRecord[]> {
    const events = await this.operationalWorkEvents().find({ tenantId, workId });
    return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  // -- Runs ----------------------------------------------------------------

  async listRuns(tenantId: string, projectId?: string): Promise<RunRecord[]> {
    const runs = await this.runRecords().find(projectId ? { tenantId, projectId } : { tenantId });
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(tenantId: string, id: string): Promise<RunRecord | null> {
    const run = await this.runRecords().get(id);
    return run && run.tenantId === tenantId ? run : null;
  }
}

export function isLeased(record: ReconciliationRecord, now: number): boolean {
  return Boolean(record.leaseExpiresAt && Date.parse(record.leaseExpiresAt) > now);
}

export class DomainValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}
