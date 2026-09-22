import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FactoryService } from '../src/server.js';
import { createReconciliationScheduler } from '../src/scheduler.js';
import { createRepository, createTempWorkspace } from './helpers.js';
import { AUTONOMOUS_EXECUTION_CAPABILITY, factoryAssociation } from '../src/association.js';
import { loadFactoryFlow, COLLECTIONS } from '../src/felt.js';
import { associationDelegationId } from '../src/provisioning.js';
import { parseInterval, reconciliationFingerprint, MINIMUM_INTERVAL_MS } from '../src/reconciliation.js';
import type { AuthBoundryControlPlane } from '../src/provisioning.js';
import type { Authenticator, CapabilityProbe, AuthenticatedContext } from '../src/auth.js';
import type { ReconciliationRecord, StructuredEvidence } from '../src/types.js';

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

/** AuthBoundry's answers, as probes rather than Factory rules. */
const grants: CapabilityProbe = async (capability) => ({
  allowed: capability === AUTONOMOUS_EXECUTION_CAPABILITY,
  reason: `AuthBoundry authorized ${capability}`,
});
const denies: CapabilityProbe = async (capability) => ({
  allowed: false, reason: `AuthBoundry denied operation ${capability}`,
});
const unavailable: CapabilityProbe = async () => ({
  allowed: false, reason: 'AuthBoundry unavailable: connect ECONNREFUSED',
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: 'pipe',
  }).toString().trim();
}

async function gitRepository(root: string): Promise<{ path: string; commit: string }> {
  const repositoryPath = await createRepository(root, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3 }),
    '.github/workflows/deploy.yml': 'name: deploy\non: push\n',
    'fly.toml': "app = 'app'\n",
  });
  git(repositoryPath, 'init', '-q', '-b', 'main');
  git(repositoryPath, 'add', '-A');
  git(repositoryPath, 'commit', '-qm', 'initial');
  return { path: repositoryPath, commit: git(repositoryPath, 'rev-parse', 'HEAD') };
}

function commitChange(repositoryPath: string, file: string): string {
  execFileSync('sh', ['-c', `echo '# change' >> ${repositoryPath}/${file}`]);
  git(repositoryPath, 'add', '-A');
  git(repositoryPath, 'commit', '-qm', `change ${Date.now()}`);
  return git(repositoryPath, 'rev-parse', 'HEAD');
}

async function factory(repositoryRoot: string, options: { workingDirectory?: string; tenant?: string } = {}) {
  const workingDirectory = options.workingDirectory ?? await createTempWorkspace('factory-continuous');
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
  const project = await domain.createProject({ tenantId: TENANT, name: 'PNA' });
  const repository = await domain.addRepository(TENANT, project.id, { owner: 'rkendel1', name: 'app' });
  const environment = await domain.createEnvironment(TENANT, project.id, { name: 'production', provider: 'fly' });
  await domain.putDesiredState(TENANT, project.id, {
    sourceRepositoryId: repository.id, sourceBranch: 'main', deploymentEnabled: false,
    targetProvider: 'fly', healthRequirement: 'health endpoint returns 200',
  });
  return { service, context, domain, project, environment, workingDirectory };
}

/** Bring the environment to a reconciled state so later drift is real drift. */
async function converge(service: FactoryService, context: AuthenticatedContext, projectId: string, environmentId: string) {
  const action = await service.createAction(context, projectId, { type: 'repo-echo', environmentId }, grants);
  const ran = await service.runAction(context, action.id, { probe: grants, autonomous: true });
  assert.equal(ran.status, 'succeeded', JSON.stringify(ran.verification));
  return ran;
}

test('interval configuration is clamped rather than trusted', async () => {
  assert.deepEqual(parseInterval('15m'), { interval: '15m', intervalMs: 900_000 });
  assert.equal(parseInterval(undefined).interval, '15m');
  for (const bad of ['1s', '30s', '0m', 'soon', '5', '2w', '99d']) {
    assert.throws(() => parseInterval(bad), /interval/, `${bad} must be refused`);
  }
  assert.equal(parseInterval('1m').intervalMs, MINIMUM_INTERVAL_MS);
});

