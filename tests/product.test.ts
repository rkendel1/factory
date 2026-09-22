import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHttpServer, FactoryService } from '../src/server.js';
import {
  actionPage,
  actionsPage,
  graphPage,
  graphsPage,
  overviewPage,
  projectPage,
  projectsPage,
  providersPage,
  runPage,
  runsPage,
  settingsPage,
  workListPage,
  workPage,
} from '../src/product-ui.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { COLLECTIONS } from '../src/felt.js';
import { factoryAssociation } from '../src/association.js';
import { loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import type { AuthBoundryAgent, AuthBoundryControlPlane, AuthBoundryDelegation } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY } from '../src/association.js';

/** AuthBoundry granting autonomous execution, so planning tests test planning. */
const autonomyGranted: CapabilityProbe = async (capability) => ({
  allowed: capability === AUTONOMOUS_EXECUTION_CAPABILITY,
  reason: `AuthBoundry authorized ${capability}`,
});
import type { ActionRecord, RunRecord, StructuredEvidence } from '../src/types.js';

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';

function declared() {
  return factoryAssociation(loadFactoryFlow());
}

function associatedControlPlane(options: {
  tenant?: string;
  agentStatus?: string;
  withDelegation?: boolean;
} = {}): AuthBoundryControlPlane {
  const tenant = options.tenant ?? TENANT;
  const association = declared();
  const agents: AuthBoundryAgent[] = [{
    id: PRINCIPAL, kind: 'agent', name: 'factory-service', tenant,
    status: options.agentStatus ?? 'active',
  }];
  const delegations: AuthBoundryDelegation[] = options.withDelegation === false ? [] : [{
    id: associationDelegationId(tenant),
    delegator: 'system',
    delegate: PRINCIPAL,
    application: association.applicationId,
    tenant,
    capabilities: [...association.capabilities],
  }];
  return {
    async listAgents(requested) { return agents.filter((agent) => agent.tenant === requested); },
    async createAgent() { throw new Error('provisioning must not create an agent in these tests'); },
    async listDelegations(requested, delegate) {
      return delegations.filter((entry) => entry.tenant === requested && entry.delegate === delegate);
    },
  };
}

function authenticator(tenant = TENANT, principal = PRINCIPAL): Authenticator {
  return {
    async authenticate() {
      return {
        principal,
        tenant,
        claims: {},
        session: { id: 'session-1' },
        delegation: null,
        boundaryVerified: true,
        authorizedCapabilities: [...declared().capabilities, 'factory.run'],
        authority: 'delegated',
        delegationId: associationDelegationId(tenant),
      };
    },
  };
}

/**
 * A repository fixture with the files discovery looks for. Execution really
 * materializes this directory and runs the `.flow` command inside it.
 */
async function fixtureRepository(root: string): Promise<string> {
  return createRepository(root, {
    'package.json': JSON.stringify({
      name: 'checkout', version: '1.0.0', type: 'module',
      scripts: { build: 'tsc', test: 'node --test' },
    }),
    'package-lock.json': JSON.stringify({ name: 'checkout', lockfileVersion: 3 }),
    'Dockerfile': 'FROM node:22-slim\n',
    'fly.toml': "app = 'checkout'\n",
    '.github/workflows/ci.yml': 'name: ci\n',
  });
}

async function service(options: {
  controlPlane?: AuthBoundryControlPlane;
  tenant?: string;
  principal?: string;
} = {}): Promise<FactoryService> {
  const workingDirectory = await createTempWorkspace('factory-product');
  const instance = await FactoryService.create({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    repositoryRoot: await fixtureRepository(workingDirectory),
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    authenticator: authenticator(options.tenant, options.principal),
    authBoundryTenantId: options.tenant ?? TENANT,
    authBoundryControlPlane: options.controlPlane ?? associatedControlPlane({ tenant: options.tenant }),
  });
  await instance.refreshConnection();
  return instance;
}

