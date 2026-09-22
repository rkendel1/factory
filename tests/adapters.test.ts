import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { OPERATIONAL_CAPABILITIES } from '../src/capabilities.js';
import {
  DEFAULT_ADAPTERS,
  flyAdapter,
  gitAdapter,
  localAdapter,
  ProviderRegistry,
  resolveProvider,
  type ProviderAdapter,
  type ProviderContext,
} from '../src/adapters.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import type { ExecutionContractRecord, StructuredEvidence } from '../src/types.js';

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';
const SECRET = 'fly-token-that-must-never-be-recorded';
const declared = () => factoryAssociation(loadFactoryFlow());

function controlPlane(): AuthBoundryControlPlane {
  const association = declared();
  return {
    async listAgents(tenant) {
      return [{ id: PRINCIPAL, kind: 'agent', name: 'factory-service', tenant, status: 'active' }];
    },
    async createAgent() { throw new Error('unexpected agent creation'); },
    async listDelegations(tenant, delegate) {
      return [{
        id: associationDelegationId(tenant), delegator: 'system', delegate,
        application: association.applicationId, tenant, capabilities: [...association.capabilities],
      }];
    },
  };
}

function authenticator(tenant = TENANT): Authenticator {
  return {
    async authenticate() {
      return {
        principal: PRINCIPAL, tenant, claims: {}, session: { id: 'session-1' }, delegation: null,
        boundaryVerified: true, authorizedCapabilities: [...declared().capabilities, 'factory.run'],
        authority: 'delegated', delegationId: associationDelegationId(tenant),
      };
    },
  };
}

const grants: CapabilityProbe = async (capability) => ({
  allowed: capability === AUTONOMOUS_EXECUTION_CAPABILITY, reason: `AuthBoundry authorized ${capability}`,
});
const denies: CapabilityProbe = async (capability) => ({
  allowed: false, reason: `AuthBoundry denied operation ${capability}`,
});

/** A recording adapter standing in for Fly, so tests can see the boundary. */
function recordingFly(): ProviderAdapter & { executions: string[]; verifications: string[] } {
  const executions: string[] = [];
  const verifications: string[] = [];
  return {
    ...flyAdapter,
    executions,
    verifications,
    async availability() { return { state: 'available', detail: 'stub' }; },
    idempotency(capability) { executions.push(capability); return flyAdapter.idempotency(capability); },
    verify(capability, evidence, context) { verifications.push(capability); return flyAdapter.verify(capability, evidence, context); },
  };
}

async function gitRepository(root: string, files: Record<string, string> = {}): Promise<string> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e 0', test: 'node -e 0' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
    'fly.toml': "app = 'checkout-app'\n",
    ...files,
  });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repositoryPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return repositoryPath;
}

async function factory(repositoryRoot: string, options: {
  workingDirectory?: string; adapters?: readonly ProviderAdapter[]; tenant?: string;
} = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-adapters');
  const service = await FactoryService.create({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    authenticator: authenticator(options.tenant),
    authBoundryTenantId: options.tenant ?? TENANT,
    authBoundryControlPlane: controlPlane(),
    ...(options.adapters ? { providerAdapters: options.adapters } : {}),
  });
  await service.refreshConnection();
  return { service, workingDirectory };
}

async function scenario(repositoryRoot: string, options: {
  workingDirectory?: string; adapters?: readonly ProviderAdapter[]; provider?: string | null;
  configuration?: Record<string, unknown>;
} = {}) {
  const { service, workingDirectory } = await factory(repositoryRoot, options);
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout' });
  const environment = await domain.createEnvironment(TENANT, project.id, {
    name: 'production',
    ...(options.provider === null ? {} : { provider: options.provider ?? 'fly' }),
    ...(options.configuration ? { configuration: options.configuration } : {}),
  });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
  });
  return { service, context, domain, project, repository, environment, workingDirectory };
}

function registryContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    repository: { id: 'repo_1', projectId: 'prj', tenantId: TENANT, provider: 'github', owner: 'rkendel1', name: 'checkout', defaultBranch: 'main', createdAt: '' },
    environment: { id: 'env_1', projectId: 'prj', tenantId: TENANT, name: 'production', provider: 'fly', createdAt: '', updatedAt: '' },
    desiredState: null,
    discovery: null,
    idempotencyKey: 'act_1',
    ...overrides,
  };
}

