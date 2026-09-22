import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { createReconciliationScheduler } from '../src/scheduler.js';
import { compareReality } from '../src/reality.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import type { EnvironmentRecord, ExecutionHooks, ExecutionCheckpoint } from '../src/types.js';

/*
 * The operational control loop against a controlled real resource.
 *
 * The resource is an HTTP service whose health endpoint reports the revision
 * it runs, read from a file on disk. The fake `fly` CLI's deploy really
 * changes that file to the revision of the workspace it was run in, exactly
 * as a deployment would change what the service serves. Factory observes the
 * service, never the file: the tests inspect the file and the endpoint
 * directly to check that Factory's records describe reality.
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
const denies: CapabilityProbe = async (capability) => ({ allowed: false, reason: `AuthBoundry denied operation ${capability}` });
const unavailable: CapabilityProbe = async () => ({ allowed: false, reason: 'AuthBoundry unavailable: connect ECONNREFUSED' });

async function gitRepository(root: string): Promise<{ path: string; head: string; earlier: string; git: (...args: string[]) => string }> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e 0', test: 'node -e 0' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
    'fly.toml': "app = 'checkout-app'\n",
  });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repositoryPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'version B');
  const earlier = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repositoryPath, 'README.md'), 'version A\n');
  git('add', '-A');
  git('commit', '-qm', 'version A');
  return { path: repositoryPath, head: git('rev-parse', 'HEAD'), earlier, git };
}

/** The controlled resource: what it serves is what the last deployment wrote. */
async function resource(root: string, initialRevision: string) {
  const stateFile = path.join(root, 'served-revision');
  writeFileSync(stateFile, initialRevision);
  let mode: 'ok' | 'unhealthy' | 'down' = 'ok';
  const server = createServer((_request, response) => {
    if (mode === 'down') { response.destroy(); return; }
    response.statusCode = mode === 'unhealthy' ? 503 : 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: mode === 'ok', version: readFileSync(stateFile, 'utf8').trim() }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/health`,
    stateFile,
    served: () => readFileSync(stateFile, 'utf8').trim(),
    set(next: typeof mode) { mode = next; },
    async ask(): Promise<{ status: number; version: string | null }> {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      const body = await response.json() as { version?: string };
      return { status: response.status, version: body.version ?? null };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fake fly CLI whose deploy writes the workspace revision into the resource. */
function fakeFly(root: string, stateFile: string) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const modeFile = path.join(root, 'fly-mode');
  const logFile = path.join(root, 'fly-invocations.log');
  writeFileSync(path.join(bin, 'fly'), `#!/bin/sh
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
echo "$1 app=$FLY_APP" >> "${logFile}"
if [ "$FLY_API_TOKEN" != "${VALID_TOKEN}" ]; then echo "Error: unauthorized" >&2; exit 1; fi
case "$mode" in
  reject) echo "Error: invalid configuration" >&2; exit 1;;
  silent) exit 0;;
esac
case "$1" in
  deploy) rev=$(git rev-parse HEAD); printf '%s' "$rev" > "${stateFile}"; echo "--> release v8 created"; exit 0;;
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

interface Options { workingDirectory?: string; hooks?: ExecutionHooks; workerId?: string; leaseMs?: number }

async function worker(repositoryRoot: string, options: Options = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-loop');
  const service = await FactoryService.create({
    mode: 'local', namespace: path.basename(workingDirectory), workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'), repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'), environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'), authenticator: authenticator(),
    authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
    credentialResolver: (name) => name === 'FLY_API_TOKEN' ? VALID_TOKEN : undefined,
    ...(options.hooks ? { executionHooks: options.hooks } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    executionLeaseMs: options.leaseMs ?? 1500,
  });
  await service.refreshConnection();
  return { service, workingDirectory };
}

async function scenario(repositoryRoot: string, healthUrl: string, options: Options = {}) {
  const { service, workingDirectory } = await worker(repositoryRoot, options);
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout' });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly', configuration: { healthUrl } });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: true, targetProvider: 'fly', healthRequirement: 'health endpoint returns 200',
  });
  return { service, context, domain, project, repository, environment, workingDirectory };
}

async function withFakeFly<T>(root: string, stateFile: string, body: (fly: ReturnType<typeof fakeFly>) => Promise<T>): Promise<T> {
  const fly = fakeFly(root, stateFile);
  const previous = process.env.PATH;
  process.env.PATH = `${fly.bin}${path.delimiter}${previous ?? ''}`;
  try { return await body(fly); } finally { process.env.PATH = previous; }
}

