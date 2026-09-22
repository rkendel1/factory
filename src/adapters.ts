import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FlowSpec } from '@feltdb/core';
import { getOperationAuthorities, type OperationAuthority } from './authority.js';
import {
  capabilityResourceKind,
  isOperationalCapability,
  REQUIRED_VERIFICATION,
  type OperationalCapability,
} from './capabilities.js';
import type {
  ActionRecord,
  DesiredStateRecord,
  EnvironmentRecord,
  ProviderExecution,
  ProviderExecutionResult,
  RepositoryDiscovery,
  RepositoryRecord,
  StructuredEvidence,
  VerificationCheck,
} from './types.js';

/**
 * The provider boundary.
 *
 * Factory coordinates an Action; an adapter knows how to talk to one external
 * system. An adapter binds a resource, hands the execution boundary what to
 * run, reads the provider's answer back into a structured result, and verifies
 * against reality. It creates no Actions, no Runs and no Evidence, authorizes
 * nothing, holds no cache, and schedules nothing: it has nothing Factory did
 * not give it and produces nothing Factory does not record.
 */
export interface ProviderContext {
  repository: RepositoryRecord | null;
  environment: EnvironmentRecord | null;
  desiredState: DesiredStateRecord | null;
  discovery: RepositoryDiscovery | null;
  /** The durable identity the provider operation is keyed on. */
  idempotencyKey: string;
}

export interface ProviderPlan {
  provider: string;
  capability: OperationalCapability;
  operation: string;
  resource: string;
  expectedEffects: string[];
  verification: string[];
  requiredAuthority: string[];
  parameters: Record<string, string>;
}

/**
 * A Factory resource bound to the provider's own resource.
 *
 * `environment:production` means nothing to Fly; `fly:app:checkout-app` does.
 * The binding comes from durable project and environment configuration, never
 * from a caller naming a provider identifier directly.
 */
export type ResourceBinding =
  | { ok: true; id: string; detail: string; parameters: Record<string, string> }
  | { ok: false; reason: string };

export interface Observation {
  outcome: 'established' | 'absent' | 'undetermined' | 'retry-safe';
  detail: string;
  checks: VerificationCheck[];
  observed: ProviderExecutionResult['observed'];
}

/** Read-only and ephemeral operations leave nothing behind, so repeating them is safe. */
async function retrySafe(capability: OperationalCapability, why: string): Promise<Observation> {
  return { outcome: 'retry-safe', detail: `${capability} ${why}; repeating it is safe`, checks: [], observed: {} };
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** The capabilities this adapter actually implements. Nothing else is claimed. */
  readonly capabilities: readonly OperationalCapability[];
  /** Credentials the adapter needs, by name. Values are never its business. */
  readonly credentials: readonly string[];
  /** Whether the adapter can reach the mechanism a capability needs from this process. */
  availability(capability?: OperationalCapability): Promise<{ state: 'available' | 'unavailable'; detail: string }>;
  /** Bind the Factory resource to the provider's resource, from durable configuration. */
  resource(capability: OperationalCapability, context: ProviderContext): ResourceBinding;
  /** Read what the provider reported into a structured, sanitized result. */
  interpret(capability: OperationalCapability, evidence: StructuredEvidence, context: ProviderContext): ProviderExecutionResult;
  /** Check reality after the operation. May reach the provider or the environment. */
  verify(capability: OperationalCapability, evidence: StructuredEvidence, context: ProviderContext): Promise<VerificationCheck[]>;
  /**
   * Resolve an unknown outcome by looking at reality, never by repeating the
   * operation. `established`: the intended effect is observably in place;
   * `absent`: it observably did not happen; `retry-safe`: the operation has no
   * external effect or is exactly-once, so a repeat is safe; `undetermined`:
   * reality cannot say yet.
   */
  observe(capability: OperationalCapability, context: ProviderContext, intended?: { revision?: string }): Promise<Observation>;
  /** Observe the environment itself, without acting. Absent when the provider cannot. */
  observeEnvironment?(context: ProviderContext): Promise<EnvironmentLiveObservation>;
  /** What the operation is expected to change, for planning and review. */
  effects(capability: OperationalCapability, context: ProviderContext): string[];
  /** Whether the provider makes an operation exactly-once under our key. */
  idempotency(capability: OperationalCapability): { exactlyOnce: boolean; note?: string };
}

