import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  API_KEY_MANAGEMENT_CAPABILITIES,
  ConfigurationAuthorizationError,
  ConfigurationValidationError,
  createConfigurationManagementRouter,
  createManagementRouter,
  createServices,
  type AppPortServices,
  type AuthenticatedPrincipal,
  type CreateServicesOptions,
  type ServiceAuthorizationDecision,
  type ServiceAuthorizationRequest,
} from '@appport/services';
import { UI_PROTOCOL_ID, validateUiContribution, type UiContribution } from '@appport/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AuthBoundryAuthenticationError,
  AuthBoundryAuthorizationError,
  type Authenticator,
} from './auth.js';
import type { UiContributor } from './ui.js';

export const appPortServicesUiContribution: UiContribution = validateUiContribution({
  protocol: UI_PROTOCOL_ID,
  product: { id: 'appport-services', version: '0.4.5' },
  surfaces: [
    { id: 'configuration', title: 'Configuration', route: '/configuration', capabilities: ['configuration.read'] },
    { id: 'secrets', title: 'Secrets', route: '/secrets', capabilities: ['configuration.read'] },
    {
      id: 'api-keys',
      title: 'API Keys',
      route: '/api-keys',
      capabilities: Object.values(API_KEY_MANAGEMENT_CAPABILITIES),
    },
    { id: 'notifications', title: 'Notifications', route: '/notifications', capabilities: ['notifications.read'] },
    { id: 'webhooks', title: 'Webhooks', route: '/webhooks', capabilities: ['webhooks.read'] },
    { id: 'jobs', title: 'Jobs', route: '/jobs', capabilities: ['jobs.read'] },
  ],
  navigation: [
    { id: 'configuration', label: 'Configuration', group: 'infrastructure', order: 200, surface: 'configuration' },
    { id: 'secrets', label: 'Secrets', group: 'infrastructure', order: 210, surface: 'secrets' },
    { id: 'api-keys', label: 'API Keys', group: 'infrastructure', order: 220, surface: 'api-keys' },
    { id: 'notifications', label: 'Notifications', group: 'infrastructure', order: 230, surface: 'notifications' },
    { id: 'webhooks', label: 'Webhooks', group: 'infrastructure', order: 240, surface: 'webhooks' },
    { id: 'jobs', label: 'Jobs', group: 'infrastructure', order: 250, surface: 'jobs' },
  ],
  composition: { requires: ['identity', 'tenant', 'application', 'environment'] },
});

const managementPaths = new Set([
  '/services', '/configuration', '/secrets', '/api-keys', '/notifications', '/webhooks', '/jobs', '/schedules', '/files',
]);

function requestedCapability(request: Request): string {
  if (request.path === '/_appport/api/keys') {
    if (request.method === 'POST') return API_KEY_MANAGEMENT_CAPABILITIES.create;
    return API_KEY_MANAGEMENT_CAPABILITIES.read;
  }
  if (request.path.startsWith('/_appport/api/keys/')) return API_KEY_MANAGEMENT_CAPABILITIES.revoke;
  if (request.path.startsWith('/v1/configuration')) {
    if (request.method === 'GET') return 'configuration.read';
    if (request.path.includes('/secrets')) {
      if (request.method === 'PUT') return 'credential.rotate';
      if (request.method === 'DELETE') return 'credential.detach';
      return 'credential.attach';
    }
    if (request.method === 'DELETE') return 'configuration.delete';
    return 'configuration.write';
  }
  if (request.path === '/api-keys') return API_KEY_MANAGEMENT_CAPABILITIES.read;
  if (request.path === '/notifications') return 'notifications.read';
  if (request.path === '/webhooks') return 'webhooks.read';
  if (request.path === '/jobs' || request.path === '/schedules') return 'jobs.read';
  if (request.path === '/files') return 'files.read';
  return 'configuration.read';
}

function requestId(request: Request): string {
  const candidate = request.header('x-request-id');
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `cfg_${randomUUID()}`;
}

/**
 * Statuses the in-process management and configuration layers produce about the
 * request itself. Any other status came from the durable authority: an
 * authority that answers 404 for an unregistered application is not telling the
 * caller that their configuration resource is missing, so its status is never
 * mirrored back to the browser.
 */
