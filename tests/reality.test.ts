import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FactoryService } from '../src/server.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { factoryAssociation } from '../src/association.js';
import { loadFactoryFlow } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY } from '../src/association.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe } from '../src/auth.js';

const TENANT = 'tenant-a';
const PRINCIPAL = 'agent:factory-service';

function declared() {
  return factoryAssociation(loadFactoryFlow());
}

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
        principal: PRINCIPAL, tenant: TENANT, claims: {}, session: { id: 'session-1' },
        delegation: null, boundaryVerified: true,
        authorizedCapabilities: [...declared().capabilities, 'factory.run'],
        authority: 'delegated', delegationId: associationDelegationId(TENANT),
      };
    },
  };
}

/** AuthBoundry's answer about autonomy, as a probe rather than a Factory rule. */
function probeFor(allowed: boolean): CapabilityProbe {
  return async (capability) => ({
    allowed: allowed && capability === AUTONOMOUS_EXECUTION_CAPABILITY,
    reason: allowed ? `AuthBoundry authorized ${capability}` : `AuthBoundry denied operation ${capability}`,
  });
}

/** A git checkout, so the observed head commit is a real one. */
async function gitRepository(root: string): Promise<{ path: string; commit: string }> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
    'fly.toml': "app = 'app'\n",
  });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repositoryPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return { path: repositoryPath, commit: git('rev-parse', 'HEAD') };
}

async function service(repositoryRoot: string): Promise<FactoryService> {
  const workingDirectory = await createTempWorkspace('factory-reality');
  const instance = await FactoryService.create({
    mode: 'local',
    namespace: path.basename(workingDirectory),
    workingDirectory,
    flowPath: path.resolve(process.cwd(), '.flow'),
    repositoryRoot,
    workspaceRoot: path.join(workingDirectory, 'workspaces'),
    environmentId: 'test',
    appportPath: path.join(workingDirectory, 'appport-services'),
    authenticator: authenticator(),
    authBoundryTenantId: TENANT,
    authBoundryControlPlane: controlPlane(),
  });
  await instance.refreshConnection();
  return instance;
}

async function project(instance: FactoryService, repositoryRoot: string) {
  const context = await instance.authenticator().authenticate({ headers: {} } as never, 'factory.ui.read');
  const domain = instance.projects();
  const record = await domain.createProject({ tenantId: TENANT, name: 'PNA' });
  const repository = await domain.addRepository(TENANT, record.id, { owner: 'rkendel1', name: 'app' });
  const environment = await domain.createEnvironment(TENANT, record.id, { name: 'production', provider: 'fly' });
  await domain.putDesiredState(TENANT, record.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
    targetProvider: 'fly', healthRequirement: 'health endpoint returns 200',
  });
  return { context, domain, record, repository, environment, repositoryRoot };
}

test('an environment nothing has reconciled reports unknown rather than drift', async () => {
  const root = await createTempWorkspace('reality-unknown');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, record, environment } = await project(instance, repository.path);

  const [report] = await instance.observeReality(context, record.id);
  assert.equal(report?.environmentId, environment.id);
  assert.equal(report?.status, 'unknown');
  assert.equal(report?.proposal, null, 'an unobserved environment proposes no action');
  assert.match(report!.explanation[0]!, /has not observed production yet/);

  // Reality still reports what it can see, and marks what it cannot.
  const commit = report!.fields.find((field) => field.field === 'sourceCommit')!;
  assert.equal(commit.desired, repository.commit.slice(0, 12), 'the repository head is observed');
  assert.equal(commit.current, null, 'nothing has been deployed, so there is no current commit');
  assert.equal(commit.drifted, false, 'an unknown current value is not drift');
});

test('reconciling an environment records reality from the run evidence', async () => {
  const root = await createTempWorkspace('reality-reconcile');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, domain, record, environment } = await project(instance, repository.path);

  const planned = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, probeFor(true));
  const ran = await instance.runAction(context, planned.id, { probe: probeFor(true), autonomous: true });
  assert.equal(ran.status, 'succeeded', JSON.stringify(ran.verification));

  // Current state is written from what happened, never copied from desire.
  const observed = (await domain.getEnvironment(TENANT, record.id, environment.id))!.currentState!;
  assert.equal(observed.reconciledRunId, ran.runId);
  assert.ok(observed.reconciledEvidenceId, 'reconciliation points at the durable evidence');
  assert.equal(observed.sourceCommit, repository.commit);
  // Nothing probed the environment, so health is unobserved rather than assumed.
  assert.equal(observed.health, 'unknown');

  const [report] = await instance.observeReality(context, record.id);
  assert.equal(report?.status, 'reconciled');
  assert.deepEqual(report?.explanation, ['production matches its desired state.']);
  assert.equal(report?.proposal, null);
});