test('the vocabulary is provider-neutral and .flow decides which of it Factory can perform', () => {
  for (const capability of OPERATIONAL_CAPABILITIES) {
    assert.doesNotMatch(capability, /fly|vercel|github/, `${capability} names no provider`);
  }
  const registry = new ProviderRegistry(loadFactoryFlow());
  assert.deepEqual(registry.providers(), ['fly', 'git', 'local']);
  assert.deepEqual(registry.providersFor('deployment.create'), ['fly']);
  assert.deepEqual(registry.providersFor('build.run'), ['local']);
  assert.deepEqual(registry.providersFor('repository.inspect'), ['git', 'local']);
  // Declared in the vocabulary, declared by no .flow operation: not performable.
  assert.deepEqual(registry.providersFor('deployment.rollback'), []);
  assert.deepEqual(registry.providersFor('migration.run'), []);
  // An adapter with no declaration is not an ability.
  const noFly = new ProviderRegistry(loadFactoryFlow(), [gitAdapter, localAdapter]);
  assert.deepEqual(noFly.providersFor('deployment.create'), []);
});

test('provider resolution is deterministic and never falls back', () => {
  const registry = new ProviderRegistry(loadFactoryFlow());

  const deploy = resolveProvider(registry, 'deployment.create', registryContext());
  assert.deepEqual(deploy, { ok: true, provider: 'fly', operation: 'fly.deployment.create', capability: 'deployment.create', resource: 'environment:production' });
  assert.deepEqual(resolveProvider(registry, 'deployment.create', registryContext()), deploy, 'the same inputs resolve the same way');

  const build = resolveProvider(registry, 'build.run', registryContext());
  assert.equal(build.ok && build.provider, 'local');
  assert.equal(build.ok && build.resource, 'repository:rkendel1/checkout');

  // Unknown capability, undeclared capability, no configured provider, wrong provider.
  assert.deepEqual(resolveProvider(registry, 'fly.deploy', registryContext()).ok, false);
  const undeclared = resolveProvider(registry, 'deployment.rollback', registryContext());
  assert.equal(!undeclared.ok && undeclared.outcome, 'capability-unavailable');
  const unconfigured = resolveProvider(registry, 'deployment.create', registryContext({ environment: { ...registryContext().environment!, provider: undefined } }));
  assert.equal(!unconfigured.ok && unconfigured.outcome, 'provider-unavailable');
  assert.match(!unconfigured.ok ? unconfigured.reason : '', /no provider is configured/);
  const wrong = resolveProvider(registry, 'deployment.create', registryContext({ environment: { ...registryContext().environment!, provider: 'vercel' } }));
  assert.equal(!wrong.ok && wrong.outcome, 'provider-unavailable');
  assert.match(!wrong.ok ? wrong.reason : '', /vercel does not satisfy deployment.create/, 'no other provider is chosen instead');
  // Desired state can name the provider when the environment does not.
  const fromDesired = resolveProvider(registry, 'environment.health', registryContext({
    environment: { ...registryContext().environment!, provider: undefined },
    desiredState: { id: 'd', projectId: 'prj', tenantId: TENANT, targetProvider: 'fly', createdAt: '', updatedAt: '' },
  }));
  assert.equal(fromDesired.ok && fromDesired.provider, 'fly');
  // Repository capabilities with several declared providers are refused, not guessed.
  assert.equal(resolveProvider(registry, 'repository.inspect', registryContext()).ok, false);
});

test('an Action with an unperformable capability is refused; an unresolvable provider is a durable outcome', async () => {
  const root = await createTempWorkspace('adapters-unavailable');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root), { provider: null });

  await assert.rejects(
    () => service.createAction(context, project.id, { capability: 'migration.run', environmentId: environment.id }, grants),
    /no \.flow operation declares migration.run/,
  );
  await assert.rejects(
    () => service.createAction(context, project.id, { capability: 'fly.deploy', environmentId: environment.id }, grants),
    /not an operational capability/,
  );

  const action = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
  assert.equal(action.status, 'failed');
  assert.equal(action.outcome, 'provider-unavailable');
  assert.equal(action.runId, undefined, 'nothing ran');
  assert.match(action.verification?.[0]?.detail ?? '', /no provider is configured for environment:production/);
  assert.equal((await domain.getAction(TENANT, action.id))?.outcome, 'provider-unavailable', 'the outcome is durable');
});