async function context(instance: FactoryService, tenant = TENANT) {
  return instance.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
}

test('projects, repositories, environments, and desired state persist in FeltDB', async () => {
  const instance = await service();
  const domain = instance.projects();

  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout', description: 'Billing surface' });
  assert.match(project.id, /^prj_/);
  assert.equal(project.status, 'active');

  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });
  assert.equal(repository.projectId, project.id);
  assert.equal(repository.defaultBranch, 'main');
  assert.deepEqual((await domain.listRepositories(TENANT, project.id)).map((r) => r.id), [repository.id]);

  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly' });
  assert.equal(environment.projectId, project.id);
  assert.deepEqual((await domain.listEnvironments(TENANT, project.id)).map((e) => e.name), ['production']);

  const desired = await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
    healthRequirement: 'health endpoint returns 200',
  });
  assert.equal(desired.projectId, project.id);
  assert.equal(desired.deploymentEnabled, false);

  // Updating desired state replaces it rather than accumulating rows.
  const updated = await domain.putDesiredState(TENANT, project.id, { sourceBranch: 'release' });
  assert.equal(updated.id, desired.id);
  assert.equal((await domain.getDesiredState(TENANT, project.id))?.sourceBranch, 'release');
});

test('tenant and project isolation hold for every product read', async () => {
  const instance = await service();
  const domain = instance.projects();
  const mine = await domain.createProject({ tenantId: TENANT, name: 'Mine' });
  const theirs = await domain.createProject({ tenantId: 'tenant-b', name: 'Theirs' });
  await domain.addRepository('tenant-b', theirs.id, { owner: 'other', name: 'repo' });
  const otherProject = await domain.createProject({ tenantId: TENANT, name: 'Other project' });
  const otherRepository = await domain.addRepository(TENANT, otherProject.id, { owner: 'me', name: 'other' });

  assert.deepEqual((await domain.listProjects(TENANT)).map((p) => p.name), ['Mine', 'Other project']);
  assert.equal(await domain.getProject(TENANT, theirs.id), null, 'another tenant project is not readable by id');
  assert.deepEqual(await domain.listRepositories(TENANT, theirs.id), []);
  assert.equal(
    await domain.getRepository(TENANT, mine.id, otherRepository.id),
    null,
    'a repository is not readable through a different project',
  );
  assert.equal(await domain.removeRepository(TENANT, mine.id, otherRepository.id), false);
});

test('an Action is planned from repository reality and stays separate from desired state', async () => {
  const instance = await service();
  const domain = instance.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Factory' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, deploymentEnabled: false, healthRequirement: 'tests pass',
  });

  const action = await instance.createAction(
    await context(instance), project.id, { type: 'repo-echo' }, autonomyGranted);
  assert.equal(action.status, 'planned', 'an authority that grants autonomy needs no approval step');
  assert.equal(action.autonomy?.allowed, true);
  assert.equal(action.operation, 'repo-echo');
  assert.equal(action.executionProvider, 'native');
  assert.ok(action.plan.length > 1, 'a plan has steps');
  assert.ok(action.discovery, 'the repository was inspected');
  // Discovery read the fixture repository, which really does contain these.
  assert.ok(action.discovery!.files.includes('package.json'));
  assert.ok(action.discovery!.files.includes('Dockerfile'));
  assert.ok(action.discovery!.files.includes('.github/workflows/ci.yml'));
  assert.equal(action.discovery!.signals.flyConfigured, true);
  assert.deepEqual(action.discovery!.signals.scripts, ['build', 'test']);
  assert.equal(action.discovery!.signals.packageManager, 'npm');
  assert.ok(action.plan.some((step) => /test script/.test(step.summary)));
  assert.ok(action.plan.some((step) => step.basis === 'package.json'));
  assert.ok(action.plan.some((step) => /Stop before deployment/.test(step.summary)),
    'disabled deployment produces a stop step, not a deploy step');

  // Desired state, Action, and Run stay distinct records.
  assert.notEqual(action.id, (await domain.getDesiredState(TENANT, project.id))!.id);
  assert.equal(action.runId, undefined);

  const rejected = await instance.createAction(await context(instance), project.id, { type: 'not-a-flow-operation' })
    .then(() => null, (error: Error) => error);
  assert.match(rejected!.message, /no \.flow operation named/);
});

