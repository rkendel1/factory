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

  assert.match(fly, /app = 'factory-idvhpa'/);
  assert.match(fly, /internal_port = 3000/);
  assert.match(fly, /FACTORY_PORT = '3000'/);
  assert.match(fly, /path = '\/health'/);
  assert.match(fly, /force_https = true/);
  assert.match(fly, /FACTORY_FELTDB_MODE = 'remote'/);
  assert.match(fly, /AUTHBOUNDRY_URL = 'https:\/\/authboundry\.fly\.dev'/);
  assert.match(fly, /FELTDB_URL = 'https:\/\/feltdb\.fly\.dev'/);
  assert.doesNotMatch(fly, /FELTDB_TOKEN\s*=/);
  assert.doesNotMatch(fly, /appport.*(?:URL|url)/i);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /pax --version/);
  assert.match(dockerfile, /USER node/);
  assert.match(workflow, /fly deploy --config fly\.toml --remote-only --strategy rolling/);
  assert.match(workflow, /FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /FELTDB_TOKEN\s*[:=]/);
});

test('remote bootstrap accepts topology and infrastructure credentials only', () => {
  const bootstrap = resolveRemoteAuthorityBootstrap({
    mode: 'remote',
    serverUrl: 'https://feltdb.example',
    serverToken: 'infrastructure-token',
    authBoundryUrl: 'https://auth.example',
  });

  assert.deepEqual(bootstrap, {
    authBoundryUrl: 'https://auth.example',
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
    /Production startup requires FELTDB_URL and AUTHBOUNDRY_URL/,
  );
});

test('deployment validation rejects a missing FeltDB URL', () => {
  assert.throws(
    () => validateDeploymentConfig({ authBoundryUrl: 'https://auth.example' }),
    /Production startup requires FELTDB_URL and AUTHBOUNDRY_URL/,
  );
});

test('deployment validation rejects a missing AuthBoundry URL', () => {
  assert.throws(
    () => validateDeploymentConfig({ feltDbUrl: 'https://feltdb.example' }),
    /Production startup requires FELTDB_URL and AUTHBOUNDRY_URL/,
  );
});

test('deployment validation trims topology and accepts the optional bootstrap secret', () => {
  const config = validateDeploymentConfig({
    feltDbUrl: ' https://feltdb.example ',
    authBoundryUrl: ' https://auth.example ',
    feltDbToken: ' infrastructure-token ',
  });

  assert.deepEqual(config, {
    feltDbUrl: 'https://feltdb.example',
    authBoundryUrl: 'https://auth.example',
    feltDbToken: 'infrastructure-token',
  });
});

test('startup diagnostics expose presence without secret values', () => {
  const diagnostics = formatDeploymentConfigDiagnostics({
    feltDbUrl: 'https://feltdb.example',
    authBoundryUrl: 'https://auth.example',
    feltDbToken: 'super-secret-token',
  });

  assert.match(diagnostics, /FELTDB_URL configured: true/);
  assert.match(diagnostics, /AUTHBOUNDRY_URL configured: true/);
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
