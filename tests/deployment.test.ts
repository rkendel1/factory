import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

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