test('a new repository commit drifts production and explains why', async () => {
  const root = await createTempWorkspace('reality-drift');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, record, environment } = await project(instance, repository.path);

  const planned = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, probeFor(true));
  const deployed = await instance.runAction(context, planned.id, { probe: probeFor(true), autonomous: true });
  assert.equal(deployed.status, 'succeeded');

  // The repository moves on. Nothing about Factory's records changes.
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repository.path,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
  execFileSync('sh', ['-c', `echo '// change' >> ${repository.path}/package.json`]);
  git('add', '-A');
  git('commit', '-qm', 'second');
  const head = git('rev-parse', 'HEAD');
  assert.notEqual(head, repository.commit);

  const [report] = await instance.observeReality(context, record.id);
  assert.equal(report?.status, 'drifted');
  const commit = report!.fields.find((field) => field.field === 'sourceCommit')!;
  assert.equal(commit.drifted, true);
  assert.equal(commit.current, repository.commit.slice(0, 12));
  assert.equal(commit.desired, head.slice(0, 12));
  assert.equal(
    report!.explanation[0],
    `production is running ${repository.commit.slice(0, 12)}. Repository main is ${head.slice(0, 12)}.`,
  );
  assert.ok(report!.proposal, 'drift proposes an action');
  assert.match(report!.proposal!.intent, /Reconcile production to/);
});

test('reconciliation plans an Action that carries the drift it exists to close', async () => {
  const root = await createTempWorkspace('reality-plan');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, record, environment } = await project(instance, repository.path);

  // Nothing has run, so there is nothing to reconcile.
  const quiet = await instance.planReconciliation(context, record.id, environment.id, { probe: probeFor(true) });
  assert.equal(quiet.action, null, 'an unobserved environment plans no action');
  assert.equal(quiet.drift.status, 'unknown');

  const first = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, probeFor(true));
  await instance.runAction(context, first.id, { probe: probeFor(true), autonomous: true });

  // Matching reality still plans nothing: reconciliation is the absence of work.
  const matched = await instance.planReconciliation(context, record.id, environment.id, { probe: probeFor(true) });
  assert.equal(matched.drift.status, 'reconciled');
  assert.equal(matched.action, null);

  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repository.path,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
  execFileSync('sh', ['-c', `echo '// change' >> ${repository.path}/fly.toml`]);
  git('add', '-A');
  git('commit', '-qm', 'third');

  const planned = await instance.planReconciliation(context, record.id, environment.id, { probe: probeFor(true) });
  assert.equal(planned.drift.status, 'drifted');
  assert.ok(planned.action);
  assert.equal(planned.action!.environmentId, environment.id);
  assert.match(planned.action!.intent, /Reconcile production to/);
  assert.equal(planned.action!.drift?.status, 'drifted');
  assert.ok(planned.action!.drift!.explanation.some((line) => /is running/.test(line)),
    'the action records why it exists');
  assert.ok(planned.action!.plan.length > 0);
});

test('autonomy is the authority\'s decision, not a Factory rule', async () => {
  const root = await createTempWorkspace('reality-autonomy');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, record, environment } = await project(instance, repository.path);

  // Denied autonomy puts the Action in front of a person.
  const gated = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, probeFor(false));
  assert.equal(gated.status, 'awaiting-approval');
  assert.equal(gated.autonomy?.capability, AUTONOMOUS_EXECUTION_CAPABILITY);
  assert.equal(gated.autonomy?.allowed, false);
  assert.match(gated.autonomy!.reason, /denied/);

  // Factory acting on its own is refused.
  await assert.rejects(
    () => instance.runAction(context, gated.id, { probe: probeFor(false), autonomous: true }),
    /may not execute autonomously/,
  );
  assert.equal((await instance.projects().getAction(TENANT, gated.id))?.status, 'awaiting-approval');

  // A person driving it is the judgement the authority asked for.
  const approved = await instance.runAction(context, gated.id, { probe: probeFor(false) });
  assert.equal(approved.status, 'succeeded', JSON.stringify(approved.verification));
  assert.equal(approved.approvedBy, PRINCIPAL);

  // Granted autonomy needs no person, and nothing about the project changed.
  const free = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, probeFor(true));
  assert.equal(free.status, 'planned');
  assert.equal(free.autonomy?.allowed, true);
  const ran = await instance.runAction(context, free.id, { probe: probeFor(true), autonomous: true });
  assert.equal(ran.status, 'succeeded');
  assert.equal(ran.approvedBy, undefined, 'an autonomous run records no human approver');
});

test('an Action planned with no authority to ask waits for a person', async () => {
  const root = await createTempWorkspace('reality-noprobe');
  const repository = await gitRepository(root);
  const instance = await service(repository.path);
  const { context, record, environment } = await project(instance, repository.path);

  // No probe means Factory could not ask. The safe answer is the default.
  const action = await instance.createAction(context, record.id, {
    type: 'repo-echo', environmentId: environment.id,
  });
  assert.equal(action.status, 'awaiting-approval');
  assert.equal(action.autonomy?.allowed, false);
  assert.match(action.autonomy!.reason, /no AuthBoundry session/);
});
