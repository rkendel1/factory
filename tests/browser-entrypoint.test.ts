import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createBrowserRelyingApplicationAdapter } from '@authboundry/core/server';
import { createHttpServer } from '../src/server.js';
import { createTempWorkspace } from './helpers.js';
import { AuthBoundryAuthenticationError, type Authenticator } from '../src/auth.js';

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
      assert.equal(response.headers.get('location'), '/api/auth/login/github?return_to=%2F');
    }
    const head = await fetch(`${origin}/`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get('location'), '/api/auth/login/github?return_to=%2F');
    assert.equal((await fetch(`${origin}/v1/ui`)).status, 401);
    assert.equal((await fetch(`${origin}/configuration`)).status, 401);
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
  } finally {
    await close(server);
  }
});

test('a product page with no session sends a browser to sign in and back, and JSON callers a 401', async () => {
  const unauthenticated: Authenticator = {
    async authenticate() { throw new AuthBoundryAuthenticationError(); },
  };
  const workingDirectory = await createTempWorkspace('factory-browser-lapsed');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`, authenticator: unauthenticated,
  });
  const origin = await listen(server);
  try {
    // A reloaded detail page returns to its section, since only exact
    // registered paths may be returned to.
    const page = await fetch(`${origin}/factory/projects/prj_123`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/api/auth/login/github?return_to=%2Ffactory%2Fprojects');

    const landing = await fetch(`${origin}/factory`, { redirect: 'manual' });
    assert.equal(landing.headers.get('location'), '/api/auth/login/github?return_to=%2Ffactory');

    // A client that asked for JSON is answered in JSON, not redirected.
    const api = await fetch(`${origin}/factory`, { redirect: 'manual', headers: { accept: 'application/json' } });
    assert.equal(api.status, 401);
    assert.equal((await api.json() as { code: string }).code, 'UNAUTHENTICATED');

    // API routes are unchanged: a machine gets a machine answer.
    assert.equal((await fetch(`${origin}/v1/projects`, { redirect: 'manual' })).status, 401);
  } finally {
    await close(server);
  }
});

test('authenticated root redirects to the Factory product surface', async () => {
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
    // Factory's own product surface is the landing page. AppPort Services is
    // still reachable, but it is no longer where an authenticated user arrives.
    assert.equal(response.headers.get('location'), '/factory');
    assert.equal((await fetch(`${origin}/factory`)).status, 200);
    assert.equal((await fetch(`${origin}/configuration`)).status, 200);
  } finally {
    await close(server);
  }
});

test('Factory uses the AuthBoundry relying-application adapter for login, session, and logout', async () => {
  let nonceHash = '';
  let revoked = false;
  const authority = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://authority.invalid');
    if (url.pathname === '/_authboundry/browser/begin') {
      assert.equal(url.searchParams.get('application'), 'factory');
      assert.equal(url.searchParams.get('provider'), 'github');
      assert.equal(url.searchParams.get('tenant'), 'default');
      assert.equal(url.searchParams.get('return_to'), '/configuration');
      nonceHash = url.searchParams.get('browser_nonce_hash') ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        kind: 'redirect',
        url: 'https://github.com/login/oauth/authorize?state=authority-state',
        state: 'authority-state',
        expires_in: 600,
      }));
      return;
    }
    if (url.pathname === '/_authboundry/browser/complete' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          application: string; handoff: string; browser_nonce: string;
        };
        assert.equal(body.application, 'factory');
        assert.equal(createHash('sha256').update(body.browser_nonce).digest('hex'), nonceHash);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          credential: 'opaque-authority-credential',
          return_to: '/configuration',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }));
      });
      return;
    }
    if (url.pathname === '/auth/session') {
      assert.equal(request.headers.authorization, 'Bearer opaque-authority-credential');
      response.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json' });
      response.end(revoked ? '{}' : JSON.stringify({
        authenticated: true,
        principal: { id: 'operator-1', kind: 'user' },
        tenant: { id: 'tenant-a' },
        claims: {}, capabilities: ['factory.ui.read'],
        session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, delegation: null,
      }));
      return;
    }
    if (url.pathname === '/auth/sign-out' && request.method === 'POST') {
      revoked = true;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(404).end();
  });
  const authorityOrigin = await listen(authority);
  const workingDirectory = await createTempWorkspace('factory-browser-proxy');
  const { server } = await createHttpServer({
    mode: 'local', workingDirectory, appportPath: `${workingDirectory}/services`,
    authBoundryUrl: authorityOrigin,
    authBoundryBrowserCookieSecret: 'test-cookie-secret-that-is-at-least-32-bytes',
  });
  const origin = await listen(server);
  try {
    const login = await fetch(`${origin}/api/auth/login/github?return_to=%2Fconfiguration`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    assert.match(login.headers.get('location') ?? '', /^https:\/\/github\.com\/login\/oauth\/authorize/);
    const transactionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(transactionCookie, /^authboundry_factory_transaction=/);
    assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly.*SameSite=Lax/);

    const callback = await fetch(`${origin}/api/auth/callback?handoff=${'a'.repeat(64)}`, {
      redirect: 'manual', headers: { cookie: transactionCookie },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/configuration');
    const sessionCookie = callback.headers.getSetCookie()
      .find((value) => value.startsWith('authboundry_factory_session='))?.split(';')[0];
    assert.ok(sessionCookie);
    assert.match(callback.headers.getSetCookie().join(' '), /HttpOnly.*SameSite=Lax/);

    const root = await fetch(`${origin}/`, { redirect: 'manual', headers: { cookie: sessionCookie } });
    assert.equal(root.headers.get('location'), '/factory');

    const logout = await fetch(`${origin}/auth/logout`, {
      redirect: 'manual', headers: { cookie: sessionCookie },
    });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/');
    assert.match(logout.headers.getSetCookie().join(' '), /authboundry_factory_session=;.*Max-Age=0/);

    const stale = await fetch(`${origin}/`, { redirect: 'manual', headers: { cookie: sessionCookie } });
    assert.equal(stale.headers.get('location'), '/api/auth/login/github?return_to=%2F');
    assert.equal((await fetch(`${origin}/api/auth/callback?handoff=${'b'.repeat(64)}`)).status, 400);
    assert.equal((await fetch(`${origin}/api/auth/login/github?return_to=https://attacker.example`)).status, 400);
    assert.equal((await fetch(`${origin}/auth/login?return_to=%2F`)).status, 404);
    assert.equal((await fetch(`${origin}/_authboundry/callback/github?state=fabricated`)).status, 404);
  } finally {
    await close(server);
    await close(authority);
  }
});

