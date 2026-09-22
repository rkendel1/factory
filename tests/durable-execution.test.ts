import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { OPERATIONAL_WORK_CONTRACT } from '../src/operational-work.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import type { ActionRecord, ExecutionCheckpoint, ExecutionHooks, RunRecord, StructuredEvidence } from '../src/types.js';

/*
 * Durable execution recovery and uncertain outcomes.
 *
 * Process failure is injected through the execution checkpoint hooks: a
 * checkpoint "freezes" (its promise never resolves) and the worker is then
 * shut down, which is what a crashed process looks like to the durable state
 * — a Run at that exact point, with a lease that stops being renewed. A
 * second worker on the same FeltDB then recovers. Nothing in production
 * depends on the hooks; production configures none.
 */

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';
const VALID_TOKEN = 'fly-token-valid-0123456789';
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

async function gitRepository(root: string, files: Record<string, string> = {}): Promise<{ path: string; head: string }> {
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
  }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return { path: repositoryPath, head: git('rev-parse', 'HEAD') };
}

function fakeFly(root: string) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const modeFile = path.join(root, 'fly-mode');
  const logFile = path.join(root, 'fly-invocations.log');
  writeFileSync(path.join(bin, 'fly'), `#!/bin/sh
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
echo "$1 app=$FLY_APP" >> "${logFile}"
if [ "$FLY_API_TOKEN" != "${VALID_TOKEN}" ]; then echo "Error: unauthorized" >&2; exit 1; fi
case "$mode" in
  hang) sleep 30; exit 0;;
esac
case "$1" in
  deploy) echo "--> release v7 created"; exit 0;;
  status) printf '{"Name":"%s","Status":"running","Hostname":"%s.fly.dev","Version":7,"ID":"app_123"}\\n' "$FLY_APP" "$FLY_APP"; exit 0;;
esac
exit 0
`);
  chmodSync(path.join(bin, 'fly'), 0o755);
  return {
    bin,
    setMode(mode: string) { writeFileSync(modeFile, mode); },
    invocations(): string[] { return existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []; },
  };
}

