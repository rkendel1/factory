import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FactoryService } from './server.js';
import { AuthBoundryAuthorizationError, type AuthenticatedContext, type Authenticator, type CapabilityProbe } from './auth.js';
import { DomainValidationError } from './domain.js';
import type { ProjectRecord } from './types.js';

/**
 * Capabilities the product surface asks AuthBoundry for.
 *
 * These are the capability names the Factory application association already
 * carries. Factory declares no new capability of its own: a name AuthBoundry
 * does not grant would be a second authorization vocabulary, and a route that
 * skipped the check would be a second authorization mechanism.
 */
export const PRODUCT_CAPABILITIES = {
  read: 'factory.ui.read',
  write: 'configuration.write',
  delete: 'configuration.delete',
  execute: 'factory.run',
} as const;

export interface ProductRoute {
  method: string;
  pattern: RegExp;
  capability: string;
  handle(input: {
    service: FactoryService;
    context: AuthenticatedContext;
    params: string[];
    body: unknown;
    url: URL;
    /** Asks AuthBoundry a capability question whose "no" is meaningful. */
    probe: CapabilityProbe;
  }): Promise<{ status: number; body: unknown }>;
}

const json = (status: number, body: unknown) => ({ status, body });

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainValidationError('a JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function text(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new DomainValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new DomainValidationError(`${field} must be a string`);
  return value;
}

const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;

function projectStatus(value: unknown): ProjectRecord['status'] {
  const status = text(value, 'status')!;
  if (!(PROJECT_STATUSES as readonly string[]).includes(status)) {
    throw new DomainValidationError(`status must be one of ${PROJECT_STATUSES.join(', ')}`);
  }
  return status as ProjectRecord['status'];
}

