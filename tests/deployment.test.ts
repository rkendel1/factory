import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createHttpServer } from '../src/server.js';
import {
  formatDeploymentConfigDiagnostics,
  resolveRemoteAuthorityBootstrap,
  validateDeploymentConfig,
} from '../src/bootstrap.js';

test('production deployment uses remote authority boundaries', async () => {
  const fly = await readFile(path.join(process.cwd(), 'fly.toml'), 'utf8');
  const dockerfile = await readFile(path.join(process.cwd(), 'Dockerfile'), 'utf8');
  const workflow = await readFile(path.join(process.cwd(), '.github/workflows/factory-runner.yml'), 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    overrides: Record<string, string>;
  };

  assert.match(fly, /app = 'factory-idvhpa'/);
  assert.match(fly, /internal_port = 3000/);
  assert.match(fly, /FACTORY_PORT = '3000'/);
  assert.match(fly, /path = '\/health'/);
  assert.match(fly, /force_https = true/);
  assert.match(fly, /FACTORY_FELTDB_MODE = 'remote'/);
  assert.match(fly, /AUTHBOUNDRY_URL = 'https:\/\/authboundry-api\.fly\.dev'/);
  assert.match(fly, /FELTDB_URL = 'http:\/\/feltdb\.internal:7700'/);
  assert.match(fly, /FACTORY_HOST = '0\.0\.0\.0'/);
  assert.doesNotMatch(fly, /FELTDB_TOKEN\s*=/);
  assert.equal((fly.match(/^\[http_service\]$/gm) ?? []).length, 1);
  assert.equal((fly.match(/^\[\[services\]\]$/gm) ?? []).length, 0);
  assert.equal((fly.match(/^\s*(?:memory|memory_mb)\s*=/gm) ?? []).length, 1);
  assert.doesNotMatch(fly, /appport.*(?:URL|url)/i);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.equal((dockerfile.match(/COPY vendor \.\/vendor/g) ?? []).length, 2);
  assert.match(dockerfile, /pax --version/);
  assert.match(dockerfile, /USER node/);
  assert.match(workflow, /fly deploy --config fly\.toml --remote-only --strategy rolling/);
  assert.match(workflow, /FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /FELTDB_TOKEN\s*[:=]/);
  assert.equal(packageJson.dependencies['@appport/services'], '^0.4.3');
  assert.equal(packageJson.overrides['@appport/services'], '$@appport/services');
  assert.equal(packageJson.dependencies['@authboundry/core'], '^1.15.2');
  assert.equal(packageJson.overrides['@authboundry/core'], '$@authboundry/core');
});

test('remote bootstrap accepts topology and infrastructure credentials only', () => {
  const bootstrap = resolveRemoteAuthorityBootstrap({
    mode: 'remote',
    serverUrl: 'https://feltdb.example',
    serverToken: 'infrastructure-token',
    authBoundryUrl: 'https://auth.example',
    authBoundryBrowserCookieSecret: 'deployment-cookie-secret-at-least-32-bytes',
  });

  assert.deepEqual(bootstrap, {
    authBoundryUrl: 'https://auth.example',
    authBoundryBrowserCookieSecret: 'deployment-cookie-secret-at-least-32-bytes',
    feltDbUrl: 'https://feltdb.example',
    feltDbToken: 'infrastructure-token',
  });
});

test('remote bootstrap fails closed when an authority endpoint is missing', () => {
  assert.throws(
    () => resolveRemoteAuthorityBootstrap({
      mode: 'remote',
      serverUrl: 'https://feltdb.example',
    }),
    /Production startup requires FELTDB_URL, AUTHBOUNDRY_URL, and AUTHBOUNDRY_BROWSER_COOKIE_SECRET/,
  );
});

test('deployment validation rejects a missing FeltDB URL', () => {
  assert.throws(
    () => validateDeploymentConfig({ authBoundryUrl: 'https://auth.example' }),
    /Production startup requires FELTDB_URL, AUTHBOUNDRY_URL, and AUTHBOUNDRY_BROWSER_COOKIE_SECRET/,
  );
});

test('deployment validation rejects a missing AuthBoundry URL', () => {
  assert.throws(
    () => validateDeploymentConfig({ feltDbUrl: 'https://feltdb.example' }),
    /Production startup requires FELTDB_URL, AUTHBOUNDRY_URL, and AUTHBOUNDRY_BROWSER_COOKIE_SECRET/,
  );
});

test('deployment validation trims topology and accepts the optional bootstrap secret', () => {
  const config = validateDeploymentConfig({
    feltDbUrl: ' https://feltdb.example ',
    authBoundryUrl: ' https://auth.example ',
    authBoundryBrowserCookieSecret: ' deployment-cookie-secret-at-least-32-bytes ',
    feltDbToken: ' infrastructure-token ',
  });

  assert.deepEqual(config, {
    feltDbUrl: 'https://feltdb.example',
    authBoundryUrl: 'https://auth.example',
    authBoundryBrowserCookieSecret: 'deployment-cookie-secret-at-least-32-bytes',
    feltDbToken: 'infrastructure-token',
  });
});

test('startup diagnostics expose presence without secret values', () => {
  const diagnostics = formatDeploymentConfigDiagnostics({
    feltDbUrl: 'https://feltdb.example',
    authBoundryUrl: 'https://auth.example',
    authBoundryBrowserCookieSecret: 'deployment-cookie-secret-at-least-32-bytes',
    feltDbToken: 'super-secret-token',
  });

  assert.match(diagnostics, /FELTDB_URL configured: true/);
  assert.match(diagnostics, /AUTHBOUNDRY_URL configured: true/);
  assert.match(diagnostics, /AUTHBOUNDRY_BROWSER_COOKIE_SECRET configured: true/);
  assert.match(diagnostics, /FELTDB_TOKEN configured: true/);
  assert.doesNotMatch(diagnostics, /super-secret-token|feltdb\.example|auth\.example/);
});

test('local runtime health exposes AppPort initialization and shutdown rejects admission', async () => {
  const { service, server } = await createHttpServer({ mode: 'local' });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const health = await response.json() as { appport?: { applicationFingerprint?: string } };
  assert.ok(health.appport?.applicationFingerprint);
  await service.shutdown();
  await assert.rejects(
    service.startRun({ workId: 'work', operation: 'run', repository: { provider: 'local', owner: 'owner', name: 'repo', ref: 'main' } }, 'principal'),
    /shutting down/,
  );
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
