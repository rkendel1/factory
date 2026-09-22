import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHttpServer } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { COLLECTIONS, loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { OPERATIONAL_WORK_CONTRACT, type OperationalWorkResult } from '../src/operational-work.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator } from '../src/auth.js';
import type { ActionRecord, ExecutionContractRecord, RunRecord, StructuredEvidence } from '../src/types.js';

/*
 * The complete Factory promise, proved the way a user reaches it: through the
 * product API the Factory pages call, with nothing hidden or test-only in the
 * path. The provider boundary is a real `fly` program on PATH (a deterministic
 * stand-in for the CLI, never for Factory), a live HTTP health endpoint, and
 * the real git and npm mechanisms.
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

/** The authenticated operator, as AuthBoundry would present it; autonomy asked per Action. */
function authenticator(log: string[]): Authenticator {
  return {
    async authenticate(_request, capability) {
      log.push(capability);
      if (capability === AUTONOMOUS_EXECUTION_CAPABILITY) {
        // A person driving the Action is the approval; the route asks only for
        // the executing capabilities.
      }
      return {
        principal: PRINCIPAL, tenant: TENANT, claims: {}, session: { id: 'session-1' }, delegation: null,
        boundaryVerified: true, authorizedCapabilities: [...declared().capabilities, 'factory.run', AUTONOMOUS_EXECUTION_CAPABILITY],
        authority: 'delegated', delegationId: associationDelegationId(TENANT),
      };
    },
  };
}

async function gitRepository(root: string): Promise<{ path: string; head: string; earlier: string }> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/app.js\',\'ok\')"', test: 'node -e "process.exit(0)"' } }),
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
  git('commit', '-qm', 'initial');
  const earlier = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repositoryPath, 'README.md'), 'second\n');
  git('add', '-A');
  git('commit', '-qm', 'second');
  return { path: repositoryPath, head: git('rev-parse', 'HEAD'), earlier };
}

