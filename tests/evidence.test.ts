import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence } from '../src/evidence.js';
import type { ExecutionContract } from '../src/types.js';

const contract: ExecutionContract = {
  runId: 'run_123',
  workId: 'work_123',
  principal: 'factory-service',
  repository: { provider: 'github', owner: 'rkendel1', name: 'flow_db', ref: 'main', commit: 'abc123' },
  operation: 'architecture-conformance',
  capabilities: ['repository.read', 'evidence.write'],
  command: ['npm', 'run', 'conformance'],
  limits: { timeoutMs: 1000 },
  evidence: { required: true },
};

test('success produces structured result', () => {
  const evidence = buildEvidence(contract, {
    status: 'completed',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stdout: 'ok\nJEV: ALIGNED\nWhy: deterministic pass',
    stderr: '',
  }, 'abc123');

  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.deterministicResult, 'PASS');
  assert.equal(evidence.finalResult, 'PASS');
  assert.equal(evidence.jev.status, 'ALIGNED');
});

test('failure produces structured result with invariant evidence', () => {
  const evidence = buildEvidence(contract, {
    status: 'failed',
    exitCode: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 2000,
    stdout: 'Invariant: durable-authority\nExpected: true\nObserved: false\nJEV: DRIFT\nWhy: durable authority missing',
    stderr: '',
  }, 'abc123');

  assert.equal(evidence.deterministicResult, 'FAIL');
  assert.equal(evidence.finalResult, 'FAIL');
  assert.equal(evidence.invariant?.name, 'durable-authority');
  assert.equal(evidence.invariant?.expected, 'true');
  assert.equal(evidence.invariant?.observed, 'false');
  assert.equal(evidence.jev.status, 'DRIFT');
});

test('JEV unavailable does not override deterministic failure', () => {
  const evidence = buildEvidence(contract, {
    status: 'failed',
    exitCode: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stdout: 'Invariant: durable-authority\nExpected: true\nObserved: false',
    stderr: 'deterministic failure',
  }, 'abc123');

  assert.equal(evidence.finalResult, 'FAIL');
  assert.equal(evidence.jev.status, 'UNAVAILABLE');
});

test('cancelled execution remains cancelled in structured evidence', () => {
  const evidence = buildEvidence(contract, {
    status: 'cancelled',
    exitCode: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stdout: '',
    stderr: 'cancelled by caller',
  }, 'abc123');

  assert.equal(evidence.deterministicResult, 'CANCELLED');
  assert.equal(evidence.finalResult, 'CANCELLED');
});
