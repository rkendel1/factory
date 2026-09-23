import type {
  FactoryAssociation,
  VerifiedAgentAssociation,
  VerifiedAssociation,
} from './association.js';

/**
 * Factory's client for AuthBoundry's control plane.
 *
 * Factory does not store, infer, or cache authority here. It asks AuthBoundry to
 * record the association and asks AuthBoundry what it holds; every answer in
 * this module is the authority's, never Factory's.
 *
 * The wire shapes below are AuthBoundry's, not a Factory convention:
 * `capabilities` travels as one comma-separated string, the operator credential
 * travels in `X-AuthBoundry-Session`, and the tenant travels in the query.
 */
export const AGENT_PATH = '/_authboundry/agents';
export const DELEGATION_PATH = '/_authboundry/delegations';
export const PROJECT_PATH = '/_authboundry/projects';
export const APPLICATION_PATH = '/_authboundry/applications';
export const POLICY_PATH = '/_authboundry/policies';
export const CAPABILITY_PATH = '/_authboundry/capabilities';
export const PROVISIONING_REQUEST_PATH = '/_authboundry/provisioning-requests';

export interface AuthBoundryAgent {
  id: string;
  kind: string;
  name: string | null;
  tenant: string;
  status: string;
}

export interface AuthBoundryDelegation {
  id: string;
  delegator: string;
  delegate: string;
  application: string | null;
  tenant: string;
  capabilities: string[];
  revoked_at?: number | null;
  expires_at?: number | null;
}

/** Canonical AuthBoundry project/application model consumed by Factory. */
export interface AuthBoundryProject {
  id: string;
  name?: string;
  status?: string;
}

export interface AuthBoundryApplication {
  id: string;
  project_id: string;
  attached: boolean;
  manifest_id?: string | null;
  canonical?: boolean;
}

export interface AuthBoundryManifestPrincipal {
  id: string;
  kind?: string;
  name?: string;
}

export interface AuthBoundryManifestPolicy {
  id: string;
  capabilities?: string[];
  principal?: string;
}

export interface AuthBoundryManifestDelegation {
  id?: string;
  delegator: string;
  delegate: string;
  capabilities: string[];
}

export interface AuthBoundryApplicationManifest {
  id: string;
  application_id: string;
  principals: AuthBoundryManifestPrincipal[];
  policies: AuthBoundryManifestPolicy[];
  delegations: AuthBoundryManifestDelegation[];
  capabilities: string[];
  environment?: string;
  production_url?: string;
}

export interface AuthBoundryPolicy {
  id: string;
  application: string;
  principal?: string;
  capabilities: string[];
  status?: string;
}

export interface AuthBoundryCapability {
  name: string;
  application: string;
  status?: string;
}

export interface AuthBoundryProvisioningRequest {
  id: string;
  status: 'requested' | 'pending_approval' | 'approved' | 'denied' | 'applied' | string;
}

export interface AuthBoundryServiceAuthorizationEvidence {
  principal: string;
  tenant: string;
  delegation?: string | null;
  capabilities: Record<string, boolean>;
  evidence: Record<string, unknown>;
}

export interface AuthBoundryControlPlane {
  listAgents(tenant: string): Promise<AuthBoundryAgent[]>;
  createAgent(tenant: string, agent: { id: string; name: string }): Promise<AuthBoundryAgent>;
  listDelegations(tenant: string, delegate: string): Promise<AuthBoundryDelegation[]>;
  /** Canonical discovery surfaces. Optional only for compatibility with old injected test doubles. */
  listProjects?(tenant: string): Promise<AuthBoundryProject[]>;
  listApplications?(tenant: string, projectId: string): Promise<AuthBoundryApplication[]>;
  getApplicationManifest?(tenant: string, applicationId: string): Promise<AuthBoundryApplicationManifest | null>;
  listPolicies?(tenant: string, applicationId: string): Promise<AuthBoundryPolicy[]>;
  listCapabilities?(tenant: string, applicationId: string): Promise<AuthBoundryCapability[]>;
  requestProvisioning?(tenant: string, request: Record<string, unknown>): Promise<AuthBoundryProvisioningRequest>;
  verifyServiceAuthorization?(capabilities: readonly string[]): Promise<AuthBoundryServiceAuthorizationEvidence>;
}

export class AuthBoundryControlPlaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AuthBoundryControlPlaneError';
  }
}

