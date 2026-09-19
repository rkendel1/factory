import type { FactoryServiceConfig } from './types.js';

export interface RemoteAuthorityBootstrap {
  authBoundryUrl: string;
  feltDbUrl: string;
  feltDbToken?: string;
}

/**
 * Resolve only the deployment-managed inputs needed to reach remote authorities.
 * Application credentials are intentionally not part of this contract.
 */
export function resolveRemoteAuthorityBootstrap(config: FactoryServiceConfig): RemoteAuthorityBootstrap {
  const authBoundryUrl = config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL;
  const feltDbUrl = config.serverUrl ?? process.env.FELTDB_URL;

  if (!authBoundryUrl || !feltDbUrl) {
    throw new Error('Production startup requires FELTDB_URL and AUTHBOUNDRY_URL');
  }

  return {
    authBoundryUrl,
    feltDbUrl,
    feltDbToken: config.serverToken ?? process.env.FELTDB_TOKEN,
  };
}
