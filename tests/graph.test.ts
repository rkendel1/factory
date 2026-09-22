import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { orderPlan, GraphValidationError } from '../src/graph.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe, AuthenticatedContext } from '../src/auth.js';
import type { StructuredEvidence } from '../src/types.js';

const TENANT = 'tenant-a';
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

/** A probe whose answer changes between calls, as a real authority's can. */
function changing(answers: boolean[]): CapabilityProbe {
  let index = 0;
  return async (capability) => {
    const allowed = answers[Math.min(index, answers.length - 1)]!;
    index += 1;
    return { allowed, reason: allowed ? `AuthBoundry authorized ${capability}` : `AuthBoundry denied operation ${capability}` };
  };
}

async function gitRepository(root: string): Promise<string> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
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
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-graph');
  const service = await FactoryService.create({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    // PAX is deliberately absent, so a pax operation is a real execution failure.
    paxExecutable: path.join(workingDirectory, 'missing-pax'),
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
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'app' });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
  });
  return { service, context, domain, project, environment, workingDirectory };
}

/** Build → Test → Deploy, all as the native echo operation that really runs. */
const pipeline = [
  { key: 'build', type: 'repo-echo', intent: 'Build' },
  { key: 'test', type: 'repo-echo', intent: 'Test', dependsOn: ['build'] },
  { key: 'deploy', type: 'repo-echo', intent: 'Deploy', dependsOn: ['test'] },
];

test('a plan is ordered by its dependencies and refused when it cannot be', () => {
  const ordered = orderPlan([
    { key: 'deploy', type: 'repo-echo', dependsOn: ['build', 'contract'] },
    { key: 'contract', type: 'repo-echo' },
    { key: 'build', type: 'repo-echo' },
    { key: 'verify', type: 'repo-echo', dependsOn: ['deploy'] },
  ]).map((entry) => entry.key);
  assert.deepEqual(ordered, ['build', 'contract', 'deploy', 'verify']);

  assert.throws(() => orderPlan([]), GraphValidationError);
  assert.throws(() => orderPlan([{ key: 'a', type: 'x', dependsOn: ['missing'] }]), /not in this graph/);
  assert.throws(() => orderPlan([{ key: 'a', type: 'x', dependsOn: ['a'] }]), /depends on itself/);
  assert.throws(() => orderPlan([
    { key: 'a', type: 'x', dependsOn: ['b'] }, { key: 'b', type: 'x', dependsOn: ['a'] },
  ]), /dependency cycle/);
  assert.throws(() => orderPlan([{ key: 'a', type: 'x' }, { key: 'a', type: 'x' }]), /used twice/);
});

test('creating a graph writes durable graph, actions and dependencies', async () => {
  const root = await createTempWorkspace('graph-create');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));

  const { graph, actions } = await service.createActionGraph(context, {
    projectId: project.id, environmentId: environment.id,
    origin: { kind: 'external', sourceSystem: 'attn', sourceType: 'work', sourceId: 'work_42' },
    actions: pipeline,
  }, grants);

  assert.match(graph.id, /^graph_/);
  assert.equal(graph.status, 'ready', 'a graph with a runnable root is ready');
  assert.deepEqual(graph.origin, { kind: 'external', sourceSystem: 'attn', sourceType: 'work', sourceId: 'work_42' });
  assert.equal(graph.requestedBy, PRINCIPAL);
  assert.equal(actions.length, 3);
  const [build, testAction, deploy] = actions;
  assert.deepEqual(build!.dependsOn, []);
  assert.deepEqual(testAction!.dependsOn, [build!.id]);
  assert.deepEqual(deploy!.dependsOn, [testAction!.id]);
  assert.deepEqual(deploy!.relationships, [{ kind: 'depends_on', actionId: testAction!.id }]);
  for (const action of actions) assert.equal(action.graphId, graph.id);

  // Every node is a plain Action, readable through the existing model.
  assert.equal((await domain.getAction(TENANT, deploy!.id))?.status, 'planned');
  const view = (await service.graphView(context, graph.id))!;
  assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['ready', 'blocked', 'blocked']);

  await assert.rejects(
    () => service.createActionGraph(context, { projectId: project.id, actions: [{ type: 'not-an-operation' }] }),
    /no \.flow operation named/,
  );
});

