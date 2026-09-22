import type { ExecutionContract, InvariantEvidence, JevEvaluation, StructuredEvidence, TerminationReason } from './types.js';

/**
 * What the execution boundary reports. Everything here is measured at the
 * boundary — timestamps from the process, output as captured and bounded,
 * termination as observed — and nothing is filled in from the plan.
 */
export interface RawExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  paxVersion?: string;
  signal?: string | null;
  terminationReason?: TerminationReason;
  timedOut?: boolean;
  cancelled?: boolean;
  timeoutMs?: number;
  truncated?: { stdout: boolean; stderr: boolean };
  outputBytes?: { stdout: number; stderr: number };
  workspace?: string;
  credentialsResolved?: string[];
  /** Top-level workspace entries the operation created. Names only, bounded. */
  artifacts?: string[];
}

function matchField(label: string, text: string): string | undefined {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

export function parseInvariantEvidence(stdout: string, stderr: string): InvariantEvidence | undefined {
  const combined = `${stdout}\n${stderr}`;
  const name = matchField('Invariant', combined);
  const expected = matchField('Expected', combined);
  const observed = matchField('Observed', combined);

  if (!name && !expected && !observed) {
    return undefined;
  }

  return { name, expected, observed };
}

export function parseJevEvaluation(stdout: string, stderr: string): JevEvaluation {
  const combined = `${stdout}\n${stderr}`;
  const status = matchField('JEV', combined) as JevEvaluation['status'] | undefined;
  const explanation = matchField('Why', combined);

  if (!status) {
    return { status: 'UNAVAILABLE', explanation };
  }

  return { status, explanation };
}

export function buildEvidence(
  contract: ExecutionContract,
  result: RawExecutionResult,
  repositoryCommit?: string,
): StructuredEvidence {
  const invariant = parseInvariantEvidence(result.stdout, result.stderr);
  // Unknown is its own verdict: Factory could not observe the process end,
  // so neither PASS nor FAIL would be true.
  const deterministicResult = result.status === 'unknown'
    ? 'UNKNOWN'
    : result.status === 'cancelled'
      ? 'CANCELLED'
      : result.exitCode === 0
        ? 'PASS'
        : 'FAIL';
  const jev = parseJevEvaluation(result.stdout, result.stderr);
  const finalResult = deterministicResult === 'FAIL'
    ? 'FAIL'
    : deterministicResult === 'CANCELLED'
      ? 'CANCELLED'
      : deterministicResult === 'UNKNOWN'
        ? 'UNKNOWN'
        : 'PASS';

  return {
    id: contract.runId,
    runId: contract.runId,
    requestId: contract.runId,
    contractId: contract.runId,
    contractFingerprint: contract.fingerprint,
    ...(contract.applicationContract ? { applicationContractFingerprint: contract.applicationContract.fingerprint } : {}),
    // The application context the authority authorized, so the durable chain
    // records which association an Action executed under.
    ...(contract.authorizedApplication ? { authorizedApplication: contract.authorizedApplication } : {}),
    ...(contract.provider ? {
      provider: {
        id: contract.provider.provider,
        capability: contract.provider.capability,
        operation: contract.provider.operation,
        resource: contract.provider.resource,
        ...(contract.provider.providerResource ? { providerResource: contract.provider.providerResource } : {}),
        parameters: contract.provider.environment,
        credentials: contract.provider.credentials,
        idempotency: contract.provider.idempotency,
      },
    } : {}),
    ...(result.terminationReason ? {
      execution: {
        terminationReason: result.terminationReason,
        signal: result.signal ?? null,
        timedOut: result.timedOut ?? false,
        cancelled: result.cancelled ?? false,
        timeoutMs: result.timeoutMs ?? contract.limits.timeoutMs,
        truncated: result.truncated ?? { stdout: false, stderr: false },
        outputBytes: result.outputBytes ?? { stdout: Buffer.byteLength(result.stdout), stderr: Buffer.byteLength(result.stderr) },
        ...(result.workspace ? { workspace: result.workspace } : {}),
        credentialsResolved: result.credentialsResolved ?? [],
      },
    } : {}),
    revision: {
      ...(contract.repository.commit ? { requested: contract.repository.commit } : {}),
      ...(repositoryCommit ? { observed: repositoryCommit } : {}),
    },
    principal: contract.principal,
    tenantId: contract.tenantId,
    operation: contract.operation,
    ...(contract.appport ? { appport: contract.appport } : {}),
    ref: contract.repository.ref,
    executionMode: contract.execution.mode,
    ...(contract.github ? {
      github: {
        package: contract.github.package,
        packageVersion: contract.github.packageVersion,
        connectionId: contract.github.connectionId,
        operation: contract.github.operation,
        capability: contract.github.capability,
        resource: contract.github.resource,
      },
    } : {}),
    authorizationDecisionId: contract.authorizationDecisionId,
    authorizationDecision: 'granted',
    status: result.status,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    repository: {
      owner: contract.repository.owner,
      name: contract.repository.name,
      // Only what the checkout observed. A requested commit is recorded above
      // as requested, never promoted to reality.
      ...(repositoryCommit ? { commit: repositoryCommit } : {}),
    },
    stdout: result.stdout,
    stderr: result.stderr,
    ...(contract.execution.mode === 'pax' ? {
      pax: {
        version: result.paxVersion ?? 'unavailable',
        operation: contract.execution.operation ?? 'run',
        target: contract.execution.target,
        args: contract.execution.args,
        invocation: [
          'pax',
          '--json',
          contract.execution.operation ?? 'run',
          ...(contract.execution.target ? [contract.execution.target] : []),
          ...contract.execution.args,
        ],
      },
    } : {}),
    artifacts: result.artifacts ?? [],
    deterministicResult,
    finalResult,
    invariant,
    jev,
  };
}

export function buildFailureEvidence(
  contract: ExecutionContract,
  error: Error,
  startedAt: string,
  completedAt: string,
  status: 'failed' | 'cancelled' | 'unknown' = 'failed',
  terminationReason: TerminationReason = status === 'cancelled' ? 'cancelled' : 'spawn-failed',
): StructuredEvidence {
  return buildEvidence(
    contract,
    {
      status,
      exitCode: null,
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      stdout: '',
      stderr: error.message,
      terminationReason,
      signal: null,
      timedOut: false,
      cancelled: status === 'cancelled',
      credentialsResolved: [],
    },
    // Nothing ran, so nothing was observed; the requested commit stays requested.
    undefined,
  );
}

export function buildGitHubEvidence(
  contract: ExecutionContract,
  result: unknown,
  timing: { startedAt: string; completedAt: string; durationMs: number },
): StructuredEvidence {
  const evidence = buildEvidence(contract, {
    status: 'completed',
    exitCode: 0,
    ...timing,
    stdout: JSON.stringify(result) ?? '',
    stderr: '',
  });
  if (!contract.github) {
    throw new Error('GitHub evidence requires a GitHub execution contract');
  }
  return {
    ...evidence,
    github: {
      package: contract.github.package,
      packageVersion: contract.github.packageVersion,
      connectionId: contract.github.connectionId,
      operation: contract.github.operation,
      capability: contract.github.capability,
      resource: contract.github.resource,
      result,
    },
  };
}