test('a converged environment reconciles to no Action and no Run', async () => {
  const root = await createTempWorkspace('continuous-converged');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);

  const before = (await domain.listActions(TENANT, project.id)).length;
  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  assert.equal(outcome.result, 'converged');
  assert.equal(outcome.actionId, undefined);
  assert.equal(outcome.runId, undefined);
  assert.equal((await domain.listActions(TENANT, project.id)).length, before, 'no Action was created');
  assert.deepEqual(outcome.explanation, ['production matches its desired state.']);
});

test('an unobserved environment reconciles without inventing drift', async () => {
  const root = await createTempWorkspace('continuous-unknown');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);

  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  assert.equal(outcome.result, 'unobserved');
  assert.equal(outcome.actionId, undefined);
  assert.equal(outcome.observedStateRevision, 'unobserved');
  assert.deepEqual(await domain.listActions(TENANT, project.id), []);
});

test('drift creates exactly one Action however often reconciliation repeats', async () => {
  const root = await createTempWorkspace('continuous-idempotent');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  commitChange(repository.path, 'fly.toml');

  // Deny autonomy so the Action stays open and a repeat pass must recognise it.
  const first = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  assert.equal(first.result, 'autonomy-denied');
  assert.ok(first.actionId);
  assert.ok(first.fingerprint);

  const second = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  assert.equal(second.result, 'awaiting-approval', 'the open Action is adopted, not duplicated');
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.fingerprint, first.fingerprint);

  const reconciliationActions = (await domain.listActions(TENANT, project.id))
    .filter((action) => action.origin === 'continuous-reconciliation');
  assert.equal(reconciliationActions.length, 1, 'repeated passes produce one Action');

  // The fingerprint is derived from the work, not from when it was planned.
  assert.equal(first.fingerprint, reconciliationFingerprint({
    projectId: project.id,
    environmentId: environment.id,
    desiredStateRevision: first.desiredStateRevision!,
    observedStateRevision: first.observedStateRevision!,
    actionType: 'repo-echo',
  }));
});

test('an authorized autonomous pass executes, verifies, and reconciles reality', async () => {
  const root = await createTempWorkspace('continuous-autonomous');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  const head = commitChange(repository.path, 'package.json');

  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  assert.equal(outcome.result, 'executed', JSON.stringify(outcome.explanation));
  assert.ok(outcome.runId);
  assert.equal(outcome.autonomy?.allowed, true);
  assert.equal(outcome.authority?.application, 'factory');
  assert.equal(outcome.authority?.delegation, associationDelegationId(TENANT));
  assert.ok(outcome.explanation.some((line) => /AuthBoundry authorized autonomous execution/.test(line)));

  // Reality converged, and the next pass has nothing to do.
  const state = (await domain.getEnvironment(TENANT, project.id, environment.id))!.currentState!;
  assert.equal(state.sourceCommit, head);
  const action = await domain.getAction(TENANT, outcome.actionId!);
  assert.equal(action?.origin, 'continuous-reconciliation');
  assert.equal(action?.approvedBy, undefined, 'an autonomous pass records no human approver');
  assert.equal(
    (await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants })).result,
    'converged',
  );
});

test('denial and unavailability are distinct, and both leave the Action for a person', async () => {
  const root = await createTempWorkspace('continuous-denied');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  commitChange(repository.path, 'fly.toml');

  const denied = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  assert.equal(denied.result, 'autonomy-denied');
  assert.equal((await domain.getAction(TENANT, denied.actionId!))?.status, 'awaiting-approval');
  assert.ok(denied.explanation.some((line) => /denied autonomous execution/.test(line)));

  // A person approving is the judgement the authority asked for.
  const approved = await service.runAction(context, denied.actionId!, { probe: denies });
  assert.equal(approved.status, 'succeeded', JSON.stringify(approved.verification));
  assert.equal(approved.approvedBy, PRINCIPAL);

  // An unreachable authority is reported apart from a refusal.
  commitChange(repository.path, 'package.json');
  const offline = await service.reconcileEnvironment(context, project.id, environment.id, { probe: unavailable });
  assert.equal(offline.result, 'authority-unavailable');
  assert.notEqual(offline.result, denied.result, 'unavailable is not collapsed into denied');
  assert.equal((await domain.getAction(TENANT, offline.actionId!))?.status, 'awaiting-approval');
  assert.ok(offline.explanation.some((line) => /could not be reached/.test(line)));
});