async function onPath(binary: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, binary), constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

function resourceFor(kind: 'repository' | 'environment', context: ProviderContext): string {
  if (kind === 'repository') {
    return context.repository ? `repository:${context.repository.owner}/${context.repository.name}` : 'repository:unresolved';
  }
  return context.environment ? `environment:${context.environment.name}` : 'environment:unresolved';
}

function timing(evidence: StructuredEvidence): Pick<ProviderExecutionResult, 'startedAt' | 'completedAt' | 'durationMs'> {
  return { startedAt: evidence.startedAt, completedAt: evidence.completedAt, durationMs: evidence.durationMs };
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).pop() ?? '';
}

/** `git status --porcelain=v2 --branch`, as git prints it. */
export function parseGitStatus(stdout: string): { oid: string | null; branch: string | null; upstream: string | null; changes: number } {
  let oid: string | null = null;
  let branch: string | null = null;
  let upstream: string | null = null;
  let changes = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim() || null;
    else if (line.startsWith('# branch.head ')) { const head = line.slice('# branch.head '.length).trim(); branch = head === '(detached)' ? null : head; }
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim() || null;
    else if (line.trim() && !line.startsWith('#')) changes += 1;
  }
  return { oid: oid === '(initial)' ? null : oid, branch, upstream, changes };
}

/** A provider's own refusal reads differently from a process that could not run. */
function rejectionOf(evidence: StructuredEvidence): string | null {
  const text = `${evidence.stderr}\n${evidence.stdout}`;
  // The provider refusing the request, as distinct from the request failing
  // to run: authentication, authorization, a missing target, or a request it
  // will not accept.
  const match = text.match(/^.*\b(unauthorized|not authorized|forbidden|permission denied|authentication|could not find app|app not found|invalid token|invalid configuration|invalid (?:app|config|request)|rejected|bad request|401|403|404|422)\b.*$/im);
  return match ? match[0].trim() : null;
}

function baseResult(evidence: StructuredEvidence, summary: string): ProviderExecutionResult {
  const status: ProviderExecutionResult['status'] = evidence.status === 'cancelled'
    ? 'cancelled'
    : evidence.exitCode === 0 ? 'succeeded' : rejectionOf(evidence) ? 'rejected' : 'failed';
  return {
    status,
    providerOperationId: null,
    ...timing(evidence),
    metadata: {
      exitCode: evidence.exitCode,
      terminationReason: evidence.execution?.terminationReason ?? null,
    },
    observed: {},
    summary: status === 'rejected' ? `provider rejected the operation: ${rejectionOf(evidence)}` : summary,
  };
}

