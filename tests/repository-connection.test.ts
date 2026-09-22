import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHttpServer, FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { gitCredentialEnvironment, redact, repositoryRemoteUrl, verifyRepositoryConnection } from '../src/repository-connection.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import type { ActionRecord, RepositoryRecord, StructuredEvidence } from '../src/types.js';

/*
 * A repository is connected when Factory can actually reach it. These tests
 * use a real remote — a git repository reached over a file:// URL — so that
 * "connected" means git answered, and execution clones from that remote when
 * no local mirror is configured, exactly as a deployed Factory does.
 */

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';
const TOKEN = 'ghp_secret_token_value_0123456789';
const declared = () => factoryAssociation(loadFactoryFlow());

function controlPlane(): AuthBoundryControlPlane {
  const association = declared();
  return {
    async listAgents(tenant) { return [{ id: PRINCIPAL, kind: 'agent', name: 'factory-service', tenant, status: 'active' }]; },
    async createAgent() { throw new Error('unexpected agent creation'); },
    async listDelegations(tenant, delegate) {
      return [{ id: associationDelegationId(tenant), delegator: 'system', delegate, application: association.applicationId, tenant, capabilities: [...association.capabilities] }];
    },
  };
}

function authenticator(): Authenticator {
  return {
    async authenticate() {
      return {
        principal: PRINCIPAL, tenant: TENANT, claims: {}, session: { id: 'session-1' }, delegation: null,
        boundaryVerified: true, authorizedCapabilities: [...declared().capabilities, 'factory.run'],
        authority: 'delegated', delegationId: associationDelegationId(TENANT),
      };
    },
  };
}

const grants: CapabilityProbe = async (capability) => ({
  allowed: capability === AUTONOMOUS_EXECUTION_CAPABILITY, reason: `AuthBoundry authorized ${capability}`,
});

async function remoteRepository(root: string): Promise<{ url: string; head: string; earlier: string }> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e 0', test: 'node -e 0' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
  });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repositoryPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'first');
  const earlier = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repositoryPath, 'README.md'), 'second\n');
  git('add', '-A');
  git('commit', '-qm', 'second');
  return { url: `file://${repositoryPath}`, head: git('rev-parse', 'HEAD'), earlier };
}

/** A Factory with no local mirror: every repository must be reached over its remote. */
async function factory(workingDirectory?: string) {
  const dir = workingDirectory ?? await createTempWorkspace('factory-connection');
  const service = await FactoryService.create({
    mode: 'local', namespace: path.basename(dir), workingDirectory: dir,
    flowPath: path.resolve(process.cwd(), '.flow'),
    workspaceRoot: path.join(dir, 'workspaces'), environmentId: 'test',
    appportPath: path.join(dir, 'appport-services'), authenticator: authenticator(),
    authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
    credentialResolver: (name) => name === 'GITHUB_TOKEN' ? TOKEN : undefined,
  });
  await service.refreshConnection();
  return { service, workingDirectory: dir };
}

test('the remote and its credential are derived from the record, and secrets are redacted from git output', () => {
  assert.equal(repositoryRemoteUrl({ provider: 'github', owner: 'rkendel1', name: 'factory' }), 'https://github.com/rkendel1/factory.git');
  assert.equal(repositoryRemoteUrl({ provider: 'github', owner: 'o', name: 'n', repositoryUrl: 'https://example.com/o/n.git' }), 'https://example.com/o/n.git');
  assert.equal(repositoryRemoteUrl({ provider: 'local', owner: 'o', name: 'n' }), null);

  const credential = gitCredentialEnvironment('github', (name) => name === 'GITHUB_TOKEN' ? TOKEN : undefined);
  assert.equal(credential.credential, 'GITHUB_TOKEN');
  assert.equal(credential.env.GIT_CONFIG_KEY_0, 'http.extraheader', 'the credential travels in git configuration through the environment, never on the command line');
  assert.doesNotMatch(credential.env.GIT_CONFIG_VALUE_0!, new RegExp(TOKEN), 'the header carries the token encoded, and is itself a secret');
  assert.deepEqual(gitCredentialEnvironment('github', () => undefined), { env: {}, secrets: {} });
  assert.equal(redact(`fatal: could not read from https://user:${TOKEN}@github.com/x`, credential.secrets), 'fatal: could not read from https://[redacted]@github.com/x');
  assert.equal(redact(`header ${credential.env.GIT_CONFIG_VALUE_0}`, credential.secrets), 'header [redacted:GITHUB_TOKEN_HEADER]');
});

