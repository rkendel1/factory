import { createAuthBoundry, type AuthBoundryClient, type AuthProjection } from '@authboundry/core';
import type { IncomingMessage } from 'node:http';
import type { FactoryServiceConfig } from './types.js';

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
  };
}

export function createAuthBoundryAuthenticator(config: FactoryServiceConfig): Authenticator {
  const baseUrl = config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL;
  if (!baseUrl) {
    throw new Error('AuthBoundry URL is required');
  }

  return {
    async authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext> {
      let client: AuthBoundryClient;
      client = createAuthBoundry({
        baseUrl,
        fetch: (input, init) => fetch(input, {
          ...init,
          headers: {
            ...requestHeaders(request),
            ...(init?.headers ?? {}),
          },
        }),
      });
      const auth = await client.session();
      const context = contextFromAuth(auth);
      if (!(await client.authorize(operation))) {
        throw new Error(`AuthBoundry denied operation ${operation}`);
      }
      return context;
    },
  };
}
