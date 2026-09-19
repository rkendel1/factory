import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeContract } from '../src/execution.js';
import { createService, createRepository, createTempWorkspace, seedWork } from './helpers.js';

test('authorized command executes and persists evidence', async () => {
  const root = await createTempWorkspace('execution-success');
  const repositoryRoot = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'repo', version: '1.0.0', type: 'module' }),
  });
  const service = await createService({ workingDirectory: root, namespace: 'execution-success', repositoryRoot });
  await seedWork(service);

  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
  }, 'factory-service');

  assert.equal(run.status, 'completed');
  const evidence = await service.getEvidence(run.id);
  assert.ok(evidence);
  assert.equal(evidence?.finalResult, 'PASS');
  assert.match(evidence?.stdout ?? '', /authorized/);
  await assert.rejects(access(path.join(root, 'workspaces', run.id)));
});

test('unauthorized shell command is rejected by executor boundary', async () => {
  const root = await createTempWorkspace('execution-unauthorized');
  const repositoryRoot = await createRepository(root, { 'README.md': '# test\n' });

  await assert.rejects(
    executeContract({
      runId: 'run_shell',
      workId: 'work_123',
      principal: 'factory-service',
      repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main', path: repositoryRoot },
      operation: 'repo-echo',
      capabilities: ['repository.read'],
      command: ['bash', '-lc', 'echo unauthorized'],
      limits: { timeoutMs: 1000 },
      evidence: { required: true },
    }, { repositoryRoot, workspaceRoot: path.join(root, 'workspaces') }),
    /not authorized/i,
  );
});