test('an authorized Action executes, records a Run, and proves it with FeltDB evidence', async () => {
  const instance = await service();
  const domain = instance.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Factory' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'development' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, deploymentEnabled: false, healthRequirement: 'evidence records a pass',
  });

  const planned = await instance.createAction(await context(instance), project.id, {
    type: 'repo-echo', environmentId: environment.id, intent: 'Prove the repository builds',
  });
  const action = await instance.runAction(await context(instance), planned.id);

  assert.equal(action.status, 'succeeded', JSON.stringify(action.verification));
  assert.ok(action.runId);
  assert.equal(action.authority?.application, 'factory');
  assert.equal(action.authority?.principal, PRINCIPAL);
  assert.equal(action.authority?.delegation, associationDelegationId(TENANT));
  assert.ok(action.authority?.authorizationDecisionId, 'the authorization decision is recorded on the action');
  assert.ok(action.verification?.some((check) => check.name === 'evidence recorded' && check.status === 'passed'));

  const db = (instance as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  const run = await db.collection<RunRecord>(COLLECTIONS.runs).get(action.runId!);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.actionId, action.id);
  assert.equal(run?.projectId, project.id);
  assert.equal(run?.environmentId, environment.id);
  assert.equal(run?.applicationId, 'factory');
  assert.equal(run?.delegationId, associationDelegationId(TENANT));
  assert.equal(run?.executionProvider, 'native');

  const evidence = await db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(action.runId!);
  assert.equal(evidence?.finalResult, 'PASS');
  assert.equal(evidence?.authorizedApplication?.applicationId, 'factory');
  assert.equal(evidence?.authorizedApplication?.resource, 'application:factory');
  assert.equal(evidence?.authorizedApplication?.delegationId, associationDelegationId(TENANT));
  assert.equal(evidence?.authorizedApplication?.principalId, PRINCIPAL);
});

test('a deploying desired state produces a deployment step, and autonomy is asked of the authority', async () => {
  const instance = await service();
  const domain = instance.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Deploys' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, deploymentEnabled: true, targetProvider: 'fly',
  });

  // The plan follows desired state; whether it waits for a person does not.
  const granted = await instance.createAction(
    await context(instance), project.id, { type: 'repo-echo' }, autonomyGranted);
  assert.ok(granted.plan.some((step) => /Deploy to fly/.test(step.summary)));
  assert.equal(granted.status, 'planned');

  // Factory could not ask, so the safe answer stands and a person is asked.
  const ungated = await instance.createAction(await context(instance), project.id, { type: 'repo-echo' });
  assert.equal(ungated.status, 'awaiting-approval');
  assert.equal(ungated.autonomy?.allowed, false);

  const overview = await instance.overview(await context(instance));
  assert.ok((overview.attentionRequired as { id: string }[]).some((entry) => entry.id === ungated.id));

  const approver = await context(instance);
  await assert.rejects(
    () => instance.runAction(approver, ungated.id, { autonomous: true }),
    /may not execute autonomously/,
  );
  const ran = await instance.runAction(approver, ungated.id);
  assert.equal(ran.status, 'succeeded', JSON.stringify(ran.verification));
  assert.equal(ran.approvedBy, PRINCIPAL);
});