test('a capability Action resolves provider, operation and resource, and plans before it acts', async () => {
  const root = await createTempWorkspace('adapters-plan');
  const { service, context, project, environment } = await scenario(await gitRepository(root));

  const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
  assert.equal(deploy.capability, 'deployment.create');
  assert.equal(deploy.provider, 'fly');
  assert.equal(deploy.operation, 'fly.deployment.create');
  assert.equal(deploy.resource, 'environment:production');
  assert.equal(deploy.verificationRequires, 'environment.health');
  assert.equal(deploy.status, 'planned');
  assert.ok(deploy.plan.some((step) => step.basis === 'provider adapter plan' && /fly performs deployment.create on environment:production/.test(step.summary)));
  assert.ok(deploy.plan.some((step) => /deploys the checkout to checkout-app/.test(step.detail ?? '')), 'the plan names the Fly app from fly.toml');

  const build = await service.createAction(context, project.id, { type: 'build.run' }, grants);
  assert.equal(build.provider, 'local');
  assert.equal(build.resource, 'repository:rkendel1/checkout');
  // A caller cannot bind a resource; it comes from durable state.
  assert.equal((build as { resource?: string }).resource, 'repository:rkendel1/checkout');
});

test('the adapter is reached only through runAction and only after authorization', async () => {
  const root = await createTempWorkspace('adapters-authorize');
  const fly = recordingFly();
  const { service, context, project, environment } = await scenario(await gitRepository(root), {
    adapters: [gitAdapter, localAdapter, fly],
  });

  const denied = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, denies);
  assert.equal(denied.status, 'awaiting-approval');
  await assert.rejects(() => service.runAction(context, denied.id, { probe: denies, autonomous: true }), /may not execute autonomously/);
  assert.deepEqual(fly.executions, [], 'a denied Action never reaches the adapter');

  const health = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, grants);
  const ran = await service.runAction(context, health.id, { probe: grants, autonomous: true });
  assert.deepEqual(fly.executions, ['environment.health'], 'the adapter was invoked once, through runAction');
  assert.ok(ran.runId);
  assert.equal(ran.authority?.delegation, associationDelegationId(TENANT), 'authorization happened per Action');

  await service.runAction(context, health.id, { probe: grants, autonomous: true });
  assert.deepEqual(fly.executions, ['environment.health'], 'a finished Action is not executed again');
});

test('execution success and verification failure stay distinct, and the health probe is real', async () => {
  const root = await createTempWorkspace('adapters-health');
  // A real HTTP endpoint that is unhealthy, then healthy.
  let status = 503;
  const server = createServer((_request, response) => { response.statusCode = status; response.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const healthUrl = `http://127.0.0.1:${address.port}/health`;
  try {
    const { service, context, domain, project, environment } = await scenario(await gitRepository(root), {
      configuration: { healthUrl },
    });

    const unhealthy = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, grants);
    const failed = await service.runAction(context, unhealthy.id, { probe: grants, autonomous: true });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.outcome, 'verification-failed', 'the probe ran and completed; what it found did not pass');
    const run = await domain.getRun(TENANT, failed.runId!);
    assert.equal(run?.status, 'completed', 'execution succeeded');
    const check = failed.verification?.find((entry) => entry.name === 'environment responds healthy');
    assert.equal(check?.status, 'failed');
    assert.match(check?.detail ?? '', /HTTP 503/);

    status = 200;
    const healthy = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, grants);
    const passed = await service.runAction(context, healthy.id, { probe: grants, autonomous: true });
    assert.equal(passed.status, 'succeeded');
    assert.equal(passed.outcome, 'succeeded');
    assert.match(passed.verification?.find((entry) => entry.name === 'environment responds healthy')?.detail ?? '', /returned HTTP 200/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a provider operation that cannot run is execution-failed, with the reason kept', async () => {
  const root = await createTempWorkspace('adapters-execfail');
  const { service, context, project, environment } = await scenario(await gitRepository(root));
  // fly is not installed here, so deployment really fails to execute.
  const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
  const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
  assert.equal(ran.status, 'failed');
  assert.equal(ran.outcome, 'execution-failed');
  assert.ok(ran.runId);
});

test('credentials are resolved only at the execution boundary and never recorded', async () => {
  const root = await createTempWorkspace('adapters-secrets');
  const previous = process.env.FLY_API_TOKEN;
  process.env.FLY_API_TOKEN = SECRET;
  try {
    const { service, context, domain, project, environment } = await scenario(await gitRepository(root), {
      configuration: { healthUrl: 'http://127.0.0.1:9/health' },
    });
    const action = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, grants);
    const ran = await service.runAction(context, action.id, { probe: grants, autonomous: true });
    const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;

    const evidence = (await db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(ran.runId!))!;
    assert.deepEqual(evidence.provider?.credentials, ['FLY_API_TOKEN'], 'evidence records which credential, by name');
    assert.equal(evidence.provider?.parameters.FACTORY_HEALTH_URL, 'http://127.0.0.1:9/health');
    const contract = (await db.collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).get(ran.runId!))!;
    for (const [label, record] of [['action', await domain.getAction(TENANT, action.id)], ['run', await domain.getRun(TENANT, ran.runId!)], ['evidence', evidence], ['contract', contract]] as const) {
      assert.doesNotMatch(JSON.stringify(record), new RegExp(SECRET), `${label} holds no credential value`);
    }
    assert.equal(evidence.provider?.idempotency.key, action.id, 'the provider idempotency identity is the durable Action identity');
  } finally {
    if (previous === undefined) delete process.env.FLY_API_TOKEN; else process.env.FLY_API_TOKEN = previous;
  }
});