export function createAuthBoundryControlPlane(options: {
  baseUrl: string;
  serviceCredential: string;
  operatorCredential?: string;
  fetch?: typeof fetch;
}): AuthBoundryControlPlane {
  const origin = options.baseUrl.replace(/\/$/, '');
  const call = async (path: string, init: RequestInit = {}, privileged = false): Promise<unknown> => {
    const credential = privileged ? options.operatorCredential : options.serviceCredential;
    if (!credential) {
      throw new AuthBoundryControlPlaneError(
        401,
        privileged ? 'operator_credential_required' : 'service_credential_required',
        privileged
          ? 'AUTHBOUNDRY_OPERATOR_CREDENTIAL is required for authority provisioning requests'
          : 'FACTORY_SERVICE_CREDENTIAL is required for AuthBoundry discovery',
      );
    }
    const response = await (options.fetch ?? fetch)(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      body = { message: text };
    }
    if (!response.ok) {
      throw new AuthBoundryControlPlaneError(
        response.status,
        typeof body.error === 'string' ? body.error : 'control_plane_request_failed',
        typeof body.message === 'string' ? body.message : `AuthBoundry control plane returned HTTP ${response.status}`,
      );
    }
    return body;
  };
  const query = (path: string, parameters: Record<string, string>): string =>
    `${path}?${new URLSearchParams(parameters).toString()}`;

  return {
    async listAgents(tenant) {
      const body = await call(query(AGENT_PATH, { tenant })) as { agents?: AuthBoundryAgent[] };
      return body.agents ?? [];
    },
    async createAgent(tenant, agent) {
      return await call(query(AGENT_PATH, { tenant }), {
        method: 'POST',
        body: JSON.stringify({ id: agent.id, name: agent.name }),
      }, true) as AuthBoundryAgent;
    },
    async listDelegations(tenant, delegate) {
      const body = await call(query(DELEGATION_PATH, { tenant, delegate })) as {
        delegations?: AuthBoundryDelegation[];
      };
      return body.delegations ?? [];
    },
    async listProjects(tenant) {
      const body = await call(query(PROJECT_PATH, { tenant })) as { projects?: AuthBoundryProject[] };
      return body.projects ?? [];
    },
    async listApplications(tenant, projectId) {
      const body = await call(query(APPLICATION_PATH, { tenant, project_id: projectId })) as {
        applications?: AuthBoundryApplication[];
      };
      return body.applications ?? [];
    },
    async getApplicationManifest(tenant, applicationId) {
      const body = await call(
        query(`${APPLICATION_PATH}/${encodeURIComponent(applicationId)}/manifest`, { tenant }),
      ) as { manifest?: AuthBoundryApplicationManifest } | AuthBoundryApplicationManifest;
      if ('manifest' in body) return body.manifest ?? null;
      return body as AuthBoundryApplicationManifest;
    },
    async listPolicies(tenant, applicationId) {
      const body = await call(query(POLICY_PATH, { tenant, application: applicationId })) as {
        policies?: AuthBoundryPolicy[];
      };
      return body.policies ?? [];
    },
    async listCapabilities(tenant, applicationId) {
      const body = await call(query(CAPABILITY_PATH, { tenant, application: applicationId })) as {
        capabilities?: AuthBoundryCapability[];
      };
      return body.capabilities ?? [];
    },
    async requestProvisioning(tenant, request) {
      return await call(query(PROVISIONING_REQUEST_PATH, { tenant }), {
        method: 'POST',
        body: JSON.stringify(request),
      }, true) as AuthBoundryProvisioningRequest;
    },
    async verifyServiceAuthorization(capabilities) {
      const session = await call('/auth/session') as {
        principal?: { id?: string };
        tenant?: { id?: string };
      };
      const decisions: Record<string, boolean> = {};
      let delegation: string | null | undefined;
      const evidence: Record<string, unknown> = { session, decisions: {} };
      for (const capability of capabilities) {
        const decision = await call('/auth/authorize', {
          method: 'POST',
          body: JSON.stringify({ capability }),
        }) as { allowed?: boolean; delegation?: string | null };
        decisions[capability] = decision.allowed === true;
        (evidence.decisions as Record<string, unknown>)[capability] = decision;
        if (delegation === undefined) delegation = decision.delegation;
        else if (decision.delegation !== undefined && decision.delegation !== delegation) delegation = null;
      }
      return {
        principal: session.principal?.id ?? '',
        tenant: session.tenant?.id ?? '',
        delegation,
        capabilities: decisions,
        evidence,
      };
    },
  };
}

