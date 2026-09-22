import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { buildEvidence, type RawExecutionResult } from './evidence.js';
import { createWorkspace, destroyWorkspace, materializeRepository, type WorkspaceHandle } from './workspace.js';
import type { ExecutionContract, StructuredEvidence, TerminationReason } from './types.js';
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

/** How much of each output stream is kept. The rest is counted, not stored. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** How long a cancelled process gets to stop on SIGTERM before SIGKILL. */
const CANCEL_GRACE_MS = 5000;

export type CredentialResolver = (name: string) => string | undefined;

export const processCredentialResolver: CredentialResolver = (name) => process.env[name];

export class CredentialUnavailableError extends Error {
  readonly outcome = 'credential-unavailable' as const;

  constructor(readonly names: string[]) {
    super(`credential ${names.join(', ')} is not available to the execution boundary`);
    this.name = 'CredentialUnavailableError';
  }
}

export class SpawnFailedError extends Error {
  readonly terminationReason = 'spawn-failed' as const;

  constructor(readonly command: string, readonly code: string | undefined, message: string) {
    super(message);
    this.name = 'SpawnFailedError';
  }
}

/**
 * Whether every credential the contract names can be resolved. Presence only:
 * the value is not read here, and nothing outside `spawn` ever holds it.
 */
export function missingCredentials(contract: Pick<ExecutionContract, 'provider'>, resolve: CredentialResolver = processCredentialResolver): string[] {
  return (contract.provider?.credentials ?? []).filter((name) => !resolve(name));
}

/**
 * The credential lifecycle ends here.
 *
 *   Action → credential name → execution boundary → resolver → spawn → provider
 *
 * Values are resolved at the moment of spawning, placed only in the child's
 * environment, and used afterwards for exactly one thing: redacting themselves
 * from whatever the process printed.
 */
function resolveCredentials(contract: ExecutionContract, resolve: CredentialResolver): Record<string, string> {
  const names = contract.provider?.credentials ?? [];
  const missing = names.filter((name) => !resolve(name));
  if (missing.length > 0) throw new CredentialUnavailableError(missing);
  return Object.fromEntries(names.map((name) => [name, resolve(name)!]));
}

function createExecutionEnvironment(contract: ExecutionContract, credentials: Record<string, string>): Record<string, string> {
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

/**
 * Remove credential values from text. Applied to everything the process
 * produced and to every error message about it, so a provider that echoes a
 * token back never gets it into evidence or a log line.
 */
export function redactSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  let output = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < 4) continue;
    output = output.split(value).join(`[redacted:${name}]`);
  }
  // Bearer tokens and cookies a provider might print regardless of ours.
  return output
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/(cookie:\s*)[^\n]+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|token|password|secret)[=:]\s*)[^\s,;"']+/gi, '$1[redacted]');
}

function validateCommand(contract: ExecutionContract): void {
  if (!contract.command || contract.command.length === 0) {
    throw new Error('Execution contract does not contain an authorized command');
  }

  const shellCommands = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell']);
  if (shellCommands.has(contract.command[0] ?? '')) {
    throw new Error('Shell-based commands are not authorized by the runner boundary');
  }
}

