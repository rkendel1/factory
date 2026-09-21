import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
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
  product: { id: 'appport-services', version: '0.4.3' },
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
    { id: 'configuration', label: 'Configuration', group: 'services', order: 100, surface: 'configuration' },
    { id: 'secrets', label: 'Secrets', group: 'services', order: 110, surface: 'secrets' },
    { id: 'api-keys', label: 'API Keys', group: 'services', order: 120, surface: 'api-keys' },
    { id: 'notifications', label: 'Notifications', group: 'services', order: 130, surface: 'notifications' },
    { id: 'webhooks', label: 'Webhooks', group: 'services', order: 140, surface: 'webhooks' },
    { id: 'jobs', label: 'Jobs', group: 'services', order: 150, surface: 'jobs' },
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
    if (request.method === 'PUT' && request.path.includes('/secrets/')) return 'secret.rotate';
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

function configurationError(error: unknown, request: Request): {
  status: number;
  code: string;
  message: string;
} {
  const errorName = error instanceof Error ? error.constructor.name : '';
  const status = typeof error === 'object' && error !== null && 'status' in error
    && typeof error.status === 'number' && error.status >= 400 && error.status < 600
    ? error.status
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
      : status === 404
        ? 'APPPORT_RESOURCE_NOT_FOUND'
        : status === 409
          ? 'APPPORT_CONFIGURATION_CONFLICT'
          : status === 422
            ? 'APPPORT_CONFIGURATION_INVALID'
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
  const services = options.services ?? createServices(options.deployment);
  const application = express();
  application.use(express.json());
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
        scopes: [...new Set([capability, ...(context.authorizedCapabilities ?? [])])],
        credentialId: typeof context.session?.id === 'string' ? context.session.id : 'authboundry',
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
    authenticate: (request) => request.auth ?? null,
    authorize: async (capability, { request }) => {
      try {
        await options.authenticator().authenticate(request, capability);
        return true;
      } catch {
        return false;
      }
    },
    includeConfiguration: false,
    includeUi: false,
  }));
  application.use(createConfigurationManagementRouter(services.configuration));
  application.use(((error, request, response, _next) => {
    const detail = { ...configurationError(error, request), requestId: requestId(request) };
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
