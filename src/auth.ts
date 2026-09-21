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

  const clientFor = (request: IncomingMessage): AuthBoundryClient => createAuthBoundry({
    baseUrl,
    fetch: (input, init) => fetch(input, {
      ...init,
      headers: {
        ...requestHeaders(request),
        ...(init?.headers ?? {}),
      },
    }),
  });

  return {
    async session(request: IncomingMessage): Promise<AuthenticatedContext> {
      return contextFromAuth(await clientFor(request).session());
    },
    async authenticate(request: IncomingMessage, operation: string): Promise<AuthenticatedContext> {
      const client = clientFor(request);
      const auth = await client.session();
      const context = contextFromAuth(auth);
      if (!(await client.authorize(operation))) {
        throw new Error(`AuthBoundry denied operation ${operation}`);
      }
      return context;
    },
  };
}

export function isAuthBoundryBrowserPath(pathname: string): boolean {
  const browserRoutes = [
    '/auth/login', '/auth/sign-in', '/auth/logout', '/auth/sign-out',
    '/auth/session', '/auth/providers', '/auth/signup',
    '/auth/password/change', '/auth/password/forgot', '/auth/password/reset',
    '/auth/email/verification', '/auth/mfa', '/auth/passkeys', '/auth/recovery',
    '/auth/account/links',
  ];
  return browserRoutes.includes(pathname)
    || pathname === '/authboundry/client.js'
    || pathname === '/_authboundry/password-policy'
    || pathname === '/_authboundry/begin'
    || /^\/_authboundry\/callback\/[^/]+$/.test(pathname);
}

async function requestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_048_576) throw new Error('AuthBoundry browser request body is too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function proxyAuthBoundryBrowserRequest(
  request: IncomingMessage,
  response: import('node:http').ServerResponse,
  baseUrl: string,
): Promise<void> {
  const incomingUrl = new URL(request.url ?? '/', 'http://factory.invalid');
  if (!isAuthBoundryBrowserPath(incomingUrl.pathname)) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const headers = new Headers();
  for (const name of ['accept', 'authorization', 'content-type', 'cookie', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  if (request.headers.host) headers.set('x-forwarded-host', request.headers.host);
  headers.set('x-forwarded-proto', 'https');

  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}${incomingUrl.pathname}${incomingUrl.search}`, {
    method: request.method,
    headers,
    body: await requestBody(request),
    redirect: 'manual',
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders: Record<string, string | string[]> = {};
  for (const name of ['cache-control', 'content-type', 'location']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) responseHeaders['set-cookie'] = cookies;
  responseHeaders['content-length'] = String(body.length);
  response.writeHead(upstream.status, responseHeaders);
  response.end(body);
}
