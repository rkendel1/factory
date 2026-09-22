import { createHash } from 'node:crypto';
import { defineCapability, errors, s } from '@appport/sdk';
import type { CapabilityContext } from '@appport/sdk';
import type { CapabilityHandler } from '@appport/core/public';
import type { OperationalCapability } from './capabilities.js';
import { nodeStatus, graphStatus, type NodeStatus } from './graph.js';
import type { PlannedAction } from './graph.js';
import type {
  ActionGraphRecord,
  ActionRecord,
  ActionOutcome,
  OperationalWorkEventType,
  OperationalWorkPlanStep,
  OperationalWorkRecord,
  OperationalWorkStatus,
  StructuredEvidence,
} from './types.js';

/**
 * The Attn ↔ Factory operational work contract.
 *
 * Attn owns attention and development work. Factory owns operational work.
 * This module is the explicit boundary between them: what Attn may ask for,
 * what Factory answers with, and nothing else. Attn never reaches Factory's
 * database, Factory never reaches Attn's, and an Attn reference on a request
 * is provenance — it says where the work came from, never that it may run.
 *
 * The contract is versioned so that either side can change without silently
 * breaking the other.
 */
export const OPERATIONAL_WORK_CONTRACT = 'factory.operational-work/1' as const;

/** The AppPort capability the contract travels through. */
export const OPERATIONAL_WORK_CAPABILITY = 'softwarefactory.operationalwork' as const;
export const OPERATIONAL_WORK_CAPABILITY_VERSION = 1 as const;

/**
 * The verbs Attn may request, in the order Factory performs them.
 *
 * These are operational: they act on a repository or an environment that
 * already exists. Development verbs — implement, fix, refactor, write — are
 * not here on purpose. Factory does not do development work and does not
 * forward it; a request for it is refused, not reinterpreted.
 */
export const OPERATIONAL_VERBS = ['inspect', 'build', 'test', 'migrate', 'deploy', 'restart', 'verify'] as const;
export type OperationalVerb = typeof OPERATIONAL_VERBS[number];

/** Verbs that describe development, named so the refusal can say why. */
const DEVELOPMENT_VERBS = new Set([
  'implement', 'write', 'fix', 'refactor', 'generate', 'code', 'design', 'author', 'edit', 'change',
  'modify', 'develop', 'create', 'plan', 'review', 'debug', 'commit', 'merge', 'push', 'scaffold',
]);

/** Keys that would carry development instructions rather than an operational request. */
const INSTRUCTION_KEYS = new Set(['instructions', 'instruction', 'prompt', 'code', 'diff', 'patch', 'files', 'spec', 'goal', 'task']);

/** Keys that would try to hand Factory authority it must only get from AuthBoundry. */
const AUTHORITY_KEYS = new Set([
  'approvedBy', 'approved', 'authority', 'authorized', 'authorization', 'capabilities', 'permissions',
  'principal', 'delegation', 'delegationId', 'tenant', 'tenantId', 'autonomous', 'grant', 'grants',
]);

const CREDENTIAL_KEY = /(api[-_]?key|token|password|passwd|secret|credential|private[-_]?key|bearer|cookie)/i;

const VERB_CAPABILITIES: Record<OperationalVerb, OperationalCapability> = {
  inspect: 'repository.inspect',
  build: 'build.run',
  test: 'test.run',
  migrate: 'migration.run',
  deploy: 'deployment.create',
  restart: 'service.restart',
  verify: 'environment.health',
};

/** Verbs whose capability acts on an environment, so one must be named. */
const ENVIRONMENT_VERBS: ReadonlySet<OperationalVerb> = new Set<OperationalVerb>(['migrate', 'deploy', 'restart', 'verify']);

/**
 * Operational rules, not planning. Factory knows that a deployment is only a
 * deployment when the repository built and tested first and the environment
 * is healthy after. These are the whole of the enrichment: fixed, inspectable,
 * and the same for every request. No model decides them.
 */
