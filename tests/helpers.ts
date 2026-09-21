import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FactoryService } from '../src/server.js';
import { COLLECTIONS } from '../src/felt.js';
import type { FactoryServiceConfig, WorkRecord } from '../src/types.js';

export async function createTempWorkspace(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

export async function createRepository(root: string, files: Record<string, string>): Promise<string> {
  const repositoryRoot = path.join(root, 'source-repo');
  await mkdir(repositoryRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(repositoryRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  }
  return repositoryRoot;
}

export async function createService(config: Partial<FactoryServiceConfig> = {}): Promise<FactoryService> {
  const workingDirectory = config.workingDirectory ?? await createTempWorkspace('factory-db');
  const flowPath = config.flowPath ?? path.resolve(process.cwd(), '.flow');
  return FactoryService.create({
    mode: 'local',
    namespace: config.namespace ?? path.basename(workingDirectory),
    workingDirectory,
    flowPath,
    repositoryRoot: config.repositoryRoot,
    workspaceRoot: config.workspaceRoot ?? path.join(workingDirectory, 'workspaces'),
    paxExecutable: config.paxExecutable,
    environmentId: 'test',
    githubIntegration: config.githubIntegration,
  });
}

export async function seedWork(service: FactoryService, work: Partial<WorkRecord> = {}): Promise<WorkRecord> {
  const record: WorkRecord = {
    id: work.id ?? 'work_123',
    ownerPrincipal: work.ownerPrincipal ?? 'factory-service',
    operation: work.operation ?? 'repo-echo',
    repositoryProvider: work.repositoryProvider ?? 'local',
    repositoryOwner: work.repositoryOwner ?? 'rkendel1',
    repositoryName: work.repositoryName ?? 'factory',
    repositoryRef: work.repositoryRef ?? 'main',
    status: work.status ?? 'active',
    ...(work.githubConnectionId ? { githubConnectionId: work.githubConnectionId } : {}),
  };

  const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  await db.collection<WorkRecord>(COLLECTIONS.work).put(record, record.id);
  return record;
}
