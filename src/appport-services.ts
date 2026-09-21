import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import {
  createConfigurationManagementRouter,
  createServices,
  configurationErrorHandler,
  type AppPortServices,
  type AuthenticatedPrincipal,
  type CreateServicesOptions,
} from '@appport/services';
import { UI_PROTOCOL_ID, validateUiContribution, type UiContribution } from '@appport/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authenticator } from './auth.js';
import type { UiContributor } from './ui.js';

export const appPortServicesUiContribution: UiContribution = validateUiContribution({
  protocol: UI_PROTOCOL_ID,
  product: { id: 'appport-services', version: '0.4.2' },
  surfaces: [
    { id: 'configuration', title: 'Configuration', route: '/configuration', capabilities: ['configuration.read'] },
    { id: 'secrets', title: 'Secrets', route: '/secrets', capabilities: ['configuration.read'] },
    { id: 'api-keys', title: 'API Keys', route: '/api-keys', capabilities: ['apikeys.read'] },
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
  if (request.path.startsWith('/v1/configuration')) {
    if (request.method === 'GET') return 'configuration.read';
    if (request.method === 'PUT' && request.path.includes('/secrets/')) return 'secret.rotate';
    if (request.method === 'DELETE') return 'configuration.delete';
    return 'configuration.write';
  }
  if (request.path === '/api-keys') return 'apikeys.read';
  if (request.path === '/notifications') return 'notifications.read';
  if (request.path === '/webhooks') return 'webhooks.read';
  if (request.path === '/jobs' || request.path === '/schedules') return 'jobs.read';
  if (request.path === '/files') return 'files.read';
  return 'configuration.read';
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
        if (typeof request.query.application !== 'string') request.query.application = options.applicationId;
        if (typeof request.query.environment !== 'string') request.query.environment = options.environment;
      }
      next();
    } catch {
      response.status(401).json({ error: 'AuthBoundry authentication or authorization failed' });
    }
  }) as RequestHandler);
  application.use(createConfigurationManagementRouter(services.configuration));
  // The published handler has a three-argument signature, so wrap it in the
  // four-argument Express error-middleware contract instead of reimplementing it.
  application.use(((error, request, response, _next) => {
    configurationErrorHandler(error, request, response);
  }) as ErrorRequestHandler);

  return {
    services,
    ui: { contribution: () => appPortServicesUiContribution },
    handles(pathname) {
      return pathname.startsWith('/v1/configuration') || managementPaths.has(pathname);
    },
    handle(request, response) {
      return new Promise<void>((resolve) => {
        response.once('finish', resolve);
        application(request, response);
      });
    },
  };
}
