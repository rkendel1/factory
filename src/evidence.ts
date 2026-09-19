import type { ExecutionContract, InvariantEvidence, JevEvaluation, StructuredEvidence } from './types.js';

interface RawExecutionResult {
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  paxVersion?: string;
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
  const deterministicResult = result.status === 'cancelled'
    ? 'CANCELLED'
    : result.exitCode === 0
      ? 'PASS'
      : 'FAIL';
  const jev = parseJevEvaluation(result.stdout, result.stderr);
  const finalResult = deterministicResult === 'FAIL'
    ? 'FAIL'
    : deterministicResult === 'CANCELLED'
      ? 'CANCELLED'
      : 'PASS';

  return {
    id: contract.runId,
    runId: contract.runId,
    requestId: contract.runId,
    contractId: contract.runId,
    contractFingerprint: contract.fingerprint,
    ...(contract.applicationContract ? { applicationContractFingerprint: contract.applicationContract.fingerprint } : {}),
    principal: contract.principal,
    tenantId: contract.tenantId,
    operation: contract.operation,
    ...(contract.appport ? { appport: contract.appport } : {}),
    ref: contract.repository.ref,
    executionMode: contract.execution.mode,
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
      commit: repositoryCommit,
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
    artifacts: [],
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
  status: 'failed' | 'cancelled' = 'failed',
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
    },
    contract.repository.commit,
  );
}
