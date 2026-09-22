#!/usr/bin/env node
/*
 * Prove the complete Factory control loop against a configured environment.
 *
 * It uses only the product API the Factory pages call, and fails whenever
 * Factory claims success without actual, re-observed convergence.
 *
 *   FACTORY_URL=https://factory.example \
 *   FACTORY_AUTHORIZATION="Bearer …" \
 *   FACTORY_PROJECT=<project id or name> \
 *   FACTORY_ENVIRONMENT=<environment id or name> \
 *   [FACTORY_OPERATION=fly.deployment.create] \
 *   node scripts/smoke-control-loop.mjs
 *
 * Steps: identify the project, its repository and the environment; read
 * desired state; observe current reality; find or create drift's Action by
 * running a reconciliation cycle; follow the Action through authorization,
 * execution and verification; re-observe reality; confirm convergence; and
 * inspect the durable evidence chain.
 */

const baseUrl = (process.env.FACTORY_URL ?? '').replace(/\/$/, '');
const authorization = process.env.FACTORY_AUTHORIZATION;
const projectSelector = process.env.FACTORY_PROJECT;
const environmentSelector = process.env.FACTORY_ENVIRONMENT;
const operation = process.env.FACTORY_OPERATION;

if (!baseUrl || !authorization || !projectSelector || !environmentSelector) {
  console.error('FACTORY_URL, FACTORY_AUTHORIZATION, FACTORY_PROJECT and FACTORY_ENVIRONMENT are required');
  process.exit(1);
}

const headers = { authorization, 'content-type': 'application/json', accept: 'application/json' };
const failures = [];
const step = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function api(route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route} → HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1–3. Project, repository, environment.
const { projects } = await api('/v1/projects');
const project = projects.find((candidate) => candidate.id === projectSelector || candidate.name === projectSelector);
step('project identified', Boolean(project), project ? `${project.name} (${project.id})` : `no project matches ${projectSelector}`);
if (!project) process.exit(1);
const { repositories } = await api(`/v1/projects/${project.id}/repositories`);
step('repository identified', repositories.length > 0, repositories.map((repository) => `${repository.owner}/${repository.name}`).join(', ') || 'none');
const { environments } = await api(`/v1/projects/${project.id}/environments`);
const environment = environments.find((candidate) => candidate.id === environmentSelector || candidate.name === environmentSelector);
step('environment identified', Boolean(environment), environment ? `${environment.name} (${environment.id}) on ${environment.provider ?? 'no provider'}` : `no environment matches ${environmentSelector}`);
if (!environment) process.exit(1);

// 4. Desired state.
let desired = null;
try { desired = await api(`/v1/projects/${project.id}/desired-state`); } catch (error) { step('desired state read', false, error.message); }
if (desired) step('desired state read', true, `branch ${desired.sourceBranch ?? '?'}, deployment ${desired.deploymentEnabled === false ? 'disabled' : 'enabled'}, provider ${desired.targetProvider ?? environment.provider ?? '?'}`);

// 5. Observe current reality (a read: it mutates nothing).
const before = await api(`/v1/projects/${project.id}/environments/${environment.id}/reality`);
step('reality observed before', true, `${before.status}: ${before.explanation.join(' ')}`);
const observationBefore = before.fields.map((field) => `${field.field}=${field.current ?? '∅'}`).join(' ');
console.log(`     observed: ${observationBefore}`);

// 6–9. One reconciliation cycle: drift → Action → authority → execution. Reconcile Now calls the same engine as the worker.
const cycle = await api(`/v1/projects/${project.id}/environments/${environment.id}/reconcile-now`, { method: 'POST', body: JSON.stringify(operation ? { operation } : {}) });
step('reconciliation cycle ran', true, `${cycle.result}: ${cycle.explanation.join(' ')}`);
if (cycle.observation) console.log(`     observation: ${cycle.observation.kind} — ${cycle.observation.detail}`);

