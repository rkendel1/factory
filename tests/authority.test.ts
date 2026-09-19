import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, createTempWorkspace, seedWork } from './helpers.js';

const request = {
  workId: 'work_123',
  repository: {
    provider: 'local',
    owner: 'rkendel1',
    name: 'factory',
    ref: 'main',
  },
  operation: 'repo-echo',
};

test('missing .flow authority rejects execution', async () => {
  const root = await createTempWorkspace('authority-flow');
  const flowPath = path.join(root, '.flow');
  await writeFile(flowPath, 'flow_version 1\napp broken {\n  collection Work {\n    owner_principal: text\n  }\n}\n', 'utf8');
  const service = await createService({ flowPath, workingDirectory: root, namespace: 'authority-flow' });
  await seedWork(service);

  const run = await service.startRun(request, 'factory-service');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /missing \.flow authority/i);
});

test('missing FeltDB work rejects execution', async () => {
  const service = await createService();
  const run = await service.startRun(request, 'factory-service');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /missing FeltDB work state/i);
});

test('missing authorization rejects execution', async () => {
  const service = await createService();
  await seedWork(service, { ownerPrincipal: 'different-principal' });

  const run = await service.startRun(request, 'factory-service');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /does not own work/i);
});

test('unauthorized capability rejects execution', async () => {
  const service = await createService();
  await seedWork(service, { operation: 'architecture-conformance' });

  const run = await service.startRun({ ...request, operation: 'architecture-conformance' }, 'unlisted-principal');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /does not own work|not delegated/i);
});
