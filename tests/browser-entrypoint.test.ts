import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHttpServer } from '../src/server.js';
import { createTempWorkspace } from './helpers.js';
import type { Authenticator } from '../src/auth.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const context = {
  principal: 'operator-1', tenant: 'tenant-a', claims: {}, session: { id: 'session-1' }, delegation: null,
  boundaryVerified: true, authorizedCapabilities: ['factory.ui.read', 'configuration.read'],
};

test('public root enters AuthBoundry without weakening protected routes or return safety', async () => {
  const authenticator: Authenticator = {
    async session() { throw new Error('missing session'); },
    async authenticate() { throw new Error('missing session'); },
  };
  const workingDirectory = await createTempWorkspace('factory-browser-entry');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`, authenticator,
  });
  const origin = await listen(server);
  try {
    for (const path of ['/', '/?return=https://attacker.example', '/?return_to=//attacker.example', '/?state=fabricated']) {
      const response = await fetch(`${origin}${path}`, {
        redirect: 'manual', headers: { authorization: 'Bearer fabricated' },
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/auth/login?return_to=%2F');
    }
    const head = await fetch(`${origin}/`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get('location'), '/auth/login?return_to=%2F');
    assert.equal((await fetch(`${origin}/v1/ui`)).status, 401);
    assert.equal((await fetch(`${origin}/configuration`)).status, 401);
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
  } finally {
    await close(server);
  }
});

test('authenticated root redirects to the existing AppPort Services entry surface', async () => {
  const authenticator: Authenticator = {
    async session() { return context; },
    async authenticate() { return context; },
  };
  const workingDirectory = await createTempWorkspace('factory-browser-authenticated');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`, authenticator,
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/configuration');
    assert.equal((await fetch(`${origin}/configuration`)).status, 200);
  } finally {
    await close(server);
  }
});

test('Factory relays only the canonical AuthBoundry browser surface on its own origin', async () => {
  const authority = createServer((request, response) => {
    if (request.url?.startsWith('/auth/login')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Sign in · AuthBoundry</title>');
      return;
    }
    if (request.url === '/auth/sign-in' && request.method === 'POST') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'authboundry_session=opaque-issued-handle; Path=/; HttpOnly; Secure; SameSite=Lax',
      });
      response.end(JSON.stringify({ authenticated: true }));
      return;
    }
    if (request.url?.startsWith('/_authboundry/callback/')) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid state' }));
      return;
    }
    response.writeHead(404).end();
  });
  const authorityOrigin = await listen(authority);
  const authenticator: Authenticator = {
    async session() { throw new Error('missing session'); },
    async authenticate() { throw new Error('missing session'); },
  };
  const workingDirectory = await createTempWorkspace('factory-browser-proxy');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`, authenticator,
    authBoundryUrl: authorityOrigin,
  });
  const origin = await listen(server);
  try {
    const login = await fetch(`${origin}/auth/login?return_to=%2F`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Sign in · AuthBoundry/);

    const signIn = await fetch(`${origin}/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(signIn.status, 200);
    assert.match(signIn.headers.get('set-cookie') ?? '', /^authboundry_session=opaque-issued-handle/);

    assert.equal((await fetch(`${origin}/_authboundry/callback/github?state=fabricated`)).status, 400);
    assert.equal((await fetch(`${origin}/auth/agents`)).status, 404);
    assert.equal((await fetch(`${origin}/_authboundry/authority-state`)).status, 404);
  } finally {
    await close(server);
    await close(authority);
  }
});