/**
 * The id AuthBoundry gives the durable Factory application delegation.
 *
 * This is AuthBoundry's constant, mirrored here so Factory looks for the record
 * the authority maintains instead of a second one of its own. Factory never
 * creates a delegation: `AuthBoundry` re-asserts this one on every bootstrap,
 * which is what makes the association survive a restart or a redeployment.
 */
export function associationDelegationId(tenantId: string): string {
  return `factory-application-${tenantId}-delegation`;
}

/** The resource an application-scoped Factory delegation is scoped to. */
export function applicationResource(applicationId: string): string {
  return `application:${applicationId}`;
}

function isUsable(delegation: AuthBoundryDelegation, now: number): boolean {
  if (delegation.revoked_at) return false;
  return !delegation.expires_at || delegation.expires_at * 1000 > now;
}

export interface ProvisioningOutcome {
  /** The association AuthBoundry holds, or null when it holds none. */
  readonly association: VerifiedAssociation | null;
  /** Agent principals Factory had to register, for the deployment log. */
  readonly registeredAgents: readonly string[];
  readonly reason?: string;
}

/**
 * Register the Factory agent principals, then read the association back.
 *
 * The division of labour is AuthBoundry's, not Factory's convenience:
 * AuthBoundry's bootstrap re-asserts the durable Factory application
 * delegation on every start, but it refuses to assign that authority to a
 * principal that does not exist. Registering the principal is therefore
 * Factory's to do, and the association that follows is AuthBoundry's to create
 * and maintain.
 *
 * Factory does not mint the delegation. If AuthBoundry holds none, this
 * reports that and nothing else: an application that could issue itself the
 * authority it is about to check would not be checking anything.
 *
 * Registration is idempotent. AuthBoundry stores an agent under the id given,
 * so re-running provisioning across a restart or redeployment addresses the
 * same principal rather than adding another.
 */
export async function provisionFactoryAssociation(options: {
  controlPlane: AuthBoundryControlPlane;
  association: FactoryAssociation;
  tenantId: string;
  now?: () => number;
}): Promise<ProvisioningOutcome> {
  const { controlPlane, association, tenantId } = options;
  const registeredAgents: string[] = [];
  const existing = await controlPlane.listAgents(tenantId);

  for (const agent of association.agents) {
    const record = existing.find((candidate) => candidate.id === agent.principalId);
    if (!record) {
      await controlPlane.createAgent(tenantId, { id: agent.principalId, name: agent.name });
      registeredAgents.push(agent.principalId);
    }
  }

  const resolved = await resolveFactoryAssociation(options);
  return { ...resolved, registeredAgents };
}

/**
 * Read the association AuthBoundry holds, without changing it.
 *
 * This is the whole of Factory's authority resolution: what the authority says
 * it holds, reported as-is, including when it holds nothing.
 */
export async function resolveFactoryAssociation(options: {
  controlPlane: AuthBoundryControlPlane;
  association: FactoryAssociation;
  tenantId: string;
  now?: () => number;
}): Promise<{ association: VerifiedAssociation | null; reason?: string }> {
  const { controlPlane, association, tenantId } = options;
  const now = options.now ?? Date.now;
  const delegationId = associationDelegationId(tenantId);
  const resource = applicationResource(association.applicationId);
  const agents: VerifiedAgentAssociation[] = [];
  const existing = await controlPlane.listAgents(tenantId);

  for (const agent of association.agents) {
    const record = existing.find((candidate) => candidate.id === agent.principalId);
    if (!record) {
      return { association: null, reason: `AuthBoundry holds no principal ${agent.principalId} in tenant ${tenantId}` };
    }
    if (record.status !== 'active') {
      return { association: null, reason: `Factory principal ${agent.principalId} is ${record.status}` };
    }
    const delegation = (await controlPlane.listDelegations(tenantId, agent.principalId))
      .find((candidate) => candidate.id === delegationId
        && candidate.application === association.applicationId
        && isUsable(candidate, now()));
    if (!delegation) {
      return {
        association: null,
        reason: `AuthBoundry holds no ${resource} delegation for ${agent.principalId} in tenant ${tenantId}`,
      };
    }
    agents.push({
      principalId: agent.principalId,
      delegationId: delegation.id,
      applicationId: association.applicationId,
      capabilities: [...delegation.capabilities],
    });
  }

  return {
    association: {
      tenantId,
      applicationId: association.applicationId,
      resource,
      agents,
    },
  };
}