test('the coordinator runs nodes in order, each through the one execution path, and is idempotent', async () => {
  const root = await createTempWorkspace('graph-run');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));
  const { graph } = await service.createActionGraph(context, {
    projectId: project.id, environmentId: environment.id, actions: pipeline,
  }, grants);

  const first = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(first.graph.status, 'completed');
  assert.ok(first.graph.startedAt && first.graph.completedAt);
  const runIds = first.actions.map((action) => action.runId);
  assert.equal(new Set(runIds).size, 3, 'each node has its own Run');
  for (const action of first.actions) {
    assert.equal(action.status, 'succeeded');
    assert.equal(action.outcome, 'succeeded');
    assert.equal(action.authority?.delegation, associationDelegationId(TENANT), 'each node was authorized on its own');
    const run = await domain.getRun(TENANT, action.runId!);
    assert.equal(run?.actionId, action.id);
    assert.equal(run?.status, 'completed');
  }

  // Coordinating again re-executes nothing.
  const second = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.deepEqual(second.actions.map((action) => action.runId), runIds, 'no node ran twice');
  assert.equal((await domain.listRuns(TENANT, project.id)).length, 3);
});

test('independent nodes become ready together and a shared dependent waits for both', async () => {
  const root = await createTempWorkspace('graph-parallel');
  const { service, context, project } = await scenario(await gitRepository(root));
  const { graph } = await service.createActionGraph(context, {
    projectId: project.id,
    actions: [
      { key: 'build', type: 'repo-echo' },
      { key: 'contract', type: 'repo-echo' },
      { key: 'deploy', type: 'repo-echo', dependsOn: ['build', 'contract'] },
    ],
  }, grants);
  const view = (await service.graphView(context, graph.id))!;
  assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['ready', 'ready', 'blocked']);

  const done = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(done.graph.status, 'completed');
});

test('a denied node waits for a person and blocks what depends on it; unavailable is distinct', async () => {
  const root = await createTempWorkspace('graph-denied');
  const { service, context, domain, project } = await scenario(await gitRepository(root));

  const denied = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, denies);
  const result = await service.coordinateGraph(context, denied.graph.id, { probe: denies, autonomous: true });
  assert.equal(result.graph.status, 'blocked');
  const [build, testAction] = result.actions;
  assert.equal(build!.status, 'awaiting-approval');
  assert.equal(build!.outcome, 'autonomy-denied');
  assert.equal(build!.runId, undefined, 'nothing ran');
  const view = (await service.graphView(context, denied.graph.id))!;
  assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['awaiting-approval', 'blocked', 'blocked']);
  assert.equal(testAction!.runId, undefined);

  // A person approving the root lets the graph continue through the same path.
  await service.runAction(context, build!.id, { probe: denies });
  const resumed = await service.coordinateGraph(context, denied.graph.id, { probe: grants, autonomous: true });
  assert.equal(resumed.graph.status, 'completed');
  assert.equal((await domain.getAction(TENANT, build!.id))?.approvedBy, PRINCIPAL);

  const offline = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, unavailable);
  const stopped = await service.coordinateGraph(context, offline.graph.id, { probe: unavailable, autonomous: true });
  assert.equal(stopped.actions[0]!.outcome, 'authority-unavailable');
  assert.notEqual(stopped.actions[0]!.outcome, build!.outcome, 'unavailable is not flattened into denied');
});

test('each node is authorized separately, so a grant revoked mid-graph stops later nodes', async () => {
  const root = await createTempWorkspace('graph-revoked');
  const { service, context, project } = await scenario(await gitRepository(root));
  const { graph } = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, grants);

  // Planning asked three times (granted). Coordination asks again per node:
  // build yes, test no.
  const result = await service.coordinateGraph(context, graph.id, { probe: changing([true, false]), autonomous: true });
  assert.equal(result.actions[0]!.status, 'succeeded');
  assert.equal(result.actions[1]!.status, 'awaiting-approval', 'the second node respected the new decision');
  assert.equal(result.actions[2]!.runId, undefined);
  assert.equal(result.graph.status, 'blocked');
});

test('an execution failure blocks dependents, is reported as such, and survives a restart', async () => {
  const root = await createTempWorkspace('graph-failure');
  const repositoryRoot = await gitRepository(root);
  const { service, context, project, workingDirectory } = await scenario(repositoryRoot);
  const { graph } = await service.createActionGraph(context, {
    projectId: project.id,
    actions: [
      // architecture-conformance needs PAX, which this Factory does not have.
      { key: 'conformance', type: 'architecture-conformance' },
      { key: 'deploy', type: 'repo-echo', dependsOn: ['conformance'] },
      { key: 'verify', type: 'repo-echo', dependsOn: ['deploy'] },
    ],
  }, grants);

  const result = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(result.graph.status, 'failed');
  assert.equal(result.graph.failure?.actionId, result.actions[0]!.id);
  assert.equal(result.graph.failure?.outcome, 'execution-failed');
  assert.equal(result.actions[0]!.status, 'failed');
  assert.equal(result.actions[0]!.outcome, 'execution-failed');
  assert.ok(result.actions[0]!.runId, 'the failed attempt left a Run');
  assert.deepEqual(result.actions[1]!.blockedBy, [result.actions[0]!.id], 'the dependent knows why it is blocked');
  assert.equal(result.actions[1]!.status, 'planned', 'a blocked node did not fail; it never ran');
  assert.equal(result.actions[2]!.runId, undefined);
  await service.shutdown();

  // Another process reads the same failure from FeltDB.
  const restarted = await factory(repositoryRoot, { workingDirectory });
  await restarted.service.refreshConnection();
  const view = (await restarted.service.graphView(context, graph.id))!;
  assert.equal(view.status, 'failed');
  assert.equal((view.failure as { outcome: string }).outcome, 'execution-failed');
  assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['failed', 'blocked', 'blocked']);
  // Coordinating again changes nothing: failed stays failed until retried.
  const again = await restarted.service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(again.graph.status, 'failed');
  assert.equal(again.actions[0]!.runId, result.actions[0]!.runId);
  await restarted.service.shutdown();
});

