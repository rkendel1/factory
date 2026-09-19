import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production deployment uses remote authority boundaries', async () => {
  const fly = await readFile(new URL('../fly.toml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

  assert.match(fly, /app = "factory-runner"/);
  assert.match(fly, /path = "\/health"/);
  assert.match(fly, /force_https = true/);
  assert.match(fly, /FACTORY_FELTDB_MODE = "remote"/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /pax --version/);
  assert.match(dockerfile, /USER node/);
});