test('an unassociated Factory principal fails closed instead of executing', async () => {
  const instance = await service({ controlPlane: associatedControlPlane({ withDelegation: false }) });
  assert.equal(instance.connectionState().status, 'unassociated');

  const domain = instance.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Factory' });
  await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });

  // Every protected route refuses before it reaches the product model.
  await assert.rejects(
    () => instance.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read'),
    /association/i,
  );

  const action = await domain.createAction({
    id: 'act_unassociated', projectId: project.id, tenantId: TENANT, type: 'repo-echo',
    intent: 'should not run', plan: [], status: 'planned',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const attempted = await instance.runAction({
    principal: PRINCIPAL, tenant: TENANT, claims: {}, session: null, delegation: null, boundaryVerified: true,
  }, action.id);
  assert.equal(attempted.status, 'failed');
  assert.equal(attempted.runId, undefined, 'no run is started without an authorized application context');
  assert.ok(attempted.verification?.some((check) => check.name === 'authority' && check.status === 'failed'));
});

test('an unverified AuthBoundry fails closed rather than assuming agreement', async () => {
  const unreachable: AuthBoundryControlPlane = {
    async listAgents() { throw new Error('authority unreachable'); },
    async createAgent() { throw new Error('authority unreachable'); },
    async listDelegations() { throw new Error('authority unreachable'); },
  };
  const instance = await service({ controlPlane: unreachable });
  const state = instance.connectionState();
  assert.equal(state.status, 'unverified');
  assert.match(state.status === 'unverified' ? state.reason : '', /unreachable/);

  await assert.rejects(
    () => instance.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read'),
    /not verified/i,
  );

  const overview = await instance.overview({
    principal: PRINCIPAL, tenant: TENANT, claims: {}, session: null, delegation: null, boundaryVerified: true,
  });
  assert.equal((overview.authority as { state: string }).state, 'unverified');
});

test('projects, environments, actions, and runs survive a Factory restart', async () => {
  const workingDirectory = await createTempWorkspace('factory-restart');
  const namespace = path.basename(workingDirectory);
  const config = {
    mode: 'local' as const,
    namespace,
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    repositoryRoot: await fixtureRepository(workingDirectory),
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    authenticator: authenticator(),
    authBoundryTenantId: TENANT,
    authBoundryControlPlane: associatedControlPlane(),
  };

  const first = await FactoryService.create(config);
  await first.refreshConnection();
  const project = await first.projects().createProject({ tenantId: TENANT, name: 'Durable' });
  const repository = await first.projects().addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'factory' });
  const environment = await first.projects().createEnvironment(TENANT, project.id, { name: 'staging' });
  await first.projects().putDesiredState(TENANT, project.id, { sourceRepositoryId: repository.id, deploymentEnabled: false });
  const planned = await first.createAction(await context(first), project.id, { type: 'repo-echo' });
  const ran = await first.runAction(await context(first), planned.id);
  assert.equal(ran.status, 'succeeded', JSON.stringify(ran.verification));
  await first.shutdown();

  // A second process reads the same durable state. Nothing lived in memory.
  const second = await FactoryService.create(config);
  await second.refreshConnection();
  assert.deepEqual((await second.projects().listProjects(TENANT)).map((p) => p.name), ['Durable']);
  assert.deepEqual((await second.projects().listEnvironments(TENANT, project.id)).map((e) => e.id), [environment.id]);
  assert.equal((await second.projects().getDesiredState(TENANT, project.id))?.sourceRepositoryId, repository.id);
  const restored = await second.projects().getAction(TENANT, planned.id);
  assert.equal(restored?.status, 'succeeded');
  assert.equal(restored?.runId, ran.runId);
  assert.equal((await second.projects().getRun(TENANT, ran.runId!))?.status, 'completed');
  await second.shutdown();
});

