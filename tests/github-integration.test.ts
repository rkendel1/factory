import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createGitHubIntegration,
  type GitHubCapabilityName,
  type GitHubConnection,
} from '@rkendel1/github-integration';
import type { Authenticator } from '../src/auth.js';
import { assertContractIntegrity } from '../src/contract.js';
import { COLLECTIONS } from '../src/felt.js';
import { createHttpServer } from '../src/server.js';
import type { ExecutionContractRecord, RunRequest } from '../src/types.js';
import { createService, createTempWorkspace, seedWork } from './helpers.js';

const capabilities: GitHubCapabilityName[] = [
  'github.repository.read',
  'github.pull_request.merge',
];

const testNamespace = (name: string) => `${name}-${Date.now()}-${Math.random()}`;

async function createIntegration() {
  const integration = createGitHubIntegration({
    authority: {
      async session() {
        return {
          authenticated: true,
          principal: { id: 'factory-service', kind: 'service' },
          tenant: { id: 'tenant-a' },
          claims: {},
          capabilities,
          session: null,
          delegation: null,
        };
      },
      async authorize(capability) {
        return capabilities.includes(capability as GitHubCapabilityName);
      },
    },
    felt: { memory: true, namespace: `factory-github-test-${Date.now()}-${Math.random()}` },
    configuration: { resolveGitHubToken: async () => 'test-token' },
  });
  const timestamp = new Date().toISOString();
  const connection: GitHubConnection = {
    id: 'github-connection-1',
    tenantId: 'tenant-a',
    applicationId: 'software_factory',
    environment: 'test',
    provider: 'github',
    credentialReference: { secretId: 'github-secret', tenantId: 'tenant-a' },
    authMechanism: 'github_app',
    status: 'configured',
    capabilities,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await integration.upsertConnection(connection);
  return integration;
}

function request(operation: string, github?: RunRequest['github']): RunRequest {
  return {
    workId: 'work_123',
    repository: { provider: 'github', owner: 'acme', name: 'factory', ref: 'main' },
    operation,
    ...(github ? { github } : {}),
  };
}

async function withGitHubFetch<T>(callback: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/orgs/acme/repos')) {
      return new Response(JSON.stringify([{
        id: 42,
        node_id: 'R_42',
        owner: { login: 'acme' },
        name: 'factory',
        full_name: 'acme/factory',
        private: true,
        archived: false,
        default_branch: 'main',
        html_url: 'https://github.test/acme/factory',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/repos/acme/factory/pulls/7/merge') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ merged: true, sha: 'abc123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: `Unexpected request: ${url}` }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test('repositories.list runs through the standalone integration and durable Factory evidence', async () => {
  await withGitHubFetch(async () => {
    const integration = await createIntegration();
    const service = await createService({ githubIntegration: integration, namespace: testNamespace('github-read') });
    await seedWork(service, {
      operation: 'repositories.list',
      repositoryProvider: 'github',
      repositoryOwner: 'acme',
      githubConnectionId: 'github-connection-1',
    });

    const run = await service.startRun(request('repositories.list'), 'factory-service');
    const evidence = await service.getEvidence(run.id);
    const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
    const record = await db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).get(run.id);

    assert.equal(run.status, 'completed');
    assert.equal(record?.contract.github?.operation, 'repositories.list');
    assert.equal(record?.contract.github?.connectionId, 'github-connection-1');
    assert.equal(record?.contract.github?.capability, 'github.repository.read');
    assert.equal(record?.contract.fingerprint, record?.fingerprint);
    assert.ok(record?.contract);
    const tampered = structuredClone(record.contract);
    tampered.github!.connectionId = 'attacker-connection';
    assert.throws(() => assertContractIntegrity(tampered), /fingerprint validation failed/i);
    assert.equal(evidence?.github?.package, '@rkendel1/github-integration');
    assert.equal(evidence?.github?.packageVersion, '1.0.1');
    assert.deepEqual(evidence?.github?.result, [{
      id: 42,
      nodeId: 'R_42',
      owner: 'acme',
      name: 'factory',
      fullName: 'acme/factory',
      private: true,
      archived: false,
      defaultBranch: 'main',
      url: 'https://github.test/acme/factory',
    }]);
    assert.doesNotMatch(JSON.stringify(evidence), /test-token|github-secret|accessToken|privateKey/i);
  });
});

test('pull_request.merge uses its mutation capability and preserves normalized result', async () => {
  await withGitHubFetch(async () => {
    const integration = await createIntegration();
    const service = await createService({ githubIntegration: integration, namespace: testNamespace('github-merge') });
    await seedWork(service, {
      operation: 'pull_request.merge',
      repositoryProvider: 'github',
      repositoryOwner: 'acme',
      githubConnectionId: 'github-connection-1',
    });

    const run = await service.startRun(
      request('pull_request.merge', { pullNumber: 7, mergeMethod: 'squash' }),
      'factory-service',
    );
    const evidence = await service.getEvidence(run.id);

    assert.equal(run.status, 'completed');
    assert.equal(evidence?.github?.capability, 'github.pull_request.merge');
    assert.equal(evidence?.github?.resource.pullNumber, 7);
    assert.deepEqual(evidence?.github?.result, { merged: true, sha: 'abc123' });
  });
});

test('GitHub provider failures use the normal failed run and evidence path', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'provider unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const integration = await createIntegration();
    const service = await createService({ githubIntegration: integration, namespace: testNamespace('github-failure') });
    await seedWork(service, {
      operation: 'repositories.list',
      repositoryProvider: 'github',
      repositoryOwner: 'acme',
      githubConnectionId: 'github-connection-1',
    });

    const run = await service.startRun(request('repositories.list'), 'factory-service');
    const evidence = await service.getEvidence(run.id);

    assert.equal(run.status, 'failed');
    assert.equal(evidence?.status, 'failed');
    assert.equal(evidence?.github?.connectionId, 'github-connection-1');
    assert.equal(evidence?.github?.operation, 'repositories.list');
    assert.match(evidence?.stderr ?? '', /provider unavailable|503/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('AuthBoundry denial prevents a GitHub mutation before execution', async () => {
  const integration = await createIntegration();
  const authenticator: Authenticator = {
    async authenticate(_request, operation) {
      if (operation === 'github.pull_request.merge') throw new Error('denied');
      return {
        principal: 'factory-service',
        tenant: 'tenant-a',
        claims: {},
        session: null,
        delegation: null,
        boundaryVerified: true,
      };
    },
  };
  const { service, server } = await createHttpServer({
    mode: 'local',
    authenticator,
    githubIntegration: integration,
  });
  await seedWork(service, {
    tenantId: 'tenant-a',
    operation: 'pull_request.merge',
    repositoryProvider: 'github',
    repositoryOwner: 'acme',
    githubConnectionId: 'github-connection-1',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request('pull_request.merge', { pullNumber: 7 })),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('caller identity, tenant, capabilities, and connection identity are rejected', async () => {
  const service = await createService({ githubIntegration: await createIntegration() });
  await seedWork(service, {
    operation: 'repositories.list',
    repositoryProvider: 'github',
    repositoryOwner: 'acme',
    githubConnectionId: 'github-connection-1',
  });
  await assert.rejects(service.startRun({
    ...request('repositories.list'),
    principal: 'attacker',
    tenant: 'other',
    capabilities: ['github.pull_request.merge'],
    connectionId: 'attacker-connection',
  } as RunRequest, 'factory-service'), /not accepted/i);
});

test('Factory keeps GitHub behind the packaged integration root and owns no GitHub webhook endpoint', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    packageJson.dependencies['@rkendel1/github-integration'],
    'file:vendor/rkendel1-github-integration-1.0.1.tgz',
  );
  assert.equal(packageJson.dependencies['@appport/services'], '^0.4.3');
  assert.match(packageJson.dependencies.express, /^\^4\./);
  assert.equal(packageJson.dependencies['@octokit/rest'], undefined);
  const sourceFiles = ['server.ts', 'types.ts', 'integrations/github.ts'];
  const source = (await Promise.all(sourceFiles.map((file) => readFile(path.resolve('src', file), 'utf8')))).join('\n');
  assert.match(source, /from '@rkendel1\/github-integration'/);
  assert.doesNotMatch(source, /@octokit|@rkendel1\/github-integration\//);
  assert.doesNotMatch(source, /accessToken|refreshToken|privateKey|clientSecret|x-hub-signature/i);
  const githubAdapter = await readFile(path.resolve('src/integrations/github.ts'), 'utf8');
  assert.doesNotMatch(githubAdapter, /\/webhooks?\b/i);
  const flow = await readFile(path.resolve('.flow'), 'utf8');
  assert.match(flow, /operation repositories\.list[\s\S]*grant github\.repository\.read/);
  assert.match(flow, /operation pull_request\.merge[\s\S]*grant github\.pull_request\.merge/);
});