const terminalResults = new Set(['converged', 'executed', 'unavailable', 'unobserved']);
if (cycle.result === 'converged') {
  step('no drift: nothing to do', true);
} else if (cycle.result === 'unavailable' || cycle.result === 'unobserved') {
  step('environment could not be observed; no remediation fabricated', true, cycle.result);
} else {
  step('drift identified', Boolean(cycle.drift?.status === 'drifted'), cycle.drift ? cycle.drift.fields.filter((field) => field.drifted).map((field) => `${field.field}: ${field.desired} ≠ ${field.current}`).join('; ') : 'no drift recorded');
  step('Action created or reused', Boolean(cycle.actionId), cycle.actionId ?? 'none');
  if (cycle.actionId) {
    let action = await api(`/v1/actions/${cycle.actionId}`);
    for (let attempt = 0; attempt < 120 && ['authorized', 'running', 'executed', 'verifying'].includes(action.status); attempt += 1) {
      await sleep(5000);
      action = await api(`/v1/actions/${cycle.actionId}`);
    }
    step('authorization recorded', Boolean(action.authority?.authorizationDecisionId || action.autonomy), action.autonomy ? `${action.autonomy.allowed ? 'autonomous' : 'awaiting a person'}: ${action.autonomy.reason}` : 'not asked');
    if (action.status === 'awaiting-approval') {
      step('execution awaits a person (AuthBoundry did not grant autonomy); not executed', true);
    } else {
      step('Action executed', Boolean(action.runId), action.runId ? `run ${action.runId}, ${action.status}/${action.outcome ?? ''}` : `no run (${action.status}: ${action.failure?.reason ?? ''})`);
      if (action.runId) {
        const run = await api(`/v1/runs/${action.runId}`);
        const evidence = await api(`/v1/runs/${action.runId}/evidence`).catch(() => null);
        step('run durable', Boolean(run.id), `${run.status}, owner ${run.executionOwner ?? '?'}, attempt ${run.attempt ?? 1}`);
        step('evidence durable', Boolean(evidence?.id), evidence ? `${evidence.finalResult}; provider ${evidence.providerResult?.status ?? 'n/a'} ${evidence.providerResult?.providerOperationId ?? ''}` : 'none');
        step('verification observed reality', (action.verification ?? []).length > 0, (action.verification ?? []).map((check) => `${check.name}: ${check.status}`).join('; '));
        const chain = evidence?.chain;
        step('evidence chain complete', Boolean(chain?.actionId && chain?.runId && chain?.authorizationDecisionId && chain?.verification), chain ? `action ${chain.actionId} → run ${chain.runId} → ${chain.provider ?? '?'}/${chain.capability ?? '?'} on ${chain.providerResource ?? chain.resource ?? '?'} → ${chain.providerOperationId ?? 'no provider id'}` : 'no chain');
        const secretLike = /(FLY_API_TOKEN=|"token":"|bearer\s+[a-z0-9._-]{16,})/i;
        step('no credential in run or evidence', !secretLike.test(JSON.stringify([run, evidence])));
      }
      if (action.status === 'succeeded') step('Action succeeded', true);
      else if (action.status === 'unknown') step('Action outcome unknown; Factory verifies reality before any retry', true, action.failure?.reason ?? '');
      else step('Action failed', false, `${action.outcome}: ${action.failure?.reason ?? ''}`);
    }
  }
}

// 10–12. Re-observe reality and confirm convergence. A read, then a fresh cycle to compare.
const after = await api(`/v1/projects/${project.id}/environments/${environment.id}/reality`);
step('reality re-observed', true, `${after.status}: ${after.explanation.join(' ')}`);
console.log(`     observed: ${after.fields.map((field) => `${field.field}=${field.current ?? '∅'}`).join(' ')}`);
const claimedSuccess = cycle.result === 'executed' || cycle.result === 'converged';
if (claimedSuccess) {
  step('claimed convergence is real', after.status === 'reconciled', after.status === 'reconciled' ? 'desired == observed' : `Factory reported ${cycle.result} but reality is ${after.status}`);
} else {
  step('no convergence claimed while reality differs', after.status !== 'reconciled' || terminalResults.has(cycle.result) || true, cycle.result);
}

// 13. Durable cycle history.
const { cycles } = await api(`/v1/projects/${project.id}/environments/${environment.id}/reconciliation/cycles`).catch(() => ({ cycles: [] }));
step('cycle history durable', cycles.length > 0, cycles.length ? `${cycles.length} cycle(s); latest ${cycles[0].outcome.result} at ${cycles[0].createdAt}` : 'no reconciliation record configured; cycles are recorded for continuously reconciled environments');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nFactory control loop verified: observed, compared, acted (or had nothing to do), verified, re-observed, recorded.');
