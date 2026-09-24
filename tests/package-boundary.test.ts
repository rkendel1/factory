import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);

test('published @feltdb/core can be consumed from an isolated project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-package-boundary-'));

  try {
    const factoryPackage = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: { '@feltdb/core': string };
    };
    const feltDbVersion = factoryPackage.dependencies['@feltdb/core'];
    const { stdout: packOutput } = await execFileAsync(
      'npm',
      ['pack', `@feltdb/core@${feltDbVersion}`, '--json', '--pack-destination', root],
      { cwd: root },
    );
    const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
    const archive = path.join(root, filename);
    const consumer = path.join(root, 'consumer');

    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), '{"type":"module"}\n', 'utf8');
    await execFileAsync('npm', [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      archive,
      'typescript',
      '@types/node',
    ], { cwd: consumer });

    const source = `
      import { createFeltDB } from '@feltdb/core';
      const db = createFeltDB({ memory: true });
      await db.collection<{ value: string }>('records').put({ value: 'ok' }, 'record');
      const record = await db.collection<{ value: string }>('records').get('record');
      if (record?.value !== 'ok') throw new Error('durable state operation failed');
    `;
    const sourcePath = path.join(consumer, 'index.ts');
    await writeFile(sourcePath, source, 'utf8');
    try {
      await execFileAsync(path.join(consumer, 'node_modules', '.bin', 'tsc'), [
        '--ignoreConfig',
        '--strict',
        '--target', 'ES2022',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--types', 'node',
        '--noEmit',
        sourcePath,
      ], { cwd: consumer });
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`Isolated TypeScript consumer failed:\n${output.stdout ?? ''}${output.stderr ?? ''}`);
    }

    const packageJson = JSON.parse(await readFile(path.join(consumer, 'node_modules', '@feltdb', 'core', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      exports?: Record<string, unknown>;
    };
    assert.equal(packageJson.name, '@feltdb/core');
    assert.ok(packageJson.version);
    assert.ok(packageJson.exports?.['.']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