function fakeFly(root: string) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const modeFile = path.join(root, 'fly-mode');
  const logFile = path.join(root, 'fly-invocations.log');
  writeFileSync(path.join(bin, 'fly'), `#!/bin/sh
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
echo "$1 app=$FLY_APP" >> "${logFile}"
if [ "$FLY_API_TOKEN" != "${VALID_TOKEN}" ]; then echo "Error: unauthorized: token $FLY_API_TOKEN rejected" >&2; exit 1; fi
case "$mode" in
  reject) echo "Error: invalid configuration: fly.toml has no [http_service] section" >&2; exit 1;;
esac
case "$1" in
  deploy) echo "==> Building image"; echo "--> release v7 created"; exit 0;;
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
  return { url: `http://127.0.0.1:${address.port}/health`, set(next: number) { current = next; }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function factory(repositoryRoot: string, workingDirectory: string, log: string[]) {
  const { server, service } = await createHttpServer({
    mode: 'local', namespace: path.basename(workingDirectory), workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'), environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'), repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'), authenticator: authenticator(log),
    authBoundryTenantId: TENANT, authBoundryControlPlane: controlPlane(),
    credentialResolver: (name) => name === 'FLY_API_TOKEN' ? VALID_TOKEN : undefined,
    workerId: 'worker-ui',
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async <T = unknown>(route: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${origin}${route}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const stop = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return { origin, api, service, stop };
}

function db(service: { }) { return (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db; }

test('the Factory promise: a user creates a project, an Action, executes it, and Factory proves the real effect durably', async () => {
  const root = await createTempWorkspace('promise');
  const repository = await gitRepository(root);
  const workingDirectory = await createTempWorkspace('promise-factory');
  const fly = fakeFly(root);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fly.bin}${path.delimiter}${previousPath ?? ''}`;
  const health = await healthServer(200);
  const log: string[] = [];
  let f = await factory(repository.path, workingDirectory, log);
  try {
    // Project → Repository → Environment → Desired State, exactly as the pages do it.
    const project = (await f.api<{ id: string }>('/v1/projects', { method: 'POST', body: { name: 'Checkout' } })).body;
    await f.api(`/v1/projects/${project.id}/repositories`, { method: 'POST', body: { owner: 'rkendel1', name: 'checkout' } });
    const environment = (await f.api<{ id: string }>(`/v1/projects/${project.id}/environments`, {
      method: 'POST', body: { name: 'production', provider: 'fly', configuration: { healthUrl: health.url } },
    })).body;
    await f.api(`/v1/projects/${project.id}/desired-state`, { method: 'PUT', body: { sourceBranch: 'main', deploymentEnabled: true, targetProvider: 'fly', healthRequirement: 'health endpoint returns 200' } });

    // The Providers page tells the truth before anything runs.
    const providers = (await f.api<{ providers: Record<string, unknown>[] }>('/v1/providers')).body.providers;
    const flyStatus = providers.find((provider) => provider.id === 'fly')!;
    const deployCapability = (flyStatus.capabilities as Record<string, unknown>[]).find((entry) => entry.capability === 'deployment.create')!;
    assert.equal(deployCapability.executable, true, JSON.stringify(deployCapability.reasons));
    assert.ok((flyStatus.vocabulary as string[]).includes('service.restart'), 'unsupported capabilities are not offered');

    // Real git inspection: branch, HEAD, upstream, clean state, remote.
    const inspect = (await f.api<ActionRecord>(`/v1/projects/${project.id}/actions`, { method: 'POST', body: { capability: 'repository.inspect', environmentId: environment.id } })).body;
    const inspected = (await f.api<ActionRecord>(`/v1/actions/${inspect.id}/run`, { method: 'POST' })).body;
    assert.equal(inspected.status, 'succeeded', JSON.stringify(inspected.failure));
    const inspectEvidence = (await f.api<StructuredEvidence>(`/v1/runs/${inspected.runId}/evidence`)).body;
    assert.equal(inspectEvidence.providerResult?.metadata.head, repository.head);
    assert.equal(inspectEvidence.providerResult?.metadata.branch, 'main');
    assert.equal(inspectEvidence.providerResult?.metadata.dirty, false);
    assert.equal(inspectEvidence.providerResult?.metadata.remote, 'github:rkendel1/checkout');
    assert.match(inspected.verification?.find((check) => check.name === 'repository state observed')?.detail ?? '', /working tree clean/);

    // Real checkout of a requested revision: the workspace really moves, and HEAD is verified.
    const checkout = (await f.api<ActionRecord>(`/v1/projects/${project.id}/actions`, {
      method: 'POST', body: { capability: 'repository.checkout', parameters: { revision: repository.earlier } },
    })).body;
    const checkedOut = (await f.api<ActionRecord>(`/v1/actions/${checkout.id}/run`, { method: 'POST' })).body;
    assert.equal(checkedOut.status, 'succeeded', JSON.stringify(checkedOut.failure));
    assert.equal(checkedOut.execution?.observedRevision, repository.earlier, 'HEAD is the requested revision, observed by git');
    assert.equal(checkedOut.verification?.find((check) => check.name === 'resulting revision matches the requested one')?.status, 'passed');
    const bogus = (await f.api<ActionRecord>(`/v1/projects/${project.id}/actions`, { method: 'POST', body: { capability: 'repository.checkout', parameters: { revision: 'deadbeefdeadbeef' } } })).body;
    const notReached = (await f.api<ActionRecord>(`/v1/actions/${bogus.id}/run`, { method: 'POST' })).body;
    assert.equal(notReached.status, 'failed');
    assert.equal(notReached.outcome, 'execution-failed');
    assert.match(notReached.failure?.reason ?? '', /deadbeef|checkout|reference|not a/i, 'git\'s own reason is kept');
    // A credential-looking parameter is refused at the API.
    assert.equal((await f.api(`/v1/projects/${project.id}/actions`, { method: 'POST', body: { capability: 'repository.checkout', parameters: { apiKey: 'x' } } })).status, 400);

    // Build → test → deploy → health, as an Action Graph, each node real.
    const created = (await f.api<{ graph: { id: string }; actions: ActionRecord[] }>('/v1/action-graphs', {
      method: 'POST',
      body: {
        projectId: project.id, environmentId: environment.id,
        actions: [
          { key: 'build', capability: 'build.run' },
          { key: 'test', capability: 'test.run', dependsOn: ['build'] },
          { key: 'deploy', capability: 'deployment.create', dependsOn: ['test'] },
          { key: 'health', capability: 'environment.health', dependsOn: ['deploy'] },
        ],
      },
    })).body;
    const view = (await f.api<{ status: string; nodes: Record<string, unknown>[] }>(`/v1/action-graphs/${created.graph.id}/run`, { method: 'POST' })).body;
    assert.equal(view.status, 'completed', JSON.stringify(view.nodes.map((node) => [node.type, node.status, node.reason])));
    assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'one real deployment');
    const [build, testNode, deploy, probe] = created.actions;
    for (const node of created.actions) {
      const action = (await f.api<ActionRecord>(`/v1/actions/${node.id}`)).body;
      assert.equal(action.status, 'succeeded', `${node.type}: ${JSON.stringify(action.failure)}`);
      assert.ok(action.runId && action.authority?.authorizationDecisionId, `${node.type} was authorized on its own`);
      const run = (await f.api<RunRecord>(`/v1/runs/${action.runId}`)).body;
      assert.equal(run.status, 'completed');
      assert.equal(run.executionOwner, 'worker-ui');
      const evidence = (await f.api<StructuredEvidence>(`/v1/runs/${action.runId}/evidence`)).body;
      assert.ok(evidence.providerResult, `${node.type} has a provider result`);
      assert.equal(evidence.chain?.actionId, node.id);
      assert.equal(evidence.chain?.graphId, created.graph.id);
    }
    const buildEvidence = (await f.api<StructuredEvidence>(`/v1/runs/${(await f.api<ActionRecord>(`/v1/actions/${build!.id}`)).body.runId}/evidence`)).body;
    assert.deepEqual(buildEvidence.artifacts, ['dist'], 'the build really produced its artifact');
    const deployAction = (await f.api<ActionRecord>(`/v1/actions/${deploy!.id}`)).body;
    assert.equal(deployAction.execution?.providerOperationId, 'v7');
    assert.ok(deployAction.verification?.some((check) => check.name === 'environment responds healthy' && check.status === 'passed'));
    const probeAction = (await f.api<ActionRecord>(`/v1/actions/${probe!.id}`)).body;
    assert.match(probeAction.verification?.find((check) => check.name === 'environment responds healthy')?.detail ?? '', /HTTP 200/);
    assert.equal((await f.api<ActionRecord>(`/v1/actions/${testNode!.id}`)).body.outcome, 'succeeded');

    // Reality: the environment was reconciled from what happened.
    const reality = (await f.api<{ status: string; fields: { field: string; current: string | null }[] }>(`/v1/projects/${project.id}/environments/${environment.id}/reality`)).body;
    assert.equal(reality.status, 'reconciled');
    assert.equal(reality.fields.find((field) => field.field === 'health')?.current, 'healthy');
    assert.equal(reality.fields.find((field) => field.field === 'sourceCommit')?.current, repository.head.slice(0, 12));

    // Idempotency: running a succeeded Action again is the same durable execution.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = (await f.api<ActionRecord>(`/v1/actions/${deploy!.id}/run`, { method: 'POST' })).body;
      assert.equal(again.runId, deployAction.runId);
    }
    assert.deepEqual(fly.invocations(), ['deploy app=checkout-app'], 'no duplicate external operation');

    // The same work through the Operational Work contract reaches the same execution path.
    const work = (await f.api<OperationalWorkResult>('/v1/operational-work', {
      method: 'POST',
      body: { contract: OPERATIONAL_WORK_CONTRACT, origin: { system: 'attn', type: 'work', id: 'work_1' }, idempotencyKey: 'ship-1', project: project.id, environment: environment.id, actions: [{ verb: 'deploy' }] },
    })).body;
    assert.equal(work.status, 'completed', JSON.stringify(work.actions));
    assert.deepEqual(work.actions.map((node) => node.capability), ['build.run', 'test.run', 'deployment.create', 'environment.health']);
    assert.deepEqual(fly.invocations(), ['deploy app=checkout-app', 'deploy app=checkout-app'], 'the second real deployment came from operational work');
    const workDeploy = (await f.api<ActionRecord>(`/v1/actions/${work.actions[2]!.actionId}`)).body;
    // Identical execution shape: the same preflight, provider, operation, resource, verification names.
    assert.deepEqual(workDeploy.preflight?.checks.map((check) => check.name), deployAction.preflight?.checks.map((check) => check.name));
    assert.deepEqual([workDeploy.provider, workDeploy.operation, workDeploy.resource], [deployAction.provider, deployAction.operation, deployAction.resource]);
    assert.deepEqual(workDeploy.verification?.map((check) => check.name), deployAction.verification?.map((check) => check.name));
    const workEvidence = (await f.api<StructuredEvidence>(`/v1/runs/${workDeploy.runId}/evidence`)).body;
    assert.equal(workEvidence.chain?.operationalWorkId, work.workId);
    assert.equal(workEvidence.provider?.providerResource, 'fly:app:checkout-app');
    assert.equal(workEvidence.chain?.executionOwner, 'worker-ui');

    // A real provider failure: invoked, rejected, failed, dependents blocked, evidence kept.
    fly.setMode('reject');
    const failing = (await f.api<{ graph: { id: string }; actions: ActionRecord[] }>('/v1/action-graphs', {
      method: 'POST', body: { projectId: project.id, environmentId: environment.id, actions: [
        { key: 'deploy', capability: 'deployment.create' }, { key: 'health', capability: 'environment.health', dependsOn: ['deploy'] },
      ] },
    })).body;
    const failedView = (await f.api<{ status: string; failure: { outcome: string; reason: string }; nodes: Record<string, unknown>[] }>(`/v1/action-graphs/${failing.graph.id}/run`, { method: 'POST' })).body;
    assert.equal(failedView.status, 'failed');
    assert.equal(failedView.failure.outcome, 'execution-failed');
    assert.match(failedView.failure.reason, /invalid configuration/);
    assert.deepEqual(failedView.nodes.map((node) => node.status), ['failed', 'blocked']);
    assert.equal(fly.invocations().length, 3, 'the provider was actually invoked');
    const failedDeploy = (await f.api<ActionRecord>(`/v1/actions/${failing.actions[0]!.id}`)).body;
    assert.equal(failedDeploy.failure?.phase, 'provider');
    const failedEvidence = (await f.api<StructuredEvidence>(`/v1/runs/${failedDeploy.runId}/evidence`)).body;
    assert.equal(failedEvidence.providerResult?.status, 'rejected');
    assert.equal(failedEvidence.status, 'failed');
    fly.setMode('ok');

    // A verification failure: provider succeeded, environment unhealthy; both results are on the evidence.
    health.set(503);
    const unhealthy = (await f.api<ActionRecord>(`/v1/projects/${project.id}/actions`, { method: 'POST', body: { capability: 'deployment.create', environmentId: environment.id } })).body;
    const unverified = (await f.api<ActionRecord>(`/v1/actions/${unhealthy.id}/run`, { method: 'POST' })).body;
    assert.equal(unverified.status, 'failed');
    assert.equal(unverified.outcome, 'verification-failed');
    assert.equal(unverified.execution?.providerStatus, 'succeeded');
    const unverifiedEvidence = (await f.api<StructuredEvidence>(`/v1/runs/${unverified.runId}/evidence`)).body;
    assert.equal(unverifiedEvidence.providerResult?.status, 'succeeded');
    assert.equal(unverifiedEvidence.chain?.verification.find((check) => check.name === 'environment responds healthy')?.status, 'failed');
    assert.equal((await f.api<RunRecord>(`/v1/runs/${unverified.runId}`)).body.status, 'completed', 'the Run completed; the Action did not succeed');
    health.set(200);

    // Credentials never persist: Action, Run, contract, provider result, evidence, errors, output, pages.
    for (const runId of [deployAction.runId!, failedDeploy.runId!, unverified.runId!]) {
      const contract = await db(f.service).collection<ExecutionContractRecord>(COLLECTIONS.executionContracts).get(runId);
      const evidence = await db(f.service).collection<StructuredEvidence>(COLLECTIONS.evidence).get(runId);
      for (const [label, record] of [['contract', contract], ['evidence', evidence], ['run', (await f.api(`/v1/runs/${runId}`)).body]] as const) {
        assert.doesNotMatch(JSON.stringify(record), new RegExp(VALID_TOKEN), `${label} ${runId} holds no credential value`);
      }
    }
    for (const page of [`/factory/actions/${deployAction.id}`, `/factory/runs/${deployAction.runId}`, `/factory/graphs/${created.graph.id}`, '/factory/providers', `/factory/work/${work.workId}`]) {
      const response = await fetch(`${f.origin}${page}`);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), new RegExp(VALID_TOKEN));
    }
    const actionJson = JSON.stringify((await f.api(`/v1/actions/${deployAction.id}`)).body);
    assert.doesNotMatch(actionJson, new RegExp(VALID_TOKEN));

    // Authorization is asked for every execution, never remembered: the route asked AuthBoundry each time.
    const asked = log.filter((capability) => capability === 'factory.run').length;
    assert.ok(asked >= 8, `factory.run was asked per execution request (${asked})`);

    // Restart Factory and reopen everything: the same state, from durable records alone.
    const snapshot = {
      deploy: (await f.api(`/v1/actions/${deployAction.id}`)).body,
      graph: (await f.api(`/v1/action-graphs/${created.graph.id}`)).body,
      work: (await f.api(`/v1/operational-work/${work.workId}`)).body,
      failed: (await f.api(`/v1/actions/${failedDeploy.id}`)).body,
      unverified: (await f.api(`/v1/actions/${unverified.id}`)).body,
      evidence: (await f.api(`/v1/runs/${deployAction.runId}/evidence`)).body,
    };
    await f.stop();
    await f.service.shutdown();
    f = await factory(repository.path, workingDirectory, log);
    const reopened = {
      deploy: (await f.api(`/v1/actions/${deployAction.id}`)).body,
      graph: (await f.api(`/v1/action-graphs/${created.graph.id}`)).body,
      work: (await f.api(`/v1/operational-work/${work.workId}`)).body,
      failed: (await f.api(`/v1/actions/${failedDeploy.id}`)).body,
      unverified: (await f.api(`/v1/actions/${unverified.id}`)).body,
      evidence: (await f.api(`/v1/runs/${deployAction.runId}/evidence`)).body,
    };
    const stable = (value: unknown) => JSON.parse(JSON.stringify(value), (key, entry) => (key === 'updatedAt' ? undefined : entry));
    assert.deepEqual(stable(reopened), stable(snapshot), 'nothing about what happened lived in process memory');
    assert.equal((reopened.graph as { status: string }).status, 'completed');
    assert.equal((reopened.work as { status: string }).status, 'completed');
    assert.equal((reopened.evidence as StructuredEvidence).chain?.observedReality?.health, 'healthy');
    assert.deepEqual(fly.invocations().length, 4, 'a restart replayed nothing');
  } finally {
    process.env.PATH = previousPath;
    await f.stop().catch(() => {});
    await f.service.shutdown().catch(() => {});
    await health.close();
  }
});
