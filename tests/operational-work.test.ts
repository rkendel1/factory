import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHttpServer, FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import {
  OPERATIONAL_WORK_CAPABILITY,
  OPERATIONAL_WORK_CONTRACT,
  OperationalWorkConflictError,
  OperationalWorkRequestError,
  operationalWorkFingerprint,
  operationalWorkId,
  parseOperationalWorkRequest,
  planOperationalWork,
  type OperationalWorkResult,
} from '../src/operational-work.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe, AuthenticatedContext } from '../src/auth.js';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const PRINCIPAL = 'agent:factory-service';
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
const unavailable: CapabilityProbe = async () => ({
  allowed: false, reason: 'AuthBoundry unavailable: connect ECONNREFUSED',
});

async function gitRepository(root: string): Promise<string> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e 0', test: 'node -e 0' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
    'fly.toml': "app = 'checkout-app'\n",
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

async function factory(repositoryRoot: string, options: { workingDirectory?: string; tenant?: string } = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-operational-work');
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
  });
  await service.refreshConnection();
  return { service, workingDirectory };
}

async function scenario(repositoryRoot: string, options: { workingDirectory?: string } = {}) {
  const { service, workingDirectory } = await factory(repositoryRoot, options);
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout' });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
  });
  return { service, context, domain, project, repository, environment, workingDirectory };
}

const otherTenant = (): AuthenticatedContext => ({
  principal: PRINCIPAL, tenant: OTHER_TENANT, claims: {}, session: { id: 'session-2' }, delegation: null,
  boundaryVerified: true, authorizedCapabilities: [...declared().capabilities, 'factory.run'],
  authority: 'delegated', delegationId: associationDelegationId(OTHER_TENANT),
});

function request(project: string, overrides: Record<string, unknown> = {}) {
  return {
    contract: OPERATIONAL_WORK_CONTRACT,
    origin: { system: 'attn', type: 'work', id: 'work_42' },
    idempotencyKey: 'attn-work-42-v1',
    project,
    intent: 'Ship checkout',
    actions: [{ verb: 'build' }, { verb: 'test' }],
    ...overrides,
  };
}

const CREDENTIAL = /(apiKey|api_key|token|password|secret|credential)/i;