const REQUEST_SCOPED_STATUSES = new Set([400, 401, 403]);

function reportedStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    && typeof error.status === 'number' && error.status >= 400 && error.status < 600
    ? error.status
    : undefined;
}

/**
 * Classify an error as a failure of the FeltDB authority behind AppPort
 * Services rather than a rejection of the caller's request.
 *
 * Only the authority's status, code, and correlation id are carried out of the
 * error. The message is left behind: it is attacker- and authority-controlled
 * text that may echo a rejected request body, and secret values never reach a
 * log.
 */
function authorityFailure(error: unknown): { status: number; code: string; requestId: string } | null {
  if (error instanceof ConfigurationAuthorizationError || error instanceof ConfigurationValidationError) {
    return null;
  }
  const status = reportedStatus(error);
  if (status === undefined || REQUEST_SCOPED_STATUSES.has(status)) {
    return null;
  }
  const field = (name: 'code' | 'requestId'): string | undefined =>
    typeof error === 'object' && error !== null && name in error
      && typeof (error as Record<string, unknown>)[name] === 'string'
      ? (error as Record<string, string>)[name]
      : undefined;
  return {
    status,
    code: field('code') ?? 'REQUEST_FAILED',
    requestId: field('requestId') ?? 'none',
  };
}

function configurationError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const errorName = error instanceof Error ? error.constructor.name : '';
  const reported = reportedStatus(error);
  const status = reported !== undefined && REQUEST_SCOPED_STATUSES.has(reported)
    ? reported
    : error instanceof ConfigurationAuthorizationError
      ? 403
      : error instanceof ConfigurationValidationError
        ? 400
        : 500;
  const knownMessage = error instanceof ConfigurationAuthorizationError
    || error instanceof ConfigurationValidationError;
  const message = knownMessage && error instanceof Error
    ? error.message
    : status >= 500
      ? 'AppPort Services could not complete the configuration request.'
      : 'Configuration request was rejected.';
  const code = status === 401
    ? 'APPPORT_AUTHENTICATION_REQUIRED'
    : status === 403
      ? 'APPPORT_AUTHORIZATION_DENIED'
      : status >= 500
        ? 'APPPORT_SERVICES_FAILURE'
        : errorName === 'ConfigurationValidationError'
          ? 'INVALID_CONFIGURATION'
          : 'CONFIGURATION_REQUEST_FAILED';
  return { status, code, message };
}

function sendConfigurationError(
  response: express.Response,
  detail: { status: number; code: string; message: string; requestId: string },
): void {
  const clientMessage = `Configuration request failed (${detail.status}) ${detail.code}: ${detail.message} Request ID: ${detail.requestId}`;
  response.status(detail.status).json({
    error: { ...detail, message: clientMessage },
    ...detail,
  });
}

export interface AppPortServicesDeployment {
  mode: 'local' | 'remote';
  namespace: string;
  environment: string;
  serverUrl?: string;
  serverToken?: string;
  path?: string;
}

/**
 * Resolve the FeltDB deployment AppPort Services runs on.
 *
 * `applicationId` is deliberately not part of this deployment. Setting it moves
 * the FeltDB client onto the canonical application service, which resolves an
 * application revision through `GET /v1/application` before every read and
 * write. Factory never registers itself with that service — `deployFlowSpec`
 * runs against the same unscoped surface the Factory's own durable state uses —
 * so every configuration read and write failed that lookup with HTTP 404 and
 * reached the browser as `APPPORT_RESOURCE_NOT_FOUND`.
 *
 * Configuration stays application-scoped either way: the scope travels in each
 * record's `applicationId` field, pinned to the Factory application by the
 * request middleware below, not in the FeltDB client's transport.
 */
export function resolveAppPortServicesDeployment(deployment: AppPortServicesDeployment): CreateServicesOptions {
  return deployment.mode === 'remote'
    ? {
        mode: 'remote',
        namespace: deployment.namespace,
        url: deployment.serverUrl,
        token: deployment.serverToken,
        environment: deployment.environment,
      }
    : {
        mode: 'local',
        namespace: deployment.namespace,
        path: deployment.path,
      };
}

