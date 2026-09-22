import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHttpServer, FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { flyAdapter, gitAdapter, localAdapter, type ProviderAdapter } from '../src/adapters.js';
import { MAX_OUTPUT_BYTES, redactSecrets } from '../src/execution.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';
import type { ActionRecord, RunRecord, StructuredEvidence } from '../src/types.js';

/*
 * Real execution, tested at the boundary.
 *
 * The provider mechanism here is a fake `fly` CLI placed on PATH: a real
 * process that Factory spawns through its real execution boundary, with real
 * credential resolution, real output capture and real termination. Nothing in
 * Factory is stubbed. The fake is a stand-in for a CLI, not for Factory.
 */

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';
const VALID_TOKEN = 'fly-token-valid-0123456789';
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
const denies: CapabilityProbe = async (capability) => ({
  allowed: false, reason: `AuthBoundry denied operation ${capability}`,
});
const unavailable: CapabilityProbe = async () => ({
  allowed: false, reason: 'AuthBoundry unavailable: connect ECONNREFUSED',
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

/**
 * A fake fly CLI. Its behaviour is chosen through a mode file the test writes,
 * because the execution boundary hands the process only the environment the
 * contract allows. Every invocation is appended to a log so a test can prove
 * the provider was, or was not, reached.
 */
function fakeFly(root: string): { bin: string; modeFile: string; logFile: string; setMode(mode: string): void; invocations(): string[] } {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const modeFile = path.join(root, 'fly-mode');
  const logFile = path.join(root, 'fly-invocations.log');
  writeFileSync(path.join(bin, 'fly'), `#!/bin/sh
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
echo "$1 app=$FLY_APP" >> "${logFile}"
if [ "$FLY_API_TOKEN" != "${VALID_TOKEN}" ]; then
  echo "Error: unauthorized: token $FLY_API_TOKEN was rejected" >&2
  exit 1
fi
case "$mode" in
  hang) sleep 30; exit 0;;
  crash) echo "Error: failed to build image: exit status 2" >&2; exit 2;;
  chatty) i=0; while [ $i -lt 40000 ]; do echo "line $i of output with token $FLY_API_TOKEN"; i=$((i+1)); done; echo "release v9 created"; exit 0;;
esac
case "$1" in
  deploy) echo "==> Building image for $FLY_APP"; echo "--> release v7 created"; echo "Visit your newly deployed app at https://$FLY_APP.fly.dev/"; exit 0;;
  status) printf '{"Name":"%s","Status":"running","Hostname":"%s.fly.dev","Version":7,"ID":"app_123"}\\n' "$FLY_APP" "$FLY_APP"; exit 0;;
esac
exit 0
`);
  chmodSync(path.join(bin, 'fly'), 0o755);
  return {
    bin,
    modeFile,
    logFile,
    setMode(mode) { writeFileSync(modeFile, mode); },
    invocations() { return existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []; },
  };
}

async function healthServer(status = 200): Promise<{ url: string; set(next: number): void; close(): Promise<void> }> {
  let current = status;
  const server = createServer((_request, response) => { response.statusCode = current; response.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/health`,
    set(next) { current = next; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Options {
  workingDirectory?: string;
  adapters?: readonly ProviderAdapter[];
  token?: string | null;
  flowPath?: string;
}

async function factory(repositoryRoot: string, options: Options = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-real');
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
    ...(options.adapters ? { providerAdapters: options.adapters } : {}),
    credentialResolver: (name) => name === 'FLY_API_TOKEN'
      ? (options.token === undefined ? VALID_TOKEN : options.token ?? undefined)
      : undefined,
  });
  await service.refreshConnection();
  return { service, workingDirectory };
}

async function scenario(repositoryRoot: string, options: Options & { configuration?: Record<string, unknown>; provider?: string | null } = {}) {
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
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: true, targetProvider: 'fly',
  });
  return { service, context, domain, project, repository, environment, workingDirectory };
}

/** Run a test with the fake fly first on PATH, restoring PATH afterwards. */
async function withFakeFly<T>(root: string, body: (fly: ReturnType<typeof fakeFly>) => Promise<T>): Promise<T> {
  const fly = fakeFly(root);
  const previous = process.env.PATH;
  process.env.PATH = `${fly.bin}${path.delimiter}${previous ?? ''}`;
  try {
    return await body(fly);
  } finally {
    process.env.PATH = previous;
  }
}

function db(service: FactoryService) {
  return (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
}

async function evidenceOf(service: FactoryService, action: ActionRecord): Promise<StructuredEvidence> {
  return (await db(service).collection<StructuredEvidence>(COLLECTIONS.evidence).get(action.runId!))!;
}

/** A recording adapter over the real one, so a test can see whether the boundary was reached. */
function recording(adapter: ProviderAdapter): ProviderAdapter & { reached: string[] } {
  const reached: string[] = [];
  return {
    ...adapter,
    reached,
    resource(capability, context) { reached.push(`resource:${capability}`); return adapter.resource(capability, context); },
    interpret(capability, evidence, context) { reached.push(`interpret:${capability}`); return adapter.interpret(capability, evidence, context); },
  };
}

test('smoke: an Action crosses the provider boundary for real and its result survives into reality', async () => {
  const root = await createTempWorkspace('real-smoke');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);

  // The safest real operation there is: git reading the repository.
  const action = await service.createAction(context, project.id, { capability: 'repository.inspect', environmentId: environment.id }, grants);
  assert.equal(action.provider, 'git');
  assert.equal(action.execution, undefined, 'a planned Action has no execution timestamps');

  const ran = await service.runAction(context, action.id, { probe: grants, autonomous: true });
  assert.equal(ran.status, 'succeeded', JSON.stringify(ran.verification));
  assert.equal(ran.outcome, 'succeeded');
  assert.deepEqual(ran.preflight?.checks.map((check) => [check.name, check.status]), [
    ['capability supported', 'passed'], ['provider resolved', 'passed'], ['provider available', 'passed'],
    ['resource bound', 'passed'], ['configuration present', 'passed'], ['credentials available', 'passed'],
    ['authority available', 'passed'],
  ]);
  assert.ok(ran.preflight?.passedAt);
  assert.ok(ran.execution?.startedAt && ran.execution.completedAt && ran.execution.durationMs !== undefined, 'timestamps come from the boundary');
  assert.ok(Date.parse(ran.execution!.startedAt!) >= Date.parse(ran.execution!.requestedAt));
  assert.equal(ran.execution?.terminationReason, 'exit');
  assert.equal(ran.execution?.exitCode, 0);
  assert.equal(ran.execution?.providerStatus, 'succeeded');
  assert.equal(ran.execution?.observedRevision, repository.head, 'the revision is what git observed');

  const run = await domain.getRun(TENANT, ran.runId!);
  assert.equal(run?.status, 'completed');
  const evidence = await evidenceOf(service, ran);
  assert.equal(evidence.providerResult?.status, 'succeeded');
  assert.equal(evidence.providerResult?.observed.revision, repository.head);
  assert.equal(evidence.revision?.observed, repository.head);
  assert.equal(evidence.execution?.terminationReason, 'exit');
  assert.deepEqual(evidence.execution?.credentialsResolved, []);
  assert.equal(evidence.provider?.providerResource, 'git:github:rkendel1/checkout');

  // Reality was written from what happened.
  const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
  assert.equal(state.sourceCommit, repository.head);
  assert.equal(state.reconciledRunId, ran.runId);
  assert.equal(state.health, 'unknown', 'nothing probed health, so health is not claimed');
});

test('a real deployment: fake CLI on PATH, credential by name, provider reference, health verified against a live endpoint', async () => {
  const root = await createTempWorkspace('real-deploy');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, { configuration: { healthUrl: health.url } });
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(ran.status, 'succeeded', JSON.stringify({ verification: ran.verification, failure: ran.failure }));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'the CLI ran once, against the bound app');
      assert.equal(ran.execution?.providerOperationId, 'v7', 'the provider reference is what fly printed');
      assert.equal(ran.execution?.observedRevision, repository.head);
      assert.deepEqual(ran.verification?.map((check) => [check.name, check.status]), [
        ['evidence recorded', 'passed'], ['deterministic result', 'passed'], ['authorized application context', 'passed'],
        ['deployment command completed', 'passed'], ['environment responds healthy', 'passed'],
      ]);
      assert.match(ran.verification?.find((check) => check.name === 'environment responds healthy')?.detail ?? '', /returned HTTP 200/);

      const evidence = await evidenceOf(service, ran);
      assert.equal(evidence.provider?.providerResource, 'fly:app:checkout-app');
      assert.deepEqual(evidence.provider?.credentials, ['FLY_API_TOKEN']);
      assert.deepEqual(evidence.execution?.credentialsResolved, ['FLY_API_TOKEN']);
      assert.equal(evidence.providerResult?.metadata.release, 'v7');
      assert.doesNotMatch(JSON.stringify(evidence), new RegExp(VALID_TOKEN), 'the token never reaches evidence');

      const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
      assert.equal(state.health, 'healthy', 'health came from the probe');
      assert.equal(state.sourceCommit, repository.head);

      // Health that fails after a successful deploy is verification-failed, not success.
      health.set(503);
      const again = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const failed = await service.runAction(context, again.id, { probe: grants, autonomous: true });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.outcome, 'verification-failed');
      assert.equal(failed.failure?.phase, 'verification');
      assert.equal(failed.execution?.providerStatus, 'succeeded', 'the deployment itself succeeded');
      assert.equal((await domain.getRun(TENANT, failed.runId!))?.status, 'completed');
    });
  } finally {
    await health.close();
  }
});

test('failure at every boundary leaves durable, specific state', async () => {
  const root = await createTempWorkspace('real-failures');
  const repository = await gitRepository(root);

  // Provider unavailable: no fly on PATH, so preflight stops before any run.
  {
    const { service, context, project, environment } = await scenario(repository.path);
    const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
    const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
    assert.equal(ran.outcome, 'provider-unavailable');
    assert.equal(ran.failure?.phase, 'preflight');
    assert.equal(ran.runId, undefined);
  }

  await withFakeFly(root, async (fly) => {
    // Missing credential: refused by name, before the provider.
    {
      const { service, context, project, environment } = await scenario(repository.path, { token: null });
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(ran.outcome, 'credential-unavailable');
      assert.match(ran.failure?.reason ?? '', /FLY_API_TOKEN is not available/);
      assert.equal(ran.runId, undefined);
      assert.deepEqual(fly.invocations(), [], 'the provider was not reached');
    }

    // Invalid credential: the provider rejects it; the rejection is recorded and redacted.
    {
      const bad = 'fly-token-rejected-9876543210';
      const { service, context, domain, project, environment } = await scenario(repository.path, { token: bad });
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(ran.outcome, 'execution-failed');
      assert.equal(ran.failure?.phase, 'provider', 'the provider said no; Factory did not fail');
      assert.match(ran.failure?.reason ?? '', /provider rejected the operation: .*unauthorized/);
      assert.equal(ran.execution?.providerStatus, 'rejected');
      const evidence = await evidenceOf(service, ran);
      assert.equal(evidence.providerResult?.status, 'rejected');
      assert.match(evidence.stderr, /\[redacted:FLY_API_TOKEN\]/, 'the echoed token was redacted');
      for (const [label, record] of [['action', ran], ['run', await domain.getRun(TENANT, ran.runId!)], ['evidence', evidence]] as const) {
        assert.doesNotMatch(JSON.stringify(record), new RegExp(bad), `${label} holds no credential value`);
      }
      assert.equal(fly.invocations().length, 1);
    }

    // Resource missing: no fly.toml and no flyApp, so nothing to deploy to.
    {
      const bare = await gitRepository(await createTempWorkspace('real-noapp'), { 'fly.toml': '' });
      const { service, context, project, environment } = await scenario(bare.path);
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(ran.outcome, 'resource-unavailable');
      assert.match(ran.failure?.reason ?? '', /not bound to a Fly app/);
      assert.equal(fly.invocations().length, 1, 'the provider was not invoked for an unbound resource');
    }

    // Authorization denied and authority unavailable stay distinct and never reach the provider.
    {
      const { service, context, project, environment } = await scenario(repository.path);
      const denied = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, denies);
      await assert.rejects(() => service.runAction(context, denied.id, { probe: denies, autonomous: true }), /may not execute autonomously/);
      assert.equal((await service.projects().getAction(TENANT, denied.id))?.outcome, 'autonomy-denied');
      const offline = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, unavailable);
      await assert.rejects(() => service.runAction(context, offline.id, { probe: unavailable, autonomous: true }));
      assert.equal((await service.projects().getAction(TENANT, offline.id))?.outcome, 'authority-unavailable');
      assert.equal(fly.invocations().length, 1);
    }

    // Provider rejects the operation itself (non-zero exit, no auth problem).
    {
      fly.setMode('crash');
      const { service, context, project, environment } = await scenario(repository.path);
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(ran.outcome, 'execution-failed');
      assert.equal(ran.failure?.phase, 'execution');
      assert.match(ran.failure?.reason ?? '', /failed to build image/);
      assert.equal(ran.execution?.exitCode, 2);
      assert.equal(ran.execution?.terminationReason, 'exit');
      assert.equal((await evidenceOf(service, ran)).providerResult?.status, 'failed');
      fly.setMode('ok');
    }

    // Bounded output: a chatty provider does not become an unbounded log, and its echoes are redacted.
    {
      fly.setMode('chatty');
      const { service, context, project, environment } = await scenario(repository.path);
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      const evidence = await evidenceOf(service, ran);
      assert.ok(evidence.execution?.truncated.stdout, 'stdout was truncated');
      assert.ok(Buffer.byteLength(evidence.stdout) <= MAX_OUTPUT_BYTES + 128);
      assert.ok(evidence.execution!.outputBytes.stdout > MAX_OUTPUT_BYTES);
      assert.doesNotMatch(evidence.stdout, new RegExp(VALID_TOKEN));
      assert.match(evidence.stdout, /\[redacted:FLY_API_TOKEN\]/);
      fly.setMode('ok');
    }
  });
});

test('timeout and cancellation are distinct, propagate to the process, and a late result never un-cancels', async () => {
  const root = await createTempWorkspace('real-timeout');
  const repository = await gitRepository(root);
  // The same .flow, with a short deployment timeout so the test is bounded.
  const flowPath = path.join(root, '.flow');
  writeFileSync(flowPath, readFileSync(path.resolve(process.cwd(), '.flow'), 'utf8')
    .replace(/(command \["fly","deploy","--remote-only","--yes"\]\n\s+timeoutMs )900000/, '$11500'));

  await withFakeFly(root, async (fly) => {
    fly.setMode('hang');
    // Timeout.
    {
      const { service, context, domain, project, environment } = await scenario(repository.path, { flowPath });
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const started = Date.now();
      const ran = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.ok(Date.now() - started < 15000, 'the hung process was killed at the timeout');
      assert.equal(ran.outcome, 'execution-failed');
      assert.equal(ran.execution?.terminationReason, 'timeout');
      assert.match(ran.failure?.reason ?? '', /timed out after 1500ms/);
      const evidence = await evidenceOf(service, ran);
      assert.equal(evidence.execution?.timedOut, true);
      assert.equal(evidence.status, 'failed');
      assert.equal((await domain.getRun(TENANT, ran.runId!))?.status, 'failed');
    }

    // Cancellation.
    {
      const { service, context, domain, project, environment } = await scenario(repository.path);
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const running = service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      let current: ActionRecord | null = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        current = await domain.getAction(TENANT, deploy.id);
        if (current?.status === 'running' && current.runId) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(current?.status, 'running', 'the Action reports running while the provider works');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const cancelled = await service.cancelAction(context, deploy.id);
      assert.ok(cancelled.execution?.cancelRequestedAt);
      const ran = await running;
      assert.equal(ran.status, 'failed');
      assert.equal(ran.outcome, 'cancelled', 'cancelled is not execution-failed');
      assert.equal(ran.execution?.terminationReason, 'cancelled');
      const run = await domain.getRun(TENANT, ran.runId!);
      assert.equal(run?.status, 'cancelled');
      const evidence = await evidenceOf(service, ran);
      assert.equal(evidence.status, 'cancelled');
      assert.equal(evidence.execution?.cancelled, true);
      // Running it again does nothing: a cancelled Action stays cancelled.
      assert.equal((await service.runAction(context, deploy.id, { probe: grants, autonomous: true })).outcome, 'cancelled');
    }
    fly.setMode('ok');
  });
});

test('terminal and cancelled Actions never reach the provider; only an explicit retry admits a new attempt', async () => {
  const root = await createTempWorkspace('real-terminal');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      const recorded = recording(flyAdapter);
      const { service, context, project, environment } = await scenario(repository.path, {
        adapters: [gitAdapter, localAdapter, recorded], configuration: { healthUrl: health.url },
      });
      const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const first = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(first.status, 'succeeded');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      const reachedAfterFirst = recorded.reached.length;

      // Succeeded: no second provider invocation, no second resource binding.
      const again = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
      assert.equal(again.runId, first.runId);
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      assert.equal(recorded.reached.length, reachedAfterFirst, 'the adapter was not reached again');

      // Cancelled before running: never runs.
      const planned = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      await service.cancelAction(context, planned.id);
      const skipped = await service.runAction(context, planned.id, { probe: grants, autonomous: true });
      assert.equal(skipped.outcome, 'cancelled');
      assert.equal(skipped.runId, undefined);
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // Failed: stays failed until retried; a retry is one new attempt with its own Run.
      fly.setMode('crash');
      const failing = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
      const failed = await service.runAction(context, failing.id, { probe: grants, autonomous: true });
      assert.equal(failed.status, 'failed');
      await service.runAction(context, failing.id, { probe: grants, autonomous: true });
      assert.equal(fly.invocations().length, 2, 'a failed Action is not re-run on its own');
      fly.setMode('ok');
      await service.retryAction(context, failing.id);
      const retried = await service.runAction(context, failing.id, { probe: grants, autonomous: true });
      assert.equal(retried.status, 'succeeded');
      assert.equal(fly.invocations().length, 3);
      assert.notEqual(retried.runId, failed.runId);
      assert.deepEqual(retried.previousRunIds, [failed.runId]);
    });
  } finally {
    await health.close();
  }
});

test('a graph executes for real, unlocking each dependent only after actual completion and verification', async () => {
  const root = await createTempWorkspace('real-graph');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, { configuration: { healthUrl: health.url } });
      const { graph } = await service.createActionGraph(context, {
        projectId: project.id, environmentId: environment.id,
        actions: [
          { key: 'build', capability: 'build.run', type: 'build.run' },
          { key: 'test', capability: 'test.run', type: 'test.run', dependsOn: ['build'] },
          { key: 'deploy', capability: 'deployment.create', type: 'deployment.create', dependsOn: ['test'] },
          { key: 'health', capability: 'environment.health', type: 'environment.health', dependsOn: ['deploy'] },
        ],
      }, grants);
      const result = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
      assert.equal(result.graph.status, 'completed', JSON.stringify(result.actions.map((action) => [action.type, action.outcome, action.failure])));
      assert.deepEqual(result.actions.map((action) => action.outcome), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'the provider was reached once, for the deploy');

      // Each node ran after the one before it had actually finished.
      const runs: RunRecord[] = [];
      for (const action of result.actions) runs.push((await domain.getRun(TENANT, action.runId!))!);
      for (let index = 1; index < runs.length; index += 1) {
        assert.ok(Date.parse(runs[index]!.startedAt!) >= Date.parse(runs[index - 1]!.completedAt!),
          `${result.actions[index]!.type} started only after ${result.actions[index - 1]!.type} completed`);
      }
      assert.equal(new Set(runs.map((run) => run.id)).size, 4, 'one Run per node');
      for (const action of result.actions) assert.ok((await evidenceOf(service, action)).providerResult, 'one Evidence per node, with the provider result');

      // Repeated coordination re-runs nothing and produces no second effect.
      const again = await service.coordinateGraph(context, graph.id, { probe: grants, autonomous: true });
      assert.deepEqual(again.actions.map((action) => action.runId), result.actions.map((action) => action.runId));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);

      // The environment's reality reflects the deployment and the probe.
      const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
      assert.equal(state.sourceCommit, repository.head);
      assert.equal(state.health, 'healthy');
    });
  } finally {
    await health.close();
  }
});

test('continuous reconciliation reaches reality: drift, real deployment, real probe, re-observed as reconciled', async () => {
  const root = await createTempWorkspace('real-reconcile');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    await withFakeFly(root, async (fly) => {
      const { service, context, domain, project, environment } = await scenario(repository.path, { configuration: { healthUrl: health.url } });
      await domain.putDesiredState(TENANT, project.id, { healthRequirement: 'health endpoint returns 200' });
      // Reality last observed at a stale revision: drift, so a deployment is planned and executed for real.
      await domain.setEnvironmentState(TENANT, project.id, environment.id, {
        observedAt: new Date().toISOString(), sourceCommit: 'stale0000000', sourceBranch: 'main', provider: 'fly', deployment: 'enabled', health: 'unknown',
      });
      const first = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants, operation: 'fly.deployment.create' });
      assert.equal(first.result, 'executed', JSON.stringify(first.explanation));
      assert.ok(first.explanation.some((line) => /re-observed after execution: it matches/.test(line)));
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
      const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
      assert.equal(state.sourceCommit, repository.head);
      assert.equal(state.health, 'healthy');
      // Second pass: converged; nothing runs.
      const second = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
      assert.equal(second.result, 'converged');
      assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
    });
  } finally {
    await health.close();
  }
});

test('a restart during execution leaves the Action unknown, never running, failed or succeeded, until reality resolves it', async () => {
  const root = await createTempWorkspace('real-restart');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment, workingDirectory } = await scenario(repository.path);
  const action = await service.createAction(context, project.id, { capability: 'repository.inspect', environmentId: environment.id }, grants);
  const now = new Date().toISOString();
  await db(service).collection<RunRecord>(COLLECTIONS.runs).put({
    id: 'run_interrupted', operationId: 'op_interrupted', operationVersion: 0, workId: `work_${action.id}`, principal: PRINCIPAL,
    tenantId: TENANT, operation: 'repository.inspect', status: 'executing', idempotencyKey: 'interrupted',
    repository: { provider: 'github', owner: 'rkendel1', name: 'checkout', ref: 'main' }, actionId: action.id, projectId: project.id,
    createdAt: now, updatedAt: now, startedAt: now,
  }, 'run_interrupted');
  await domain.patchAction(TENANT, action.id, { status: 'running', runId: 'run_interrupted', execution: { requestedAt: now, startedAt: now } });
  await service.shutdown();

  const restarted = await factory(repository.path, { workingDirectory });
  const recovered = (await restarted.service.projects().getAction(TENANT, action.id))!;
  // The provider had been invoked when the process stopped: Factory does not
  // know what it did, and says so rather than calling it failed.
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.outcome, 'unknown');
  assert.equal(recovered.failure?.phase, 'unknown');
  const run = (await restarted.service.getRun('run_interrupted'))!;
  assert.equal(run.status, 'unknown');
  assert.equal(run.uncertainty?.invocationMayHaveOccurred, true);
  // It does not run again on its own.
  assert.equal((await restarted.service.runAction(context, action.id, { probe: grants, autonomous: true })).status, 'unknown');
  // Reality resolves it: a read-only inspection is safe to repeat, so it returns to planned and runs as a new attempt.
  const resolved = await restarted.service.resolveUncertainAction(context, action.id);
  assert.equal(resolved.status, 'planned');
  assert.deepEqual(resolved.previousRunIds, ['run_interrupted']);
  const rerun = await restarted.service.runAction(context, action.id, { probe: grants, autonomous: true });
  assert.equal(rerun.status, 'succeeded');
  assert.notEqual(rerun.runId, 'run_interrupted');
  await restarted.service.shutdown();
});

test('capability status is honest per provider, and the API and pages never carry a credential value', async () => {
  const root = await createTempWorkspace('real-status');
  const repository = await gitRepository(root);
  const health = await healthServer(200);
  try {
    // Without fly on PATH and without a token: nothing Fly is executable, and it says why.
    {
      const { service, context } = await scenario(repository.path, { token: null });
      const fly = (await service.operationalProviders(context)).find((provider) => provider.id === 'fly')!;
      const deploy = (fly.capabilities as Record<string, unknown>[]).find((entry) => entry.capability === 'deployment.create')!;
      assert.equal(deploy.implementation, true);
      assert.equal(deploy.declared, true);
      assert.equal(deploy.available, false);
      assert.equal(deploy.credential, false);
      assert.equal(deploy.executable, false);
      assert.deepEqual(deploy.reasons, ['fly CLI is not on PATH', 'credential FLY_API_TOKEN is not configured']);
      assert.ok((fly.vocabulary as string[]).includes('deployment.rollback'), 'rollback is not offered by fly');
      assert.deepEqual(fly.credentialsPresent, { FLY_API_TOKEN: false });
      const git = (await service.operationalProviders(context)).find((provider) => provider.id === 'git')!;
      assert.ok((git.capabilities as Record<string, unknown>[]).every((entry) => entry.executable === true), 'git is executable here');
    }
    await withFakeFly(root, async (fly) => {
      const workingDirectory = await createTempWorkspace('real-status-http');
      const { server, service } = await createHttpServer({
        mode: 'local', namespace: path.basename(workingDirectory), workingDirectory,
        flowPath: path.resolve(process.cwd(), '.flow'), environmentId: 'test',
        appportPath: path.join(workingDirectory, 'appport-services'), repositoryRoot: repository.path,
        workspaceRoot: path.join(workingDirectory, 'workspaces'), authenticator: authenticator(),
        authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
        credentialResolver: (name) => name === 'FLY_API_TOKEN' ? VALID_TOKEN : undefined,
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      try {
        const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
        const domain = service.projects();
        const project = await domain.createProject({ tenantId: TENANT, name: 'Checkout' });
        await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'checkout' });
        const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly', configuration: { healthUrl: health.url } });

        const providers = await (await fetch(`${origin}/v1/providers`)).json() as { providers: Record<string, unknown>[] };
        const flyStatus = providers.providers.find((provider) => provider.id === 'fly')!;
        const deploy = (flyStatus.capabilities as Record<string, unknown>[]).find((entry) => entry.capability === 'deployment.create')!;
        assert.equal(deploy.executable, true, JSON.stringify(deploy.reasons));
        assert.doesNotMatch(JSON.stringify(providers), new RegExp(VALID_TOKEN));

        const created = await (await fetch(`${origin}/v1/projects/${project.id}/actions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability: 'deployment.create', environmentId: environment.id }),
        })).json() as ActionRecord;
        const ran = await (await fetch(`${origin}/v1/actions/${created.id}/run`, { method: 'POST' })).json() as ActionRecord;
        assert.equal(ran.status, 'succeeded', JSON.stringify(ran.failure));
        assert.deepEqual(fly.invocations(), ['deploy app=checkout-app']);
        for (const route of [`/v1/actions/${created.id}`, `/v1/runs/${ran.runId}`, `/v1/runs/${ran.runId}/evidence`, `/v1/projects/${project.id}/runs`, '/v1/overview']) {
          const body = await (await fetch(`${origin}${route}`)).text();
          assert.doesNotMatch(body, new RegExp(VALID_TOKEN), `${route} carries no credential value`);
        }
        // Cancel on a finished Action changes nothing.
        const cancelled = await (await fetch(`${origin}/v1/actions/${created.id}/cancel`, { method: 'POST' })).json() as ActionRecord;
        assert.equal(cancelled.status, 'succeeded');
        for (const page of [`/factory/actions/${created.id}`, `/factory/runs/${ran.runId}`, '/factory/providers']) {
          const response = await fetch(`${origin}${page}`);
          assert.equal(response.status, 200);
          assert.doesNotMatch(await response.text(), new RegExp(VALID_TOKEN));
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  } finally {
    await health.close();
  }
});