const DEPLOY = { operation: 'fly.deployment.create' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('drift is deterministic: matching, drifted, unknown and unavailable are four different answers', () => {
  const environment: EnvironmentRecord = { id: 'env', projectId: 'p', tenantId: TENANT, name: 'production', provider: 'fly', createdAt: '', updatedAt: '' };
  const desiredState = { id: 'd', projectId: 'p', tenantId: TENANT, sourceBranch: 'main', createdAt: '', updatedAt: '' };
  const discovery = { inspectedAt: '', files: [], signals: { headCommit: 'abc123abc123' } };
  const compare = (current: EnvironmentRecord['currentState'] | null) => compareReality({ project: { id: 'p' }, environment, desiredState, repository: null, discovery, current: current ?? null });
  const observed = (revision: string, kind: 'observed' | 'provider-unavailable' = 'observed') => ({
    observedAt: 'now', sourceCommit: revision, sourceBranch: 'main', provider: 'fly', deployment: 'enabled' as const, health: 'healthy' as const,
    observation: { kind, at: 'now', detail: 'test' },
  });
  assert.equal(compare(observed('abc123abc123')).status, 'reconciled');
  assert.equal(compare(observed('def456def456')).status, 'drifted');
  assert.equal(compare(null).status, 'unknown');
  const outage = compare(observed('def456def456', 'provider-unavailable'));
  assert.equal(outage.status, 'unavailable', 'a failed observation is never drift');
  assert.ok(outage.fields.every((field) => !field.drifted));
  assert.equal(outage.proposal, null);
  // Same inputs, same answer.
  assert.deepEqual(compare(observed('def456def456')), compare(observed('def456def456')));
});

test('the loop: desired A, reality B → drift → one Action → real deployment → verification → re-observed as A → reconciled', async () => {
  const root = await createTempWorkspace('loop-e2e');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.earlier);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, app.url);
      await service.configureReconciliation(context, project.id, environment.id, { interval: '15m' });

      // Reality is observed from the resource itself: it serves version B.
      assert.equal((await app.ask()).version, repository.earlier);
      const first = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(first.result, 'executed', JSON.stringify(first.explanation));
      assert.equal(first.observation?.kind, 'observed');
      assert.equal(first.observation?.reported?.revision, repository.earlier, 'the observation came from the resource');
      assert.equal(first.drift?.status, 'drifted');
      assert.ok(first.drift?.fields.some((field) => field.field === 'sourceCommit' && field.drifted));
      assert.ok(first.actionId && first.runId && first.evidenceId);

      // The real resource changed: the deployment wrote version A and the endpoint serves it.
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      assert.equal(app.served(), repository.head);
      assert.equal((await app.ask()).version, repository.head);
      assert.equal(first.reobservation?.kind, 'observed');
      assert.equal(first.reobservation?.reported?.revision, repository.head, 'reality was re-observed after execution');

      const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
      assert.equal(state.sourceCommit, repository.head);
      assert.equal(state.health, 'healthy');
      assert.equal(state.observation?.kind, 'observed');
      const reality = (await service.observeReality(context, project.id))[0]!;
      assert.equal(reality.status, 'reconciled');

      // Healthy: the next cycle finds nothing to do and creates nothing.
      const second = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(second.result, 'converged');
      assert.equal(second.actionId, undefined);
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      assert.equal((await domain.listActions(TENANT, project.id)).length, 1);

      // The cycle is explainable from durable evidence alone.
      const record = (await domain.getReconciliation(TENANT, project.id, environment.id))!;
      await service.recordReconciliationOutcome(record, first);
      const cycles = await domain.listReconciliationCycles(TENANT, project.id, environment.id);
      const executed = cycles.find((cycle) => cycle.outcome.result === 'executed')!;
      assert.equal(executed.outcome.observation?.reported?.revision, repository.earlier);
      assert.equal(executed.outcome.reobservation?.reported?.revision, repository.head);
      assert.equal(executed.outcome.drift?.status, 'drifted');
      assert.ok(executed.outcome.actionId && executed.outcome.runId && executed.outcome.evidenceId && executed.outcome.authority?.delegation);
      await service.shutdown();
    });
  } finally {
    await app.close();
  }
});