const IMPLIED_VERBS: Partial<Record<OperationalVerb, { verb: OperationalVerb; reason: string }[]>> = {
  deploy: [
    { verb: 'build', reason: 'deploy requires a built repository' },
    { verb: 'test', reason: 'deploy requires a tested repository' },
    { verb: 'verify', reason: 'a deployment counts only once the environment is healthy' },
  ],
  restart: [
    { verb: 'verify', reason: 'a restart counts only once the environment is healthy' },
  ],
};

export type OperationalTarget = 'repository' | 'environment';

export interface RequestedOperationalAction {
  verb: OperationalVerb;
  target?: OperationalTarget;
  parameters?: Record<string, string | number | boolean>;
}

export interface OperationalWorkOrigin {
  system: string;
  type: string;
  id: string;
}

export interface OperationalWorkRequest {
  contract: typeof OPERATIONAL_WORK_CONTRACT;
  /** Provenance only. Factory records it and never dereferences it. */
  origin: OperationalWorkOrigin;
  idempotencyKey: string;
  project: string;
  environment?: string;
  intent?: string;
  actions: RequestedOperationalAction[];
}

export interface OperationalWorkActionResult {
  actionId: string;
  key: string;
  capability: string;
  provider: string | null;
  implied: boolean;
  status: NodeStatus;
  outcome: ActionOutcome | null;
  runId: string | null;
  evidenceId: string | null;
}

export interface OperationalWorkEvidence {
  actionId: string;
  runId: string;
  evidenceId: string;
  result: string;
}

/**
 * What Attn gets back. Compact on purpose: identifiers, statuses and
 * outcomes, and references to Factory's evidence. It carries no credential,
 * no command line, no log, and no Factory-internal state Attn would have to
 * understand to act on it.
 */
export interface OperationalWorkResult {
  contract: typeof OPERATIONAL_WORK_CONTRACT;
  workId: string;
  origin: OperationalWorkOrigin;
  status: OperationalWorkStatus;
  outcome: string | null;
  graphId: string | null;
  intent: string | null;
  actions: OperationalWorkActionResult[];
  completedActions: string[];
  blockedActions: string[];
  failedActions: string[];
  evidence: OperationalWorkEvidence[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export class OperationalWorkRequestError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_OPERATIONAL_WORK';

  constructor(message: string) {
    super(message);
    this.name = 'OperationalWorkRequestError';
  }
}

export class OperationalWorkConflictError extends Error {
  readonly status = 409;
  readonly code = 'OPERATIONAL_WORK_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'OperationalWorkConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, field: string, path: string, maxLength = 200): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationalWorkRequestError(`${path}${field} is required and must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new OperationalWorkRequestError(`${path}${field} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function optionalText(record: Record<string, unknown>, field: string, path: string, maxLength = 200): string | undefined {
  if (record[field] === undefined || record[field] === null) return undefined;
  return requiredText(record, field, path, maxLength);
}

/**
 * Walk the whole request once and refuse anything that looks like a
 * credential, wherever it sits. A secret in a request would otherwise be
 * copied into durable work state and evidence, which is exactly where it
 * must never be.
 */
function refuseCredentials(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => refuseCredentials(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new OperationalWorkRequestError(
        `${path}${key} looks like a credential; Factory resolves credentials by name at execution time and never accepts them in a request`,
      );
    }
    refuseCredentials(child, `${path}${key}.`);
  }
}

function refuseUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (AUTHORITY_KEYS.has(key)) {
      throw new OperationalWorkRequestError(
        `${path}${key} is not accepted: a request cannot carry authority; AuthBoundry decides whether each Action may run`,
      );
    }
    if (INSTRUCTION_KEYS.has(key)) {
      throw new OperationalWorkRequestError(
        `${path}${key} is not accepted: Factory performs operational actions, not development instructions`,
      );
    }
    throw new OperationalWorkRequestError(`${path}${key} is not part of ${OPERATIONAL_WORK_CONTRACT}`);
  }
}

