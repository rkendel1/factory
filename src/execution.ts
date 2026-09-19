import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildEvidence } from './evidence.js';
import { createWorkspace, destroyWorkspace, materializeRepository, type WorkspaceHandle } from './workspace.js';
import type { ExecutionContract, StructuredEvidence } from './types.js';

export interface ExecutionHandle {
  cancel: () => void;
}

export interface ExecutionOutcome {
  evidence: StructuredEvidence;
  repositoryCommit?: string;
}

function createExecutionEnvironment(contract: ExecutionContract): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_TERMINAL_PROMPT: '0',
    FACTORY_RUN_ID: contract.runId,
    FACTORY_WORK_ID: contract.workId,
    FACTORY_OPERATION: contract.operation,
    npm_config_loglevel: 'error',
  };
}

function validateCommand(contract: ExecutionContract): void {
  if (contract.command.length === 0) {
    throw new Error('Execution contract does not contain an authorized command');
  }

  const shellCommands = new Set(['sh', 'bash']);
  if (shellCommands.has(contract.command[0])) {
    throw new Error('Shell-based commands are not authorized by the runner boundary');
  }
}

export async function executeContract(
  contract: ExecutionContract,
  options: {
    repositoryRoot?: string;
    workspaceRoot?: string;
    onHandle?: (handle: ExecutionHandle) => void;
  } = {},
): Promise<ExecutionOutcome> {
  validateCommand(contract);
  const workspace = await createWorkspace(contract.runId, options.workspaceRoot);
  let repositoryCommit: string | undefined;

  try {
    ({ commit: repositoryCommit } = await materializeRepository(contract.repository, workspace, options.repositoryRoot));
    const result = await runBoundedCommand(contract, workspace, options.onHandle);
    return { evidence: buildEvidence(contract, result, repositoryCommit), repositoryCommit };
  } finally {
    await destroyWorkspace(workspace);
  }
}

async function runBoundedCommand(
  contract: ExecutionContract,
  workspace: WorkspaceHandle,
  onHandle?: (handle: ExecutionHandle) => void,
): Promise<{
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = contract.command;
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

      resolve({ ...base, status: code === 0 ? 'completed' : 'failed' });
    });
  });
}
