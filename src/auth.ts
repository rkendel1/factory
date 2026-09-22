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
  '/', '/configuration', '/api-keys', '/v1/ui', '/runs', '/work',
  '/factory', '/factory/projects', '/factory/actions', '/factory/runs', '/factory/providers',
  '/factory/graphs', '/factory/settings', '/factory/work',
] as const;

/**
 * Where a login may return a browser to, for a product page.
 *
 * The adapter allows only exact registered paths, so a detail page returns to
 * its section rather than to itself. A path that is not a product page returns
 * to the landing surface.
 */
export function factoryReturnPath(pathname: string): string {
  const section = pathname.match(/^\/factory(?:\/(projects|actions|runs|providers|graphs|settings))?/);
  return section ? `/factory${section[1] ? `/${section[1]}` : ''}` : '/factory';
}

export interface AuthenticatedContext {
  principal: string;
  tenant: string;
  claims: Record<string, unknown>;
  session: Record<string, unknown> | null;
  delegation: Record<string, unknown> | null;
  boundaryVerified?: boolean;
  authorizedCapabilities?: string[];
  /**
   * Provenance of the grant AuthBoundry made for this operation: `claim` when
   * the principal's own claims satisfied a policy, `delegated` when it acted on
   * delegated authority. `delegationId` names the delegation that carried it.
   *
   * Factory keeps both because "allowed" alone cannot answer whether a Factory
   * agent was authorized through the Factory application association or through
   * some other authority it happens to hold.
   */
  authority?: string;
  delegationId?: string | null;
}

export interface AuthorizationGrant {
  allowed: boolean;
  authority?: string;
  delegationId: string | null;
}

/**
 * Ask AuthBoundry a capability question without turning a denial into an error.
 *
 * Some Factory questions have a meaningful "no" — whether an Action may run
 * without a person is one — so the answer is returned rather than thrown.
 */
export type CapabilityProbe = (capability: string) => Promise<{
  allowed: boolean;
  reason: string;
}>;

export interface Authenticator {
  session?(request: IncomingMessage): Promise<AuthenticatedContext>;
  authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext>;
}

export class AuthBoundryAuthenticationError extends Error {
  readonly status = 401;

  constructor(message = 'AuthBoundry authentication is required') {
    super(message);
    this.name = 'AuthBoundryAuthenticationError';
  }
}

export class AuthBoundryAuthorizationError extends Error {
  readonly status = 403;

  constructor(readonly capability: string) {
    super(`AuthBoundry denied operation ${capability}`);
    this.name = 'AuthBoundryAuthorizationError';
  }
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'cookie', 'x-request-id']) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

function contextFromAuth(auth: AuthProjection): AuthenticatedContext {
  if (!auth.authenticated || !auth.principal?.id || !auth.tenant?.id) {
    throw new AuthBoundryAuthenticationError();
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

  const credentialFetchFor = (request: IncomingMessage, credential?: string): typeof fetch =>
    ((input, init) => fetch(input, {
      ...init,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : requestHeaders(request)),
        ...(init?.headers ?? {}),
      },
    })) as typeof fetch;

  const clientFor = (request: IncomingMessage, credential?: string): AuthBoundryClient => createAuthBoundry({
    baseUrl,
    fetch: credentialFetchFor(request, credential),
  });

  /**
   * Ask AuthBoundry its own authority question and keep the whole answer.
   *
   * `AuthBoundryClient.authorize` collapses the decision to a boolean, which
   * discards the grant's provenance. Factory needs that provenance to hold a
   * service principal to its application association, so it reads the published
   * `/auth/authorize` response directly rather than re-deriving anything.
   */
  const authorizeWithProvenance = async (
    credentialFetch: typeof fetch,
    capability: string,
  ): Promise<AuthorizationGrant> => {
    const response = await credentialFetch(`${baseUrl.replace(/\/$/, '')}/auth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability }),
    });
    if (!response.ok) {
      throw new AuthBoundryAuthorizationError(capability);
    }
    const body = await response.json() as {
      allowed?: boolean;
      principal?: string;
      authority?: string;
      delegation?: string | null;
    };
    return {
      allowed: body.allowed === true,
      ...(typeof body.authority === 'string' ? { authority: body.authority } : {}),
      delegationId: typeof body.delegation === 'string' ? body.delegation : null,
    };
  };

  const resolve = async (request: IncomingMessage): Promise<{
    credentialFetch: typeof fetch;
    context: AuthenticatedContext;
  }> => {
    const browser = await createFactoryBrowserAdapter(config).session({
      application: FACTORY_BROWSER_APPLICATION_ID,
      cookieHeader: request.headers.cookie,
    });
    if (browser) {
      const projection = browser.projection;
      return {
        credentialFetch: credentialFetchFor(request, browser.credential),
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
      throw new AuthBoundryAuthenticationError();
    }
    const client = clientFor(request);
    return {
      credentialFetch: credentialFetchFor(request),
      context: contextFromAuth(await client.session()),
    };
  };

  return {
    async session(request: IncomingMessage): Promise<AuthenticatedContext> {
      return (await resolve(request)).context;
    },
    async authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext> {
      const { credentialFetch, context } = await resolve(request);
      const grant = await authorizeWithProvenance(credentialFetch, operation);
      if (!grant.allowed) {
        throw new AuthBoundryAuthorizationError(operation);
      }
      return {
        ...context,
        ...(grant.authority === undefined ? {} : { authority: grant.authority }),
        delegationId: grant.delegationId,
      };
    },
  };
}

/**
 * The credentials the reconciliation worker acts under.
 *
 * The worker authenticates exactly as any other caller does — a bearer
 * credential presented to AuthBoundry — so it passes through the same session,
 * association and authorization checks. Factory holds no separate service
 * identity of its own.
 *
 * Without a credential there is no worker. An autonomous loop that could not
 * ask an authority anything would be acting on nobody's behalf.
 */
export function createServiceSession(
  authenticator: Authenticator,
  credential: string,
): {
  context: () => Promise<AuthenticatedContext>;
  probe: CapabilityProbe;
} {
  const request = { headers: { authorization: `Bearer ${credential}` } } as IncomingMessage;
  return {
    context: () => authenticator.authenticate(request, 'factory.run'),
    probe: async (capability) => {
      try {
        await authenticator.authenticate(request, capability);
        return { allowed: true, reason: `AuthBoundry authorized ${capability}` };
      } catch (error) {
        if (error instanceof AuthBoundryAuthorizationError) {
          return { allowed: false, reason: error.message };
        }
        // An authority that cannot be reached is not a grant. The caller reads
        // this as unavailable and fails closed on it.
        return {
          allowed: false,
          reason: error instanceof Error
            ? `AuthBoundry unavailable: ${error.message}`
            : 'AuthBoundry unavailable',
        };
      }
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