function parseVerb(value: unknown, path: string): OperationalVerb {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationalWorkRequestError(`${path}verb is required`);
  }
  const verb = value.trim().toLowerCase();
  if ((OPERATIONAL_VERBS as readonly string[]).includes(verb)) return verb as OperationalVerb;
  if (DEVELOPMENT_VERBS.has(verb)) {
    throw new OperationalWorkRequestError(
      `${path}verb ${verb} is development work, which Factory does not perform; operational verbs are ${OPERATIONAL_VERBS.join(', ')}`,
    );
  }
  throw new OperationalWorkRequestError(
    `${path}verb ${verb} is not an operational verb; operational verbs are ${OPERATIONAL_VERBS.join(', ')}`,
  );
}

function parseParameters(value: unknown, path: string): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new OperationalWorkRequestError(`${path}parameters must be an object`);
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw new OperationalWorkRequestError(`${path}parameters.${key} is not a valid parameter name`);
    }
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new OperationalWorkRequestError(`${path}parameters.${key} must be a string, number or boolean`);
    }
    if (typeof entry === 'string' && entry.length > 500) {
      throw new OperationalWorkRequestError(`${path}parameters.${key} must be at most 500 characters`);
    }
    parameters[key] = entry;
  }
  return parameters;
}

/**
 * Validate a request against the contract. Nothing here reads state: the
 * answer depends only on the request, so the same request is accepted or
 * refused the same way everywhere.
 */
export function parseOperationalWorkRequest(value: unknown): OperationalWorkRequest {
  if (!isRecord(value)) throw new OperationalWorkRequestError('an operational work request must be a JSON object');
  refuseCredentials(value, '');
  refuseUnknownKeys(value, ['contract', 'origin', 'idempotencyKey', 'project', 'environment', 'intent', 'actions'], '');

  if (value.contract !== OPERATIONAL_WORK_CONTRACT) {
    throw new OperationalWorkRequestError(`contract must be ${OPERATIONAL_WORK_CONTRACT}`);
  }
  if (!isRecord(value.origin)) throw new OperationalWorkRequestError('origin is required');
  refuseUnknownKeys(value.origin, ['system', 'type', 'id'], 'origin.');
  const origin: OperationalWorkOrigin = {
    system: requiredText(value.origin, 'system', 'origin.', 64).toLowerCase(),
    type: requiredText(value.origin, 'type', 'origin.', 64).toLowerCase(),
    id: requiredText(value.origin, 'id', 'origin.'),
  };
  for (const [field, text] of Object.entries(origin)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(text)) {
      throw new OperationalWorkRequestError(`origin.${field} must be an identifier`);
    }
  }

  const idempotencyKey = requiredText(value, 'idempotencyKey', '');
  const project = requiredText(value, 'project', '');
  const environment = optionalText(value, 'environment', '');
  const intent = optionalText(value, 'intent', '', 500);

  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new OperationalWorkRequestError('actions must be a non-empty array of operational actions');
  }
  if (value.actions.length > 32) throw new OperationalWorkRequestError('actions may hold at most 32 entries');
  const seen = new Set<string>();
  const actions = value.actions.map((entry, index): RequestedOperationalAction => {
    const path = `actions[${index}].`;
    if (!isRecord(entry)) throw new OperationalWorkRequestError(`actions[${index}] must be an object`);
    refuseUnknownKeys(entry, ['verb', 'target', 'parameters'], path);
    const verb = parseVerb(entry.verb, path);
    let target: OperationalTarget | undefined;
    if (entry.target !== undefined) {
      if (entry.target !== 'repository' && entry.target !== 'environment') {
        throw new OperationalWorkRequestError(`${path}target must be repository or environment`);
      }
      target = entry.target;
    }
    const key = `${verb}:${target ?? ''}`;
    if (seen.has(key)) throw new OperationalWorkRequestError(`${path}verb ${verb} is requested twice`);
    seen.add(key);
    const parameters = parseParameters(entry.parameters, path);
    return { verb, ...(target ? { target } : {}), ...(parameters ? { parameters } : {}) };
  });

  for (const action of actions) {
    const needsEnvironment = ENVIRONMENT_VERBS.has(action.verb)
      || (action.verb === 'inspect' && action.target === 'environment');
    if (needsEnvironment && !environment) {
      throw new OperationalWorkRequestError(`verb ${action.verb} acts on an environment, so environment is required`);
    }
  }

  return {
    contract: OPERATIONAL_WORK_CONTRACT,
    origin,
    idempotencyKey,
    project,
    ...(environment ? { environment } : {}),
    ...(intent ? { intent } : {}),
    actions,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/**
 * Identity of a piece of work: the tenant, where it came from, and the
 * caller's idempotency key. The same three always name the same work, in
 * this process or the next one, so a retried request finds what the first
 * one created instead of creating it again.
 */
export function operationalWorkId(tenantId: string, request: Pick<OperationalWorkRequest, 'origin' | 'idempotencyKey'>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([tenantId, request.origin.system, request.origin.type, request.origin.id, request.idempotencyKey]))
    .digest('hex');
  return `owk_${digest.slice(0, 24)}`;
}

