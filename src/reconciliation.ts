import { createHash } from 'node:crypto';
import type {
  DesiredStateRecord,
  EnvironmentCurrentState,
  ReconciliationRecord,
} from './types.js';

/**
 * The shortest interval Factory will schedule.
 *
 * A caller-supplied interval decides how often Factory talks to a repository,
 * an authority and a provider, so it is clamped rather than trusted: an
 * uncontrolled scheduler is a denial-of-service Factory would be performing on
 * its own dependencies.
 */
export const MINIMUM_INTERVAL_MS = 60_000;
export const MAXIMUM_INTERVAL_MS = 24 * 60 * 60_000;
export const DEFAULT_INTERVAL = '15m';

const INTERVAL = /^(\d{1,5})(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export class IntervalError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'IntervalError';
  }
}

export function parseInterval(value: string | undefined): { interval: string; intervalMs: number } {
  const text = (value ?? DEFAULT_INTERVAL).trim();
  const match = text.match(INTERVAL);
  if (!match) {
    throw new IntervalError(`interval must look like 30s, 15m, 6h or 1d; received ${JSON.stringify(text)}`);
  }
  const milliseconds = Number(match[1]) * UNIT_MS[match[2]!]!;
  if (milliseconds < MINIMUM_INTERVAL_MS) {
    throw new IntervalError(`interval must be at least ${MINIMUM_INTERVAL_MS / 1000}s`);
  }
  if (milliseconds > MAXIMUM_INTERVAL_MS) {
    throw new IntervalError('interval must be at most 1d');
  }
  return { interval: text, intervalMs: milliseconds };
}

function digest(parts: readonly (string | undefined)[]): string {
  return createHash('sha256').update(parts.map((part) => part ?? '').join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * A revision is what the record says, not when Factory read it.
 *
 * Two passes over an unchanged desired state produce the same revision, which
 * is what lets the fingerprint below recognise that the work has not changed.
 */
export function desiredStateRevision(desiredState: DesiredStateRecord | null): string {
  if (!desiredState) return 'none';
  return digest([
    desiredState.id,
    desiredState.sourceRepositoryId,
    desiredState.sourceBranch,
    desiredState.deploymentEnabled === undefined ? undefined : String(desiredState.deploymentEnabled),
    desiredState.targetProvider,
    desiredState.healthRequirement,
  ]);
}

export function observedStateRevision(current: EnvironmentCurrentState | null): string {
  if (!current) return 'unobserved';
  return digest([
    current.sourceCommit,
    current.sourceBranch,
    current.provider,
    current.deployment,
    current.health,
  ]);
}

/**
 * The identity of a piece of reconciliation work.
 *
 * It is derived from what the work is about — this environment, this desired
 * state, this observed reality, this kind of Action — and not from when it was
 * planned. Repeating a pass over unchanged inputs therefore produces the same
 * fingerprint and recognises the Action that already exists, while any real
 * change to desire or reality produces a different one and earns a new Action.
 */
export function reconciliationFingerprint(input: {
  projectId: string;
  environmentId: string;
  desiredStateRevision: string;
  observedStateRevision: string;
  actionType: string;
}): string {
  return digest([
    input.projectId,
    input.environmentId,
    input.desiredStateRevision,
    input.observedStateRevision,
    input.actionType,
  ]);
}

export function nextDueAt(record: ReconciliationRecord, now: number): string {
  return new Date(now + Math.max(record.intervalMs, MINIMUM_INTERVAL_MS)).toISOString();
}

/** Human phrasing for a record's schedule, for the UI and for explanations. */
export function describeSchedule(record: ReconciliationRecord): string {
  if (!record.enabled) return 'Disabled';
  const units: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day' };
  const match = record.interval.match(INTERVAL);
  if (!match) return `Every ${record.interval}`;
  const count = Number(match[1]);
  return `Every ${count === 1 ? '' : `${count} `}${units[match[2]!]}${count === 1 ? '' : 's'}`;
}