test('a verification failure is reported apart from an execution failure and blocks dependents', async () => {
  const root = await createTempWorkspace('graph-verification');
  const { service, context, domain, project } = await scenario(await gitRepository(root));
  const { graph, actions } = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, grants);

  // Record the outcome the run path produces when execution completes but a
  // check does not pass; the coordinator's job is to represent and block on it.
  await domain.patchAction(TENANT, actions[0]!.id, {
    status: 'failed', outcome: 'verification-failed', runId: 'run_prior',
    verification: [{ name: 'health endpoint returns 200', status: 'failed', detail: 'HTTP 503' }],
  });
  const result = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(result.graph.status, 'failed');
  assert.equal(result.graph.failure?.outcome, 'verification-failed');
  assert.equal(result.graph.failure?.reason, 'HTTP 503');
  assert.deepEqual(result.actions[1]!.blockedBy, [actions[0]!.id]);
});

test('a retry admits a new Run and keeps the earlier one as history', async () => {
  const root = await createTempWorkspace('graph-retry');
  const { service, context, domain, project } = await scenario(await gitRepository(root));
  const { graph, actions } = await service.createActionGraph(context, {
    projectId: project.id,
    actions: [{ key: 'a', type: 'repo-echo' }, { key: 'b', type: 'repo-echo', dependsOn: ['a'] }],
  }, grants);

  // A prior attempt that really ran and failed.
  const failed = await domain.patchAction(TENANT, actions[0]!.id, {
    status: 'failed', outcome: 'execution-failed', runId: 'run_first', verification: [],
  });
  await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  await assert.rejects(() => service.retryAction(context, actions[1]!.id), /only a failed action/);

  const retried = await service.retryAction(context, failed!.id);
  assert.equal(retried.status, 'planned');
  assert.equal(retried.retries, 1);
  assert.deepEqual(retried.previousRunIds, ['run_first'], 'history is kept, not mutated');
  assert.equal(retried.runId, undefined);

  const done = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(done.graph.status, 'completed');
  assert.notEqual(done.actions[0]!.runId, 'run_first', 'the retry produced a new Run');
  assert.deepEqual(done.actions[0]!.previousRunIds, ['run_first']);
});

test('the graph → action → run → evidence chain is complete', async () => {
  const root = await createTempWorkspace('graph-evidence');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));
  const { graph } = await service.createActionGraph(context, {
    projectId: project.id, environmentId: environment.id, actions: pipeline,
  }, grants);
  const { actions } = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;

  for (const action of actions) {
    assert.equal(action.graphId, graph.id);
    assert.ok(action.authority?.authorizationDecisionId, 'the authorization decision is on the Action');
    const run = (await domain.getRun(TENANT, action.runId!))!;
    assert.equal(run.actionId, action.id);
    assert.equal(run.delegationId, associationDelegationId(TENANT));
    const evidence = (await db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(run.id))!;
    assert.equal(evidence.authorizationDecisionId, action.authority!.authorizationDecisionId);
    assert.equal(evidence.authorizedApplication?.delegationId, associationDelegationId(TENANT));
    assert.equal(evidence.finalResult, 'PASS');
  }
  // There is one evidence record per Run and no graph-level evidence store.
  assert.equal((await db.collection(COLLECTIONS.evidence).all()).length, 3);
});

