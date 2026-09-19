import test from 'node:test';
import assert from 'node:assert/strict';
import { factoryAppPortApplication } from '../src/appport.js';
import { createService, createRepository, createTempWorkspace, seedWork } from './helpers.js';

test('AppPort SDK is the canonical Factory protocol contract', () => {
  const manifest = factoryAppPortApplication.manifest();
  assert.equal(manifest.application.id, 'software-factory');
  assert.deepEqual(manifest.provides.map((capability) => capability.name), ['factory.execution.run']);
  assert.match(factoryAppPortApplication.fingerprint(), /^[a-f0-9]{64}$/);
});

test('authorized runs persist AppPort provenance without secret material', async () => {
  const root = await createTempWorkspace('appport-test');
  const repositoryRoot = await createRepository(root, { 'README.md': 'appport' });
  const service = await createService({
    namespace: `appport-${Date.now()}`,
    repositoryRoot,
    appportPath: `${root}/services`,
  });
  const work = await seedWork(service, {
    operation: 'repo-echo',
    repositoryRef: 'main',
  });

  const run = await service.startRun({
    workId: work.id,
    operation: 'repo-echo',
    repository: {
      provider: 'local',
      owner: 'rkendel1',
      name: 'factory',
      ref: 'main',
    },
  }, 'factory-service');

  const evidence = await service.getEvidence(run.id);
  assert.equal(run.status, 'completed');
  assert.deepEqual(evidence?.appport, {
    protocol: 'appport',
    operation: 'repo-echo',
    service: 'execution',
    capability: 'repository.read',
  });
  assert.equal(JSON.stringify(evidence).includes('secret'), false);
});
