import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_PROTOCOL_ID, validateUiContribution } from '@appport/protocol';
import { appPortServicesUiContribution } from '../src/appport-services.js';
import { composeProductUi, factoryUiContribution, factoryUiContributor } from '../src/ui.js';
import { createHttpServer } from '../src/server.js';
import { createTempWorkspace } from './helpers.js';
import type { Authenticator } from '../src/auth.js';

const capabilities = [
  'repository.read', 'evidence.write', 'artifact.write',
  'configuration.read', 'apikeys.read', 'notifications.read', 'webhooks.read', 'jobs.read',
];

test('Factory and AppPort Services publish valid AppPort/ui/1 contributions', () => {
  for (const contribution of [factoryUiContribution, appPortServicesUiContribution]) {
    assert.equal(validateUiContribution(contribution).protocol, UI_PROTOCOL_ID);
    assert.equal(new Set(contribution.surfaces.map(({ id }) => id)).size, contribution.surfaces.length);
    assert.equal(new Set(contribution.navigation.map(({ id }) => id)).size, contribution.navigation.length);
    assert.deepEqual(contribution.composition.requires, ['identity', 'tenant', 'application', 'environment']);
  }
});

test('generic product composition preserves shared context and only granted capabilities', async () => {
  const context = {
    principal: { id: 'operator-1' },
    tenant: 'tenant-a',
    application: 'software_factory',
    environment: 'test',
    capabilities,
  } as const;
  const composed = await composeProductUi([
    factoryUiContributor,
    { contribution: () => appPortServicesUiContribution },
  ], context);

  assert.deepEqual(composed.products.map(({ id }) => id), ['software_factory', 'appport-services']);
  assert.deepEqual(composed.context, context);
  assert.deepEqual([...composed.capabilities].sort(), [...capabilities].sort());
  assert.ok(composed.surfaces.some(({ route }) => route === '/factory/runs'));
  assert.ok(composed.surfaces.some(({ route }) => route === '/configuration'));
  assert.ok(composed.surfaces.every(({ capabilities: required }) => required.every((capability) => capabilities.includes(capability))));
});

test('composition filters unauthorized surfaces and never contains secret values', async () => {
  const marker = 'must-not-leak-secret-value';
  const composed = await composeProductUi([
    factoryUiContributor,
    { contribution: () => appPortServicesUiContribution },
  ], {
    principal: { id: 'operator-1' },
    tenant: 'tenant-a',
    application: 'software_factory',
    environment: 'test',
    capabilities: ['configuration.read'],
  });
  assert.deepEqual(composed.surfaces.map(({ route }) => route).sort(), ['/configuration', '/secrets']);
  assert.doesNotMatch(JSON.stringify(composed), new RegExp(marker));
});

test('authenticated UI discovery composes Factory with packaged service UI', async () => {
  const workingDirectory = await createTempWorkspace('factory-ui');
  const seen: string[] = [];
  const authenticator: Authenticator = {
    async authenticate(_request, operation) {
      seen.push(operation);
      return {
        principal: 'operator-1', tenant: 'tenant-a', claims: {}, session: null, delegation: null,
        boundaryVerified: true, authorizedCapabilities: capabilities,
      };
    },
  };
  const { server } = await createHttpServer({ mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`, environmentId: 'test', authenticator });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/ui`);
    assert.equal(response.status, 200);
    const body = await response.json() as { products: Array<{ id: string }>; context: { tenant: string; application: string; environment: string } };
    assert.deepEqual(body.products.map(({ id }) => id), ['software_factory', 'appport-services']);
    assert.deepEqual(body.context, { principal: { id: 'operator-1' }, tenant: 'tenant-a', application: 'software_factory', environment: 'test', capabilities });
    assert.deepEqual(seen, ['factory.ui.read']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