test('redaction covers credential values and provider-printed secrets', () => {
  const redacted = redactSecrets(
    'deploying with token abc123secret\nAuthorization: Bearer eyJhbGciOi.xyz\nCookie: session=deadbeef\napi_key=sk-live-1\nfine',
    { FLY_API_TOKEN: 'abc123secret' },
  );
  assert.doesNotMatch(redacted, /abc123secret|eyJhbGciOi|deadbeef|sk-live-1/);
  assert.match(redacted, /\[redacted:FLY_API_TOKEN\]/);
  assert.match(redacted, /fine$/);
});

/*
 * Integration mode: the real fly CLI against a real app. Never fakes anything,
 * never destroys anything: `environment.inspect` reads status and
 * `environment.health` probes the app. Opt in with
 *   FACTORY_INTEGRATION_FLY=1 FACTORY_INTEGRATION_FLY_APP=<app> FLY_API_TOKEN=<token>
 */
test('fly integration: real status and health against a configured app', {
  skip: process.env.FACTORY_INTEGRATION_FLY !== '1' ? 'set FACTORY_INTEGRATION_FLY=1 with FACTORY_INTEGRATION_FLY_APP and FLY_API_TOKEN' : false,
}, async () => {
  const app = process.env.FACTORY_INTEGRATION_FLY_APP!;
  const root = await createTempWorkspace('real-integration');
  const repository = await gitRepository(root, { 'fly.toml': `app = '${app}'\n` });
  const workingDirectory = await createTempWorkspace('real-integration-factory');
  const service = await FactoryService.create({
    mode: 'local', namespace: path.basename(workingDirectory), workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'), repositoryRoot: repository.path,
    workspaceRoot: path.join(workingDirectory, 'workspaces'), environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'), authenticator: authenticator(),
    authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
  });
  await service.refreshConnection();
  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = service.projects();
  const project = await domain.createProject({ tenantId: TENANT, name: 'Integration' });
  await domain.addRepository(TENANT, project.id, { owner: 'integration', name: app });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly' });

  const inspect = await service.createAction(context, project.id, { capability: 'environment.inspect', environmentId: environment.id }, grants);
  const inspected = await service.runAction(context, inspect.id, { probe: grants, autonomous: true });
  assert.equal(inspected.status, 'succeeded', JSON.stringify({ failure: inspected.failure, verification: inspected.verification }));
  assert.equal((await evidenceOf(service, inspected)).providerResult?.metadata.app, app);

  const probe = await service.createAction(context, project.id, { capability: 'environment.health', environmentId: environment.id }, grants);
  const probed = await service.runAction(context, probe.id, { probe: grants, autonomous: true });
  assert.ok(['succeeded', 'failed'].includes(probed.status));
  assert.ok(probed.verification?.some((check) => check.name === 'environment responds healthy'));

  // Opt in separately to a real deployment of the test app through the same path.
  if (process.env.FACTORY_INTEGRATION_FLY_DEPLOY === '1') {
    const deploy = await service.createAction(context, project.id, { capability: 'deployment.create', environmentId: environment.id }, grants);
    const deployed = await service.runAction(context, deploy.id, { probe: grants, autonomous: true });
    assert.equal(deployed.status, 'succeeded', JSON.stringify({ failure: deployed.failure, verification: deployed.verification }));
    assert.ok(deployed.execution?.providerOperationId, 'fly reported a release');
    assert.ok(deployed.verification?.some((check) => check.name === 'environment responds healthy' && check.status === 'passed'));
    assert.equal((await evidenceOf(service, deployed)).chain?.observedReality?.health, 'healthy');
  }
  await service.shutdown();
});
