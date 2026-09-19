import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
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

  assert.equal(run.status, 'completed', run.error ?? '');
  const evidence = await service.getEvidence(run.id);
  assert.ok(evidence);
  assert.equal(evidence?.finalResult, 'PASS');
  assert.match(evidence?.stdout ?? '', /authorized/);
  await assert.rejects(access(path.join(root, 'workspaces', run.id)));
});

test('authorized PAX operation invokes PAX and records provenance', async () => {
  const root = await createTempWorkspace('execution-pax');
  const pax = path.join(root, 'pax');
  await writeFile(pax, '#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("pax 0.1.0"); else console.log(JSON.stringify({ status: "match" }));\n', 'utf8');
  await chmod(pax, 0o755);
  const repositoryRoot = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'repo', version: '1.0.0' }),
  });
  const service = await createService({
    workingDirectory: root,
    namespace: path.basename(root),
    repositoryRoot,
    paxExecutable: pax,
  });
  await seedWork(service, { operation: 'architecture-conformance' });

  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'architecture-conformance',
  }, 'factory-service');

  assert.equal(run.status, 'completed', run.error ?? '');
  const evidence = await service.getEvidence(run.id);
  assert.equal(evidence?.pax?.version, 'pax 0.1.0');
  assert.deepEqual(evidence?.pax?.invocation.slice(0, 4), ['pax', '--json', 'run', 'conformance']);
  assert.match(evidence?.stdout ?? '', /"status":"match"/);
});

test('missing PAX fails before project execution', async () => {
  const root = await createTempWorkspace('execution-pax-missing');
  const repositoryRoot = await createRepository(root, { 'package.json': '{}' });
  await assert.rejects(
    executeContract({
      runId: 'run_pax_missing',
      workId: 'work_123',
      principal: 'factory-service',
      repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main', path: repositoryRoot },
      operation: 'architecture-conformance',
      capabilities: ['repository.read'],
      execution: { mode: 'pax', operation: 'run', target: 'conformance', args: [] },
      limits: { timeoutMs: 1000 },
      evidence: { required: true },
    }, { repositoryRoot, workspaceRoot: path.join(root, 'workspaces'), paxExecutable: path.join(root, 'missing-pax') }),
    /PAX is required.*unavailable/i,
  );
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
      execution: { mode: 'native', args: [] },
      command: ['bash', '-lc', 'echo unauthorized'],
      limits: { timeoutMs: 1000 },
      evidence: { required: true },
    }, { repositoryRoot, workspaceRoot: path.join(root, 'workspaces') }),
    /not authorized/i,
  );
});