/** The same key reused for a different request is a conflict, not a retry. */
export function operationalWorkFingerprint(request: OperationalWorkRequest): string {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}

/**
 * Translate a request into Factory's own plan.
 *
 * The plan is deterministic: the same request always yields the same steps
 * in the same order with the same dependencies. Requested verbs are kept,
 * implied ones are added by the operational rules above and marked as such,
 * and the result is a chain in operational order, because a step in this
 * vocabulary is only safe once the ones before it have finished.
 */
export function planOperationalWork(request: OperationalWorkRequest): OperationalWorkPlanStep[] {
  const requested = new Map(request.actions.map((action) => [action.verb, action]));
  const implied = new Map<OperationalVerb, string>();
  for (const action of request.actions) {
    for (const rule of IMPLIED_VERBS[action.verb] ?? []) {
      if (!requested.has(rule.verb) && !implied.has(rule.verb)) implied.set(rule.verb, rule.reason);
    }
  }

  const steps: OperationalWorkPlanStep[] = [];
  for (const verb of OPERATIONAL_VERBS) {
    const action = requested.get(verb);
    const reason = implied.get(verb);
    if (!action && !reason) continue;
    const capability = verb === 'inspect' && action?.target === 'environment' ? 'environment.inspect' : VERB_CAPABILITIES[verb];
    const previous = steps[steps.length - 1];
    steps.push({
      key: verb,
      verb,
      capability,
      implied: !action,
      reason: reason ?? `requested by ${request.origin.system}`,
      dependsOn: previous ? [previous.key] : [],
      ...(action?.parameters ? { parameters: action.parameters } : {}),
    });
  }
  return steps;
}

/** The plan as the Action Graph takes it, so nodes are ordinary Actions. */
export function plannedActions(work: Pick<OperationalWorkRecord, 'plan' | 'origin' | 'intent'>): PlannedAction[] {
  return work.plan.map((step) => ({
    key: step.key,
    type: step.capability,
    capability: step.capability,
    intent: `${step.verb}: ${work.intent ?? `operational work for ${work.origin.system} ${work.origin.type} ${work.origin.id}`}`
      + (step.implied ? ` (${step.reason})` : ''),
    dependsOn: step.dependsOn,
    ...(step.parameters ? { parameters: step.parameters } : {}),
  }));
}

