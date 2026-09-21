import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.js';
import { createService, seedWork } from './helpers.js';
import {
  AuthBoundryAuthenticationError,
  AuthBoundryAuthorizationError,
  type Authenticator,
} from '../src/auth.js';

function authenticator(principal: string, tenant: string, allowed = true): Authenticator {
  return {
    async authenticate() {
      if (!allowed) {
        throw new AuthBoundryAuthorizationError('factory.run');
      }
      return {
        principal,
        tenant,
        claims: {},
        session: { id: 'session-1' },
        delegation: null,
        boundaryVerified: true,
      };
    },
  };
}

async function withServer(auth: Authenticator, callback: (url: string) => Promise<void>): Promise<void> {
  const { server, service } = await createHttpServer({ mode: 'local', authenticator: auth });
  await seedWork(service, { tenantId: 'tenant-a' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const payload = {
  workId: 'work_123',
  repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
  operation: 'repo-echo',
};

test('HTTP execution uses AuthBoundry identity and ignores caller identity fields', async () => {
  await withServer(authenticator('factory-service', 'tenant-a'), async (url) => {
    const response = await fetch(`${url}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 201);
    const run = await response.json() as { principal: string; tenantId: string };
    assert.equal(run.principal, 'factory-service');
    assert.equal(run.tenantId, 'tenant-a');
  });
});

test('HTTP execution fails closed when AuthBoundry denies authorization', async () => {
  await withServer(authenticator('factory-service', 'tenant-a', false), async (url) => {
    const response = await fetch(`${url}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code: string }).code, 'FORBIDDEN');
  });
});

test('HTTP execution returns 401 when no AuthBoundry session exists', async () => {
  const auth: Authenticator = {
    async authenticate() {
      throw new AuthBoundryAuthenticationError();
    },
  };
  await withServer(auth, async (url) => {
    const response = await fetch(`${url}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'UNAUTHENTICATED');
  });
});

test('cross-tenant reads are denied even with a known run id', async () => {
  let tenant = 'tenant-a';
  const auth: Authenticator = {
    async authenticate() {
      return {
        principal: 'factory-service',
        tenant,
        claims: {},
        session: { id: 'session-1' },
        delegation: null,
        boundaryVerified: true,
      };
    },
  };
  await withServer(auth, async (url) => {
    const created = await fetch(`${url}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const run = await created.json() as { id: string };
    tenant = 'tenant-b';
    const response = await fetch(`${url}/v1/runs/${run.id}`);
    assert.equal(response.status, 404);
  });
});
