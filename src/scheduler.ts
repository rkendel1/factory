import { randomUUID } from 'node:crypto';
import type { FactoryService } from './server.js';
import type { AuthenticatedContext, CapabilityProbe } from './auth.js';
import type { ReconciliationRecord } from './types.js';

/**
 * The reconciliation worker.
 *
 * The scheduler is not authoritative. It holds no reconciliation state of its
 * own: it asks FeltDB which records are due, claims one at a time, and writes
 * everything it learns back. A restart loses nothing but the timer, and two
 * Factory instances running this loop cannot both act on one environment,
 * because claiming is a compare-and-set on the record.
 *
 * It also decides nothing. Whether work is required is the reconciliation
 * engine's answer, and whether Factory may act on it is AuthBoundry's.
 */
export interface SchedulerOptions {
  service: FactoryService;
  /** Resolves the authority each pass acts under. */
  context: () => Promise<AuthenticatedContext>;
  probe?: CapabilityProbe;
  /** How often the worker looks for due records. */
  tickMs?: number;
  /** How long a claim is held before another worker may reclaim it. */
  leaseMs?: number;
  /** Most records handled in one tick, so one worker cannot monopolise a tick. */
  batchSize?: number;
  now?: () => number;
  onError?: (error: unknown, record?: ReconciliationRecord) => void;
}

export interface SchedulerHandle {
  readonly id: string;
  /** Run one pass over the due records. Exposed so a tick is testable. */
  tick(): Promise<ReconciliationRecord[]>;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export const DEFAULT_TICK_MS = 30_000;
export const DEFAULT_LEASE_MS = 5 * 60_000;

export function createReconciliationScheduler(options: SchedulerOptions): SchedulerHandle {
  const id = `worker_${randomUUID()}`;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const batchSize = options.batchSize ?? 5;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  const tick = async (): Promise<ReconciliationRecord[]> => {
    // Ticks never overlap: a slow pass delays the next look rather than
    // stacking a second worker on top of the first inside one process.
    if (ticking) return [];
    ticking = true;
    const handled: ReconciliationRecord[] = [];
    try {
      const domain = options.service.projects();
      const due = await domain.dueReconciliations(now());
      for (const record of due.slice(0, batchSize)) {
        const claimed = await domain.claimReconciliation(record.id, id, now(), leaseMs);
        // Another worker won the claim. That is the normal outcome of a race,
        // not an error, and this worker simply moves on.
        if (!claimed) continue;
        try {
          const context = await options.context();
          const result = await options.service.runReconciliationPass(context, claimed, {
            ...(options.probe ? { probe: options.probe } : {}),
            now: now(),
          });
          handled.push(result.record);
        } catch (error) {
          options.onError?.(error, claimed);
          // A pass that threw still releases its claim, or the environment
          // would be stuck until the lease expired.
          const released = await domain.releaseReconciliation(claimed.id, {
            status: 'failed',
            lastError: error instanceof Error ? error.message : String(error),
            nextDueAt: new Date(now() + Math.max(claimed.intervalMs, 60_000)).toISOString(),
          });
          if (released) handled.push(released);
        }
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      ticking = false;
    }
    return handled;
  };

  return {
    id,
    tick,
    start() {
      if (timer) return;
      /*
       * Starting does not run everything. Records carry their own next-due
       * time, so a restart resumes the schedule rather than reconciling every
       * environment at once because the process happened to boot.
       */
      timer = setInterval(() => { void tick(); }, tickMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
