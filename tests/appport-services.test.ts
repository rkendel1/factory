import test from 'node:test';
import assert from 'node:assert/strict';
import { createServices, type AppPortServices } from '@appport/services';
import type { StateFirstDB } from '@feltdb/core';
import { createHttpServer } from '../src/server.js';
import { createTempWorkspace } from './helpers.js';
import {
  AuthBoundryAuthenticationError,
  AuthBoundryAuthorizationError,
  type Authenticator,
} from '../src/auth.js';

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
  'apikeys.read', 'apikeys.create', 'apikeys.revoke', 'notifications.read', 'webhooks.read', 'jobs.read',
]): Authenticator {
  return {
    async authenticate(_request, operation) {
      seen.push(operation);
      if (!allowed.includes(operation)) throw new AuthBoundryAuthorizationError(operation);
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
    const query = '?application=caller_override&environment=production';
    const variable = await fetch(`${origin}/v1/configuration/variables${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PUBLIC_ORIGIN', value: 'https://factory.example', required: true }),
    });
    assert.equal(variable.status, 201);
    const variableView = await variable.json() as { tenantId: string; applicationId: string; environment: string };
    assert.deepEqual(
      { tenantId: variableView.tenantId, applicationId: variableView.applicationId, environment: variableView.environment },
      { tenantId: 'tenant-a', applicationId: 'software_factory', environment: 'development' },
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
    assert.match(html, /error\?\.(?:message)/);
    assert.doesNotMatch(html, /localStorage|sessionStorage|secret-value-that-must-not-be-returned/);
  });
});

test('packaged API-key management routes use explicit AuthBoundry capabilities', async () => {
  const seen: string[] = [];
  const services = createServices({ memory: true, namespace: `api-key-management-${Date.now()}` });
  await withServicesServer(authorized(seen), async (origin) => {
    const createdResponse = await fetch(`${origin}/_appport/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deployment', scopes: ['configuration.read'] }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = JSON.parse(createdText) as { id: string; secret: string };
    assert.ok(created.id);
    assert.ok(created.secret);

    const listedResponse = await fetch(`${origin}/_appport/api/keys`);
    assert.equal(listedResponse.status, 200);
    const listedText = await listedResponse.text();
    assert.match(listedText, /deployment/);
    assert.doesNotMatch(listedText, new RegExp(created.secret));
    assert.doesNotMatch(listedText, /secretHash/);

    assert.equal((await fetch(`${origin}/_appport/api/keys/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await fetch(`${origin}/_appport/api/keys`)).json(), []);
    assert.ok(seen.includes('apikeys.create'));
    assert.ok(seen.includes('apikeys.read'));
    assert.ok(seen.includes('apikeys.revoke'));
  }, services);
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
    assert.equal(mutation.status, 403);
    assert.doesNotMatch(await mutation.text(), new RegExp(secret));
  });
});

test('AppPort Services returns 403 when an authenticated principal is denied', async () => {
  const denied: Authenticator = {
    async authenticate(_request, capability) {
      throw new AuthBoundryAuthorizationError(capability);
    },
  };
  await withServicesServer(denied, async (origin) => {
    const response = await fetch(`${origin}/v1/configuration`, { headers: { 'x-request-id': 'cfg_test-denied' } });
    assert.equal(response.status, 403);
    const body = await response.json() as {
      error: { message: string };
      code: string;
      message: string;
      requestId: string;
    };
    assert.equal(body.code, 'APPPORT_AUTHORIZATION_DENIED');
    assert.equal(body.requestId, 'cfg_test-denied');
    assert.match(body.error.message, /Configuration request failed \(403\).*Request ID: cfg_test-denied/);
    assert.equal(response.headers.get('x-request-id'), 'cfg_test-denied');
  });

  test('configuration request correlation is forwarded to AuthBoundry', async () => {
    let observedRequestId: string | undefined;
    const authenticator: Authenticator = {
      async authenticate(request) {
        observedRequestId = request.headers['x-request-id'];
        return {
          principal: 'operator-1', tenant: 'tenant-a', claims: {}, session: { id: 'session-1' }, delegation: null,
          boundaryVerified: true, authorizedCapabilities: ['configuration.read'],
        };
      },
    };
    await withServicesServer(authenticator, async (origin) => {
      const response = await fetch(`${origin}/v1/configuration`, {
        headers: { 'x-request-id': 'cfg_traceability' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), 'cfg_traceability');
    });
    assert.equal(observedRequestId, 'cfg_traceability');
  });
});

test('AppPort Services returns 401 when no AuthBoundry session exists', async () => {
  const unauthenticated: Authenticator = {
    async authenticate() {
      throw new AuthBoundryAuthenticationError();
    },
  };
  await withServicesServer(unauthenticated, async (origin) => {
    const response = await fetch(`${origin}/v1/configuration`);
    assert.equal(response.status, 401);
    const body = await response.json() as { code: string; message: string; requestId: string };
    assert.equal(body.code, 'APPPORT_AUTHENTICATION_REQUIRED');
    assert.match(body.message, /AuthBoundry authentication is required/);
    assert.match(body.requestId, /^cfg_/);
  });
});

test('service unavailability returns a sanitized failure without a local fallback', async () => {
  const workingDirectory = await createTempWorkspace('factory-services-unavailable');
  const services = createServices({ mode: 'local', namespace: 'unavailable', path: workingDirectory });
  services.configuration.list = async () => { throw new Error(`backend unavailable: ${secret}`); };
  await withServicesServer(authorized([]), async (origin) => {
    const response = await fetch(`${origin}/v1/configuration`);
    assert.equal(response.status, 500);
    const body = await response.json() as { code: string; message: string; error: { message: string } };
    assert.equal(body.code, 'APPPORT_SERVICES_FAILURE');
    assert.match(body.message, /could not complete/);
    assert.match(body.error.message, /Request ID: cfg_/);
    assert.doesNotMatch(JSON.stringify(body), /backend unavailable|secret-value/);
  }, services);
});