/** Git: the repository as it is, in the materialized checkout. */
export const gitAdapter: ProviderAdapter = {
  id: 'git',
  displayName: 'Git',
  capabilities: ['repository.inspect', 'repository.checkout'],
  credentials: [],
  async availability() {
    return (await onPath('git'))
      ? { state: 'available', detail: 'git is on PATH' }
      : { state: 'unavailable', detail: 'git is not on PATH' };
  },
  resource(_capability, context) {
    if (!context.repository) return { ok: false, reason: 'the project has no repository to act on' };
    return {
      ok: true,
      id: `git:${context.repository.provider}:${context.repository.owner}/${context.repository.name}`,
      detail: `${context.repository.owner}/${context.repository.name} at ${context.desiredState?.sourceBranch ?? context.repository.defaultBranch}`,
      parameters: {},
    };
  },
  interpret(capability, evidence, context) {
    const result = baseResult(evidence, capability === 'repository.inspect' ? 'repository state observed' : 'repository checked out');
    const observed = evidence.revision?.observed ?? evidence.repository.commit;
    const state = capability === 'repository.inspect' ? parseGitStatus(evidence.stdout) : null;
    const remote = context.repository ? `${context.repository.provider}:${context.repository.owner}/${context.repository.name}` : null;
    return {
      ...result,
      providerOperationId: observed ?? null,
      metadata: {
        ...result.metadata,
        remote,
        ...(state ? { branch: state.branch, upstream: state.upstream, head: state.oid, dirty: state.changes > 0, changes: state.changes } : { head: lastLine(evidence.stdout) || null }),
      },
      observed: observed ? { revision: observed } : {},
      summary: result.status === 'succeeded' && observed
        ? state
          ? `${state.branch ?? 'detached'} at ${observed.slice(0, 12)}, ${state.changes > 0 ? `${state.changes} uncommitted change(s)` : 'clean'}`
          : `${result.summary} at ${observed.slice(0, 12)}`
        : result.summary,
    };
  },
  async verify(capability, evidence) {
    const observed = evidence.revision?.observed ?? evidence.repository.commit ?? null;
    const requested = evidence.revision?.requested ?? null;
    const state = capability === 'repository.inspect' ? parseGitStatus(evidence.stdout) : null;
    const checks: VerificationCheck[] = [{
      name: capability === 'repository.inspect' ? 'repository state observed' : 'checkout reached a revision',
      status: evidence.exitCode === 0 && observed ? 'passed' : 'failed',
      detail: observed
        ? state
          ? `HEAD is ${observed} on ${state.branch ?? 'a detached HEAD'}${state.upstream ? ` tracking ${state.upstream}` : ''}; ${state.changes > 0 ? `${state.changes} uncommitted change(s)` : 'working tree clean'}`
          : `HEAD is ${observed}`
        : evidence.exitCode === 0 ? 'git reported no revision' : lastLine(evidence.stderr) || 'git did not exit 0',
    }];
    if (state && observed && state.oid && !observed.startsWith(state.oid) && !state.oid.startsWith(observed)) {
      checks.push({ name: 'inspected HEAD matches the checked-out revision', status: 'failed', detail: `git status reports ${state.oid}, the checkout reported ${observed}` });
    }
    if (capability === 'repository.checkout') {
      checks.push({
        name: 'resulting revision matches the requested one',
        // With no specific revision requested, the branch tip is the request.
        status: !requested ? (observed ? 'passed' : 'failed') : observed && (observed === requested || observed.startsWith(requested)) ? 'passed' : 'failed',
        detail: requested ? `requested ${requested}, observed ${observed ?? 'nothing'}` : `no specific revision was requested; ${evidence.ref} resolved to ${observed ?? 'nothing'}`,
      });
    }
    return checks;
  },
  observe(capability) { return retrySafe(capability, 'is read-only'); },
  effects() { return ['reads the repository; changes nothing outside the ephemeral workspace']; },
  idempotency() { return { exactlyOnce: true, note: 'read-only' }; },
};

/** Local: the project's own build and test, in the controlled execution boundary. */
export const localAdapter: ProviderAdapter = {
  id: 'local',
  displayName: 'Local execution',
  capabilities: ['build.run', 'test.run'],
  credentials: [],
  async availability() {
    return (await onPath('npm'))
      ? { state: 'available', detail: 'npm is on PATH' }
      : { state: 'unavailable', detail: 'npm is not on PATH' };
  },
  resource(_capability, context) {
    if (!context.repository) return { ok: false, reason: 'the project has no repository to act on' };
    return {
      ok: true,
      id: `local:workspace:${context.repository.owner}/${context.repository.name}`,
      detail: `ephemeral workspace of ${context.repository.owner}/${context.repository.name}`,
      parameters: {},
    };
  },
  interpret(capability, evidence, context) {
    const script = capability === 'build.run' ? 'build' : capability === 'test.run' ? 'test' : null;
    const declared = script ? context.discovery?.signals.scripts?.includes(script) ?? false : false;
    const result = baseResult(evidence, `${capability} exited ${evidence.exitCode}`);
    return {
      ...result,
      metadata: { ...result.metadata, script, scriptDeclared: script ? declared : null },
      observed: evidence.revision?.observed ? { revision: evidence.revision.observed } : {},
      summary: script && !declared && result.status === 'succeeded'
        ? `package.json declares no ${script} script; nothing was ${script === 'build' ? 'built' : 'tested'}`
        : result.summary,
    };
  },
  async verify(capability, evidence, context) {
    const script = capability === 'build.run' ? 'build' : capability === 'test.run' ? 'test' : null;
    const declared = script ? context.discovery?.signals.scripts?.includes(script) ?? false : false;
    if (script && !declared) {
      // --if-present exits 0 without doing anything. That is not a build.
      return [{
        name: `${capability} completed`,
        status: 'skipped',
        detail: `package.json declares no ${script} script, so nothing was ${script === 'build' ? 'built' : 'tested'}`,
      }];
    }
    return [{
      name: `${capability} completed`,
      status: evidence.exitCode === 0 ? 'passed' : 'failed',
      detail: evidence.exitCode === 0
        ? script
          ? `package.json ${script} script exited 0${evidence.artifacts.length ? `; produced ${evidence.artifacts.join(', ')}` : '; produced no new top-level artifacts'}`
          : 'command exited 0'
        : lastLine(evidence.stderr) || `exited ${evidence.exitCode}`,
    }];
  },
  observe(capability) { return retrySafe(capability, 'ran in an ephemeral workspace with no external effect'); },
  effects(capability) {
    return capability === 'build.run'
      ? ['runs the repository build script in an ephemeral workspace']
      : capability === 'test.run'
        ? ['runs the repository test script in an ephemeral workspace']
        : ['runs the declared command in an ephemeral workspace'];
  },
  idempotency() { return { exactlyOnce: true, note: 'ephemeral workspace; no external effect' }; },
};

