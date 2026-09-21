import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, createRepository, createTempWorkspace, seedWork } from './helpers.js';

function flowWithCommand(command: string[], timeoutMs = 1000): string {
  return `flow_version 1
app software_factory {
  collection Work {
    owner_principal: text
    operation: text
    repository_provider: text
    repository_owner: text
    repository_name: text
    repository_ref: text
    status: text
  }
  collection ExecutionRequest {
    run_id: text
    work_id: text
    operation: text
    principal: text
    created_at: datetime
  }
  collection ExecutionContract {
    run_id: text
    principal: text
    operation: text
    command_json: text
    created_at: datetime
  }
  collection Run {
    work_id: text
    principal: text
    operation: text
    status: text
    created_at: datetime
    updated_at: datetime
    completed_at: datetime
  }
  collection RunEvent {
    run_id: text
    status: text
    detail: text
    created_at: datetime
  }
  collection Artifact {
    run_id: text
    path: text
    kind: text
    created_at: datetime
  }
  collection Evidence {
    run_id: text
    status: text
    deterministic_result: text
    final_result: text
    created_at: datetime
  }
  collection AuthorizationDecision {
    run_id: text
    principal: text
    operation: text
    decision: text
    reason: text
    created_at: datetime
  }
  capability FactoryApplicationAccess {
    visibility internal
    application factory
    grant factory.ui.read
    grant configuration.read
    grant configuration.write
    grant configuration.delete
    grant secret.rotate
    grant apikeys.read
    grant apikeys.create
    grant apikeys.revoke
  }
  capability RepositoryEchoExecution {
    visibility internal
    operation repo-echo
    principal factory-service
    command ${JSON.stringify(command)}
    timeoutMs ${timeoutMs}
    grant repository.read
    grant evidence.write
  }
}`;
}

test('timeout fails run and records evidence', async () => {
  const root = await createTempWorkspace('execution-timeout');
  const flowPath = path.join(root, '.flow');
  await writeFile(flowPath, flowWithCommand(['node', '-e', 'setTimeout(() => console.log("done"), 2000)'], 50), 'utf8');
  const repositoryRoot = await createRepository(root, { 'package.json': '{"name":"repo","version":"1.0.0"}' });
  const service = await createService({ workingDirectory: root, namespace: 'execution-timeout', repositoryRoot, flowPath });
  await seedWork(service);

  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
  }, 'factory-service');

  assert.equal(run.status, 'failed');
  const evidence = await service.getEvidence(run.id);
  assert.match(evidence?.stderr ?? '', /timed out/i);
});

test('nonzero exit fails run', async () => {
  const root = await createTempWorkspace('execution-failure');
  const flowPath = path.join(root, '.flow');
  await writeFile(flowPath, flowWithCommand(['node', '-e', 'process.exit(2)']), 'utf8');
  const repositoryRoot = await createRepository(root, { 'package.json': '{"name":"repo","version":"1.0.0"}' });
  const service = await createService({ workingDirectory: root, namespace: 'execution-failure', repositoryRoot, flowPath });
  await seedWork(service);

  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
  }, 'factory-service');

  assert.equal(run.status, 'failed');
  const evidence = await service.getEvidence(run.id);
  assert.equal(evidence?.exitCode, 2);
  assert.equal(evidence?.deterministicResult, 'FAIL');
});

test('same idempotency key returns the same run', async () => {
  const root = await createTempWorkspace('execution-idempotent');
  const repositoryRoot = await createRepository(root, { 'package.json': '{"name":"repo","version":"1.0.0"}' });
  const service = await createService({ workingDirectory: root, namespace: 'execution-idempotent', repositoryRoot });
  await seedWork(service);

  const request = {
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
    idempotencyKey: 'idem-1',
  };

  const first = await service.startRun(request, 'factory-service');
  const second = await service.startRun(request, 'factory-service');
  assert.equal(first.id, second.id);
});

test('durable run survives restart and interrupted intermediate state is recoverable', async () => {
  const root = await createTempWorkspace('execution-recovery');
  const repositoryRoot = await createRepository(root, { 'package.json': '{"name":"repo","version":"1.0.0"}' });
  const service = await createService({ workingDirectory: root, namespace: 'execution-recovery', repositoryRoot });
  await seedWork(service);

  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
    idempotencyKey: 'restart-accepted',
  }, 'factory-service');

  const restarted = await createService({ workingDirectory: root, namespace: 'execution-recovery', repositoryRoot });
  const stored = await restarted.getRun(run.id);
  assert.equal(stored?.id, run.id);

  const interruptedRoot = await createTempWorkspace('execution-interrupted');
  const interruptedRepo = await createRepository(interruptedRoot, { 'package.json': '{"name":"repo","version":"1.0.0"}' });
  const interrupted = await createService({ workingDirectory: interruptedRoot, namespace: 'execution-interrupted', repositoryRoot: interruptedRepo });
  await seedWork(interrupted);
  const db = (interrupted as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  await db.collection('Run').put({
    id: 'run_interrupt',
    operationId: 'op_interrupt',
    operationVersion: 0,
    workId: 'work_123',
    principal: 'factory-service',
    operation: 'repo-echo',
    status: 'preparing',
    idempotencyKey: 'interrupt',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, 'run_interrupt');
  await db.admitOperation({ idempotencyKey: 'interrupt-op', kind: 'factory.run' });

  const recovered = await createService({ workingDirectory: interruptedRoot, namespace: 'execution-interrupted', repositoryRoot: interruptedRepo });
  const recoveredRun = await recovered.getRun('run_interrupt');
  assert.equal(recoveredRun?.status, 'failed');
  assert.match(recoveredRun?.error ?? '', /restarted/i);
});
