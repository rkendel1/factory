import type { FactoryServiceConfig } from './types.js';

export interface RemoteAuthorityBootstrap {
  authBoundryUrl: string;
  feltDbUrl: string;
  feltDbToken?: string;
}

export interface DeploymentConfig {
  authBoundryUrl?: string;
  feltDbUrl?: string;
  feltDbToken?: string;
}

/**
 * Resolve only the deployment-managed inputs needed to reach remote authorities.
 * Application credentials are intentionally not part of this contract.
 */
export function readDeploymentConfig(config: FactoryServiceConfig): DeploymentConfig {
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  };

  return {
    authBoundryUrl: trim(config.authBoundryUrl ?? process.env.AUTHBOUNDRY_URL),
    feltDbUrl: trim(config.serverUrl ?? process.env.FELTDB_URL),
    feltDbToken: trim(config.serverToken ?? process.env.FELTDB_TOKEN),
  };
}

export function validateDeploymentConfig(config: DeploymentConfig): RemoteAuthorityBootstrap {
  const authBoundryUrl = config.authBoundryUrl?.trim();
  const feltDbUrl = config.feltDbUrl?.trim();
  const feltDbToken = config.feltDbToken?.trim() || undefined;

  if (!authBoundryUrl || !feltDbUrl) {
    throw new Error('Production startup requires FELTDB_URL and AUTHBOUNDRY_URL');
  }

  return {
    authBoundryUrl,
    feltDbUrl,
    feltDbToken,
  };
}

export function resolveRemoteAuthorityBootstrap(config: FactoryServiceConfig): RemoteAuthorityBootstrap {
  return validateDeploymentConfig(readDeploymentConfig(config));
}

export function formatDeploymentConfigDiagnostics(config: DeploymentConfig): string {
  return [
    'Factory startup configuration:',
    `  FELTDB_URL configured: ${Boolean(config.feltDbUrl)}`,
    `  AUTHBOUNDRY_URL configured: ${Boolean(config.authBoundryUrl)}`,
    `  FELTDB_TOKEN configured: ${Boolean(config.feltDbToken)}`,
  ].join('\n');
}