test('AuthBoundry browser transactions are isolated by relying application', async () => {
  const adapter = createBrowserRelyingApplicationAdapter({
    authorityUrl: 'https://authority.example',
    cookieSecret: 'test-cookie-secret-that-is-at-least-32-bytes',
    applications: [
      { id: 'factory', callbackPath: '/api/auth/callback', allowedReturnPaths: ['/'] },
      { id: 'portal', callbackPath: '/portal/callback', allowedReturnPaths: ['/'] },
    ],
    fetch: async () => new Response(JSON.stringify({
      kind: 'redirect', url: 'https://github.com/login/oauth/authorize', state: 'state', expires_in: 600,
    }), { status: 200 }),
  });
  const begun = await adapter.beginLogin({ application: 'factory', provider: 'github', tenant: 'default', returnTo: '/' });
  const cookieHeader = begun.setCookies[0].split(';')[0];
  await assert.rejects(
    adapter.completeLogin({ application: 'portal', handoff: 'c'.repeat(64), cookieHeader, callbackPath: '/portal/callback' }),
    /no pending login/,
  );
  await assert.rejects(
    adapter.completeLogin({ application: 'factory', handoff: 'c'.repeat(64), cookieHeader, callbackPath: '/portal/callback' }),
    /callback path is not registered/,
  );
});
