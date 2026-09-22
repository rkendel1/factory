import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildEvidence } from './evidence.js';
import { createWorkspace, destroyWorkspace, materializeRepository, type WorkspaceHandle } from './workspace.js';
import type { ExecutionContract, StructuredEvidence } from './types.js';
import { assertContractIntegrity } from './contract.js';

export async function verifyPax(executable = process.env.PAX_BIN ?? 'pax'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PAX executable "${executable}" did not respond to --version`));
    }, 5000);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new Error(`PAX is required for this execution but "${executable}" is unavailable`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`PAX is required for this execution but "${executable} --version" failed: ${errorOutput.trim()}`));
        return;
      }
      resolve((output || errorOutput).trim());
    });
  });
}

export interface ExecutionHandle {
  cancel: () => void;
}

export interface ExecutionOutcome {
  evidence: StructuredEvidence;
  repositoryCommit?: string;
}

/**
 * The environment a provider operation runs in.
 *
 * Parameters come from the contract. Credentials come from this process, by
 * the names the contract lists, at the moment of spawning: they are resolved
 * inside the execution boundary and nowhere else, so no Action, contract, or
 * evidence ever holds a value.
 */
function createExecutionEnvironment(contract: ExecutionContract): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const name of contract.provider?.credentials ?? []) {
    const value = process.env[name];
    if (value) credentials[name] = value;
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_TERMINAL_PROMPT: '0',
    FACTORY_RUN_ID: contract.runId,
    FACTORY_WORK_ID: contract.workId,
    FACTORY_OPERATION: contract.operation,
    ...(contract.provider ? {
      FACTORY_PROVIDER: contract.provider.provider,
      FACTORY_CAPABILITY: contract.provider.capability,
      FACTORY_RESOURCE: contract.provider.resource,
      FACTORY_IDEMPOTENCY_KEY: contract.provider.idempotency.key,
      ...contract.provider.environment,
    } : {}),
    ...credentials,
    npm_config_loglevel: 'error',
  };
}

function validateCommand(contract: ExecutionContract): void {
  if (!contract.command || contract.command.length === 0) {
    throw new Error('Execution contract does not contain an authorized command');
  }

  const shellCommands = new Set(['sh', 'bash']);
  if (shellCommands.has(contract.command[0] ?? '')) {
    throw new Error('Shell-based commands are not authorized by the runner boundary');
  }
}

export async function executeContract(
  contract: ExecutionContract,
  options: {
    repositoryRoot?: string;
    workspaceRoot?: string;
    onHandle?: (handle: ExecutionHandle) => void;
    paxExecutable?: string;
  } = {},
): Promise<ExecutionOutcome> {
  assertContractIntegrity(contract);
  if (contract.execution.mode === 'native') {
    validateCommand(contract);
  }
  const paxVersion = contract.execution.mode === 'pax'
    ? await verifyPax(options.paxExecutable)
    : undefined;
  const workspace = await createWorkspace(contract.runId, options.workspaceRoot);
  let repositoryCommit: string | undefined;

  try {
    ({ commit: repositoryCommit } = await materializeRepository(contract.repository, workspace, options.repositoryRoot));
    const result = await runBoundedCommand(contract, workspace, options.onHandle, options.paxExecutable, paxVersion);
    return { evidence: buildEvidence(contract, result, repositoryCommit), repositoryCommit };
  } finally {
    await destroyWorkspace(workspace);
  }
}

async function runBoundedCommand(
  contract: ExecutionContract,
  workspace: WorkspaceHandle,
  onHandle?: (handle: ExecutionHandle) => void,
  paxExecutable = process.env.PAX_BIN ?? 'pax',
  paxVersion?: string,
): Promise<{
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  paxVersion?: string;
}> {
  return new Promise((resolve, reject) => {
    const command = contract.execution.mode === 'pax' ? paxExecutable : contract.command?.[0];
    const args = contract.execution.mode === 'pax'
      ? ['--json', contract.execution.operation ?? 'run', contract.execution.target ?? '', ...contract.execution.args]
      : contract.command?.slice(1) ?? [];
    if (!command || (contract.execution.mode === 'pax' && !contract.execution.target)) {
      reject(new Error('Execution contract does not contain a complete authorized execution'));
      return;
    }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let stdout = '';
    let stderr = '';
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let cancelled = false;
    let timedOut = false;

    try {
      child = spawn(command, args, {
        cwd: workspace.repositoryPath,
        env: createExecutionEnvironment(contract),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    onHandle?.({
      cancel: () => {
        cancelled = true;
        child?.kill('SIGTERM');
      },
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGKILL');
    }, contract.limits.timeoutMs);

    if (!child) {
      reject(new Error('Failed to start child process'));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      const base = {
        exitCode: code,
        startedAt,
        completedAt,
        durationMs: completedAtMs - startedAtMs,
        stdout,
        stderr,
        ...(paxVersion ? { paxVersion } : {}),
      };

      if (cancelled) {
        resolve({ ...base, status: 'cancelled' });
        return;
      }

      if (timedOut) {
        resolve({
          ...base,
          status: 'failed',
          exitCode: code,
          stderr: `${stderr}${stderr ? '\n' : ''}Execution timed out after ${contract.limits.timeoutMs}ms`,
        });
        return;
      }

      resolve({
        ...base,
        status: code === 0 ? 'completed' : 'failed',
      });
    });
  });
}