/** Probe a health URL for real. Never throws; a failure is an observation. */
export async function probeHealth(url: string, timeoutMs = 10000): Promise<{ ok: boolean; status?: number; error?: string; version?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    // A health endpoint that says which revision it runs is reality reporting
    // itself; it is read, never assumed.
    let version: string | undefined;
    try {
      const body = await response.json() as Record<string, unknown>;
      const claimed = body.version ?? body.revision ?? body.commit;
      if (typeof claimed === 'string' && claimed.trim()) version = claimed.trim();
    } catch { /* not JSON, or no body */ }
    return { ok: response.ok, status: response.status, ...(version ? { version } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a provider can say about an environment right now, without acting.
 *
 * `kind` distinguishes an answer from the resource (`observed`) from the
 * reasons there is none: the provider could not be reached, the resource is
 * not bound, or nothing is configured to observe. Only `observed` is a fact
 * about reality; the others are facts about Factory's view of it.
 */
export interface EnvironmentLiveObservation {
  kind: 'observed' | 'provider-unavailable' | 'resource-unavailable' | 'unsupported';
  detail: string;
  source?: string;
  reported?: { revision?: string; health?: 'healthy' | 'unhealthy'; status?: number };
}

export async function observeEnvironmentLive(adapter: ProviderAdapter | null, context: ProviderContext): Promise<EnvironmentLiveObservation> {
  if (!adapter?.observeEnvironment) {
    return { kind: 'unsupported', detail: adapter ? `${adapter.id} offers no live observation of an environment` : 'no provider is configured for this environment' };
  }
  return adapter.observeEnvironment(context);
}

function flyApp(context: ProviderContext): string | null {
  const configured = context.environment?.configuration?.flyApp;
  if (typeof configured === 'string' && configured) return configured;
  const discovered = context.discovery?.signals.flyApp;
  return typeof discovered === 'string' && discovered ? discovered : null;
}

function configuredHealthUrl(context: ProviderContext): string | null {
  const configured = context.environment?.configuration?.healthUrl;
  return typeof configured === 'string' && configured ? configured : null;
}

function flyHealthUrl(context: ProviderContext): string | null {
  const configured = configuredHealthUrl(context);
  if (configured) return configured;
  const app = flyApp(context);
  return app ? `https://${app}.fly.dev/health` : null;
}

/**
 * Fly: deployment and environment operations through the fly CLI.
 *
 * The CLI reads `FLY_APP` and `FLY_API_TOKEN` from its environment; the
 * execution boundary sets the first from the bound resource and resolves the
 * second by name at spawn time. Deployment is not exactly-once: `fly deploy`
 * has no idempotency key, so a retried deployment may deploy twice. That is
 * recorded on the evidence rather than hidden.
 */
export const flyAdapter: ProviderAdapter = {
  id: 'fly',
  displayName: 'Fly',
  capabilities: ['deployment.create', 'environment.inspect', 'environment.health'],
  credentials: ['FLY_API_TOKEN'],
  async availability(capability) {
    // The health probe is an HTTP request made from this process; the rest
    // goes through the fly CLI, which has to be installed to be real.
    if (capability === 'environment.health') return { state: 'available', detail: 'health probe runs in-process over HTTPS' };
    return (await onPath('fly'))
      ? { state: 'available', detail: 'fly CLI is on PATH' }
      : { state: 'unavailable', detail: 'fly CLI is not on PATH' };
  },
  resource(capability, context) {
    const app = flyApp(context);
    const environment = context.environment?.name ?? 'the environment';
    if (capability === 'environment.health') {
      const url = flyHealthUrl(context);
      if (!url) {
        return { ok: false, reason: `${environment} has no health URL: configure environment.configuration.healthUrl or a Fly app` };
      }
      return {
        ok: true,
        id: app ? `fly:app:${app}` : `url:${url}`,
        detail: `health of ${url}`,
        parameters: { ...(app ? { FLY_APP: app } : {}), FACTORY_HEALTH_URL: url },
      };
    }
    if (!app) {
      return { ok: false, reason: `${environment} is not bound to a Fly app: configure environment.configuration.flyApp or add fly.toml to the repository` };
    }
    return {
      ok: true,
      id: `fly:app:${app}`,
      detail: `Fly app ${app}`,
      parameters: { FLY_APP: app, ...(capability === 'deployment.create' && flyHealthUrl(context) ? { FACTORY_HEALTH_URL: flyHealthUrl(context)! } : {}) },
    };
  },
  interpret(capability, evidence) {
    if (capability === 'environment.health') {
      let observed: { ok?: boolean; status?: number; error?: string; url?: string; version?: string | null } = {};
      try { observed = JSON.parse(lastLine(evidence.stdout) || '{}'); } catch { /* not JSON */ }
      const result = baseResult(evidence, observed.ok ? `${observed.url} returned HTTP ${observed.status}${observed.version ? `, reporting revision ${observed.version}` : ''}` : observed.error ?? (observed.status ? `HTTP ${observed.status}` : 'no health response'));
      return {
        ...result,
        status: evidence.status === 'cancelled' ? 'cancelled' : evidence.exitCode === 0 ? 'succeeded' : result.status,
        metadata: { ...result.metadata, httpStatus: observed.status ?? null, url: observed.url ?? null, reportedVersion: observed.version ?? null },
        observed: {
          health: observed.ok ? 'healthy' : 'unhealthy',
          ...(observed.status !== undefined ? { healthStatus: observed.status } : {}),
          ...(observed.url ? { healthUrl: observed.url } : {}),
          ...(observed.version ? { revision: observed.version } : {}),
        },
      };
    }
    if (capability === 'environment.inspect') {
      let status: { Name?: string; Status?: string; Hostname?: string; Version?: number; ID?: string } = {};
      try { status = JSON.parse(evidence.stdout.trim() || '{}'); } catch { /* not JSON */ }
      const result = baseResult(evidence, status.Name ? `${status.Name} is ${status.Status ?? 'unknown'}` : 'status read');
      return {
        ...result,
        providerOperationId: status.ID ?? null,
        metadata: { ...result.metadata, app: status.Name ?? null, appStatus: status.Status ?? null, hostname: status.Hostname ?? null, version: status.Version ?? null },
      };
    }
    // deployment.create: fly prints the release it created.
    const release = evidence.stdout.match(/\b(?:release|version)\s+(v\d+)\b/i)?.[1]
      ?? evidence.stdout.match(/\bv(\d+)\b\s+(?:deployed|created)/i)?.[0] ?? null;
    const image = evidence.stdout.match(/image:\s*(\S+)/i)?.[1] ?? null;
    const result = baseResult(evidence, release ? `deployed release ${release}` : evidence.exitCode === 0 ? 'fly deploy exited 0' : 'fly deploy did not exit 0');
    return {
      ...result,
      providerOperationId: release,
      metadata: { ...result.metadata, release, image },
      observed: evidence.revision?.observed ? { revision: evidence.revision.observed } : {},
    };
  },
  async verify(capability, evidence, context) {
    if (capability === 'environment.health') {
      const interpreted = flyAdapter.interpret(capability, evidence, context);
      return [{
        name: 'environment responds healthy',
        status: interpreted.observed.health === 'healthy' ? 'passed' : 'failed',
        detail: interpreted.summary,
      }];
    }
    if (capability === 'deployment.create') {
      const checks: VerificationCheck[] = [{
        name: 'deployment command completed',
        status: evidence.exitCode === 0 ? 'passed' : 'failed',
        detail: evidence.exitCode === 0 ? 'fly deploy exited 0' : lastLine(evidence.stderr) || 'fly deploy did not exit 0',
      }];
      if (evidence.exitCode !== 0) return checks;
      // A deployment that finished is not yet one that serves traffic. Ask the
      // environment itself; when there is nothing to ask, say so rather than
      // assume.
      const url = flyHealthUrl(context);
      if (!url) {
        checks.push({ name: 'environment responds healthy', status: 'skipped', detail: 'no health URL is configured for this environment, so health could not be verified' });
        return checks;
      }
      const probe = await probeHealth(url);
      checks.push({
        name: 'environment responds healthy',
        status: probe.ok ? 'passed' : 'failed',
        detail: probe.ok ? `${url} returned HTTP ${probe.status}${probe.version ? `, reporting revision ${probe.version}` : ''}` : probe.error ?? `${url} returned HTTP ${probe.status}`,
      });
      // When the environment reports which revision it runs, the deployment
      // is verified against it: the intended revision must be what serves.
      const intended = evidence.revision?.observed ?? evidence.repository.commit;
      if (probe.ok && probe.version && intended) {
        const matches = intended === probe.version || intended.startsWith(probe.version) || probe.version.startsWith(intended);
        checks.push({
          name: 'environment serves the deployed revision',
          status: matches ? 'passed' : 'failed',
          detail: matches ? `${url} reports ${probe.version}` : `${url} reports ${probe.version}, but ${intended} was deployed`,
        });
      }
      return checks;
    }
    return [{ name: `${capability} completed`, status: evidence.exitCode === 0 ? 'passed' : 'failed', detail: lastLine(evidence.exitCode === 0 ? evidence.stdout : evidence.stderr) }];
  },
  async observeEnvironment(context) {
    /*
     * Reality is observed only where the environment is explicitly configured
     * to be observed. A guessed URL would make an unrelated host's answer, or
     * its absence, into a fact about this environment.
     */
    const url = configuredHealthUrl(context);
    if (!url) {
      return { kind: 'unsupported', detail: 'no health URL is configured for this environment (environment.configuration.healthUrl); recorded state from verified operations is used' };
    }
    const probe = await probeHealth(url);
    if (probe.error) {
      return { kind: 'provider-unavailable', detail: `${url} could not be reached: ${probe.error}`, source: url };
    }
    return {
      kind: 'observed',
      detail: `${url} returned HTTP ${probe.status}${probe.version ? `, reporting revision ${probe.version}` : ''}`,
      source: url,
      reported: { health: probe.ok ? 'healthy' : 'unhealthy', status: probe.status!, ...(probe.version ? { revision: probe.version } : {}) },
    };
  },
  async observe(capability, context, intended) {
    if (capability !== 'deployment.create') return retrySafe(capability, 'is read-only');
    /*
     * A deployment whose result was lost is established only when the
     * environment is observably serving and healthy — and, when the
     * environment reports which revision it runs, running the intended one.
     * A healthy environment on another revision shows the deployment did not
     * take effect; an unhealthy or unreachable one proves nothing either way,
     * and a repeat would be a second deployment.
     */
    const url = flyHealthUrl(context);
    if (!url) {
      return { outcome: 'undetermined', detail: 'no health URL is configured, so the deployment cannot be observed', checks: [], observed: {} };
    }
    const probe = await probeHealth(url);
    const check: VerificationCheck = {
      name: 'environment responds healthy',
      status: probe.ok ? 'passed' : 'failed',
      detail: probe.ok ? `${url} returned HTTP ${probe.status}${probe.version ? `, reporting revision ${probe.version}` : ''}` : probe.error ?? `${url} returned HTTP ${probe.status}`,
    };
    if (!probe.ok) {
      return { outcome: 'undetermined', detail: `the environment is not healthy (${check.detail}); whether the deployment happened cannot be determined`, checks: [check], observed: { health: 'unhealthy', healthUrl: url, ...(probe.status !== undefined ? { healthStatus: probe.status } : {}) } };
    }
    const observed = { health: 'healthy' as const, healthStatus: probe.status!, healthUrl: url, ...(probe.version ? { revision: probe.version } : {}) };
    if (probe.version && intended?.revision) {
      const matches = intended.revision === probe.version || intended.revision.startsWith(probe.version) || probe.version.startsWith(intended.revision);
      const revisionCheck: VerificationCheck = {
        name: 'environment serves the deployed revision',
        status: matches ? 'passed' : 'failed',
        detail: matches ? `${url} reports ${probe.version}` : `${url} reports ${probe.version}, not the intended ${intended.revision}`,
      };
      return matches
        ? { outcome: 'established', detail: `the environment is serving and healthy at ${url}, at the intended revision ${probe.version}`, checks: [check, revisionCheck], observed }
        : { outcome: 'absent', detail: `the environment is healthy but serves ${probe.version}, not the intended ${intended.revision}; the deployment did not take effect`, checks: [check, revisionCheck], observed };
    }
    return { outcome: 'established', detail: `the environment is serving and healthy at ${url}${probe.version ? ` at revision ${probe.version}` : ''}`, checks: [check], observed };
  },
  effects(capability, context) {
    const app = flyApp(context) ?? 'the Fly app';
    return capability === 'deployment.create'
      ? [`deploys the checkout to ${app}`, 'serves new traffic once healthy']
      : capability === 'environment.health'
        ? [`probes ${flyHealthUrl(context) ?? `${app} health`}; changes nothing`]
        : [`reads ${app} status; changes nothing`];
  },
  idempotency(capability) {
    return capability === 'deployment.create'
      ? { exactlyOnce: false, note: 'fly deploy has no idempotency key; a retry may deploy again' }
      : { exactlyOnce: true, note: 'read-only' };
  },
};

export const DEFAULT_ADAPTERS: readonly ProviderAdapter[] = [gitAdapter, localAdapter, flyAdapter];

/**
 * What Factory can perform: the intersection of what `.flow` declares and
 * what an adapter implements. Neither alone is enough — an adapter for an
 * undeclared capability is not authority, and a declaration with no adapter
 * is not an ability.
 */
export interface ProviderCapability {
  capability: OperationalCapability;
  operation: string;
  authority: OperationAuthority;
}

export class ProviderRegistry {
  private readonly byProvider = new Map<string, ProviderCapability[]>();
  /** Declared by `.flow` for a provider whose adapter does not implement it. */
  private readonly unimplemented = new Map<string, ProviderCapability[]>();

  constructor(flowSpec: FlowSpec, readonly adapters: readonly ProviderAdapter[] = DEFAULT_ADAPTERS) {
    for (const authority of getOperationAuthorities(flowSpec).values()) {
      if (!authority.provider || !isOperationalCapability(authority.operationalCapability)) continue;
      const adapter = adapters.find((candidate) => candidate.id === authority.provider);
      if (!adapter) continue;
      const entry = { capability: authority.operationalCapability, operation: authority.operation, authority };
      const target = adapter.capabilities.includes(authority.operationalCapability) ? this.byProvider : this.unimplemented;
      const list = target.get(authority.provider) ?? [];
      list.push(entry);
      target.set(authority.provider, list);
    }
  }

  adapter(id: string): ProviderAdapter | null {
    return this.adapters.find((adapter) => adapter.id === id) ?? null;
  }

  providers(): string[] {
    return [...this.byProvider.keys()].sort();
  }

  capabilitiesOf(provider: string): ProviderCapability[] {
    return [...(this.byProvider.get(provider) ?? [])].sort((a, b) => a.capability.localeCompare(b.capability));
  }

  /** Declared in `.flow` but not implemented by the adapter: honest, not executable. */
  unimplementedOf(provider: string): ProviderCapability[] {
    return [...(this.unimplemented.get(provider) ?? [])].sort((a, b) => a.capability.localeCompare(b.capability));
  }

  /** Providers that can satisfy a capability, in a stable order. */
  providersFor(capability: OperationalCapability): string[] {
    return this.providers().filter((provider) =>
      this.capabilitiesOf(provider).some((entry) => entry.capability === capability));
  }

  operationFor(provider: string, capability: OperationalCapability): ProviderCapability | null {
    return this.capabilitiesOf(provider).find((entry) => entry.capability === capability) ?? null;
  }
}

export type ProviderResolution =
  | { ok: true; provider: string; operation: string; capability: OperationalCapability; resource: string }
  | { ok: false; outcome: 'capability-unavailable' | 'provider-unavailable'; reason: string };

/**
 * Deterministic provider resolution.
 *
 * A repository capability goes to the provider `.flow` declares for it. An
 * environment capability goes to the provider the environment or desired
 * state names, and only that one: when it cannot satisfy the capability, or
 * nothing names a provider, the answer is provider-unavailable. Factory never
 * picks a different provider than the one that was configured.
 */
export function resolveProvider(
  registry: ProviderRegistry,
  capability: string,
  context: ProviderContext,
): ProviderResolution {
  if (!isOperationalCapability(capability)) {
    return { ok: false, outcome: 'capability-unavailable', reason: `${capability} is not an operational capability Factory knows` };
  }
  const candidates = registry.providersFor(capability);
  if (candidates.length === 0) {
    return { ok: false, outcome: 'capability-unavailable', reason: `no .flow operation declares ${capability} for an adapter that implements it` };
  }
  const kind = capabilityResourceKind(capability);
  const resource = resourceFor(kind, context);

  if (kind === 'repository') {
    if (candidates.length === 1) {
      return { ok: true, provider: candidates[0]!, operation: registry.operationFor(candidates[0]!, capability)!.operation, capability, resource };
    }
    return { ok: false, outcome: 'provider-unavailable', reason: `${capability} is declared by ${candidates.join(', ')}; a repository capability must have one provider` };
  }

  const configured = context.environment?.provider ?? context.desiredState?.targetProvider ?? null;
  if (!configured) {
    return { ok: false, outcome: 'provider-unavailable', reason: `no provider is configured for ${resource}; declare one on the environment or in desired state` };
  }
  if (!candidates.includes(configured)) {
    return { ok: false, outcome: 'provider-unavailable', reason: `provider ${configured} does not satisfy ${capability}; providers that do: ${candidates.join(', ')}` };
  }
  return { ok: true, provider: configured, operation: registry.operationFor(configured, capability)!.operation, capability, resource };
}

/** Plan an operation without performing it. */
export function planOperation(
  registry: ProviderRegistry,
  resolution: Extract<ProviderResolution, { ok: true }>,
  context: ProviderContext,
): ProviderPlan {
  const adapter = registry.adapter(resolution.provider)!;
  const entry = registry.operationFor(resolution.provider, resolution.capability)!;
  const required = REQUIRED_VERIFICATION[resolution.capability];
  const binding = adapter.resource(resolution.capability, context);
  return {
    provider: resolution.provider,
    capability: resolution.capability,
    operation: resolution.operation,
    resource: resolution.resource,
    expectedEffects: adapter.effects(resolution.capability, context),
    verification: [`${resolution.capability} result`, ...(required ? [required] : [])],
    requiredAuthority: [...entry.authority.capabilities],
    parameters: binding.ok ? binding.parameters : {},
  };
}

/** What the execution boundary receives. Credentials by name only. */
export function providerExecution(
  registry: ProviderRegistry,
  resolution: Extract<ProviderResolution, { ok: true }>,
  context: ProviderContext,
  binding: Extract<ResourceBinding, { ok: true }>,
): ProviderExecution {
  const adapter = registry.adapter(resolution.provider)!;
  return {
    provider: resolution.provider,
    capability: resolution.capability,
    operation: resolution.operation,
    resource: resolution.resource,
    providerResource: binding.id,
    environment: binding.parameters,
    credentials: [...adapter.credentials],
    idempotency: { key: context.idempotencyKey, ...adapter.idempotency(resolution.capability) },
  };
}

export function interpretOperation(
  registry: ProviderRegistry,
  action: Pick<ActionRecord, 'provider' | 'capability'>,
  evidence: StructuredEvidence,
  context: ProviderContext,
): ProviderExecutionResult | null {
  const adapter = action.provider ? registry.adapter(action.provider) : null;
  if (!adapter || !isOperationalCapability(action.capability)) return null;
  return adapter.interpret(action.capability, evidence, context);
}

export async function verifyOperation(
  registry: ProviderRegistry,
  action: Pick<ActionRecord, 'provider' | 'capability'>,
  evidence: StructuredEvidence,
  context: ProviderContext,
): Promise<VerificationCheck[]> {
  const adapter = action.provider ? registry.adapter(action.provider) : null;
  if (!adapter || !isOperationalCapability(action.capability)) return [];
  return adapter.verify(action.capability, evidence, context);
}