export const PRODUCT_ROUTES: ProductRoute[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/projects$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context }) {
      return json(200, { projects: await service.projects().listProjects(context.tenant) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/projects$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, body }) {
      const input = asRecord(body);
      return json(201, await service.projects().createProject({
        tenantId: context.tenant,
        name: text(input.name, 'name')!,
        ...(input.description === undefined ? {} : { description: text(input.description, 'description', false)! }),
      }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      const project = await service.projects().getProject(context.tenant, params[0]!);
      return project ? json(200, project) : json(404, { error: 'Project not found' });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/projects\/([^/]+)$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body }) {
      const input = asRecord(body);
      const project = await service.projects().updateProject(context.tenant, params[0]!, {
        ...(input.name === undefined ? {} : { name: text(input.name, 'name')! }),
        ...(input.description === undefined ? {} : { description: text(input.description, 'description')! }),
        ...(input.status === undefined ? {} : { status: projectStatus(input.status) }),
      });
      return project ? json(200, project) : json(404, { error: 'Project not found' });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/repositories$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      return json(200, { repositories: await service.projects().listRepositories(context.tenant, params[0]!) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/projects\/([^/]+)\/repositories$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body }) {
      const projectId = params[0]!;
      if (!await service.projects().getProject(context.tenant, projectId)) {
        return json(404, { error: 'Project not found' });
      }
      const input = asRecord(body);
      return json(201, await service.projects().addRepository(context.tenant, projectId, {
        ...(input.provider === undefined ? {} : { provider: text(input.provider, 'provider')! }),
        owner: text(input.owner, 'owner')!,
        name: text(input.name, 'name')!,
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: text(input.defaultBranch, 'defaultBranch')! }),
        ...(input.repositoryUrl === undefined ? {} : { repositoryUrl: text(input.repositoryUrl, 'repositoryUrl')! }),
      }));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/projects\/([^/]+)\/repositories\/([^/]+)$/,
    capability: PRODUCT_CAPABILITIES.delete,
    async handle({ service, context, params }) {
      const removed = await service.projects().removeRepository(context.tenant, params[0]!, params[1]!);
      return removed ? json(204, null) : json(404, { error: 'Repository not found' });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/environments$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      return json(200, { environments: await service.projects().listEnvironments(context.tenant, params[0]!) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/projects\/([^/]+)\/environments$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body }) {
      const projectId = params[0]!;
      if (!await service.projects().getProject(context.tenant, projectId)) {
        return json(404, { error: 'Project not found' });
      }
      const input = asRecord(body);
      return json(201, await service.projects().createEnvironment(context.tenant, projectId, {
        name: text(input.name, 'name')!,
        ...(input.provider === undefined ? {} : { provider: text(input.provider, 'provider')! }),
        ...(input.configuration === undefined ? {} : { configuration: input.configuration as Record<string, unknown> }),
      }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/environments\/([^/]+)$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      const environment = await service.projects().getEnvironment(context.tenant, params[0]!, params[1]!);
      return environment ? json(200, environment) : json(404, { error: 'Environment not found' });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/desired-state$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      const desired = await service.projects().getDesiredState(context.tenant, params[0]!);
      return desired ? json(200, desired) : json(404, { error: 'Desired state has not been defined' });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/projects\/([^/]+)\/desired-state$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body }) {
      const projectId = params[0]!;
      if (!await service.projects().getProject(context.tenant, projectId)) {
        return json(404, { error: 'Project not found' });
      }
      const input = asRecord(body);
      return json(200, await service.projects().putDesiredState(context.tenant, projectId, {
        ...(input.sourceRepositoryId === undefined ? {} : { sourceRepositoryId: text(input.sourceRepositoryId, 'sourceRepositoryId')! }),
        ...(input.sourceBranch === undefined ? {} : { sourceBranch: text(input.sourceBranch, 'sourceBranch')! }),
        ...(input.deploymentEnabled === undefined ? {} : { deploymentEnabled: Boolean(input.deploymentEnabled) }),
        ...(input.targetProvider === undefined ? {} : { targetProvider: text(input.targetProvider, 'targetProvider')! }),
        ...(input.healthRequirement === undefined ? {} : { healthRequirement: text(input.healthRequirement, 'healthRequirement')! }),
        updatedBy: context.principal,
      }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/actions$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      return json(200, { actions: await service.projects().listActions(context.tenant, params[0]!) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/projects\/([^/]+)\/actions$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body, probe }) {
      const input = asRecord(body);
      return json(201, await service.createAction(context, params[0]!, {
        type: text(input.type, 'type')!,
        ...(input.intent === undefined ? {} : { intent: text(input.intent, 'intent')! }),
        ...(input.environmentId === undefined ? {} : { environmentId: text(input.environmentId, 'environmentId')! }),
        ...(input.repositoryId === undefined ? {} : { repositoryId: text(input.repositoryId, 'repositoryId')! }),
        ...(input.operation === undefined ? {} : { operation: text(input.operation, 'operation')! }),
      }, probe));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/actions\/([^/]+)$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      const action = await service.projects().getAction(context.tenant, params[0]!);
      return action ? json(200, action) : json(404, { error: 'Action not found' });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/actions\/([^/]+)\/run$/,
    capability: PRODUCT_CAPABILITIES.execute,
    async handle({ service, context, params, body, probe }) {
      const input = body === undefined ? {} : asRecord(body);
      // `autonomous` means Factory is acting on its own and must hold the
      // authority to. A person driving the Action is the approval itself.
      return json(202, await service.runAction(context, params[0]!, {
        probe,
        autonomous: input.autonomous === true,
      }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/actions$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context }) {
      return json(200, { actions: await service.projects().listActions(context.tenant) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/runs$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      return json(200, { runs: await service.projects().listRuns(context.tenant, params[0]!) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/reality$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      return json(200, { environments: await service.observeReality(context, params[0]!) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/projects\/([^/]+)\/environments\/([^/]+)\/reality$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context, params }) {
      const reports = await service.observeReality(context, params[0]!);
      const report = reports.find((candidate) => candidate.environmentId === params[1]);
      return report ? json(200, report) : json(404, { error: 'Environment not found' });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/projects\/([^/]+)\/environments\/([^/]+)\/reconcile$/,
    capability: PRODUCT_CAPABILITIES.write,
    async handle({ service, context, params, body, probe }) {
      const input = body === undefined ? {} : asRecord(body);
      const result = await service.planReconciliation(context, params[0]!, params[1]!, {
        probe,
        ...(input.operation === undefined ? {} : { operation: text(input.operation, 'operation')! }),
      });
      // No drift is not an error: there is simply nothing to do.
      return json(result.action ? 201 : 200, result);
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/providers$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service }) {
      return json(200, { providers: service.providers() });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/overview$/,
    capability: PRODUCT_CAPABILITIES.read,
    async handle({ service, context }) {
      return json(200, await service.overview(context));
    },
  },
];

export function matchProductRoute(method: string, pathname: string):
  { route: ProductRoute; params: string[] } | null {
  for (const route of PRODUCT_ROUTES) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}

export async function handleProductRoute(input: {
  service: FactoryService;
  authenticator: () => Authenticator;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  body: unknown;
}): Promise<boolean> {
  const matched = matchProductRoute(input.request.method ?? 'GET', input.url.pathname);
  if (!matched) return false;
  const context = await input.authenticator().authenticate(input.request, matched.route.capability);

  /*
   * A second question to the same authority with the same credentials. A
   * denial is an answer here, not a failure, so it is returned rather than
   * thrown; anything else is a real failure and still is one.
   */
  const probe: CapabilityProbe = async (capability) => {
    try {
      await input.authenticator().authenticate(input.request, capability);
      return { allowed: true, reason: `AuthBoundry authorized ${capability}` };
    } catch (error) {
      if (error instanceof AuthBoundryAuthorizationError) {
        return { allowed: false, reason: error.message };
      }
      throw error;
    }
  };

  const result = await matched.route.handle({
    service: input.service,
    context,
    params: matched.params,
    body: input.body,
    url: input.url,
    probe,
  });
  input.response.statusCode = result.status;
  if (result.status === 204 || result.body === null) {
    input.response.end();
    return true;
  }
  input.response.setHeader('content-type', 'application/json');
  input.response.end(JSON.stringify(result.body, null, 2));
  return true;
}