test('providers are read from .flow rather than hard-coded', async () => {
  const instance = await service();
  const providers = instance.providers();
  assert.deepEqual(providers.map((provider) => provider.id).sort(), ['integration', 'native', 'pax']);

  const native = providers.find((provider) => provider.id === 'native')!;
  assert.equal(native.connectionState, 'ready');
  assert.ok(native.operations.some((operation) => operation.operation === 'repo-echo'));
  assert.ok(native.capabilities.includes('repository.read'));

  const integration = providers.find((provider) => provider.id === 'integration')!;
  assert.ok(integration.operations.some((operation) => operation.operation === 'pull_request.merge'));
  assert.ok(integration.capabilities.includes('github.pull_request.merge'));
  // Every capability a provider advertises is one .flow actually declares.
  const declaredCapabilities = new Set(providers.flatMap((provider) => provider.capabilities));
  for (const capability of declaredCapabilities) {
    assert.match(capability, /^[a-z]+(\.[a-z_]+)+$/);
  }
});

test('the product surface is the landing page and AppPort Services still works beneath it', async () => {
  const workingDirectory = await createTempWorkspace('factory-surface');
  const { server } = await createHttpServer({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    // AppPort Services scopes configuration to a declared environment, so the
    // surface test uses one in order to exercise it rather than a stub name.
    environmentId: 'development',
    appportPath: path.join(workingDirectory, 'appport-services'),
    repositoryRoot: await fixtureRepository(workingDirectory),
    authenticator: authenticator(),
    authBoundryTenantId: TENANT,
    authBoundryControlPlane: associatedControlPlane(),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/factory', 'Factory is the landing surface');

    const overview = await fetch(`${origin}/factory`);
    assert.equal(overview.status, 200);
    const html = await overview.text();
    for (const label of ['Overview', 'Projects', 'Actions', 'Runs', 'Providers', 'AppPort Services', 'Settings']) {
      assert.ok(html.includes(`>${label}</a>`), `navigation includes ${label}`);
    }
    assert.ok(html.includes('Actions Orchestrator'));

    // The product API answers, and AppPort Services remains mounted.
    const projects = await fetch(`${origin}/v1/projects`);
    assert.equal(projects.status, 200);
    const created = await fetch(`${origin}/v1/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'From the API' }),
    });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };

    const invalid = await fetch(`${origin}/v1/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);

    const action = await fetch(`${origin}/v1/projects/${project.id}/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'repo-echo' }),
    });
    assert.equal(action.status, 201);
    assert.equal((await action.json() as ActionRecord).status, 'planned');

    assert.equal((await fetch(`${origin}/v1/providers`)).status, 200);
    assert.equal((await fetch(`${origin}/v1/overview`)).status, 200);

    // AppPort Services is still reachable as the infrastructure area.
    assert.equal((await fetch(`${origin}/configuration`)).status, 200);
    assert.equal((await fetch(`${origin}/v1/configuration`)).status, 200);
    assert.equal((await fetch(`${origin}/services`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('every product page script parses as an ES module', async () => {
  // The browser never reports a page whose script failed to parse: it simply
  // never runs, and every section stays at "Loading…". Parsing each page's
  // script the way a browser would is what catches that before a deploy does.
  const workingDirectory = await createTempWorkspace('factory-page-scripts');
  const pages: [string, string][] = [
    ['overview', overviewPage()],
    ['projects', projectsPage()],
    ['project', projectPage('prj_example')],
    ['actions', actionsPage()],
    ['action', actionPage('act_example')],
    ['runs', runsPage()],
    ['run', runPage('run_example')],
    ['providers', providersPage()],
    ['settings', settingsPage()],
    ['graphs', graphsPage()],
    ['graph', graphPage('graph_example')],
    ['work-list', workListPage()],
    ['work', workPage('owk_example')],
  ];
  for (const [name, html] of pages) {
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, `${name} page has a module script`);
    const file = path.join(workingDirectory, `${name}.mjs`);
    writeFileSync(file, script);
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      (error: unknown) => {
        const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr: Buffer }).stderr) : String(error);
        assert.fail(`${name} page script does not parse:\n${detail}`);
      },
    );
  }
});