/** Keeps at most `limit` bytes and remembers how much arrived in total. */
class BoundedOutput {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.kept >= this.limit) return;
    const room = this.limit - this.kept;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.kept += slice.length;
  }

  get truncated(): boolean { return this.total > this.kept; }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${text}\n[output truncated: ${this.total} bytes, ${this.kept} kept]` : text;
  }
}

export async function executeContract(
  contract: ExecutionContract,
  options: {
    repositoryRoot?: string;
    workspaceRoot?: string;
    onHandle?: (handle: ExecutionHandle) => void;
    paxExecutable?: string;
    credentialResolver?: CredentialResolver;
    /** Called once the provider process exists, before its result is known. */
    onSpawned?: () => Promise<void> | void;
  } = {},
): Promise<ExecutionOutcome> {
  assertContractIntegrity(contract);
  if (contract.execution.mode === 'native') {
    validateCommand(contract);
  }
  // Credentials are checked before anything is created, so a missing one
  // leaves no workspace and no half-started operation behind.
  const credentials = resolveCredentials(contract, options.credentialResolver ?? processCredentialResolver);
  const paxVersion = contract.execution.mode === 'pax'
    ? await verifyPax(options.paxExecutable)
    : undefined;
  const workspace = await createWorkspace(contract.runId, options.workspaceRoot);
  let repositoryCommit: string | undefined;

  try {
    ({ commit: repositoryCommit } = await materializeRepository(contract.repository, workspace, options.repositoryRoot));
    const result = await runBoundedCommand(contract, workspace, credentials, options.onHandle, options.paxExecutable, paxVersion, options.onSpawned);
    return { evidence: buildEvidence(contract, result, repositoryCommit), repositoryCommit };
  } catch (error) {
    // Anything that names the workspace or a value must be sanitized before it
    // becomes a message a caller can persist.
    if (error instanceof Error) error.message = redactSecrets(error.message, credentials);
    throw error;
  } finally {
    await destroyWorkspace(workspace);
  }
}

async function runBoundedCommand(
  contract: ExecutionContract,
  workspace: WorkspaceHandle,
  credentials: Record<string, string>,
  onHandle?: (handle: ExecutionHandle) => void,
  paxExecutable = process.env.PAX_BIN ?? 'pax',
  paxVersion?: string,
  onSpawned?: () => Promise<void> | void,
): Promise<RawExecutionResult> {
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
    // What the operation leaves behind is observed, not inferred: the
    // workspace's top-level entries before and after, bounded.
    const listWorkspace = () => { try { return new Set(readdirSync(workspace.repositoryPath)); } catch { return new Set<string>(); } };
    const before = listWorkspace();
    const stdout = new BoundedOutput(MAX_OUTPUT_BYTES);
    const stderr = new BoundedOutput(MAX_OUTPUT_BYTES);
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let cancelled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    try {
      child = spawn(command, args, {
        cwd: workspace.repositoryPath,
        env: createExecutionEnvironment(contract, credentials),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout or cancel reaches everything a
        // provider CLI spawned underneath it, not only the CLI itself.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(error);
      return;
    }

    const signalTree = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    onHandle?.({
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // Ask politely, then insist. A provider CLI that ignores SIGTERM does
        // not get to keep running.
        signalTree('SIGTERM');
        killTimer = setTimeout(() => signalTree('SIGKILL'), CANCEL_GRACE_MS);
      },
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree('SIGKILL');
    }, contract.limits.timeoutMs);

    if (!child) {
      reject(new Error('Failed to start child process'));
      return;
    }

    // The process exists: from here on, an interruption leaves the outcome
    // unknown rather than failed.
    Promise.resolve(onSpawned?.()).catch(reject);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(new SpawnFailedError(command, error.code, redactSecrets(
        error.code === 'ENOENT'
          ? `${command} is not installed on the execution host`
          : `${command} could not be started: ${error.message}`,
        credentials,
      )));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      const terminationReason: TerminationReason = cancelled
        ? 'cancelled'
        : timedOut ? 'timeout' : signal ? 'signal' : 'exit';
      const base = {
        exitCode: code,
        signal: signal ?? null,
        terminationReason,
        timedOut,
        cancelled,
        timeoutMs: contract.limits.timeoutMs,
        startedAt,
        completedAt,
        durationMs: completedAtMs - startedAtMs,
        stdout: redactSecrets(stdout.text(), credentials),
        stderr: redactSecrets(stderr.text(), credentials),
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
        outputBytes: { stdout: stdout.total, stderr: stderr.total },
        workspace: workspace.repositoryPath,
        credentialsResolved: Object.keys(credentials),
        artifacts: [...listWorkspace()].filter((entry) => !before.has(entry)).sort().slice(0, 50),
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
          stderr: `${base.stderr}${base.stderr ? '\n' : ''}Execution timed out after ${contract.limits.timeoutMs}ms`,
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
