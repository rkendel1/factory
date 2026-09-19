import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryDB, loadFactoryFlow, COLLECTIONS } from '../src/felt.js';
import type { FlowCollection } from '@feltdb/core';

function collection(flow: ReturnType<typeof loadFactoryFlow>, name: string): FlowCollection {
  const result = flow.collections.find((item) => item.name === name);
  assert.ok(result, `missing ${name} collection`);
  return result;
}

test('the canonical FlowSpec exposes Factory state and relationships to Studio', () => {
  const flow = loadFactoryFlow();
  assert.deepEqual(flow.collections.map(({ name }) => name), Object.values(COLLECTIONS));

  assert.equal(collection(flow, 'ExecutionRequest').fields.find((field) => field.name === 'runId')?.type, 'ref Run');
  assert.equal(collection(flow, 'ExecutionContract').fields.find((field) => field.name === 'runId')?.type, 'ref Run');
  assert.equal(collection(flow, 'Run').fields.find((field) => field.name === 'workId')?.type, 'ref Work');
  assert.equal(collection(flow, 'Evidence').fields.find((field) => field.name === 'runId')?.type, 'ref Run');
  assert.equal(collection(flow, 'AuthorizationDecision').fields.find((field) => field.name === 'runId')?.type, 'ref Run');

  const contractPolicy = flow.policies.find((policy) => policy.name === 'ExecutionContract');
  const authorizationPolicy = flow.policies.find((policy) => policy.name === 'AuthorizationDecision');
  assert.ok(contractPolicy?.statements.includes('write: none'));
  assert.ok(authorizationPolicy?.statements.includes('write: none'));
});

test('Studio can observe durable Factory run changes through FeltDB reactivity', async () => {
  const db = await createFactoryDB({
    mode: 'local',
    namespace: `studio-${Date.now()}`,
    flowPath: `${process.cwd()}/.flow`,
  });
  const runs = db.collection<{ id: string; status: string }>(COLLECTIONS.runs);
  const observed = new Promise<string>((resolve) => {
    const unsubscribe = runs.subscribe((items) => {
      const status = items.find((item) => item.id === 'studio-run')?.status;
      if (status === 'completed') {
        unsubscribe();
        resolve(status);
      }
    });
  });

  await runs.put({ id: 'studio-run', status: 'accepted' }, 'studio-run');
  await runs.update('studio-run', { status: 'completed' });

  assert.equal(await observed, 'completed');
});