test('persistent drift produces one Action, not a storm, whatever state the Action is in', async () => {
  const root = await createTempWorkspace('loop-storm');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.earlier);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      // Denied autonomy: the Action waits for a person and repeated cycles adopt it.
      const { service, context, domain, project, environment } = await scenario(repository.path, app.url);
      const results: string[] = [];
      for (let cycle = 0; cycle < 4; cycle += 1) {
        results.push((await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies, ...DEPLOY })).result);
      }
      assert.deepEqual(results, ['autonomy-denied', 'awaiting-approval', 'awaiting-approval', 'awaiting-approval']);
      const actions = await domain.listActions(TENANT, project.id);
      assert.equal(actions.length, 1, 'one Action for one unresolved drift');
      assert.deepEqual(fly.invocations(), []);

      await service.shutdown();

      // Running: a cycle while the Action executes reports executing and creates nothing.
      const hooks: ExecutionHooks & { release?: () => void } = {
        async checkpoint(point: ExecutionCheckpoint) {
          if (point === 'before-invocation') await new Promise<void>((resolve) => { hooks.release = resolve; });
        },
      };
      const b = await scenario(repository.path, app.url, { hooks, workerId: 'worker-b' });
      const running = b.service.reconcileEnvironment(b.context, b.project.id, b.environment.id, { probe: grants, ...DEPLOY });
      for (let i = 0; i < 100 && !hooks.release; i += 1) await sleep(50);
      assert.ok(hooks.release, 'the deployment is in flight');
      const during = await b.service.reconcileEnvironment(b.context, b.project.id, b.environment.id, { probe: grants, ...DEPLOY });
      assert.equal(during.result, 'executing', JSON.stringify(during.explanation));
      assert.equal(during.actionId, (await b.domain.listActions(TENANT, b.project.id))[0]!.id);
      assert.equal((await b.domain.listActions(TENANT, b.project.id)).length, 1);
      hooks.release!();
      const done = await running;
      assert.equal(done.result, 'executed', JSON.stringify(done.explanation));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      await b.service.shutdown();
    });
  } finally {
    await app.close();
  }
});

test('failures back off durably: execution failure, verification failure and provider outage never fabricate reconciliation', async () => {
  const root = await createTempWorkspace('loop-failures');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.earlier);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, app.url);
      const record = await service.configureReconciliation(context, project.id, environment.id, { interval: '1m' });

      // Execution failure: the provider rejects; reality stays B; the record backs off.
      fly.setMode('reject');
      const pass1 = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(pass1.result, 'execution-failed', JSON.stringify(pass1.explanation));
      await service.recordReconciliationOutcome((await domain.getReconciliation(TENANT, project.id, environment.id))!, pass1);
      assert.equal(app.served(), repository.earlier, 'reality did not change');
      assert.equal((await service.observeReality(context, project.id))[0]!.status, 'drifted', 'no false reconciliation');
      let current = (await domain.getReconciliation(TENANT, project.id, environment.id))!;
      assert.equal(current.retry?.attempts, 1);
      assert.equal(current.retry?.lastResult, 'execution-failed');
      assert.ok(Date.parse(current.retry!.nextEligibleAt) > Date.now());
      assert.equal(record.enabled, true);

      // The same drift is not planned again while the backoff holds.
      const held = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(held.result, 'retry-suspended');
      assert.equal((await domain.listActions(TENANT, project.id)).filter((action) => action.origin === 'continuous-reconciliation').length, 1);
      assert.equal(fly.invocations().filter((line) => line.startsWith('deploy')).length, 1);

      // Verification failure: the provider "succeeds" without changing anything; the environment stays drifted.
      fly.setMode('silent');
      await domain.patchReconciliation(TENANT, current.id, { retry: undefined });
      const unverified = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(unverified.result, 'verification-failed', JSON.stringify(unverified.explanation));
      assert.equal(unverified.reobservation?.reported?.revision, repository.earlier, 'reality was re-observed, and still serves B');
      assert.equal((await service.observeReality(context, project.id))[0]!.status, 'drifted');
      const action = (await domain.getAction(TENANT, unverified.actionId!))!;
      assert.equal(action.outcome, 'verification-failed');
      assert.ok(action.verification?.some((check) => check.name === 'environment serves the deployed revision' && check.status === 'failed'));

      // Provider outage: reality becomes unavailable; nothing is remediated or fabricated.
      app.set('down');
      const outage = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(outage.result, 'unavailable', JSON.stringify(outage.explanation));
      assert.equal(outage.observation?.kind, 'provider-unavailable');
      assert.equal(outage.actionId, undefined);
      const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
      assert.equal(state.sourceCommit, repository.earlier, 'the last observed fact stands; nothing was invented');
      assert.equal(state.observation?.kind, 'provider-unavailable');
      assert.equal((await service.observeReality(context, project.id))[0]!.status, 'unavailable');
      const deploysBefore = fly.invocations().filter((line) => line.startsWith('deploy')).length;

      // Unhealthy is not an outage: the resource answered.
      app.set('unhealthy');
      const unhealthy = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies, ...DEPLOY });
      assert.equal(unhealthy.observation?.kind, 'observed');
      assert.equal(unhealthy.observation?.reported?.health, 'unhealthy');
      assert.notEqual(unhealthy.result, 'unavailable');
      assert.equal(fly.invocations().filter((line) => line.startsWith('deploy')).length, deploysBefore, 'denied autonomy executed nothing');
      await service.shutdown();
    });
  } finally {
    await app.close();
  }
});