test('reconciliation plans a one-node graph and repeats do not add another', async () => {
  const root = await createTempWorkspace('graph-reconcile');
  const repositoryRoot = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repositoryRoot);

  // Converge once so the next commit is real drift.
  const first = await service.createAction(context, project.id, { type: 'repo-echo', environmentId: environment.id }, grants);
  await service.runAction(context, first.id, { probe: grants, autonomous: true });
  execFileSync('sh', ['-c', `echo '# change' >> ${repositoryRoot}/package.json`]);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qam', 'change'], { cwd: repositoryRoot });

  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  assert.equal(outcome.result, 'autonomy-denied');
  assert.ok(outcome.graphId, 'reconciliation created a graph');
  const graph = (await domain.getGraph(TENANT, outcome.graphId!))!;
  assert.equal(graph.origin.kind, 'continuous-reconciliation');
  assert.equal(graph.reconciliationFingerprint, outcome.fingerprint);
  assert.equal((await domain.graphActions(TENANT, graph.id)).length, 1, 'one node');

  const repeat = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  assert.equal(repeat.graphId, outcome.graphId, 'unchanged drift reuses the graph');
  assert.equal((await domain.listGraphs(TENANT, project.id)).length, 1);

  // A person closes that drift; the graph it belonged to completes.
  await service.runAction(context, outcome.actionId!, { probe: denies });
  assert.equal((await domain.getGraph(TENANT, outcome.graphId!))?.status, 'blocked', 'the graph is not re-derived until coordinated');
  await service.coordinateGraph(context, outcome.graphId!, { probe: grants, autonomous: true });
  assert.equal((await domain.getGraph(TENANT, outcome.graphId!))?.status, 'completed');

  // New drift, granted: the one-node graph completes exactly as the lone Action did.
  execFileSync('sh', ['-c', `echo '# more' >> ${repositoryRoot}/package.json`]);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qam', 'more'], { cwd: repositoryRoot });
  const executed = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  assert.equal(executed.result, 'executed');
  assert.equal((await domain.getGraph(TENANT, executed.graphId!))?.status, 'completed');
});

test('graphs are isolated by tenant, project and environment', async () => {
  const root = await createTempWorkspace('graph-isolation');
  const { service, context, domain, project, environment } = await scenario(await gitRepository(root));
  const { graph } = await service.createActionGraph(context, {
    projectId: project.id, environmentId: environment.id, actions: [{ type: 'repo-echo' }],
  }, grants);
  const other = await domain.createProject({ tenantId: TENANT, name: 'Other' });
  await service.createActionGraph(context, { projectId: other.id, actions: [{ type: 'repo-echo' }] }, grants);

  assert.equal((await domain.listGraphs(TENANT)).length, 2);
  assert.equal((await domain.listGraphs(TENANT, project.id)).length, 1);
  assert.equal(await domain.getGraph('tenant-b', graph.id), null, 'another tenant cannot read it by id');
  assert.deepEqual(await domain.listGraphs('tenant-b'), []);
  assert.equal((await domain.getGraph(TENANT, graph.id))?.environmentId, environment.id);
  await assert.rejects(
    () => service.createActionGraph(context, { projectId: project.id, environmentId: 'env_elsewhere', actions: [{ type: 'repo-echo' }] }),
    /environment env_elsewhere was not found/,
  );
});

test('a partially completed graph resumes from FeltDB after a restart', async () => {
  const root = await createTempWorkspace('graph-restart');
  const repositoryRoot = await gitRepository(root);
  const { service, context, project, workingDirectory } = await scenario(repositoryRoot);
  const { graph, actions } = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, grants);

  // Run only the first node, then stop the process.
  await service.runAction(context, actions[0]!.id, { probe: grants, autonomous: true });
  await service.shutdown();

  const restarted = await factory(repositoryRoot, { workingDirectory });
  await restarted.service.refreshConnection();
  const before = (await restarted.service.graphView(context, graph.id))!;
  assert.deepEqual((before.nodes as { status: string }[]).map((node) => node.status), ['completed', 'ready', 'blocked']);

  const done = await restarted.service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(done.graph.status, 'completed');
  assert.equal(done.actions[0]!.runId, actions[0]!.runId ?? done.actions[0]!.runId);
  const firstRun = (await restarted.service.projects().getAction(TENANT, actions[0]!.id))!.runId;
  assert.equal(done.actions[0]!.runId, firstRun, 'the node that finished before the restart was not re-run');
  await restarted.service.shutdown();
});

test('cancelling stops coordination and keeps what already happened', async () => {
  const root = await createTempWorkspace('graph-cancel');
  const { service, context, project } = await scenario(await gitRepository(root));
  const { graph, actions } = await service.createActionGraph(context, { projectId: project.id, actions: pipeline }, grants);
  await service.runAction(context, actions[0]!.id, { probe: grants, autonomous: true });

  const cancelled = await service.cancelActionGraph(context, graph.id);
  assert.equal(cancelled.status, 'cancelled');
  const view = (await service.graphView(context, graph.id))!;
  assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['completed', 'cancelled', 'cancelled']);
  const after = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
  assert.equal(after.graph.status, 'cancelled');
  assert.equal(after.actions[1]!.runId, undefined, 'nothing ran after cancellation');
});
