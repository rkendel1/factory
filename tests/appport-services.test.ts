import test from 'node:test';
import assert from 'node:assert/strict';
import { createServices, type AppPortServices } from '@appport/services';
import type { StateFirstDB } from '@feltdb/core';
import { createHttpServer } from '../src/server.js';
import { createTempWorkspace } from './helpers.js';
import type { Authenticator } from '../src/auth.js';

const secret = 'secret-value-that-must-not-be-returned';

async function withServicesServer(
  authenticator: Authenticator,
  callback: (origin: string) => Promise<void>,
  appPortServices?: AppPortServices,
): Promise<void> {
  const workingDirectory = await createTempWorkspace('factory-services');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/appport-services`, environmentId: 'development', authenticator, appPortServices,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function authorized(seen: string[], allowed = [
  'configuration.read', 'configuration.write', 'configuration.delete', 'secret.rotate',
  'apikeys.read', 'notifications.read', 'webhooks.read', 'jobs.read',
]): Authenticator {
  return {
    async authenticate(_request, operation) {
      seen.push(operation);
      if (!allowed.includes(operation)) throw new Error(`denied ${operation}`);
      return {
        principal: 'operator-1', tenant: 'tenant-a', claims: {}, session: { id: 'session-1' }, delegation: null,
        boundaryVerified: true, authorizedCapabilities: allowed,
      };
    },
  };
}

test('Factory consumes packaged configuration and secrets with AuthBoundry context', async () => {
  const seen: string[] = [];
  const services = createServices({ memory: true, namespace: 'configuration-consumption' });
  await withServicesServer(authorized(seen), async (origin) => {
    const query = '?application=software_factory&environment=production';
    const variable = await fetch(`${origin}/v1/configuration/variables${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PUBLIC_ORIGIN', value: 'https://factory.example', required: true }),
    });
    assert.equal(variable.status, 201);
    const variableView = await variable.json() as { tenantId: string; applicationId: string; environment: string };
    assert.deepEqual(
      { tenantId: variableView.tenantId, applicationId: variableView.applicationId, environment: variableView.environment },
      { tenantId: 'tenant-a', applicationId: 'software_factory', environment: 'production' },
    );

    const updatedVariable = await fetch(`${origin}/v1/configuration/variables/PUBLIC_ORIGIN${query}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'https://updated.factory.example', required: true }),
    });
    const updatedVariableText = await updatedVariable.text();
    assert.equal(updatedVariable.status, 200, updatedVariableText);

    const createdSecret = await fetch(`${origin}/v1/configuration/secrets${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DEPLOY_TOKEN', value: secret, required: true }),
    });
    assert.equal(createdSecret.status, 201);
    assert.doesNotMatch(await createdSecret.text(), new RegExp(secret));

    const rotatedSecret = await fetch(`${origin}/v1/configuration/secrets/DEPLOY_TOKEN${query}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: `${secret}-rotated`, required: true }),
    });
    const rotatedSecretText = await rotatedSecret.text();
    assert.equal(rotatedSecret.status, 200, rotatedSecretText);
    assert.doesNotMatch(rotatedSecretText, /secret-value/);

    const listed = await fetch(`${origin}/v1/configuration${query}`);
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.match(text, /https:\/\/updated\.factory\.example/);
    assert.match(text, /DEPLOY_TOKEN/);
    assert.doesNotMatch(text, new RegExp(secret));

    assert.equal((await fetch(`${origin}/v1/configuration/variables/PUBLIC_ORIGIN${query}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${origin}/v1/configuration/secrets/DEPLOY_TOKEN${query}`, { method: 'DELETE' })).status, 204);
    const empty = await fetch(`${origin}/v1/configuration${query}`);
    assert.deepEqual(await empty.json(), { variables: [], secrets: [], declarations: [] });
    assert.deepEqual(seen, [
      'configuration.write', 'configuration.write', 'configuration.write', 'secret.rotate',
      'configuration.read', 'configuration.delete', 'configuration.delete', 'configuration.read',
    ]);
  }, services);
  const db = services['_getDb'] as StateFirstDB;
  const audit = await db.collection<Record<string, unknown>>('ConfigurationAuditEvents').all();
  assert.equal(audit.length, 6);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(secret));
});

test('packaged management screens are mounted rather than recreated by Factory', async () => {
  await withServicesServer(authorized([]), async (origin) => {
    const pages = ['/configuration', '/secrets', '/api-keys', '/notifications', '/webhooks', '/jobs'];
    const responses = await Promise.all(pages.map((page) => fetch(`${origin}${page}`)));
    assert.ok(responses.every(({ status }) => status === 200));
    const html = await responses[0].text();
    assert.match(html, /<strong>AppPort Services<\/strong>/);
    assert.match(html, /<h1>Configuration<\/h1>/);
    assert.match(html, /<h2>Variables<\/h2>/);
    assert.match(html, /<h2>Secrets<\/h2>/);
    assert.match(html, /<option>development<\/option>/);
    assert.doesNotMatch(html, /localStorage|sessionStorage|secret-value-that-must-not-be-returned/);
  });
});

test('service API defaults to the host application and environment context', async () => {
  const services = createServices({ memory: true, namespace: `host-context-${Date.now()}` });
  await withServicesServer(authorized([]), async (origin) => {
    const response = await fetch(`${origin}/v1/configuration/variables`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HOST_CONTEXT', value: 'shared' }),
    });
    assert.equal(response.status, 201);
    const view = await response.json() as { tenantId: string; applicationId: string; environment: string };
    assert.deepEqual(
      { tenantId: view.tenantId, applicationId: view.applicationId, environment: view.environment },
      { tenantId: 'tenant-a', applicationId: 'software_factory', environment: 'development' },
    );
    const listed = await fetch(`${origin}/v1/configuration`);
    assert.match(await listed.text(), /HOST_CONTEXT/);
  }, services);
});

test('read-visible configuration UI cannot bypass write authorization', async () => {
  await withServicesServer(authorized([], ['configuration.read']), async (origin) => {
    assert.equal((await fetch(`${origin}/configuration`)).status, 200);
    const mutation = await fetch(`${origin}/v1/configuration/variables`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DENIED_VALUE', value: secret }),
    });
    assert.equal(mutation.status, 401);
    assert.doesNotMatch(await mutation.text(), new RegExp(secret));
  });
});

test('AppPort Services fails closed when AuthBoundry denies access', async () => {
  const denied: Authenticator = { async authenticate() { throw new Error('denied'); } };
  await withServicesServer(denied, async (origin) => {
    const response = await fetch(`${origin}/v1/configuration`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'AuthBoundry authentication or authorization failed' });
  });
});

test('service unavailability returns a sanitized failure without a local fallback', async () => {
  const workingDirectory = await createTempWorkspace('factory-services-unavailable');
  const services = createServices({ mode: 'local', namespace: 'unavailable', path: workingDirectory });
  services.configuration.list = async () => { throw new Error(`backend unavailable: ${secret}`); };
  await withServicesServer(authorized([]), async (origin) => {
    const response = await fetch(`${origin}/v1/configuration`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.match(text, /Configuration operation failed/);
    assert.doesNotMatch(text, /backend unavailable|secret-value/);
  }, services);
});
