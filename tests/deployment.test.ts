import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createHttpServer } from '../src/server.js';

test('production deployment uses remote authority boundaries', async () => {
  const fly = await readFile(path.join(process.cwd(), 'fly.toml'), 'utf8');
  const dockerfile = await readFile(path.join(process.cwd(), 'Dockerfile'), 'utf8');

  assert.match(fly, /app = "factory-runner"/);
  assert.match(fly, /path = "\/health"/);
  assert.match(fly, /force_https = true/);
  assert.match(fly, /FACTORY_FELTDB_MODE = "remote"/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /pax --version/);
  assert.match(dockerfile, /USER node/);
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
