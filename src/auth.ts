import { createAuthBoundry, type AuthBoundryClient, type AuthProjection } from '@authboundry/core';
import {
  createBrowserRelyingApplicationAdapter,
  type BrowserRelyingApplicationAdapter,
} from '@authboundry/core/server';
import type { IncomingMessage } from 'node:http';
import type { FactoryServiceConfig } from './types.js';

export const FACTORY_BROWSER_APPLICATION_ID = 'factory';
export const FACTORY_BROWSER_CALLBACK_PATH = '/api/auth/callback';
export const FACTORY_BROWSER_RETURN_PATHS = [
  '/', '/configuration', '/api-keys', '/v1/ui', '/runs', '/work', '/factory/runs', '/factory/work',
] as const;

export interface AuthenticatedContext {
  principal: string;
  tenant: string;
  claims: Record<string, unknown>;
  session: Record<string, unknown> | null;
  delegation: Record<string, unknown> | null;
  boundaryVerified?: boolean;
  authorizedCapabilities?: string[];
}

export interface Authenticator {
  session?(request: IncomingMessage): Promise<AuthenticatedContext>;
  authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext>;
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'cookie']) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

function contextFromAuth(auth: AuthProjection): AuthenticatedContext {
  if (!auth.authenticated || !auth.principal?.id || !auth.tenant?.id) {
    throw new Error('AuthBoundry authentication is required');
  }

  return {
    principal: auth.principal.id,
    tenant: auth.tenant.id,
    claims: auth.claims,
    session: auth.session as Record<string, unknown> | null,
    delegation: auth.delegation as Record<string, unknown> | null,
    boundaryVerified: true,
    authorizedCapabilities: [...auth.capabilities],
  };
}

export function createAuthBoundryAuthenticator(config: FactoryServiceConfig): Authenticator {
  const baseUrl = config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL;
  if (!baseUrl) {
    throw new Error('AuthBoundry URL is required');
  }

  const clientFor = (request: IncomingMessage, credential?: string): AuthBoundryClient => createAuthBoundry({
    baseUrl,
    fetch: (input, init) => fetch(input, {
      ...init,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : requestHeaders(request)),
        ...(init?.headers ?? {}),
      },
    }),
  });

  const resolve = async (request: IncomingMessage): Promise<{
    client: AuthBoundryClient;
    context: AuthenticatedContext;
  }> => {
    const browser = await createFactoryBrowserAdapter(config).session({
      application: FACTORY_BROWSER_APPLICATION_ID,
      cookieHeader: request.headers.cookie,
    });
    if (browser) {
      const projection = browser.projection;
      return {
        client: clientFor(request, browser.credential),
        context: {
          principal: projection.principal.id,
          tenant: projection.tenant.id,
          claims: projection.claims,
          session: projection.session,
          delegation: projection.delegation && typeof projection.delegation === 'object'
            ? projection.delegation as Record<string, unknown>
            : null,
          boundaryVerified: true,
          authorizedCapabilities: [...projection.capabilities],
        },
      };
    }
    if (typeof request.headers.authorization !== 'string') {
      throw new Error('AuthBoundry authentication is required');
    }
    const client = clientFor(request);
    return { client, context: contextFromAuth(await client.session()) };
  };

  return {
    async session(request: IncomingMessage): Promise<AuthenticatedContext> {
      return (await resolve(request)).context;
    },
    async authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext> {
      const { client, context } = await resolve(request);
      if (!(await client.authorize(operation))) {
        throw new Error(`AuthBoundry denied operation ${operation}`);
      }
      return context;
    },
  };
}

export function createFactoryBrowserAdapter(config: FactoryServiceConfig): BrowserRelyingApplicationAdapter {
  if (config.authBoundryBrowserAdapter) return config.authBoundryBrowserAdapter;
  const authorityUrl = config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL;
  const cookieSecret = config.authBoundryBrowserCookieSecret ?? process.env.AUTHBOUNDRY_BROWSER_COOKIE_SECRET;
  if (!authorityUrl) throw new Error('AuthBoundry URL is required');
  if (!cookieSecret) throw new Error('AUTHBOUNDRY_BROWSER_COOKIE_SECRET is required');
  return createBrowserRelyingApplicationAdapter({
    authorityUrl,
    cookieSecret,
    production: config.mode === 'remote' || process.env.NODE_ENV === 'production',
    applications: [{
      id: FACTORY_BROWSER_APPLICATION_ID,
      callbackPath: FACTORY_BROWSER_CALLBACK_PATH,
      allowedReturnPaths: [...FACTORY_BROWSER_RETURN_PATHS],
    }],
  });
}
