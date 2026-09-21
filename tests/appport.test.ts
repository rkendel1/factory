import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryAppPortApplication } from '../src/appport.js';
import { createCanonicalApplicationContract } from '../src/application-contract.js';
import { loadFactoryFlow } from '../src/felt.js';
import { createService, createRepository, createTempWorkspace, seedWork } from './helpers.js';

test('AppPort SDK is the canonical Factory protocol contract', () => {
  const factoryAppPortApplication = createFactoryAppPortApplication();
  const contract = createCanonicalApplicationContract(loadFactoryFlow());
  const manifest = factoryAppPortApplication.manifest();
  assert.equal(manifest.application.id, 'software_factory');
  assert.deepEqual(manifest.provides.map((capability) => capability.name), [
    'softwarefactory.architectureconformance',
    'softwarefactory.pullrequestmerge',
    'softwarefactory.repoecho',
    'softwarefactory.repositorieslist',
  ]);
  assert.equal(factoryAppPortApplication.fingerprint(), contract.appBoundry.contractFingerprint);
  assert.equal(contract.fingerprint, contract.appBoundry.contractFingerprint);
});

test('authorized runs persist AppPort provenance without secret material', async () => {
  const root = await createTempWorkspace('appport-test');
  const repositoryRoot = await createRepository(root, { 'README.md': 'appport' });
  const service = await createService({
    namespace: `appport-${Date.now()}`,
    repositoryRoot,
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
  assert.equal(evidence?.appport?.protocol, 'appport');
  assert.equal(evidence?.appport?.operation, 'repo-echo');
  assert.equal(evidence?.appport?.service, 'execution');
  assert.equal(evidence?.appport?.capability, 'repository.read');
  assert.equal(evidence?.appport?.applicationFingerprint, evidence?.applicationContractFingerprint);
  assert.equal(JSON.stringify(evidence).includes('secret'), false);
});

test('changing .flow changes the canonical application projection', () => {
  const flow = loadFactoryFlow();
  const changed = structuredClone(flow);
  changed.capabilities[1].statements = changed.capabilities[1].statements.map((statement) =>
    statement === 'grant evidence.write' ? 'grant artifact.write' : statement);
  const original = createCanonicalApplicationContract(flow);
  const projection = createCanonicalApplicationContract(changed);
  assert.notEqual(projection.fingerprint, original.fingerprint);
  assert.notEqual(
    projection.appBoundry.contractFingerprint,
    original.appBoundry.contractFingerprint,
  );
});