test('an unknown outcome is observed before any retry, and reality can resolve it', async () => {
  const root = await createTempWorkspace('loop-unknown');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.earlier);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      const hooks: ExecutionHooks = { async checkpoint(point) { if (point === 'after-result-before-persistence') throw new Error('result lost'); } };
      const { service, context, domain, project, environment } = await scenario(repository.path, app.url, { hooks });
      const lost = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(lost.result, 'unknown', JSON.stringify(lost.explanation));
      assert.equal(app.served(), repository.head, 'the deployment really happened; only the result was lost');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // The next cycle observes reality first: it serves A, so the environment converged, and the
      // unknown Action is resolved from that observation — without a second deployment.
      const resolved = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(resolved.result, 'converged', JSON.stringify(resolved.explanation));
      assert.ok(resolved.explanation.some((line) => line.includes(lost.actionId!) && /resolved by observation as succeeded/.test(line)));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'no blind retry');
      const action = (await domain.getAction(TENANT, lost.actionId!))!;
      assert.equal(action.status, 'succeeded');
      assert.ok(action.verification?.some((check) => check.name === 'outcome resolved by observation'));
      assert.equal((await domain.getRun(TENANT, action.runId!))?.uncertainty?.resolvedBy, 'observation');
      assert.equal((await service.observeReality(context, project.id))[0]!.status, 'reconciled');

      // Reality that cannot establish the outcome keeps it unknown and still never retries.
      const hooks2: ExecutionHooks = { async checkpoint(point) { if (point === 'after-result-before-persistence') throw new Error('result lost'); } };
      const app2 = await resource(await createTempWorkspace('loop-unknown-2'), repository.earlier);
      try {
        const second = await scenario(repository.path, app2.url, { hooks: hooks2 });
        const lost2 = await second.service.reconcileEnvironment(second.context, second.project.id, second.environment.id, { probe: grants, ...DEPLOY });
        assert.equal(lost2.result, 'unknown');
        app2.set('unhealthy');
        const still = await second.service.reconcileEnvironment(second.context, second.project.id, second.environment.id, { probe: grants, ...DEPLOY });
        assert.equal(still.result, 'unknown', JSON.stringify(still.explanation));
        assert.equal(fly.invocations().length, 2, 'one deployment per scenario, no retry of the unknown one');
        // Healthy but serving the old revision: reality establishes the deployment did not take effect,
        // so the unknown Action is resolved as failed and only then is a new attempt legitimate.
        app2.set('ok');
        const absent = await second.service.reconcileEnvironment(second.context, second.project.id, second.environment.id, { probe: denies, ...DEPLOY });
        const resolvedAction = (await second.domain.getAction(TENANT, lost2.actionId!))!;
        assert.equal(resolvedAction.status, 'failed');
        assert.equal(resolvedAction.outcome, 'execution-failed');
        assert.match(resolvedAction.failure?.reason ?? '', /did not take effect/);
        assert.equal(absent.result, 'execution-failed', 'this cycle reports what reality established about the old Action');
        const next = await second.service.reconcileEnvironment(second.context, second.project.id, second.environment.id, { probe: denies, ...DEPLOY });
        assert.equal(next.result, 'autonomy-denied', 'a new Action is planned only after reality resolved the old one, and waits for a person');
        assert.notEqual(next.actionId, lost2.actionId);
        assert.equal(fly.invocations().length, 2, 'still no duplicate external operation');
        await second.service.shutdown();
      } finally {
        await app2.close();
      }
      await service.shutdown();
    });
  } finally {
    await app.close();
  }
});