async function healthServer(status = 200) {
  let current = status;
  const server = createServer((_request, response) => { response.statusCode = current; response.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/health`,
    set(next: number) { current = next; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A checkpoint gate. `freeze(point)` makes that checkpoint never resolve for
 * the matching Action (or any); `throwAt(point)` makes it fail. `reached`
 * records every checkpoint the worker passed, in order.
 */
function gate(): ExecutionHooks & { reached: string[]; freeze(point: ExecutionCheckpoint, actionId?: string): Promise<void>; throwAt(point: ExecutionCheckpoint): void; clear(): void } {
  let frozen: { point: ExecutionCheckpoint; actionId?: string; hit: () => void } | null = null;
  let throwing: ExecutionCheckpoint | null = null;
  const reached: string[] = [];
  return {
    reached,
    freeze(point, actionId) {
      return new Promise<void>((resolve) => { frozen = { point, actionId, hit: resolve }; });
    },
    throwAt(point) { throwing = point; },
    clear() { frozen = null; throwing = null; },
    async checkpoint(point, detail) {
      reached.push(`${point}${detail.actionId ? `@${detail.actionId}` : ''}`);
      if (throwing === point) { throwing = null; throw new Error(`simulated failure at ${point}`); }
      if (frozen && frozen.point === point && (!frozen.actionId || frozen.actionId === detail.actionId)) {
        frozen.hit();
        frozen = null;
        await new Promise<never>(() => { /* the process stops here */ });
      }
    },
  };
}

interface Options { workingDirectory?: string; hooks?: ExecutionHooks; workerId?: string; leaseMs?: number; flowPath?: string; token?: string | null }

async function worker(repositoryRoot: string, options: Options = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-durable');
  const service = await FactoryService.create({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: options.flowPath ?? path.resolve(process.cwd(), '.flow'),
    repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    authenticator: authenticator(),
    authBoundryTenantId: TENANT,
    authBoundryControlPlane: controlPlane(),
    credentialResolver: (name) => name === 'FLY_API_TOKEN' ? (options.token === undefined ? VALID_TOKEN : options.token ?? undefined) : undefined,
    ...(options.hooks ? { executionHooks: options.hooks } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    executionLeaseMs: options.leaseMs ?? 1000,
  });
  await service.refreshConnection();
  return { service, workingDirectory };
}

async function scenario(repositoryRoot: string, options: Options & { configuration?: Record<string, unknown> } = {}) {
  const { service, workingDirectory } = await worker(repositoryRoot, options);
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout' });
  const environment = await domain.createEnvironment(TENANT, project.id, {
    name: 'production', provider: 'fly', ...(options.configuration ? { configuration: options.configuration } : {}),
  });
  await domain.putDesiredState(TENANT, project.id, { sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: true, targetProvider: 'fly' });
  return { service, context, domain, project, repository, environment, workingDirectory };
}

async function withFakeFly<T>(root: string, body: (fly: ReturnType<typeof fakeFly>) => Promise<T>): Promise<T> {
  const fly = fakeFly(root);
  const previous = process.env.PATH;
  process.env.PATH = `${fly.bin}${path.delimiter}${previous ?? ''}`;
  try { return await body(fly); } finally { process.env.PATH = previous; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function db(service: FactoryService) { return (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db; }
async function evidenceOf(service: FactoryService, runId: string): Promise<StructuredEvidence | null> {
  return db(service).collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
}

/** Start an Action on a worker whose hooks freeze at `point`, then "crash" the worker. */
async function crashAt(point: ExecutionCheckpoint, options: { repositoryRoot: string; configuration?: Record<string, unknown>; capability?: string }) {
  const hooks = gate();
  const setup = await scenario(options.repositoryRoot, { hooks, workerId: 'worker-a', leaseMs: 1500, configuration: options.configuration });
  const action = await setup.service.createAction(setup.context, setup.project.id, {
    capability: options.capability ?? 'deployment.create', environmentId: setup.environment.id,
  }, grants);
  const frozen = hooks.freeze(point, action.id);
  const running = setup.service.runAction(setup.context, action.id, { probe: grants, autonomous: true });
  running.catch(() => { /* abandoned with the crashed worker */ });
  await frozen;
  await setup.service.shutdown();
  await sleep(1700); // the crashed worker's lease lapses
  const restarted = await worker(options.repositoryRoot, { workingDirectory: setup.workingDirectory, workerId: 'worker-b', leaseMs: 1500 });
  return { ...setup, hooks, action, restarted: restarted.service };
}

test('ownership: one live worker owns a Run, a live lease refuses another, an expired lease is reclaimed with the attempt advanced', async () => {
  const root = await createTempWorkspace('durable-ownership');
  const repository = await gitRepository(root);
  await withFakeFly(root, async (fly) => {
    const hooks = gate();
    const a = await scenario(repository.path, { hooks, workerId: 'worker-a', leaseMs: 4000 });
    const action = await a.service.createAction(a.context, a.project.id, { capability: 'deployment.create', environmentId: a.environment.id }, grants);
    const frozen = hooks.freeze('after-ownership', action.id);
    const running = a.service.runAction(a.context, action.id, { probe: grants, autonomous: true });
    running.catch(() => {});
    await frozen;
    const runId = (await a.domain.getAction(TENANT, action.id))!.runId!;
    const owned = (await a.domain.getRun(TENANT, runId))!;
    assert.equal(owned.executionOwner, 'worker-a');
    assert.equal(owned.attempt, 1);
    assert.ok(owned.leaseExpiresAt && Date.parse(owned.leaseExpiresAt) > Date.now(), 'the lease is live');

    // Worker B cannot take a live lease, and running the Action on B does nothing.
    const b = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-b', leaseMs: 4000 });
    assert.equal(await b.service.acquireRunOwnership(runId), null, 'a live lease refuses another worker');
    assert.equal((await b.service.runAction(a.context, action.id, { probe: grants, autonomous: true })).status, 'running', 'the Action is in flight elsewhere');
    assert.deepEqual(fly.invocations(), [], 'nothing was executed twice or at all');

    // Worker A stops heartbeating; after expiry B reclaims with the attempt advanced.
    await a.service.shutdown();
    await sleep(4200);
    const reclaimed = await b.service.acquireRunOwnership(runId);
    assert.equal(reclaimed?.executionOwner, 'worker-b');
    assert.equal(reclaimed?.attempt, 2, 'reclaiming is a new attempt on the same Run');
    // Reclaiming did not execute anything: the record decides what may happen next.
    assert.deepEqual(fly.invocations(), []);
    await b.service.shutdown();
  });
});

test('ownership: heartbeat keeps a lease live while the worker works', async () => {
  const root = await createTempWorkspace('durable-heartbeat');
  const repository = await gitRepository(root);
  await withFakeFly(root, async (fly) => {
    fly.setMode('hang');
    const a = await scenario(repository.path, { workerId: 'worker-a', leaseMs: 1500 });
    const action = await a.service.createAction(a.context, a.project.id, { capability: 'deployment.create', environmentId: a.environment.id }, grants);
    const running = a.service.runAction(a.context, action.id, { probe: grants, autonomous: true });
    let run: RunRecord | null = null;
    for (let i = 0; i < 100 && run?.status !== 'executing'; i += 1) {
      await sleep(50);
      const current = await a.domain.getAction(TENANT, action.id);
      run = current?.runId ? await a.domain.getRun(TENANT, current.runId) : null;
    }
    assert.equal(run?.status, 'executing');
    const firstHeartbeat = run!.heartbeatAt!;
    await sleep(2000);
    const later = (await a.domain.getRun(TENANT, run!.id))!;
    assert.ok(Date.parse(later.heartbeatAt!) > Date.parse(firstHeartbeat), 'the heartbeat advanced');
    assert.ok(Date.parse(later.leaseExpiresAt!) > Date.now(), 'the lease stayed live past its original expiry');
    const b = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-b', leaseMs: 1500 });
    assert.equal(await b.service.acquireRunOwnership(run!.id), null, 'a heartbeating lease is not reclaimable');
    await a.service.cancelAction(a.context, action.id);
    const done = await running;
    assert.equal(done.outcome, 'cancelled');
    assert.equal(done.cancellation?.stage, 'after-external-submission');
    assert.equal(done.cancellation?.effect, 'submitted', 'cancelling a submitted external operation does not claim to reverse it');
    const released = (await a.domain.getRun(TENANT, run!.id))!;
    assert.equal(released.leaseExpiresAt, undefined, 'a finished Run holds no lease');
    assert.ok(released.finishedAt);
    await b.service.shutdown();
    await a.service.shutdown();
  });
});

test('crash before invocation: the Run is failed and known, nothing reached the provider, the Action says interrupted', async () => {
  const root = await createTempWorkspace('durable-before');
  const repository = await gitRepository(root);
  await withFakeFly(root, async (fly) => {
    const { action, restarted, domain, hooks } = await crashAt('before-invocation', { repositoryRoot: repository.path });
    assert.ok(hooks.reached.some((point) => point.startsWith('after-ownership')));
    const recovered = (await domain.getAction(TENANT, action.id))!;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.outcome, 'execution-failed');
    assert.equal(recovered.failure?.phase, 'interrupted');
    const run = (await domain.getRun(TENANT, recovered.runId!))!;
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /restarted/);
    assert.deepEqual(fly.invocations(), [], 'the provider was never invoked');
    // Not replayed on restart, not replayed on request.
    assert.equal((await restarted.runAction((await restarted.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read')), action.id, { probe: grants, autonomous: true })).status, 'failed');
    assert.deepEqual(fly.invocations(), []);
    await restarted.shutdown();
  });
});

test('crash after invocation with the result lost: unknown, never failed; reality resolves it; a repeat is never blind', async () => {
  const root = await createTempWorkspace('durable-unknown');
  const repository = await gitRepository(root);
  const health = await healthServer(503);
  try {
    await withFakeFly(root, async (fly) => {
      const { action, restarted, domain, context } = await crashAt('after-result-before-persistence', {
        repositoryRoot: repository.path, configuration: { healthUrl: health.url },
      });
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'the provider acted exactly once');
      const recovered = (await domain.getAction(TENANT, action.id))!;
      assert.equal(recovered.status, 'unknown');
      assert.equal(recovered.outcome, 'unknown');
      assert.notEqual(recovered.outcome, 'execution-failed');
      const run = (await domain.getRun(TENANT, recovered.runId!))!;
      assert.equal(run.status, 'unknown');
      assert.equal(run.uncertainty?.invocationMayHaveOccurred, true);
      assert.equal(run.uncertainty?.retrySafe, false, 'fly deploy is not exactly-once, so a repeat is not known to be safe');
      const evidence = (await evidenceOf(restarted, run.id))!;
      assert.equal(evidence.status, 'unknown');
      assert.equal(evidence.finalResult, 'UNKNOWN');
      assert.doesNotMatch(JSON.stringify([run, evidence, recovered]), new RegExp(VALID_TOKEN));

      // Reality cannot resolve it yet: it stays unknown, is observed, and is not retried.
      const undetermined = await restarted.resolveUncertainAction(context, action.id);
      assert.equal(undetermined.status, 'unknown');
      assert.equal((await domain.getRun(TENANT, run.id))!.uncertainty?.observations.at(-1)?.outcome, 'undetermined');
      assert.equal((await restarted.runAction(context, action.id, { probe: grants, autonomous: true })).status, 'unknown', 'not re-run');
      await assert.rejects(() => restarted.retryAction(context, action.id), /not known to be safe/);
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // Reality resolves it: the environment is serving and healthy.
      health.set(200);
      const resolved = await restarted.resolveUncertainAction(context, action.id);
      assert.equal(resolved.status, 'succeeded');
      assert.equal(resolved.outcome, 'succeeded');
      assert.ok(resolved.verification?.some((check) => check.name === 'outcome resolved by observation' && check.status === 'passed'));
      const finalRun = (await domain.getRun(TENANT, run.id))!;
      assert.equal(finalRun.status, 'completed');
      assert.equal(finalRun.uncertainty?.resolvedBy, 'observation');
      assert.equal((await evidenceOf(restarted, run.id))!.resolution?.resolution, 'succeeded');
      assert.equal((await domain.getEnvironment(TENANT, recovered.projectId, recovered.environmentId!))!.currentState?.health, 'healthy');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'resolution never re-deployed');
      await restarted.shutdown();
    });
  } finally {
    await health.close();
  }
});

test('a provider result that cannot be persisted leaves the Run unknown, not failed', async () => {
  const root = await createTempWorkspace('durable-persist');
  const repository = await gitRepository(root);
  await withFakeFly(root, async (fly) => {
    const hooks = gate();
    const { service, context, project, environment, domain } = await scenario(repository.path, { hooks, workerId: 'worker-a' });
    const action = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
    hooks.throwAt('after-result-before-persistence');
    const ran = await service.runAction(context, action.id, { probe: grants, autonomous: true });
    assert.equal(ran.status, 'unknown');
    assert.equal(ran.outcome, 'unknown');
    const run = (await domain.getRun(TENANT, ran.runId!))!;
    assert.equal(run.status, 'unknown');
    assert.match(run.uncertainty?.reason ?? '', /result could not be recorded/);
    assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
    await service.shutdown();
  });
});

test('crash during verification and after success: verification resumes from evidence; a finished Run is never replayed', async () => {
  const root = await createTempWorkspace('durable-verify');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      for (const point of ['after-persistence-before-verification', 'after-verification-before-completion', 'after-evidence'] as const) {
        const { action, restarted, domain, context } = await crashAt(point, { repositoryRoot: repository.path, configuration: { healthUrl: health.url } });
        const recovered = (await domain.getAction(TENANT, action.id))!;
        assert.equal(recovered.status, 'succeeded', `${point}: ${JSON.stringify(recovered.failure)}`);
        assert.ok(recovered.verification?.some((check) => check.name === 'environment responds healthy' && check.status === 'passed'), point);
        const run = (await domain.getRun(TENANT, recovered.runId!))!;
        assert.equal(run.status, 'completed');
        assert.equal((await evidenceOf(restarted, run.id))?.chain?.actionId, action.id);
        assert.equal((await restarted.runAction(context, action.id, { probe: grants, autonomous: true })).runId, run.id, 'not replayed');
        await restarted.shutdown();
      }
      assert.equal(fly.invocations().length, 3, 'one invocation per Action across three crash points');
    });
  } finally {
    await health.close();
  }
});

test('graph: an unknown node blocks dependents, resolves through observation, and a restart resumes the graph', async () => {
  const root = await createTempWorkspace('durable-graph');
  const repository = await gitRepository(root);
  const health = await healthServer(503);
  try {
    await withFakeFly(root, async (fly) => {
      const hooks = gate();
      const a = await scenario(repository.path, { hooks, workerId: 'worker-a', leaseMs: 1500, configuration: { healthUrl: health.url } });
      const { graph, actions } = await a.service.createActionGraph(a.context, {
        projectId: a.project.id, environmentId: a.environment.id,
        actions: [
          { key: 'build', capability: 'build.run', type: 'build.run' },
          { key: 'deploy', capability: 'deployment.create', type: 'deployment.create', dependsOn: ['build'] },
          { key: 'health', capability: 'environment.health', type: 'environment.health', dependsOn: ['deploy'] },
        ],
      }, grants);
      const [build, deploy, probe] = actions;
      const frozen = hooks.freeze('after-result-before-persistence', deploy!.id);
      const coordinating = a.service.coordinateGraph(a.context, graph.id, { probe: grants, autonomous: true });
      coordinating.catch(() => {});
      await frozen;
      await a.service.shutdown();
      await sleep(1700);

      const b = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-b', leaseMs: 1500 });
      const context = await b.service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
      const view = (await b.service.graphView(context, graph.id))!;
      assert.deepEqual((view.nodes as { status: string }[]).map((node) => node.status), ['completed', 'unknown', 'blocked']);
      assert.equal(view.status, 'unresolved');
      assert.match((view.nodes as { reason: string }[])[1]!.reason, /uncertain/);

      // Coordinating asks reality about the unknown node and runs nothing else.
      const stillUnknown = await b.service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
      assert.equal(stillUnknown.graph.status, 'unresolved');
      assert.equal(stillUnknown.actions[0]!.runId, build!.runId ?? stillUnknown.actions[0]!.runId, 'completed build is never executed again');
      assert.equal(stillUnknown.actions[2]!.runId, undefined, 'health did not run while deploy is unknown');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // Reality resolves the deploy; dependents proceed; the provider is not re-invoked.
      health.set(200);
      const resumed = await b.service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
      assert.equal(resumed.graph.status, 'completed', JSON.stringify(resumed.actions.map((action) => [action.type, action.status, action.failure])));
      assert.equal(resumed.actions[1]!.status, 'succeeded');
      assert.equal(resumed.actions[2]!.status, 'succeeded');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      assert.equal(probe!.id, resumed.actions[2]!.id);
      await b.service.shutdown();
    });
  } finally {
    await health.close();
  }
});

test('operational work reports unresolved, not failed, while a step is unknown', async () => {
  const root = await createTempWorkspace('durable-work');
  const repository = await gitRepository(root);
  await withFakeFly(root, async () => {
    const hooks = gate();
    const { service, context, project, environment, domain } = await scenario(repository.path, { hooks, workerId: 'worker-a' });
    hooks.throwAt('after-result-before-persistence');
    const { result } = await service.createOperationalWork(context, {
      contract: OPERATIONAL_WORK_CONTRACT, origin: { system: 'attn', type: 'work', id: 'work_9' }, idempotencyKey: 'k9',
      project: project.id, environment: environment.id, actions: [{ verb: 'inspect', target: 'environment' }],
    }, grants);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.actions[0]!.status, 'unknown');
    const events = await domain.listOperationalWorkEvents(TENANT, result.workId);
    assert.equal(events.at(-1)?.type, 'OperationalWorkUnresolved');
    // A read-only inspection is safe to repeat: resolution returns it to planned and the next pass runs it.
    const resolved = await service.resolveUncertainAction(context, result.actions[0]!.actionId);
    assert.equal(resolved.status, 'planned');
    const again = await service.createOperationalWork(context, {
      contract: OPERATIONAL_WORK_CONTRACT, origin: { system: 'attn', type: 'work', id: 'work_9' }, idempotencyKey: 'k9',
      project: project.id, environment: environment.id, actions: [{ verb: 'inspect', target: 'environment' }],
    }, grants);
    assert.equal(again.result.status, 'completed');
    await service.shutdown();
  });
});

test('cancellation records what was cancelled at each stage and never implies an effect was reversed', async () => {
  const root = await createTempWorkspace('durable-cancel');
  const repository = await gitRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e "setTimeout(()=>{},30000)"', test: 'node -e 0' } }),
  });
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      const hooks = gate();
      const { service, context, project, environment, domain } = await scenario(repository.path, { hooks, workerId: 'worker-a', configuration: { healthUrl: health.url } });

      // Before execution.
      const planned = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const before = await service.cancelAction(context, planned.id);
      assert.equal(before.cancellation?.stage, 'before-invocation');
      assert.equal(before.cancellation?.effect, 'not-started');

      // During local (native) execution: the process is stopped; nothing external.
      const build = await service.createAction(context, project.id, { capability: 'build.run' }, grants);
      const building = service.runAction(context, build.id, { probe: grants, autonomous: true });
      for (let i = 0; i < 100; i += 1) {
        const current = await domain.getAction(TENANT, build.id);
        const run = current?.runId ? await domain.getRun(TENANT, current.runId) : null;
        if (run?.status === 'executing') break;
        await sleep(50);
      }
      await sleep(200);
      await service.cancelAction(context, build.id);
      const stopped = await building;
      assert.equal(stopped.outcome, 'cancelled');
      assert.equal(stopped.cancellation?.stage, 'native-execution');
      assert.equal(stopped.cancellation?.effect, 'stopped');
      assert.equal(stopped.execution?.terminationReason, 'cancelled');

      // During verification: the external operation stands; only verification was still running.
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const frozen = hooks.freeze('after-verification-before-completion', deploy.id);
      const deploying = service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      await frozen;
      const during = await service.cancelAction(context, deploy.id);
      assert.equal(during.cancellation?.stage, 'during-verification');
      assert.equal(during.cancellation?.effect, 'submitted');
      hooks.clear();
      // The frozen worker never returns; the durable state is what matters.
      deploying.catch(() => {});
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      const run = (await domain.getRun(TENANT, (await domain.getAction(TENANT, deploy.id))!.runId!))!;
      assert.equal(run.status, 'completed', 'a completed external operation is not un-done by cancelling verification');
      await service.shutdown();
    });
  } finally {
    await health.close();
  }
});

test('evidence reconstructs the whole chain from operational work to observed reality, without credentials', async () => {
  const root = await createTempWorkspace('durable-chain');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async () => {
      const { service, context, project, environment, domain } = await scenario(repository.path, { workerId: 'worker-chain', configuration: { healthUrl: health.url } });
      const { result } = await service.createOperationalWork(context, {
        contract: OPERATIONAL_WORK_CONTRACT, origin: { system: 'attn', type: 'work', id: 'work_77' }, idempotencyKey: 'chain-1',
        project: project.id, environment: environment.id, actions: [{ verb: 'deploy' }],
      }, grants);
      assert.equal(result.status, 'completed', JSON.stringify(result.actions));
      const deployNode = result.actions.find((node) => node.capability === 'deployment.create')!;
      const evidence = (await evidenceOf(service, deployNode.runId!))!;
      const chain = evidence.chain!;
      assert.equal(chain.operationalWorkId, result.workId);
      assert.equal(chain.graphId, result.graphId);
      assert.equal(chain.actionId, deployNode.actionId);
      assert.equal(chain.runId, deployNode.runId);
      assert.equal(chain.attempt, 1);
      assert.equal(chain.executionOwner, 'worker-chain');
      assert.ok(chain.authorizationDecisionId);
      assert.equal(chain.provider, 'fly');
      assert.equal(chain.capability, 'deployment.create');
      assert.equal(chain.resource, 'environment:production');
      assert.equal(chain.providerResource, 'fly:app:checkout-app');
      assert.equal(chain.idempotencyKey, deployNode.actionId);
      assert.equal(chain.providerOperationId, 'v7');
      assert.ok(chain.verification.some((check) => check.name === 'environment responds healthy' && check.status === 'passed'));
      assert.equal(chain.observedReality?.health, 'healthy');
      assert.equal(chain.observedReality?.sourceCommit, repository.head);
      const run = (await domain.getRun(TENANT, deployNode.runId!))!;
      assert.equal(run.providerOperationId, 'v7');
      assert.doesNotMatch(JSON.stringify([evidence, run, result]), new RegExp(VALID_TOKEN));
      await service.shutdown();
    });
  } finally {
    await health.close();
  }
});
