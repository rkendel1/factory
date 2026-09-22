import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RepositoryRef } from './types.js';

export interface WorkspaceHandle {
  rootPath: string;
  repositoryPath: string;
  inputPath: string;
  outputPath: string;
  artifactsPath: string;
  evidencePath: string;
}

async function runProcess(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GIT_TERMINAL_PROMPT: '0',
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
      reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`));
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

async function copyRepository(sourcePath: string, destinationPath: string, ref?: string): Promise<string | undefined> {
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

  await runProcess('git', ['clone', '--depth', '1', sourcePath, destinationPath]);
  if (ref) {
    await runProcess('git', ['checkout', ref], destinationPath);
  }
  return await runProcess('git', ['rev-parse', 'HEAD'], destinationPath);
}

export async function materializeRepository(
  repository: RepositoryRef,
  workspace: WorkspaceHandle,
  repositoryRoot?: string,
): Promise<{ commit?: string }> {
  const sourcePath = repository.path ?? repositoryRoot;
  if (!sourcePath) {
    throw new Error('No local repository mirror is configured for this execution request');
  }

  const commit = await copyRepository(sourcePath, workspace.repositoryPath, repository.ref);
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
