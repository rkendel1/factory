import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ActionPlanStep,
  DesiredStateRecord,
  RepositoryDiscovery,
  RepositoryRecord,
} from './types.js';

const CANDIDATE_FILES = [
  'package.json',
  'Dockerfile',
  'fly.toml',
  'vercel.json',
  '.vercel/project.json',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  '.flow',
];

async function exists(root: string, relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function workflows(root: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, '.github', 'workflows'));
    return entries.filter((entry) => /\.ya?ml$/.test(entry)).sort();
  } catch {
    return [];
  }
}

/**
 * Inspect what a repository actually contains.
 *
 * Factory plans from repository reality rather than asking an operator to
 * restate it. Discovery reports only what it found; it never guesses a
 * deployment command that no file supports.
 */
export async function discoverRepository(
  root: string,
  repository?: RepositoryRecord,
): Promise<RepositoryDiscovery> {
  const found: string[] = [];
  for (const candidate of CANDIDATE_FILES) {
    if (await exists(root, candidate)) found.push(candidate);
  }
  const githubWorkflows = await workflows(root);

  let packageManager: string | undefined;
  let scripts: string[] | undefined;
  if (found.includes('package.json')) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      scripts = Object.keys(manifest.scripts ?? {}).sort();
      packageManager = manifest.packageManager
        ?? (found.includes('pnpm-lock.yaml') ? 'pnpm'
          : found.includes('yarn.lock') ? 'yarn'
            : found.includes('package-lock.json') ? 'npm' : undefined);
    } catch {
      // A manifest Factory cannot parse is reported as present and nothing more.
    }
  }

  return {
    inspectedAt: new Date().toISOString(),
    ...(repository ? { repositoryId: repository.id } : {}),
    files: [...found, ...githubWorkflows.map((name) => `.github/workflows/${name}`)].sort(),
    signals: {
      ...(packageManager ? { packageManager } : {}),
      ...(scripts ? { scripts } : {}),
      containerized: found.includes('Dockerfile'),
      flyConfigured: found.includes('fly.toml'),
      vercelConfigured: found.includes('vercel.json') || found.includes('.vercel/project.json'),
      ...(githubWorkflows.length ? { githubWorkflows } : {}),
    },
  };
}

/**
 * Derive the steps an Action intends to perform.
 *
 * Every step cites its basis — the desired state field or the repository file
 * that produced it — so a reviewer can see why Factory intends to do this and
 * not something else. A desired state that deployment is disabled produces a
 * plan that says so rather than a deployment step.
 */
export function planFromDiscovery(input: {
  type: string;
  desiredState: DesiredStateRecord | null;
  discovery: RepositoryDiscovery | null;
  repository: RepositoryRecord | null;
  environmentName?: string;
}): ActionPlanStep[] {
  const steps: ActionPlanStep[] = [];
  const push = (summary: string, detail?: string, basis?: string) =>
    steps.push({
      order: steps.length + 1,
      summary,
      ...(detail ? { detail } : {}),
      ...(basis ? { basis } : {}),
    });

  if (input.repository) {
    const branch = input.desiredState?.sourceBranch ?? input.repository.defaultBranch;
    push(
      `Materialize ${input.repository.owner}/${input.repository.name} at ${branch}`,
      `provider ${input.repository.provider}`,
      input.desiredState?.sourceBranch ? 'desiredState.sourceBranch' : 'repository.defaultBranch',
    );
  } else {
    push('Materialize the authorized work repository', undefined, 'work record');
  }

  const signals = input.discovery?.signals;
  if (signals?.packageManager) {
    push(
      `Install dependencies with ${signals.packageManager}`,
      signals.scripts?.length ? `available scripts: ${signals.scripts.join(', ')}` : undefined,
      'package.json',
    );
  }
  if (signals?.scripts?.includes('test')) {
    push('Run the repository test script', undefined, 'package.json scripts.test');
  }
  if (signals?.containerized) {
    push('Build the container image declared by the repository', undefined, 'Dockerfile');
  }

  if (input.desiredState?.deploymentEnabled === false) {
    push(
      'Stop before deployment',
      'desired state has deployment disabled',
      'desiredState.deploymentEnabled',
    );
  } else if (input.desiredState?.deploymentEnabled) {
    const target = input.desiredState.targetProvider
      ?? (signals?.flyConfigured ? 'fly' : signals?.vercelConfigured ? 'vercel' : undefined);
    push(
      target ? `Deploy to ${target}${input.environmentName ? ` (${input.environmentName})` : ''}` : 'Deploy to the configured target',
      target ? undefined : 'no target provider is declared and none was discovered',
      input.desiredState.targetProvider ? 'desiredState.targetProvider' : 'repository discovery',
    );
  }

  if (input.desiredState?.healthRequirement) {
    push(
      `Verify ${input.desiredState.healthRequirement}`,
      undefined,
      'desiredState.healthRequirement',
    );
  }

  push('Record structured evidence for the run', undefined, '.flow evidence requirement');
  return steps;
}