/** Work status is a summary of its graph, never a separate fact. */
export function operationalWorkStatus(work: OperationalWorkRecord, graph: ActionGraphRecord | null, actions: readonly ActionRecord[]): OperationalWorkStatus {
  if (work.status === 'cancelled') return 'cancelled';
  if (!graph) return work.status === 'planning' ? 'planning' : 'accepted';
  switch (graphStatus(graph, actions)) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running': return 'running';
    case 'blocked': return 'blocked';
    case 'unresolved': return 'unresolved';
    default: return 'ready';
  }
}

export function operationalWorkOutcome(status: OperationalWorkStatus, graph: ActionGraphRecord | null, actions: readonly ActionRecord[]): string | null {
  switch (status) {
    case 'completed': return 'succeeded';
    case 'cancelled': return 'cancelled';
    case 'failed': return graph?.failure?.outcome ?? actions.find((action) => action.status === 'failed')?.outcome ?? 'execution-failed';
    case 'blocked': {
      const byId = new Map(actions.map((action) => [action.id, action]));
      const waiting = actions.find((action) => nodeStatus(action, byId) === 'awaiting-approval');
      return waiting?.outcome ?? 'awaiting-approval';
    }
    case 'unresolved': return 'unknown';
    default: return null;
  }
}

export const OPERATIONAL_WORK_TERMINAL_EVENTS: Partial<Record<OperationalWorkStatus, OperationalWorkEventType>> = {
  completed: 'OperationalWorkCompleted',
  failed: 'OperationalWorkFailed',
  blocked: 'OperationalWorkBlocked',
  unresolved: 'OperationalWorkUnresolved',
  cancelled: 'OperationalWorkCancelled',
};

/** Build the Attn-facing result from durable records. Nothing is computed twice elsewhere. */
export function operationalWorkResult(input: {
  work: OperationalWorkRecord;
  graph: ActionGraphRecord | null;
  actions: readonly ActionRecord[];
  evidence: ReadonlyMap<string, StructuredEvidence>;
  status: OperationalWorkStatus;
}): OperationalWorkResult {
  const { work, graph, actions, evidence, status } = input;
  const byId = new Map(actions.map((action) => [action.id, action]));
  const steps = new Map(work.plan.map((step) => [step.capability, step]));
  const nodes = actions.map((action): OperationalWorkActionResult => {
    const proof = action.runId ? evidence.get(action.runId) ?? null : null;
    return {
      actionId: action.id,
      key: steps.get(action.capability ?? action.type)?.key ?? action.type,
      capability: action.capability ?? action.type,
      provider: action.provider ?? null,
      implied: steps.get(action.capability ?? action.type)?.implied ?? false,
      status: nodeStatus(action, byId),
      outcome: action.outcome ?? null,
      runId: action.runId ?? null,
      evidenceId: proof?.id ?? null,
    };
  });
  return {
    contract: OPERATIONAL_WORK_CONTRACT,
    workId: work.id,
    origin: work.origin,
    status,
    outcome: status === 'accepted' || status === 'planning' ? null : operationalWorkOutcome(status, graph, actions),
    graphId: work.graphId ?? null,
    intent: work.intent ?? null,
    actions: nodes,
    completedActions: nodes.filter((node) => node.status === 'completed').map((node) => node.actionId),
    blockedActions: nodes.filter((node) => node.status === 'blocked' || node.status === 'awaiting-approval').map((node) => node.actionId),
    failedActions: nodes.filter((node) => node.status === 'failed').map((node) => node.actionId),
    evidence: nodes.flatMap((node) => node.runId && node.evidenceId
      ? [{ actionId: node.actionId, runId: node.runId, evidenceId: node.evidenceId, result: evidence.get(node.runId)!.finalResult }]
      : []),
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    completedAt: work.completedAt ?? null,
  };
}

/* -------------------------------------------------------------------------
 * AppPort capability.
 *
 * The contract crosses the system boundary as an AppPort capability with a
 * typed input and output, the same protocol every other AppPort application
 * speaks. There is no Attn-specific transport.
 * ---------------------------------------------------------------------- */

