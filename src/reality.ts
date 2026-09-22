import type {
  DesiredStateRecord,
  EnvironmentCurrentState,
  EnvironmentRecord,
  RepositoryDiscovery,
  RepositoryRecord,
  RunRecord,
  StructuredEvidence,
} from './types.js';

/**
 * Reality is observed, never assumed.
 *
 * Every field below comes from something Factory can actually see: the
 * repository it discovered, the durable evidence of the last run that
 * reconciled this environment, and the environment record itself. A field
 * Factory cannot observe is reported as unknown rather than filled in with the
 * desired value, because a reality that quietly mirrors desire can never drift.
 */
export interface RealityField {
  field: string;
  label: string;
  desired: string | null;
  current: string | null;
  drifted: boolean;
  /** Where the observation came from, so a reader can check it. */
  source: string;
}

export type DriftStatus = 'reconciled' | 'drifted' | 'unknown';

export interface DriftReport {
  projectId: string;
  environmentId: string;
  environmentName: string;
  status: DriftStatus;
  observedAt: string;
  fields: RealityField[];
  /** Plain sentences a person can act on, not a diff dump. */
  explanation: string[];
  /** Present when drift exists and Factory can name what would fix it. */
  proposal: { type: string; intent: string } | null;
}

const UNKNOWN = 'unknown';

function short(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 12) : null;
}

/**
 * What the environment looks like now.
 *
 * Current state has exactly one writer: reconciliation, from the durable
 * evidence of the run that produced it. Reality is not re-derived here from
 * runs, because two derivations of one fact disagree the moment they are
 * computed differently — and the one that silently wins would decide whether
 * drift exists.
 *
 * An environment nothing has reconciled has no current state. That is a real
 * answer, and a different one from "the environment is wrong".
 */
export function observeEnvironment(environment: EnvironmentRecord): EnvironmentCurrentState | null {
  return environment.currentState ?? null;
}

/**
 * Compare what should be true with what is, field by field.
 *
 * A field is only drifted when both sides are known and differ. An unknown
 * current value is reported as unknown: it means Factory has not observed this
 * environment yet, which is a different problem from the environment being
 * wrong, and conflating them would invent drift on every new environment.
 */
export function compareReality(input: {
  project: { id: string };
  environment: EnvironmentRecord;
  desiredState: DesiredStateRecord | null;
  repository: RepositoryRecord | null;
  discovery: RepositoryDiscovery | null;
  current: EnvironmentCurrentState | null;
}): DriftReport {
  const { environment, desiredState, repository, discovery, current } = input;
  const desiredBranch = desiredState?.sourceBranch ?? repository?.defaultBranch ?? null;
  const desiredCommit = discovery?.signals.headCommit ?? null;
  const desiredDeployment = desiredState?.deploymentEnabled === undefined
    ? null
    : desiredState.deploymentEnabled ? 'enabled' : 'disabled';
  const desiredProvider = desiredState?.targetProvider ?? environment.provider ?? null;

  const compare = (
    field: string,
    label: string,
    desired: string | null,
    observed: string | null,
    source: string,
  ): RealityField => ({
    field,
    label,
    desired,
    current: observed,
    drifted: Boolean(desired && observed && desired !== observed),
    source,
  });

  const fields: RealityField[] = [
    compare('sourceBranch', 'Branch', desiredBranch, current?.sourceBranch ?? null,
      'desired state and the last reconciling run'),
    compare('sourceCommit', 'Commit', short(desiredCommit), short(current?.sourceCommit),
      'repository head and the evidence of the last reconciling run'),
    compare('deployment', 'Deployment', desiredDeployment, current?.deployment ?? null,
      'desired state and environment configuration'),
    compare('health', 'Health', desiredState?.healthRequirement ? 'healthy' : null,
      current?.health ?? null, 'desired state and the last run evidence'),
    compare('provider', 'Provider', desiredProvider, current?.provider ?? null,
      'desired state and the environment record'),
  ];

  const drifted = fields.filter((field) => field.drifted);
  const status: DriftStatus = !current
    ? 'unknown'
    : drifted.length > 0 ? 'drifted' : 'reconciled';

  return {
    projectId: input.project.id,
    environmentId: environment.id,
    environmentName: environment.name,
    status,
    observedAt: current?.observedAt ?? new Date().toISOString(),
    fields,
    explanation: explain({ environment, fields: drifted, status, desiredBranch, desiredCommit, current }),
    proposal: status === 'drifted'
      ? {
          type: 'reconcile',
          intent: reconcileIntent(environment, desiredBranch, desiredCommit),
        }
      : null,
  };
}

function explain(input: {
  environment: EnvironmentRecord;
  fields: readonly RealityField[];
  status: DriftStatus;
  desiredBranch: string | null;
  desiredCommit: string | null;
  current: EnvironmentCurrentState | null;
}): string[] {
  if (input.status === 'unknown') {
    return [`Factory has not observed ${input.environment.name} yet. `
      + 'No run has reconciled this environment, so there is nothing to compare desired state against.'];
  }
  if (input.status === 'reconciled') {
    return [`${input.environment.name} matches its desired state.`];
  }
  return input.fields.map((field) => {
    if (field.field === 'sourceCommit') {
      return `${input.environment.name} is running ${field.current}. `
        + `Repository ${input.desiredBranch ?? 'head'} is ${field.desired}.`;
    }
    return `${input.environment.name} has ${field.label.toLowerCase()} ${field.current}, `
      + `and desired state says ${field.desired}.`;
  });
}

function reconcileIntent(
  environment: EnvironmentRecord,
  branch: string | null,
  commit: string | null,
): string {
  const source = commit ? short(commit) : branch ?? 'the repository head';
  return `Reconcile ${environment.name} to ${source}`;
}

/**
 * The state to record once a run has reconciled an environment.
 *
 * Reconciliation closes the loop: the evidence of what happened becomes the
 * current state the next comparison reads, so the next observation is of
 * reality rather than of intent.
 */
export function reconciledState(input: {
  environment: EnvironmentRecord;
  run: RunRecord;
  evidence: StructuredEvidence | null;
  desiredState: DesiredStateRecord | null;
}): EnvironmentCurrentState {
  const { run, evidence, desiredState } = input;
  return {
    observedAt: run.completedAt ?? new Date().toISOString(),
    ...(evidence?.repository?.commit ? { sourceCommit: evidence.repository.commit } : {}),
    ...(run.repository?.ref ? { sourceBranch: run.repository.ref } : {}),
    ...(desiredState?.targetProvider ?? input.environment.provider
      ? { provider: desiredState?.targetProvider ?? input.environment.provider! }
      : {}),
    deployment: desiredState?.deploymentEnabled === false ? 'disabled' : 'enabled',
    health: evidence?.finalResult === 'PASS' ? 'healthy' : evidence ? 'unhealthy' : UNKNOWN as 'unknown',
    reconciledRunId: run.id,
    ...(evidence ? { reconciledEvidenceId: evidence.id } : {}),
  };
}
