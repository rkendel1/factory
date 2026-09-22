import { createFeltDB, parseFlowSpec, validateFlowSpec, type FlowSpec, type StateFirstDB } from '@feltdb/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FactoryDBConfig } from './types.js';

export const COLLECTIONS = {
  work: 'Work',
  executionRequests: 'ExecutionRequest',
  executionContracts: 'ExecutionContract',
  runs: 'Run',
  runEvents: 'RunEvent',
  artifacts: 'Artifact',
  evidence: 'Evidence',
  authorizationDecisions: 'AuthorizationDecision',
  projects: 'Project',
  repositories: 'Repository',
  environments: 'Environment',
  desiredState: 'DesiredState',
  actions: 'Action',
  reconciliations: 'Reconciliation',
  actionGraphs: 'ActionGraph',
} as const;

const DEFAULT_NAMESPACE = 'software-factory';
const DEFAULT_FLOW_PATH = path.resolve(process.cwd(), '.flow');

export function loadFactoryFlow(flowPath = DEFAULT_FLOW_PATH): FlowSpec {
  if (!existsSync(flowPath)) {
    throw new Error(`Missing authoritative .flow file at ${flowPath}`);
  }

  const source = readFileSync(flowPath, 'utf8');
  const spec = parseFlowSpec(source);
  const diagnostics = validateFlowSpec(spec).filter((diagnostic) => diagnostic.severity === 'error');

  if (diagnostics.length > 0) {
    throw new Error(`Invalid authoritative .flow: ${diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  }

  return spec;
}

function resolveMode(config: FactoryDBConfig): 'local' | 'remote' {
  if (config.mode) {
    return config.mode;
  }

  if (config.serverUrl ?? process.env.FELTDB_URL) {
    return 'remote';
  }

  throw new Error('FeltDB mode must be explicit. Use mode="local" for development/tests or configure FELTDB_URL for remote authority.');
}

export async function createFactoryDB(config: FactoryDBConfig = {}): Promise<StateFirstDB> {
  const mode = resolveMode(config);
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;
  const authorityScope = {
    kind: 'tenant' as const,
    tenantId: config.tenantId ?? namespace,
    environmentId: config.environmentId ?? (mode === 'local' ? 'local' : 'production'),
  };

  const db = mode === 'remote'
    ? (() => {
      const serverUrl = config.serverUrl ?? process.env.FELTDB_URL;
      if (!serverUrl) {
        throw new Error('Remote FeltDB mode requires FELTDB_URL or serverUrl.');
      }

      return createFeltDB({
        namespace,
        authorityScope,
        server: {
          url: serverUrl,
          token: config.serverToken ?? process.env.FELTDB_TOKEN,
          environment: authorityScope.environmentId,
        },
      });
    })()
    : createFeltDB({ namespace, authorityScope });

  await db.deployFlowSpec(loadFactoryFlow(config.flowPath));
  return db;
}
