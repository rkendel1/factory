import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, createTempWorkspace, seedWork } from './helpers.js';
import { COLLECTIONS } from '../src/felt.js';

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

test('caller execution fields are rejected instead of becoming contract authority', async () => {
  const service = await createService();
  await seedWork(service);

  await assert.rejects(
    service.startRun({
      ...request,
      command: ['node', '-e', 'process.exit(0)'],
      execution_mode: 'native',
      timeoutMs: 999999999,
      capabilities: ['secret.read'],
      principal: 'attacker',
    } as typeof request & Record<string, unknown>, 'factory-service'),
    /not accepted/i,
  );
});

test('authorized contract and evidence retain factory provenance', async () => {
  const service = await createService();
  await seedWork(service);

  const run = await service.startRun(request, 'factory-service');
  const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  const contract = await db.collection(COLLECTIONS.executionContracts).get(run.id) as {
    fingerprint: string;
    contract: { command?: string[]; fingerprint?: string; authorizationDecisionId?: string };
  } | null;
  const evidence = await service.getEvidence(run.id);

  assert.ok(contract?.fingerprint);
  assert.equal(contract?.fingerprint, contract?.contract.fingerprint);
  assert.equal(contract?.contract.authorizationDecisionId, run.authorizationDecisionId);
  assert.equal(evidence?.contractFingerprint, contract?.fingerprint);
  assert.equal(evidence?.authorizationDecision, 'granted');
  assert.deepEqual(contract?.contract.command, ['node', '-e', "console.log('authorized')"]);
});
