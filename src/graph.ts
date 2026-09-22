import type { ActionGraphRecord, ActionGraphStatus, ActionRecord } from './types.js';

/**
 * Graph coordination as pure functions over durable records.
 *
 * Nothing here holds state. Every answer is derived from the Actions as FeltDB
 * has them, so two Factory instances, or one instance before and after a
 * restart, derive the same answer from the same records.
 */

export type NodeStatus =
  | 'ready'
  | 'blocked'
  | 'awaiting-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PlannedAction {
  /** Request-local name other actions refer to in `dependsOn`. */
  key?: string;
  type: string;
  intent?: string;
  parameters?: Record<string, unknown>;
  dependsOn?: string[];
  operation?: string;
  capability?: string;
}

export class GraphValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

/**
 * Resolve a requested plan into an execution order.
 *
 * Every dependency must name an action in the same request, and the result
 * must be acyclic: a graph that waits on itself would block forever, and the
 * time to say so is before anything durable is written.
 */
export function orderPlan(actions: readonly PlannedAction[]): { key: string; action: PlannedAction; dependsOn: string[] }[] {
  if (actions.length === 0) throw new GraphValidationError('an action graph needs at least one action');
  const keyed = actions.map((action, index) => ({
    key: action.key?.trim() || `action-${index + 1}`,
    action,
    dependsOn: [...new Set(action.dependsOn ?? [])],
  }));
  const keys = new Set<string>();
  for (const entry of keyed) {
    if (keys.has(entry.key)) throw new GraphValidationError(`action key ${entry.key} is used twice`);
    keys.add(entry.key);
  }
  for (const entry of keyed) {
    for (const dependency of entry.dependsOn) {
      if (!keys.has(dependency)) {
        throw new GraphValidationError(`action ${entry.key} depends on ${dependency}, which is not in this graph`);
      }
      if (dependency === entry.key) {
        throw new GraphValidationError(`action ${entry.key} depends on itself`);
      }
    }
  }

  // Kahn's algorithm; anything left over is on a cycle.
  const remaining = new Map(keyed.map((entry) => [entry.key, new Set(entry.dependsOn)]));
  const ordered: typeof keyed = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key)
      .sort();
    if (ready.length === 0) {
      throw new GraphValidationError(`action graph has a dependency cycle among ${[...remaining.keys()].sort().join(', ')}`);
    }
    for (const key of ready) {
      ordered.push(keyed.find((entry) => entry.key === key)!);
      remaining.delete(key);
      for (const dependencies of remaining.values()) dependencies.delete(key);
    }
  }
  return ordered;
}

/**
 * What a node is, given its Action and the Actions it depends on.
 *
 * A failed dependency blocks a node rather than failing it: the node never
 * ran, and saying it failed would invent a result. The failure stays on the
 * Action that actually failed.
 */
export function nodeStatus(action: ActionRecord, byId: ReadonlyMap<string, ActionRecord>): NodeStatus {
  if (action.status === 'succeeded') return 'completed';
  if (action.status === 'running' || action.status === 'authorized' || action.status === 'executed' || action.status === 'verifying') return 'running';
  if (action.outcome === 'cancelled') return 'cancelled';
  if (action.status === 'failed') return 'failed';

  const dependencies = (action.dependsOn ?? []).map((id) => byId.get(id));
  if (dependencies.some((dependency) => !dependency)) return 'blocked';
  if (dependencies.some((dependency) => dependency!.status === 'failed' || dependency!.outcome === 'cancelled')) {
    return 'blocked';
  }
  if (dependencies.some((dependency) => dependency!.status !== 'succeeded')) return 'blocked';
  if (action.status === 'awaiting-approval') return 'awaiting-approval';
  return 'ready';
}

/** The dependencies that stop a node, so the reason can be persisted. */
export function blockingDependencies(action: ActionRecord, byId: ReadonlyMap<string, ActionRecord>): string[] {
  return (action.dependsOn ?? []).filter((id) => {
    const dependency = byId.get(id);
    return !dependency || dependency.status === 'failed' || dependency.outcome === 'cancelled';
  });
}

/** Nodes that may run now, in a deterministic order. */
export function readyActions(actions: readonly ActionRecord[]): ActionRecord[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return actions
    .filter((action) => nodeStatus(action, byId) === 'ready')
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id));
}

/**
 * Nodes whose dependencies are met, including those waiting for a person.
 *
 * A node the authority declined at planning time is asked about again when
 * its turn comes: the decision that matters is the one made now, and a grant
 * given since planning should let the node run without anyone re-planning.
 */
export function runnableActions(actions: readonly ActionRecord[]): ActionRecord[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return actions
    .filter((action) => {
      const status = nodeStatus(action, byId);
      return status === 'ready' || status === 'awaiting-approval';
    })
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id));
}

/**
 * The graph's status is a summary of its nodes, never a separate fact.
 *
 * A graph is failed only when a node failed and nothing else can run; blocked
 * when a person is needed; completed only when every node succeeded.
 */
export function graphStatus(graph: ActionGraphRecord, actions: readonly ActionRecord[]): ActionGraphStatus {
  if (graph.status === 'cancelled') return 'cancelled';
  if (actions.length === 0) return 'planned';
  const byId = new Map(actions.map((action) => [action.id, action]));
  const statuses = actions.map((action) => nodeStatus(action, byId));
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'failed' || status === 'cancelled')) return 'failed';
  if (statuses.some((status) => status === 'awaiting-approval')) return 'blocked';
  if (statuses.some((status) => status === 'ready')) return 'ready';
  return 'planned';
}
