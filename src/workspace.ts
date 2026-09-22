import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RepositoryRef } from './types.js';
import { gitFailureReason } from './repository-connection.js';

export interface WorkspaceHandle {
  rootPath: string;
  repositoryPath: string;
  inputPath: string;
  outputPath: string;
  artifactsPath: string;
  evidencePath: string;
}

async function runProcess(command: string, args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed: ${gitFailureReason(stderr) ?? gitFailureReason(stdout) ?? `exited ${code}`}`));
    });
  });
}

export async function createWorkspace(runId: string, workspaceRoot = '/tmp/software-factory'): Promise<WorkspaceHandle> {
  const rootPath = path.join(workspaceRoot, runId);
  const handle: WorkspaceHandle = {
    rootPath,
    repositoryPath: path.join(rootPath, 'repo'),
    inputPath: path.join(rootPath, 'input'),
    outputPath: path.join(rootPath, 'output'),
    artifactsPath: path.join(rootPath, 'artifacts'),
    evidencePath: path.join(rootPath, 'evidence'),
  };

  await mkdir(handle.inputPath, { recursive: true });
  await mkdir(handle.outputPath, { recursive: true });
  await mkdir(handle.artifactsPath, { recursive: true });
  await mkdir(handle.evidencePath, { recursive: true });
  return handle;
}

async function checkout(destinationPath: string, ref?: string, commit?: string, env: Record<string, string> = {}): Promise<string> {
  if (commit) {
    // The real checkout. A revision the repository does not have fails here,
    // with git's own reason, before anything runs against the workspace.
    await runProcess('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', commit], destinationPath, env);
  } else if (ref) {
    await runProcess('git', ['checkout', ref], destinationPath, env);
  }
  return await runProcess('git', ['rev-parse', 'HEAD'], destinationPath, env);
}

async function copyRepository(sourcePath: string, destinationPath: string, ref?: string, commit?: string): Promise<string | undefined> {
  try {
    await stat(path.join(sourcePath, '.git'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
    await cp(sourcePath, destinationPath, { recursive: true });
    return undefined;
  }

  // A requested commit needs history; a branch needs only its tip.
  await runProcess('git', commit ? ['clone', sourcePath, destinationPath] : ['clone', '--depth', '1', sourcePath, destinationPath]);
  return checkout(destinationPath, ref, commit);
}

/** Clone the connected remote. The credential travels only in git's environment. */
async function cloneRemote(url: string, destinationPath: string, ref?: string, commit?: string, env: Record<string, string> = {}): Promise<string> {
  const args = commit
    ? ['clone', '--no-checkout', url, destinationPath]
    : ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, destinationPath];
  await runProcess('git', args, undefined, env);
  return checkout(destinationPath, commit ? undefined : ref, commit, env);
}

export interface MaterializeOptions {
  /** Git environment carrying the repository credential, resolved at the boundary. */
  credentialEnv?: Record<string, string>;
}

export async function materializeRepository(
  repository: RepositoryRef,
  workspace: WorkspaceHandle,
  repositoryRoot?: string,
  options: MaterializeOptions = {},
): Promise<{ commit?: string }> {
  const sourcePath = repository.path ?? repositoryRoot;
  let commit: string | undefined;
  if (sourcePath && (await stat(sourcePath).then(() => true, () => false))) {
    commit = await copyRepository(sourcePath, workspace.repositoryPath, repository.ref, repository.commit);
  } else if (repository.url) {
    commit = await cloneRemote(repository.url, workspace.repositoryPath, repository.ref, repository.commit, options.credentialEnv);
  } else {
    throw new Error(`repository ${repository.owner}/${repository.name} is not connected: no local mirror and no remote URL`);
  }

  // The commit is what git reports after the checkout, never what was asked
  // for. A requested commit the checkout did not reach is a failure, not a fact.
  if (repository.commit && commit && commit !== repository.commit && !commit.startsWith(repository.commit)) {
    throw new Error(`checkout of ${repository.ref} reached ${commit}, not the requested revision ${repository.commit}`);
  }
  return commit ? { commit } : {};
}

export async function destroyWorkspace(workspace: WorkspaceHandle): Promise<void> {
  await rm(workspace.rootPath, { recursive: true, force: true });
}