test('worker crash and restart: a claimed reconciliation is reclaimed, an Action created before dying is reused, no duplicate effect', async () => {
  const root = await createTempWorkspace('loop-crash');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.earlier);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      const a = await scenario(repository.path, app.url, { workerId: 'worker-a' });
      const record = await a.service.configureReconciliation(a.context, a.project.id, a.environment.id, { interval: '1m' });

      // Worker A claims the record and dies before doing anything.
      const claimed = await a.domain.claimReconciliation(record.id, 'worker-a', Date.now(), 600);
      assert.ok(claimed?.leaseOwner === 'worker-a');
      assert.equal(await a.domain.claimReconciliation(record.id, 'worker-b', Date.now(), 600), null, 'a live lease refuses another worker');
      await a.service.shutdown();
      await sleep(700);

      // Worker B reclaims after expiry and runs the cycle; the scheduler is durable, not a timer.
      const b = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-b' });
      const bContext = await b.service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
      const reclaimed = await b.service.projects().claimReconciliation(record.id, 'worker-b', Date.now(), 60_000);
      assert.equal(reclaimed?.leaseOwner, 'worker-b');
      await b.service.projects().releaseReconciliation(record.id, {});

      // Worker B observes drift, creates the Action, and dies before executing it.
      const planned = await b.service.reconcileEnvironment(bContext, a.project.id, a.environment.id, { probe: denies, ...DEPLOY });
      assert.equal(planned.result, 'autonomy-denied');
      await b.service.shutdown();

      // Worker C reuses the durable Action and executes it through the same path; nothing is duplicated.
      const c = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-c' });
      const cContext = await c.service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
      const reused = await c.service.reconcileEnvironment(cContext, a.project.id, a.environment.id, { probe: grants, ...DEPLOY });
      assert.equal(reused.actionId, planned.actionId, 'the existing Action is reused after a restart');
      assert.equal((await c.service.projects().listActions(TENANT, a.project.id)).length, 1);
      // Approval by a person runs it; a later cycle finds reality converged.
      await c.service.runAction(cContext, planned.actionId!, { probe: grants });
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      assert.equal(app.served(), repository.head);
      const after = await c.service.reconcileEnvironment(cContext, a.project.id, a.environment.id, { probe: grants, ...DEPLOY });
      assert.equal(after.result, 'converged', JSON.stringify(after.explanation));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // Restart resumes durable scheduling: the record is not due yet, so a tick does nothing.
      const d = await worker(repository.path, { workingDirectory: a.workingDirectory, workerId: 'worker-d' });
      const dContext = await d.service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
      const stored = (await d.service.projects().getReconciliation(TENANT, a.project.id, a.environment.id))!;
      assert.equal(stored.enabled, true);
      assert.equal(stored.interval, '1m');
      const scheduler = createReconciliationScheduler({ service: d.service, context: async () => dContext, probe: grants, tickMs: 60_000 });
      await d.service.projects().patchReconciliation(TENANT, stored.id, { nextDueAt: new Date(Date.now() + 60_000).toISOString() });
      assert.deepEqual(await scheduler.tick(), [], 'future work is not executed early because Factory restarted');
      await d.service.projects().patchReconciliation(TENANT, stored.id, { nextDueAt: new Date(Date.now() - 1000).toISOString() });
      const handled = await scheduler.tick();
      assert.equal(handled.length, 1, 'overdue work is processed');
      assert.equal(handled[0]!.leaseOwner, undefined, 'ownership was released');
      assert.ok(Date.parse(handled[0]!.nextDueAt!) > Date.now(), 'the next observation was scheduled durably');
      const cycles = await d.service.projects().listReconciliationCycles(TENANT, a.project.id, a.environment.id);
      assert.ok(cycles.length >= 1);
      assert.equal(cycles[0]!.outcome.result, 'converged');
      await c.service.shutdown();
      await d.service.shutdown();
    });
  } finally {
    await app.close();
  }
});

test('environment health comes from reality, not from the last Run', async () => {
  const root = await createTempWorkspace('loop-health');
  const repository = await gitRepository(root);
  const app = await resource(root, repository.head);
  try {
    await withFakeFly(root, app.stateFile, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, app.url);
      // Run failed (provider rejected), environment healthy at the desired revision: reconciled.
      fly.setMode('reject');
      const failedAction = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const failed = await service.runAction(context, failedAction.id, { probe: grants, autonomous: true });
      assert.equal(failed.status, 'failed');
      const converged = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, ...DEPLOY });
      assert.equal(converged.result, 'converged', JSON.stringify(converged.explanation));
      assert.equal((await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState?.health, 'healthy');

      // Run succeeded, environment unhealthy: drifted, never healthy because of the Run.
      fly.setMode('ok');
      app.set('unhealthy');
      const drifted = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies, ...DEPLOY });
      assert.equal(drifted.observation?.reported?.health, 'unhealthy');
      assert.equal((await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState?.health, 'unhealthy');
      assert.equal((await service.observeReality(context, project.id))[0]!.status, 'drifted');
      await service.shutdown();
    });
  } finally {
    await app.close();
  }
});
