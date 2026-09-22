import { spawn } from 'node:child_process';
import type { RepositoryConnection, RepositoryRecord } from './types.js';

/**
 * A repository is connected when Factory can reach it, not when a record
 * names it. Connection is verified against the remote with `git ls-remote`,
 * recorded on the repository, and refreshed by reconciliation and on demand.
 *
 * Credentials never enter the record, the command line or an error message:
 * a token is resolved by name at the boundary, handed to git through its
 * environment, and redacted from anything git prints.
 */

/** The credential name a provider's repositories are read with. */
export const REPOSITORY_CREDENTIALS: Readonly<Record<string, string>> = { github: 'GITHUB_TOKEN' };

export function repositoryRemoteUrl(repository: Pick<RepositoryRecord, 'provider' | 'owner' | 'name' | 'repositoryUrl'>): string | null {
  if (repository.repositoryUrl) return repository.repositoryUrl;
  if (repository.provider === 'github') return `https://github.com/${repository.owner}/${repository.name}.git`;
  return null;
}

export function repositoryCredentialName(provider: string): string | undefined {
  return REPOSITORY_CREDENTIALS[provider];
}

/**
 * Git configuration carried in the environment, so a credential is never an
 * argument another process on the host could list.
 */
export function gitCredentialEnvironment(provider: string, resolve: (name: string) => string | undefined): { env: Record<string, string>; credential?: string; secrets: Record<string, string> } {
  const name = repositoryCredentialName(provider);
  const value = name ? resolve(name) : undefined;
  if (!name || !value) return { env: {}, secrets: {} };
  const header = provider === 'github'
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`
    : `AUTHORIZATION: bearer ${value}`;
  return {
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: header },
    credential: name,
    secrets: { [name]: value, [`${name}_HEADER`]: header },
  };
}

export function redact(text: string, secrets: Readonly<Record<string, string>>): string {
  let output = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value && value.length >= 4) output = output.split(value).join(`[redacted:${name}]`);
  }
  return output.replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@');
}

function lsRemote(url: string, branch: string | undefined, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-remote', '--symref', url, 'HEAD', ...(branch ? [`refs/heads/${branch}`] : [])], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 65536) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 65536) stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Git explains a failure on its first `fatal:` line; the lines after it are generic advice. */
export function gitFailureReason(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const fatal = lines.find((line) => /^(fatal|error|remote):/.test(line));
  return (fatal ?? lines[0])?.replace(/^(fatal|error):\s*/, '');
}

/**
 * Ask the remote what it has. `connected` means the repository answered:
 * its HEAD, its default branch, and the tip of the configured branch are
 * recorded so planning and drift compare against what the remote holds.
 */
export async function verifyRepositoryConnection(
  repository: RepositoryRecord,
  resolve: (name: string) => string | undefined,
  options: { timeoutMs?: number } = {},
): Promise<RepositoryConnection> {
  const checkedAt = new Date().toISOString();
  const url = repositoryRemoteUrl(repository);
  if (!url) {
    return { status: 'unconfigured', checkedAt, detail: `no remote is known for provider ${repository.provider}; set repositoryUrl`, credential: null };
  }
  const credential = gitCredentialEnvironment(repository.provider, resolve);
  const credentialName = repositoryCredentialName(repository.provider) ?? null;
  try {
    const result = await lsRemote(url, repository.defaultBranch, credential.env, options.timeoutMs ?? 20_000);
    if (result.code !== 0) {
      const reason = redact(gitFailureReason(result.stderr) ?? `git ls-remote exited ${result.code}`, credential.secrets);
      const needsCredential = credentialName && !credential.credential && /^https?:/.test(url);
      return {
        status: 'unreachable', checkedAt, url, credential: credential.credential ?? null,
        detail: needsCredential ? `${reason} (no ${credentialName} is configured; a private repository needs one)` : reason,
      };
    }
    let headCommit: string | undefined;
    let branchCommit: string | undefined;
    let defaultBranch: string | undefined;
    for (const line of result.stdout.split('\n')) {
      const symref = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
      if (symref) { defaultBranch = symref[1]; continue; }
      const [sha, ref] = line.trim().split(/\s+/);
      if (!sha || !ref) continue;
      if (ref === 'HEAD') headCommit = sha;
      if (repository.defaultBranch && ref === `refs/heads/${repository.defaultBranch}`) branchCommit = sha;
    }
    if (!headCommit && !branchCommit) {
      return { status: 'unreachable', checkedAt, url, credential: credential.credential ?? null, detail: 'the remote answered but reported no HEAD' };
    }
    if (repository.defaultBranch && !branchCommit) {
      return { status: 'unreachable', checkedAt, url, credential: credential.credential ?? null, ...(headCommit ? { headCommit } : {}), ...(defaultBranch ? { defaultBranch } : {}), detail: `branch ${repository.defaultBranch} does not exist on the remote${defaultBranch ? ` (its default branch is ${defaultBranch})` : ''}` };
    }
    return {
      status: 'connected', checkedAt, url, credential: credential.credential ?? null,
      ...(headCommit ? { headCommit } : {}),
      ...(branchCommit ? { branchCommit } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      detail: `${url} answered; ${repository.defaultBranch ?? defaultBranch ?? 'HEAD'} is at ${(branchCommit ?? headCommit)!.slice(0, 12)}${credential.credential ? ` (authenticated with ${credential.credential})` : ''}`,
    };
  } catch (error) {
    return { status: 'unreachable', checkedAt, url, credential: credential.credential ?? null, detail: redact(error instanceof Error ? error.message : String(error), credential.secrets) };
  }
}