test('a repository is connected only when the remote answers; unreachable and unconfigured are recorded truthfully', async () => {
  const root = await createTempWorkspace('connection');
  const remote = await remoteRepository(root);
  const record = (overrides: Partial<RepositoryRecord>): RepositoryRecord => ({
    id: 'repo_1', projectId: 'prj', tenantId: TENANT, provider: 'github', owner: 'rkendel1', name: 'checkout', defaultBranch: 'main', createdAt: '', ...overrides,
  });
  const connected = await verifyRepositoryConnection(record({ repositoryUrl: remote.url }), () => undefined);
  assert.equal(connected.status, 'connected', connected.detail);
  assert.equal(connected.branchCommit, remote.head, 'the tip of the configured branch, as the remote reports it');
  assert.equal(connected.headCommit, remote.head);
  assert.equal(connected.defaultBranch, 'main');
  assert.equal(connected.credential, null);

  const wrongBranch = await verifyRepositoryConnection(record({ repositoryUrl: remote.url, defaultBranch: 'release' }), () => undefined);
  assert.equal(wrongBranch.status, 'unreachable');
  assert.match(wrongBranch.detail, /branch release does not exist on the remote \(its default branch is main\)/);

  const missing = await verifyRepositoryConnection(record({ repositoryUrl: `file://${root}/does-not-exist` }), () => undefined);
  assert.equal(missing.status, 'unreachable');
  assert.match(missing.detail, /does-not-exist|not found|does not appear/i);

  const unconfigured = await verifyRepositoryConnection(record({ provider: 'local' }), () => undefined);
  assert.equal(unconfigured.status, 'unconfigured');

  // A token is used by name, never recorded, and never printed by a failure.
  const withToken = await verifyRepositoryConnection(record({ repositoryUrl: `file://${root}/does-not-exist` }), (name) => name === 'GITHUB_TOKEN' ? TOKEN : undefined);
  assert.equal(withToken.credential, 'GITHUB_TOKEN');
  assert.doesNotMatch(JSON.stringify(withToken), new RegExp(TOKEN));
});