export interface FactoryAppPortServices {
  readonly services: AppPortServices;
  readonly ui: UiContributor;
  handles(pathname: string): boolean;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export function createFactoryAppPortServices(options: {
  services?: AppPortServices;
  deployment: CreateServicesOptions;
  authenticator: () => Authenticator;
  applicationId: string;
  environment: string;
}): FactoryAppPortServices {
  const requests = new AsyncLocalStorage<Request>();
  const services = options.services ?? createServices({
    ...options.deployment,
    application: options.applicationId,
    authorizer: {
      async authorize(
        request: ServiceAuthorizationRequest,
        { signal }: { signal: AbortSignal },
      ): Promise<ServiceAuthorizationDecision> {
        const inbound = requests.getStore();
        if (!inbound) throw new Error('AppPort Services authorization has no inbound Factory request');
        if (signal.aborted) throw signal.reason;
        const context = await options.authenticator().authenticate(inbound, request.capability);
        return {
          decision_id: `factory_${request.request_id}`,
          allowed: true,
          capability: request.capability,
          tenant_id: request.tenant_id,
          application_id: request.application_id,
          subject: request.subject,
          resource: request.resource,
          ...(context.authority ? { reason: `Authorized by ${context.authority}` } : {}),
          evaluated_at: Date.now(),
        };
      },
    },
  });
  const application = express();
  application.use(express.json());
  application.use((request, _response, next) => requests.run(request, next));
  application.use((async (request, response, next) => {
    const correlationId = requestId(request);
    response.setHeader('x-request-id', correlationId);
    request.headers['x-request-id'] = correlationId;
    const capability = requestedCapability(request);
    try {
      const context = await options.authenticator().authenticate(request, capability);
      request.auth = {
        principalId: context.principal,
        principalType: 'api_key',
        tenantId: context.tenant,
        credentialId: typeof context.session?.id === 'string' ? context.session.id : 'authboundry',
        verifiedBy: 'host',
      } satisfies AuthenticatedPrincipal;
      if (request.path.startsWith('/v1/configuration')) {
        request.query.application = options.applicationId;
        request.query.environment = options.environment;
      }
      next();
    } catch (error) {
      if (error instanceof AuthBoundryAuthorizationError) {
        const detail = {
          status: 403,
          code: 'APPPORT_AUTHORIZATION_DENIED',
          message: error.message,
          requestId: correlationId,
        };
        sendConfigurationError(response, detail);
        return;
      }
      const message = error instanceof AuthBoundryAuthenticationError
        ? error.message
        : 'AuthBoundry authentication failed';
      const detail = {
        status: 401,
        code: 'APPPORT_AUTHENTICATION_REQUIRED',
        message,
        requestId: correlationId,
      };
      sendConfigurationError(response, detail);
    }
  }) as RequestHandler);
  application.use(createManagementRouter({
    services: { apiKeys: services.apiKeys },
    authority: services.gateway,
    authenticate: (request) => request.auth ?? null,
    includeConfiguration: false,
    includeUi: false,
  }));
  application.use(createConfigurationManagementRouter(services.configuration));
  application.use(((error, request, response, _next) => {
    const correlationId = requestId(request);
    const upstream = authorityFailure(error);
    if (upstream) {
      process.stderr.write(
        `AppPort Services configuration authority failure (${correlationId}): `
        + `HTTP ${upstream.status} ${upstream.code}, authority request ${upstream.requestId}\n`,
      );
    }
    const detail = {
      ...(upstream
        ? {
            status: 502,
            code: 'APPPORT_AUTHORITY_UNAVAILABLE',
            message: 'AppPort Services could not reach the configuration authority.',
          }
        : configurationError(error)),
      requestId: correlationId,
    };
    sendConfigurationError(response, detail);
  }) as ErrorRequestHandler);

  return {
    services,
    ui: { contribution: () => appPortServicesUiContribution },
    handles(pathname) {
      return pathname.startsWith('/v1/configuration')
        || pathname.startsWith('/_appport/api/keys')
        || managementPaths.has(pathname);
    },
    handle(request, response) {
      return new Promise<void>((resolve) => {
        response.once('finish', resolve);
        application(request, response);
      });
    },
  };
}