test('a multi-provider graph executes in dependency order and a provider failure blocks dependents', async () => {
  const root = await createTempWorkspace('adapters-graph');
  const { service, context, project, environment } = await scenario(await gitRepository(root));
  const { graph, actions } = await service.createActionGraph(context, {
    projectId: project.id, environmentId: environment.id,
    actions: [
      { key: 'build', capability: 'build.run', type: 'build.run' },
      { key: 'test', capability: 'test.run', type: 'test.run', dependsOn: ['build'] },
      { key: 'deploy', capability: 'deployment.create', type: 'deployment.create', dependsOn: ['test'] },
      { key: 'health', capability: 'environment.health', type: 'environment.health', dependsOn: ['deploy'] },
    ],
  }, grants);
  assert.deepEqual(actions.map((action) => action.provider), ['local', 'local', 'fly', 'fly']);
  assert.deepEqual(actions.map((action) => action.resource), [
    'repository:rkendel1/checkout', 'repository:rkendel1/checkout', 'environment:production', 'environment:production',
  ]);

  const result = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(result.actions[0]!.status, 'succeeded', 'build ran through local');
  assert.equal(result.actions[1]!.status, 'succeeded', 'test ran through local');
  assert.equal(result.actions[2]!.outcome, 'execution-failed', 'fly is not installed here');
  assert.deepEqual(result.actions[3]!.blockedBy, [result.actions[2]!.id], 'health is blocked by the failed deploy');
  assert.equal(result.graph.status, 'failed');
  assert.equal(result.graph.failure?.outcome, 'execution-failed');
  const view = (await service.graphView(context, graph.id))!;
  const healthNode = (view.nodes as { reason: string | null }[])[3]!;
  assert.match(healthNode.reason ?? '', /deployment.create — execution-failed/, 'the block names its cause');

  // Coordinating again invokes nothing twice.
  const again = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.deepEqual(again.actions.map((action) => action.runId), result.actions.map((action) => action.runId));
});

test('provider status separates reachability from authorization, and is tenant-scoped', async () => {
  const root = await createTempWorkspace('adapters-status');
  const { service, context, project, environment } = await scenario(await gitRepository(root));
  await service.createAction(context, project.id, { capability: 'build.run' }, grants);

  const providers = await service.operationalProviders(context);
  const fly = providers.find((provider) => provider.id === 'fly')!;
  assert.equal(fly.configured, true, 'production names fly');
  assert.deepEqual((fly.projects as { name: string; environments: string[] }[]), [{ id: project.id, name: 'Checkout', environments: ['production'] }]);
  assert.ok(['available', 'unavailable'].includes(fly.status as string));
  assert.match(fly.note as string, /authorization is decided per Action by AuthBoundry/);
  assert.deepEqual((fly.capabilities as { capability: string }[]).map((entry) => entry.capability), ['deployment.create', 'environment.health', 'environment.inspect']);
  assert.deepEqual(fly.credentials, ['FLY_API_TOKEN']);
  assert.doesNotMatch(JSON.stringify(providers), /fly-token/);

  const local = providers.find((provider) => provider.id === 'local')!;
  assert.equal((local.recentActions as unknown[]).length, 1);

  // Another tenant sees the same providers and none of this tenant's projects.
  const other = await service.operationalProviders({ ...context, tenant: 'tenant-b' });
  assert.equal(other.find((provider) => provider.id === 'fly')!.configured, false);
  assert.equal((other.find((provider) => provider.id === 'local')!.recentActions as unknown[]).length, 0);
  assert.equal(environment.provider, 'fly');
});

test('adapters are the only defaults and each declares what it needs', () => {
  assert.deepEqual(DEFAULT_ADAPTERS.map((adapter) => adapter.id), ['git', 'local', 'fly']);
  assert.deepEqual(flyAdapter.credentials, ['FLY_API_TOKEN']);
  assert.deepEqual(gitAdapter.credentials, []);
  assert.equal(flyAdapter.idempotency('deployment.create').exactlyOnce, false, 'fly deploy is not claimed exactly-once');
  assert.equal(flyAdapter.idempotency('environment.health').exactlyOnce, true);
});