test('authority is re-checked at execution time, so a revoked grant stops the run', async () => {
  const root = await createTempWorkspace('continuous-revoked');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);

  // Planned while autonomy was granted.
  const action = await service.createAction(context, project.id, {
    type: 'repo-echo', environmentId: environment.id,
  }, grants);
  assert.equal(action.status, 'planned');
  assert.equal(action.autonomy?.allowed, true);

  // The grant is revoked before it runs. The stored answer is not trusted.
  await assert.rejects(
    () => service.runAction(context, action.id, { probe: denies, autonomous: true }),
    /may not execute autonomously/,
  );
  const stopped = await domain.getAction(TENANT, action.id);
  assert.equal(stopped?.status, 'awaiting-approval');
  assert.equal(stopped?.autonomy?.allowed, false);
  assert.equal(stopped?.runId, undefined, 'no run started under a revoked grant');
});

test('reconciliation configuration and history survive a restart', async () => {
  const root = await createTempWorkspace('continuous-restart');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment, workingDirectory } = await scenario(repository.path);

  const configured = await service.configureReconciliation(context, project.id, environment.id, { interval: '15m' });
  assert.equal(configured.enabled, true);
  assert.equal(configured.intervalMs, 900_000);
  await converge(service, context, project.id, environment.id);
  const pass = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  await service.recordReconciliationOutcome(configured, pass);
  await service.shutdown();

  const restarted = await factory(repository.path, { workingDirectory });
  await restarted.service.refreshConnection();
  const record = await restarted.service.projects().getReconciliation(TENANT, project.id, environment.id);
  assert.equal(record?.id, configured.id, 'the same record, not a new one');
  assert.equal(record?.enabled, true);
  assert.equal(record?.interval, '15m');
  assert.equal(record?.status, 'healthy');
  assert.ok(record?.lastObservedAt, 'observation history survived');
  assert.ok(record?.nextDueAt, 'the schedule survived');

  // Restarting reconciles nothing by itself: the record is not yet due.
  const worker = createReconciliationScheduler({
    service: restarted.service,
    context: async () => context,
    probe: grants,
    now: () => Date.parse(record!.nextDueAt!) - 60_000,
  });
  assert.deepEqual(await worker.tick(), [], 'a record that is not due is not run at startup');
  await restarted.service.shutdown();
});

test('the worker runs due records, skips disabled ones, and reschedules', async () => {
  const root = await createTempWorkspace('continuous-worker');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  const record = await service.configureReconciliation(context, project.id, environment.id, { interval: '15m' });

  const worker = createReconciliationScheduler({
    service, context: async () => context, probe: grants, now: () => Date.now(),
  });
  const handled = await worker.tick();
  assert.deepEqual(handled.map((entry) => entry.id), [record.id]);
  assert.equal(handled[0]?.status, 'healthy');
  assert.equal(handled[0]?.leaseOwner, undefined, 'the claim is released when the pass ends');
  assert.ok(handled[0]?.nextDueAt);
  assert.ok(Date.parse(handled[0]!.nextDueAt!) > Date.now(), 'the record is rescheduled, not left due');

  // Immediately ticking again does nothing: it is no longer due.
  assert.deepEqual(await worker.tick(), []);

  // A disabled record is never claimed, however overdue.
  await service.configureReconciliation(context, project.id, environment.id, { enabled: false });
  const later = createReconciliationScheduler({
    service, context: async () => context, probe: grants, now: () => Date.now() + 86_400_000,
  });
  assert.deepEqual(await later.tick(), [], 'disabled reconciliation does not run');
  assert.equal(
    (await service.projects().getReconciliation(TENANT, project.id, environment.id))?.status,
    'disabled',
  );
});

test('two workers cannot claim the same reconciliation', async () => {
  const root = await createTempWorkspace('continuous-lease');
  const repository = await gitRepository(root);
  const { service, context, project, environment } = await scenario(repository.path);
  const record = await service.configureReconciliation(context, project.id, environment.id, { interval: '15m' });
  const domain = service.projects();
  const now = Date.now();

  const first = await domain.claimReconciliation(record.id, 'worker-a', now, 60_000);
  assert.ok(first, 'the first worker claims it');
  assert.equal(first?.leaseOwner, 'worker-a');
  assert.equal(first?.status, 'running');

  const second = await domain.claimReconciliation(record.id, 'worker-b', now, 60_000);
  assert.equal(second, null, 'a held claim is refused');
  assert.deepEqual(await domain.dueReconciliations(now), [], 'a leased record is not offered again');

  // An expired lease is reclaimable, so a worker that died does not block it.
  const reclaimed = await domain.claimReconciliation(record.id, 'worker-c', now + 120_000, 60_000);
  assert.equal(reclaimed?.leaseOwner, 'worker-c');

  await domain.releaseReconciliation(record.id, { status: 'healthy' });
  const released = await domain.getReconciliation(TENANT, project.id, environment.id);
  assert.equal(released?.leaseOwner, undefined);
});

