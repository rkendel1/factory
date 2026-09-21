import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverUi } from '@appport/client';
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
  assert.deepEqual(factoryUiContribution.product, { id: 'software_factory', version: '1.0.0' });
  assert.ok(factoryUiContribution.surfaces.every(({ route }) => route.startsWith('/') && !route.startsWith('//')));
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
  assert.equal(new Set(composed.surfaces.map(({ id }) => id)).size, composed.surfaces.length);
  assert.equal(new Set(composed.navigation.map(({ id }) => id)).size, composed.navigation.length);
  assert.ok(composed.navigation.some(({ product }) => product.id === 'software_factory'));
  assert.ok(composed.navigation.some(({ product }) => product.id === 'appport-services'));
});

test('single-product composition works for either independently owned product', async () => {
  const context = {
    principal: { id: 'operator-1' }, tenant: 'tenant-a', application: 'software_factory', environment: 'test', capabilities,
  } as const;
  const factoryOnly = await composeProductUi([factoryUiContributor], context);
  const servicesOnly = await composeProductUi([{ contribution: () => appPortServicesUiContribution }], context);
  assert.deepEqual(factoryOnly.products.map(({ id }) => id), ['software_factory']);
  assert.deepEqual(servicesOnly.products.map(({ id }) => id), ['appport-services']);
  assert.ok(factoryOnly.navigation.length > 0);
  assert.ok(servicesOnly.navigation.length > 0);
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

test('authenticated AppPort discovery returns a filtered Factory contribution', async () => {
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
    const body = await discoverUi(`http://127.0.0.1:${address.port}`);
    assert.equal(body.protocol, UI_PROTOCOL_ID);
    assert.deepEqual(body.product, { id: 'software_factory', version: '1.0.0' });
    assert.deepEqual(body.surfaces.map(({ id }) => id), ['work', 'runs', 'evidence', 'artifacts']);
    assert.deepEqual(body.capabilities, ['artifact.write', 'evidence.write', 'repository.read']);
    assert.deepEqual(seen, ['factory.ui.read']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