test('the contract admits operational verbs only and refuses authority, instructions and credentials', () => {
  const parsed = parseOperationalWorkRequest(request('prj_1'));
  assert.equal(parsed.contract, OPERATIONAL_WORK_CONTRACT);
  assert.deepEqual(parsed.origin, { system: 'attn', type: 'work', id: 'work_42' });
  assert.deepEqual(parsed.actions, [{ verb: 'build' }, { verb: 'test' }]);

  const refused = (overrides: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseOperationalWorkRequest(request('prj_1', overrides)), (error: unknown) => {
      assert.ok(error instanceof OperationalWorkRequestError, `expected a contract refusal, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    });

  // Development is Eve's; Factory does not reinterpret it as operations.
  refused({ actions: [{ verb: 'implement' }] }, /development work, which Factory does not perform/);
  refused({ actions: [{ verb: 'launch' }] }, /not an operational verb/);
  refused({ actions: [{ verb: 'build', instructions: 'add a feature flag' }] }, /development instructions/);
  refused({ prompt: 'make it faster' }, /development instructions/);
  // Authority cannot be carried by a request.
  refused({ approvedBy: 'attn' }, /cannot carry authority/);
  refused({ autonomous: true }, /cannot carry authority/);
  refused({ origin: { system: 'attn', type: 'work', id: 'work_42', authority: 'delegated' } }, /cannot carry authority/);
  // Credentials never enter Factory through a request, wherever they sit.
  refused({ actions: [{ verb: 'deploy', parameters: { apiKey: 'x' } }], environment: 'env' }, /looks like a credential/);
  refused({ flyToken: 'x' }, /looks like a credential/);
  // Contract discipline.
  refused({ contract: 'factory.operational-work/2' }, /contract must be/);
  refused({ idempotencyKey: '' }, /idempotencyKey is required/);
  refused({ origin: { system: 'attn', id: 'work_42' } }, /origin\.type is required/);
  refused({ actions: [] }, /non-empty array/);
  refused({ actions: [{ verb: 'deploy' }] }, /environment is required/);
  refused({ actions: [{ verb: 'build' }, { verb: 'build' }] }, /requested twice/);

  // Identity is tenant + origin + key; the whole request is fingerprinted.
  assert.equal(operationalWorkId(TENANT, parsed), operationalWorkId(TENANT, parseOperationalWorkRequest(request('prj_1'))));
  assert.notEqual(operationalWorkId(TENANT, parsed), operationalWorkId(OTHER_TENANT, parsed));
  assert.notEqual(operationalWorkId(TENANT, parsed), operationalWorkId(TENANT, { ...parsed, idempotencyKey: 'other' }));
  assert.equal(operationalWorkFingerprint(parsed), operationalWorkFingerprint(parseOperationalWorkRequest(request('prj_1'))));
  assert.notEqual(operationalWorkFingerprint(parsed), operationalWorkFingerprint(parseOperationalWorkRequest(request('prj_2'))));
});

test('translation is deterministic and enrichment follows fixed operational rules', () => {
  const deploy = planOperationalWork(parseOperationalWorkRequest(request('prj_1', {
    environment: 'env_1', actions: [{ verb: 'deploy' }],
  })));
  assert.deepEqual(deploy.map((step) => [step.key, step.capability, step.implied, step.dependsOn]), [
    ['build', 'build.run', true, []],
    ['test', 'test.run', true, ['build']],
    ['deploy', 'deployment.create', false, ['test']],
    ['verify', 'environment.health', true, ['deploy']],
  ]);
  assert.match(deploy[0]!.reason, /deploy requires a built repository/);

  // Order comes from the vocabulary, not the request.
  const reversed = planOperationalWork(parseOperationalWorkRequest(request('prj_1', { actions: [{ verb: 'test' }, { verb: 'build' }] })));
  assert.deepEqual(reversed.map((step) => step.key), ['build', 'test']);
  assert.deepEqual(reversed, planOperationalWork(parseOperationalWorkRequest(request('prj_1'))));

  const restart = planOperationalWork(parseOperationalWorkRequest(request('prj_1', { environment: 'env_1', actions: [{ verb: 'restart' }] })));
  assert.deepEqual(restart.map((step) => [step.key, step.implied]), [['restart', false], ['verify', true]]);

  const inspect = planOperationalWork(parseOperationalWorkRequest(request('prj_1', {
    environment: 'env_1', actions: [{ verb: 'inspect', target: 'environment' }],
  })));
  assert.deepEqual(inspect.map((step) => step.capability), ['environment.inspect']);
  assert.deepEqual(planOperationalWork(parseOperationalWorkRequest(request('prj_1', { actions: [{ verb: 'inspect' }] })))
    .map((step) => step.capability), ['repository.inspect']);
});

test('accepted work becomes an ordinary Action Graph, runs through the one path, and answers compactly', async () => {
  const root = await createTempWorkspace('operational-work-run');
  const { service, context, domain, project } = await scenario(await gitRepository(root));

  const { created, result } = await service.createOperationalWork(context, request(project.id), grants);
  assert.equal(created, true);
  assert.match(result.workId, /^owk_/);
  assert.equal(result.contract, OPERATIONAL_WORK_CONTRACT);
  assert.deepEqual(result.origin, { system: 'attn', type: 'work', id: 'work_42' });
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(result.actions.map((node) => [node.key, node.capability, node.provider, node.implied, node.status]), [
    ['build', 'build.run', 'local', false, 'completed'],
    ['test', 'test.run', 'local', false, 'completed'],
  ]);
  assert.equal(result.completedActions.length, 2);
  assert.deepEqual(result.blockedActions, []);
  assert.deepEqual(result.failedActions, []);
  assert.equal(result.evidence.length, 2, 'every step points at Factory evidence');
  assert.ok(result.completedAt);
  // The result contract is exactly what Attn needs and nothing more.
  assert.deepEqual(Object.keys(result).sort(), [
    'actions', 'blockedActions', 'completedActions', 'completedAt', 'contract', 'createdAt', 'evidence',
    'failedActions', 'graphId', 'intent', 'origin', 'outcome', 'status', 'updatedAt', 'workId',
  ]);

  // The graph and its nodes are the ordinary records, authorized per node.
  const graph = await domain.getGraph(TENANT, result.graphId!);
  assert.deepEqual(graph?.origin, { kind: 'external', sourceSystem: 'attn', sourceType: 'work', sourceId: 'work_42' });
  for (const node of result.actions) {
    const action = await domain.getAction(TENANT, node.actionId);
    assert.equal(action?.graphId, result.graphId);
    assert.equal(action?.authority?.delegation, associationDelegationId(TENANT), 'AuthBoundry authorized the node');
    const run = await domain.getRun(TENANT, node.runId!);
    assert.equal(run?.actionId, node.actionId);
    assert.equal((await service.getEvidence(node.runId!, context))?.id, node.evidenceId);
  }
  assert.equal((await domain.listRuns(TENANT, project.id)).length, 2, 'one Run per step, no second execution path');

  // Durable work and events, with no secret material anywhere.
  const work = await domain.getOperationalWork(TENANT, result.workId);
  assert.equal(work?.status, 'completed');
  assert.equal(work?.requestedBy, PRINCIPAL);
  const events = await domain.listOperationalWorkEvents(TENANT, result.workId);
  assert.deepEqual(events.map((event) => event.type), ['OperationalWorkAccepted', 'OperationalWorkPlanned', 'OperationalWorkCompleted']);
  assert.deepEqual(events[2]!.summary?.completedActions, result.completedActions);
  assert.equal(events[2]!.outcome, 'succeeded');
  for (const record of [work, events, result]) {
    for (const key of Object.keys(flatten(record))) assert.doesNotMatch(key, CREDENTIAL, `${key} in durable work state`);
  }
});

test('the same origin and key name the same work, in this process and after a restart', async () => {
  const root = await createTempWorkspace('operational-work-idempotent');
  const repositoryRoot = await gitRepository(root);
  const { service, context, domain, project, workingDirectory } = await scenario(repositoryRoot);

  const first = await service.createOperationalWork(context, request(project.id), grants);
  const second = await service.createOperationalWork(context, request(project.id), grants);
  assert.equal(second.created, false);
  assert.equal(second.result.workId, first.result.workId);
  assert.equal(second.result.graphId, first.result.graphId);
  assert.deepEqual(second.result.actions.map((node) => node.actionId), first.result.actions.map((node) => node.actionId));
  assert.deepEqual(second.result.actions.map((node) => node.runId), first.result.actions.map((node) => node.runId), 'nothing ran twice');
  assert.equal((await domain.listRuns(TENANT, project.id)).length, 2);

  // A reused key with a different request is a conflict, not a silent retry.
  await assert.rejects(
    () => service.createOperationalWork(context, request(project.id, { actions: [{ verb: 'inspect' }] }), grants),
    OperationalWorkConflictError,
  );
  await service.shutdown();

  const restarted = await factory(repositoryRoot, { workingDirectory });
  const again = await restarted.service.createOperationalWork(context, request(project.id), grants);
  assert.equal(again.created, false);
  assert.equal(again.result.workId, first.result.workId);
  assert.equal(again.result.status, 'completed');
  assert.deepEqual(again.result.actions.map((node) => node.runId), first.result.actions.map((node) => node.runId));
  assert.equal((await restarted.service.projects().listRuns(TENANT, project.id)).length, 2);
  assert.equal((await restarted.service.operationalWorkView(context, first.result.workId))?.status, 'completed');
  await restarted.service.shutdown();
});

test('an Attn origin grants nothing: AuthBoundry decides each step, and its answers stay distinct', async () => {
  const root = await createTempWorkspace('operational-work-authority');
  const { service, context, domain, project } = await scenario(await gitRepository(root));

  const blocked = await service.createOperationalWork(context, request(project.id), denies);
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.result.outcome, 'autonomy-denied');
  assert.deepEqual(blocked.result.actions.map((node) => node.status), ['awaiting-approval', 'blocked']);
  assert.deepEqual(blocked.result.blockedActions, blocked.result.actions.map((node) => node.actionId));
  assert.ok(blocked.result.actions.every((node) => node.runId === null), 'nothing ran on Attn\'s say-so');
  assert.equal((await domain.listRuns(TENANT, project.id)).length, 0);
  const events = await domain.listOperationalWorkEvents(TENANT, blocked.result.workId);
  assert.equal(events.at(-1)?.type, 'OperationalWorkBlocked');
  assert.equal(events.at(-1)?.outcome, 'autonomy-denied');

  // A person approving the step, and a grant since, lets the same work finish.
  await service.runAction(context, blocked.result.actions[0]!.actionId, { probe: denies });
  await service.coordinateGraph(context, blocked.result.graphId!, { probe: grants, autonomous: true });
  const finished = (await service.operationalWorkView(context, blocked.result.workId))!;
  assert.equal(finished.status, 'completed');
  assert.equal((await domain.listOperationalWorkEvents(TENANT, finished.workId)).at(-1)?.type, 'OperationalWorkCompleted');

  const offline = await service.createOperationalWork(context, request(project.id, { idempotencyKey: 'attn-work-42-v2' }), unavailable);
  assert.equal(offline.result.status, 'blocked');
  assert.equal(offline.result.outcome, 'authority-unavailable', 'unavailable is not flattened into denied');
});

test('enriched work reports a provider failure as failed with the failing and blocked steps named', async () => {
  const root = await createTempWorkspace('operational-work-deploy');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));

  const { result } = await service.createOperationalWork(context, request(project.id, {
    environment: environment.id, actions: [{ verb: 'deploy' }],
  }), grants);
  assert.deepEqual(result.actions.map((node) => [node.key, node.implied, node.status]), [
    ['build', true, 'completed'],
    ['test', true, 'completed'],
    ['deploy', false, 'failed'],
    ['verify', true, 'blocked'],
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'execution-failed', 'fly is not installed here');
  assert.deepEqual(result.failedActions, [result.actions[2]!.actionId]);
  assert.deepEqual(result.blockedActions, [result.actions[3]!.actionId]);
  assert.equal(result.completedActions.length, 2);
  const events = await domain.listOperationalWorkEvents(TENANT, result.workId);
  assert.equal(events.at(-1)?.type, 'OperationalWorkFailed');
  assert.deepEqual(events.at(-1)?.summary?.failedActions, result.failedActions);
});

test('work can be cancelled, and cancelled work stays cancelled on a retry', async () => {
  const root = await createTempWorkspace('operational-work-cancel');
  const { service, context, domain, project } = await scenario(await gitRepository(root));

  const planned = await service.createOperationalWork(context, request(project.id), grants, { coordinate: false });
  assert.equal(planned.result.status, 'ready');
  assert.equal(planned.result.outcome, null);

  const cancelled = (await service.cancelOperationalWork(context, planned.result.workId))!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal((await domain.getGraph(TENANT, cancelled.graphId!))?.status, 'cancelled');
  assert.equal((await domain.listOperationalWorkEvents(TENANT, cancelled.workId)).at(-1)?.type, 'OperationalWorkCancelled');

  const retried = await service.createOperationalWork(context, request(project.id), grants);
  assert.equal(retried.created, false);
  assert.equal(retried.result.status, 'cancelled');
  assert.equal((await domain.listRuns(TENANT, project.id)).length, 0, 'cancelled work never ran');
});

test('tenant, project and environment isolation hold across the boundary', async () => {
  const root = await createTempWorkspace('operational-work-isolation');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));
  const { result } = await service.createOperationalWork(context, request(project.id), grants);

  // Another tenant cannot see, cancel, or reuse the work.
  const stranger = otherTenant();
  assert.equal(await service.operationalWorkView(stranger, result.workId), null);
  assert.equal(await service.cancelOperationalWork(stranger, result.workId), null);
  assert.deepEqual(await service.listOperationalWork(stranger), []);
  await assert.rejects(
    () => service.createOperationalWork(stranger, request(project.id), grants),
    /project .* was not found/,
    'another tenant cannot request work against this project',
  );
  assert.equal((await domain.listOperationalWork(OTHER_TENANT)).length, 0, 'the refusal wrote nothing');

  // An environment from another project is not this project's environment.
  const other = await domain.createProject({ tenantId: TENANT, name: 'Other' });
  await assert.rejects(
    () => service.createOperationalWork(context, request(other.id, {
      idempotencyKey: 'cross-env', environment: environment.id, actions: [{ verb: 'verify' }],
    }), grants),
    /environment .* was not found/,
  );

  // A credential in a request is refused before anything durable is written.
  await assert.rejects(
    () => service.createOperationalWork(context, request(project.id, { idempotencyKey: 'leak', apiKey: 'fly-token' }), grants),
    OperationalWorkRequestError,
  );
  assert.equal((await domain.listOperationalWork(TENANT)).length, 1);
});

test('the contract travels over AppPort envelopes on the product API, and the UI shows the origin', async () => {
  const workingDirectory = await createTempWorkspace('operational-work-http');
  const { server } = await createHttpServer({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    repositoryRoot: await gitRepository(workingDirectory),
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    authenticator: authenticator(),
    authBoundryTenantId: TENANT,
    authBoundryControlPlane: controlPlane(),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown) => fetch(`${origin}/v1/operational-work`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    const project = await (await fetch(`${origin}/v1/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Checkout' }),
    })).json() as { id: string };
    await fetch(`${origin}/v1/projects/${project.id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'rkendel1', name: 'checkout' }),
    });

    // An AppPort request envelope, answered with an AppPort response envelope.
    const envelope = (requestId: string, input: unknown) => ({
      protocol: 'appport/1', type: 'request', requestId,
      capability: { name: OPERATIONAL_WORK_CAPABILITY, version: 1 }, input,
    });
    const accepted = await post(envelope('req-1', request(project.id)));
    assert.equal(accepted.status, 200);
    const response = await accepted.json() as { protocol: string; type: string; requestId: string; ok: boolean; output: OperationalWorkResult };
    assert.equal(response.protocol, 'appport/1');
    assert.equal(response.type, 'response');
    assert.equal(response.requestId, 'req-1');
    assert.equal(response.ok, true);
    assert.equal(response.output.status, 'completed');
    assert.deepEqual(response.output.origin, { system: 'attn', type: 'work', id: 'work_42' });

    // The same request again is the same work.
    const repeated = await (await post(envelope('req-2', request(project.id)))).json() as { output: OperationalWorkResult };
    assert.equal(repeated.output.workId, response.output.workId);

    // The contract's refusals come back as protocol errors, not internals.
    const development = await post(envelope('req-3', request(project.id, { actions: [{ verb: 'refactor' }] })));
    assert.equal(development.status, 400);
    const refusal = await development.json() as { ok: boolean; error: { code: string; message: string } };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, 'INVALID_INPUT');
    assert.match(refusal.error.message, /verb|enum|invalid/i);

    const authority = await post(envelope('req-4', request(project.id, { idempotencyKey: 'k2', approvedBy: 'attn' })));
    assert.equal(authority.status, 400);

    const wrong = await post({ ...envelope('req-5', request(project.id)), capability: { name: 'softwarefactory.repoecho', version: 1 } });
    assert.equal(wrong.status, 400);

    // A bare contract body speaks the same contract.
    const bare = await post(request(project.id, { idempotencyKey: 'bare-1' }));
    assert.equal(bare.status, 201);
    const bareResult = await bare.json() as OperationalWorkResult;
    assert.equal(bareResult.status, 'completed');
    assert.equal((await post(request(project.id, { idempotencyKey: 'bare-1' }))).status, 200);

    // Read routes.
    const fetched = await fetch(`${origin}/v1/operational-work/${response.output.workId}`);
    assert.equal(fetched.status, 200);
    assert.equal(((await fetched.json()) as OperationalWorkResult).workId, response.output.workId);
    const events = await (await fetch(`${origin}/v1/operational-work/${response.output.workId}/events`)).json() as { events: { type: string }[] };
    assert.deepEqual(events.events.map((event) => event.type), ['OperationalWorkAccepted', 'OperationalWorkPlanned', 'OperationalWorkCompleted']);
    assert.equal((await fetch(`${origin}/v1/operational-work/owk_missing`)).status, 404);
    const listed = await (await fetch(`${origin}/v1/operational-work`)).json() as { work: OperationalWorkResult[] };
    assert.equal(listed.work.length, 2);
    const cancel = await fetch(`${origin}/v1/operational-work/${response.output.workId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.equal(((await cancel.json()) as OperationalWorkResult).status, 'completed', 'finished work is not un-finished by cancel');

    // The product surface shows the origin without reading Attn.
    const list = await fetch(`${origin}/factory/work`);
    assert.equal(list.status, 200);
    assert.ok((await list.text()).includes('>Requested work</a>'));
    const page = await fetch(`${origin}/factory/work/${response.output.workId}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('never a source it reads'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.assign({}, ...value.map((entry, index) => flatten(entry, `${prefix}${index}.`)));
  }
  if (value && typeof value === 'object') {
    return Object.assign({}, ...Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => ({ [`${prefix}${key}`]: child, ...flatten(child, `${prefix}${key}.`) })));
  }
  return {};
}