const primitive = s.union([s.string(), s.number(), s.boolean()]);
const NODE_STATUSES = ['ready', 'blocked', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled', 'unknown'] as const;
const ACTION_OUTCOMES = [
  'succeeded', 'capability-unavailable', 'provider-unavailable', 'resource-unavailable', 'credential-unavailable',
  'autonomy-denied', 'authority-unavailable', 'awaiting-approval', 'execution-failed', 'verification-failed',
  'verification-unavailable', 'unknown', 'cancelled',
] as const;

export const operationalWorkInputSchema = s.object({
  contract: s.literal(OPERATIONAL_WORK_CONTRACT),
  origin: s.object({ system: s.string(), type: s.string(), id: s.string() }),
  idempotencyKey: s.string(),
  project: s.string(),
  environment: s.optional(s.string()),
  intent: s.optional(s.string()),
  actions: s.array(s.object({
    verb: s.enum(OPERATIONAL_VERBS),
    target: s.optional(s.enum(['repository', 'environment'])),
    parameters: s.optional(s.record(primitive)),
  }), { minItems: 1, maxItems: 32 }),
});

export const operationalWorkOutputSchema = s.object({
  contract: s.literal(OPERATIONAL_WORK_CONTRACT),
  workId: s.string(),
  origin: s.object({ system: s.string(), type: s.string(), id: s.string() }),
  status: s.enum(['accepted', 'planning', 'ready', 'running', 'blocked', 'unresolved', 'completed', 'failed', 'cancelled']),
  outcome: s.nullable(s.string()),
  graphId: s.nullable(s.string()),
  intent: s.nullable(s.string()),
  actions: s.array(s.object({
    actionId: s.string(),
    key: s.string(),
    capability: s.string(),
    provider: s.nullable(s.string()),
    implied: s.boolean(),
    status: s.enum(NODE_STATUSES),
    outcome: s.nullable(s.enum(ACTION_OUTCOMES)),
    runId: s.nullable(s.string()),
    evidenceId: s.nullable(s.string()),
  })),
  completedActions: s.array(s.string()),
  blockedActions: s.array(s.string()),
  failedActions: s.array(s.string()),
  evidence: s.array(s.object({
    actionId: s.string(),
    runId: s.string(),
    evidenceId: s.string(),
    result: s.string(),
  })),
  createdAt: s.string(),
  updatedAt: s.string(),
  completedAt: s.nullable(s.string()),
});

export type OperationalWorkHandler = CapabilityHandler<unknown, OperationalWorkResult>;

export function operationalWorkCapability(handler: OperationalWorkHandler) {
  return defineCapability<unknown, OperationalWorkResult>({
    name: OPERATIONAL_WORK_CAPABILITY,
    version: OPERATIONAL_WORK_CAPABILITY_VERSION,
    description: `Request operational work (${OPERATIONAL_VERBS.join(', ')}) from Factory under ${OPERATIONAL_WORK_CONTRACT}.`,
    input: operationalWorkInputSchema,
    output: operationalWorkOutputSchema,
    authorization: ['factory.run'],
    idempotency: 'supported',
    handler,
  });
}

/** Errors a handler raises become protocol errors, never sanitized internals. */
export function toAppPortError(error: unknown, context: CapabilityContext): never {
  if (error instanceof OperationalWorkRequestError) throw errors.invalidInput(error.message);
  if (error instanceof OperationalWorkConflictError) throw errors.conflict(error.message);
  if (error && typeof error === 'object' && (error as { status?: number }).status === 400) {
    throw errors.invalidRequest((error as Error).message);
  }
  if (error && typeof error === 'object' && (error as { status?: number }).status === 403) {
    throw errors.forbidden((error as Error).message);
  }
  context.logger.error('operational work failed', { requestId: context.requestId });
  throw error;
}
