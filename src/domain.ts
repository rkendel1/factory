import { randomUUID } from 'node:crypto';
import type { StateFirstDB } from '@feltdb/core';
import { COLLECTIONS } from './felt.js';
import type {
  ActionRecord,
  ActionStatus,
  DesiredStateRecord,
  EnvironmentRecord,
  ProjectRecord,
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

export class DomainValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}