test('with no local mirror, an Action clones the connected remote for real and drift compares against the remote tip', async () => {
  const root = await createTempWorkspace('connection-execute');
  const remote = await remoteRepository(root);
  const { service, workingDirectory } = await factory();
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
  const added = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout', repositoryUrl: remote.url });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly' });
  await domain.putDesiredState(TENANT, project.id, { sourceRepositoryId: added.id, sourceBranch: 'main', deploymentEnabled: false });

  // Not verified yet: no discovery, no desired commit.
  assert.equal((await service.observeReality(context, project.id))[0]!.fields.find((field) => field.field === 'sourceCommit')?.desired, null);
  const connected = (await service.connectRepository(context, project.id, added.id))!;
  assert.equal(connected.connection?.status, 'connected', connected.connection?.detail ?? 'no connection');
  assert.equal((await service.observeReality(context, project.id))[0]!.fields.find((field) => field.field === 'sourceCommit')?.desired, remote.head.slice(0, 12), 'desired commit is the remote tip');

  // Inspect: the workspace is a real clone of the remote.
  const inspect = await service.createAction(context, project.id, { capability: 'repository.inspect', environmentId: environment.id }, grants);
  const inspected = await service.runAction(context, inspect.id, { probe: grants, autonomous: true });
  assert.equal(inspected.status, 'succeeded', JSON.stringify(inspected.failure));
  assert.equal(inspected.execution?.observedRevision, remote.head);
  const inspectedRunId = inspected.runId!;
  const evidence = await (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(inspectedRunId);
  assert.deepEqual(evidence?.execution?.credentialsResolved, ['GITHUB_TOKEN'], 'the repository credential was resolved by name at the boundary');
  assert.doesNotMatch(JSON.stringify([evidence, inspected, await domain.getRun(TENANT, inspected.runId!)]), new RegExp(TOKEN));

  // Checkout of an earlier revision over the remote, verified against HEAD.
  const checkout = await service.createAction(context, project.id, { capability: 'repository.checkout', parameters: { revision: remote.earlier } }, grants);
  const checkedOut = await service.runAction(context, checkout.id, { probe: grants, autonomous: true });
  assert.equal(checkedOut.status, 'succeeded', JSON.stringify(checkedOut.failure));
  assert.equal(checkedOut.execution?.observedRevision, remote.earlier);

  // A repository that cannot be reached is an execution failure that says so, with nothing invented.
  const broken = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'gone', repositoryUrl: `file://${root}/gone` });
  await domain.putDesiredState(TENANT, project.id, { sourceRepositoryId: broken.id });
  const unreachable = (await service.connectRepository(context, project.id, broken.id))!;
  assert.equal(unreachable.connection?.status, 'unreachable');
  const failing = await service.createAction(context, project.id, { capability: 'repository.inspect', repositoryId: broken.id }, grants);
  const failed = await service.runAction(context, failing.id, { probe: grants, autonomous: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.outcome, 'execution-failed');
  assert.match(failed.failure?.reason ?? '', /gone|not found|does not appear/i);

  // Connection state survives a restart.
  await service.shutdown();
  const restarted = await factory(workingDirectory);
  const stored = (await restarted.service.projects().listRepositories(TENANT, project.id)).find((repository) => repository.id === added.id)!;
  assert.equal(stored.connection?.status, 'connected');
  assert.equal(stored.connection?.branchCommit, remote.head);
  await restarted.service.shutdown();
});

test('the product API verifies a repository when it is added and on demand, and the page shows the connection', async () => {
  const root = await createTempWorkspace('connection-http');
  const remote = await remoteRepository(root);
  const workingDirectory = await createTempWorkspace('connection-http-factory');
  const { server, service } = await createHttpServer({
    mode: 'local', namespace: path.basename(workingDirectory), workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'), environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    workspaceRoot: path.join(workingDirectory, 'workspaces'), authenticator: authenticator(),
    authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
    credentialResolver: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body?: unknown) => fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const project = await (await post('/v1/projects', { name: 'Checkout' })).json() as { id: string };
    const added = await (await post(`/v1/projects/${project.id}/repositories`, { owner: 'rkendel1', name: 'checkout', repositoryUrl: remote.url })).json() as RepositoryRecord;
    assert.equal(added.connection?.status, 'connected', 'adding a repository verifies it');
    assert.equal(added.connection?.branchCommit, remote.head);
    const verified = await (await post(`/v1/projects/${project.id}/repositories/${added.id}/verify`)).json() as RepositoryRecord;
    assert.equal(verified.connection?.status, 'connected');
    const listed = await (await fetch(`${origin}/v1/projects/${project.id}/repositories`)).json() as { repositories: RepositoryRecord[] };
    assert.equal(listed.repositories[0]!.connection?.status, 'connected');
    const page = await fetch(`${origin}/factory/projects/${project.id}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Add and verify repository'));

    // And the Action created from the page's form executes against the remote.
    const environment = await (await post(`/v1/projects/${project.id}/environments`, { name: 'production', provider: 'fly' })).json() as { id: string };
    const action = await (await post(`/v1/projects/${project.id}/actions`, { capability: 'repository.inspect', environmentId: environment.id })).json() as ActionRecord;
    const ran = await (await post(`/v1/actions/${action.id}/run`)).json() as ActionRecord;
    assert.equal(ran.status, 'succeeded', JSON.stringify(ran.failure));
    assert.equal(ran.execution?.observedRevision, remote.head);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdown();
  }
});