test('reconciliation evidence explains the whole chain', async () => {
  const root = await createTempWorkspace('continuous-evidence');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  commitChange(repository.path, 'package.json');

  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: grants });
  assert.equal(outcome.result, 'executed');

  // The outcome names desired state, observed reality, action, run and authority.
  assert.ok(outcome.desiredStateRevision);
  assert.ok(outcome.observedStateRevision);
  assert.ok(outcome.actionId && outcome.runId && outcome.evidenceId);

  const action = (await domain.getAction(TENANT, outcome.actionId!))!;
  assert.equal(action.projectId, project.id);
  assert.equal(action.environmentId, environment.id);
  assert.ok(action.drift?.explanation.some((line) => /is running/.test(line)));

  // The durable evidence is the existing FeltDB record, not a second store.
  const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  const evidence = await db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(outcome.runId!);
  assert.equal(evidence?.id, outcome.evidenceId);
  assert.equal(evidence?.authorizedApplication?.applicationId, 'factory');
  assert.equal(evidence?.authorizedApplication?.principalId, PRINCIPAL);
  assert.equal(evidence?.authorizedApplication?.delegationId, associationDelegationId(TENANT));
  assert.equal(evidence?.finalResult, 'PASS');

  const run = await domain.getRun(TENANT, outcome.runId!);
  assert.equal(run?.actionId, action.id);
  assert.equal(run?.projectId, project.id);
  assert.equal(run?.environmentId, environment.id);
});

test('reconciliation records are isolated by tenant, project and environment', async () => {
  const root = await createTempWorkspace('continuous-isolation');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await service.configureReconciliation(context, project.id, environment.id, { interval: '15m' });

  const other = await domain.createProject({ tenantId: TENANT, name: 'Other' });
  const otherEnvironment = await domain.createEnvironment(TENANT, other.id, { name: 'staging' });
  await service.configureReconciliation(context, other.id, otherEnvironment.id, { interval: '30m' });

  assert.equal((await domain.listReconciliations(TENANT)).length, 2);
  assert.equal((await domain.listReconciliations(TENANT, project.id)).length, 1);
  assert.equal((await domain.listReconciliations('tenant-b')).length, 0, 'another tenant sees none');
  assert.equal(await domain.getReconciliation('tenant-b', project.id, environment.id), null);
  assert.equal(
    await domain.getReconciliation(TENANT, project.id, otherEnvironment.id),
    null,
    'an environment of another project is not reachable through this one',
  );

  const view = await service.reconciliationView(context, project.id);
  assert.equal(view.environments.length, 1);
  assert.equal(view.environments[0]!.environmentId, environment.id);
});

test('reconciliation planning records the repository knowledge it used', async () => {
  const root = await createTempWorkspace('continuous-knowledge');
  const repository = await gitRepository(root);
  const { service, context, domain, project, environment } = await scenario(repository.path);
  await converge(service, context, project.id, environment.id);
  commitChange(repository.path, 'fly.toml');

  const outcome = await service.reconcileEnvironment(context, project.id, environment.id, { probe: denies });
  const action = (await domain.getAction(TENANT, outcome.actionId!))!;

  // Workflow YAML is discovered and recorded, never executed.
  assert.ok(action.discovery?.files.includes('.github/workflows/deploy.yml'));
  assert.ok(action.discovery?.signals.headCommit, 'the commit that produced the plan is recorded');
  assert.equal(action.discovery?.signals.packageManager, 'npm');
  assert.ok(action.plan.every((step) => !/\.ya?ml/.test(step.summary)),
    'no plan step executes workflow YAML');
  // Each step cites the file or desired-state field it came from.
  assert.ok(action.plan.some((step) => step.basis === 'package.json'));
  assert.ok(action.plan.every((step) => step.basis === undefined || typeof step.basis === 'string'));
  assert.equal(action.executionProvider, 'native', 'execution goes through a .flow provider');
});
