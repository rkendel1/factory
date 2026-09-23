import type { DecisionTransportExecutionResponse, StateFirstDB } from '@feltdb/core';
import type {
  AuthBoundryApplication,
  AuthBoundryApplicationManifest,
  AuthBoundryControlPlane,
  AuthBoundryDelegation,
  AuthBoundryManifestDelegation,
  AuthBoundryPolicy,
  AuthBoundryProject,
  AuthBoundryProvisioningRequest,
} from './provisioning.js';
import { applicationResource, AuthBoundryControlPlaneError } from './provisioning.js';
import type { VerifiedAssociation } from './association.js';
import { COLLECTIONS } from './felt.js';

export const FACTORY_PROJECT_ID = 'factory';
export const FACTORY_APPLICATION_ID = 'factory';
export const FACTORY_SERVICE_PRINCIPAL = 'agent:factory-service';
export const FACTORY_REQUIRED_CAPABILITIES = [
  'factory.run',
  'factory.action.autonomous',
] as const;

export type AuthorityBlocker =
  | 'authboundry_unreachable'
  | 'project_missing'
  | 'project_mismatch'
  | 'application_missing'
  | 'application_mismatch'
  | 'application_unattached'
  | 'manifest_unavailable'
  | 'principal_missing'
  | 'principal_invalid'
  | 'policy_missing'
  | 'delegation_missing'
  | 'capability_missing'
  | 'service_credential_missing'
  | 'authorization_evidence_invalid'
  | 'pending_approval';

export interface FactoryAuthorityHealth {
  authBoundry: { reachable: boolean };
  project: { discovered: boolean; expected: boolean; id?: string };
  application: { discovered: boolean; attached: boolean; project?: string; id?: string };
  manifest: { available: boolean; id?: string; environment?: string; productionUrl?: string };
  principal: { canonical: boolean; present: boolean; id: string };
  policy: { complete: boolean; missing: string[] };
  delegation: { complete: boolean; missing: string[] };
  credentials: { service: boolean };
  capabilities: Record<(typeof FACTORY_REQUIRED_CAPABILITIES)[number], boolean>;
  reconciliation: {
    healthy: boolean;
    blocker?: AuthorityBlocker;
    reason?: string;
    requestId?: string;
    requestStatus?: string;
    semanticDecisionId?: string;
  };
}

export interface FactoryAuthorityReconciliationRecord {
  id: string;
  tenantId: string;
  projectId: string;
  applicationId?: string;
  discovered: Record<string, unknown>;
  required: Record<string, unknown>;
  actual: Record<string, unknown>;
  missing: Record<string, unknown>;
  request?: AuthBoundryProvisioningRequest;
  health: FactoryAuthorityHealth;
  semanticDecision?: DecisionTransportExecutionResponse['evaluation'];
  history?: Array<{
    observedAt: string;
    health: FactoryAuthorityHealth;
    missing: Record<string, unknown>;
    request?: AuthBoundryProvisioningRequest;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryAuthorityReconciliation {
  health: FactoryAuthorityHealth;
  association: VerifiedAssociation | null;
  manifest: AuthBoundryApplicationManifest | null;
  record: FactoryAuthorityReconciliationRecord;
}

function initialHealth(serviceCredentialPresent: boolean): FactoryAuthorityHealth {
  return {
    authBoundry: { reachable: false },
    project: { discovered: false, expected: false },
    application: { discovered: false, attached: false },
    manifest: { available: false },
    principal: { canonical: true, present: false, id: FACTORY_SERVICE_PRINCIPAL },
    policy: { complete: false, missing: [] },
    delegation: { complete: false, missing: [] },
    credentials: { service: serviceCredentialPresent },
    capabilities: { 'factory.run': false, 'factory.action.autonomous': false },
    reconciliation: { healthy: false },
  };
}

function fail(health: FactoryAuthorityHealth, blocker: AuthorityBlocker, reason: string): void {
  health.reconciliation = { healthy: false, blocker, reason };
}

function active(status: string | undefined): boolean {
  return status === undefined || status === 'active' || status === 'granted' || status === 'approved';
}

function usable(delegation: AuthBoundryDelegation, now: number): boolean {
  return !delegation.revoked_at && (!delegation.expires_at || delegation.expires_at * 1000 > now);
}

function requiredDelegationKey(value: AuthBoundryManifestDelegation): string {
  return value.id ?? `${value.delegator}->${value.delegate}`;
}

function delegationMatches(
  requirement: AuthBoundryManifestDelegation,
  actual: AuthBoundryDelegation,
  applicationId: string,
  now: number,
): boolean {
  return usable(actual, now)
    && actual.application === applicationId
    && actual.delegator === requirement.delegator
    && actual.delegate === requirement.delegate
    && (!requirement.id || actual.id === requirement.id)
    && requirement.capabilities.every((capability) => actual.capabilities.includes(capability));
}

function policyMatches(requirement: AuthBoundryApplicationManifest['policies'][number], actual: AuthBoundryPolicy): boolean {
  return actual.id === requirement.id
    && active(actual.status)
    && (!requirement.principal || actual.principal === requirement.principal)
    && (requirement.capabilities ?? []).every((capability) => actual.capabilities.includes(capability));
}

function canonicalApplication(applications: readonly AuthBoundryApplication[]): AuthBoundryApplication | null {
  const canonical = applications.filter((application) =>
    application.id === FACTORY_APPLICATION_ID || application.canonical === true);
  return canonical.length === 1 ? canonical[0]! : null;
}

function canonicalProject(projects: readonly AuthBoundryProject[]): AuthBoundryProject | null {
  return projects.find((project) => project.id === FACTORY_PROJECT_ID) ?? null;
}

async function requestMissing(
  controlPlane: AuthBoundryControlPlane,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<AuthBoundryProvisioningRequest | undefined> {
  if (!controlPlane.requestProvisioning) return undefined;
  try {
    return await controlPlane.requestProvisioning(tenantId, body);
  } catch (error) {
    // Discovery still succeeded. Absence of the explicitly privileged
    // credential blocks the request; it must not be misreported as an
    // AuthBoundry outage or cause a fallback to the service credential.
    if (error instanceof AuthBoundryControlPlaneError
      && error.code === 'operator_credential_required') return undefined;
    throw error;
  }
}

async function persist(
  db: StateFirstDB,
  record: FactoryAuthorityReconciliationRecord,
  semantic: boolean,
): Promise<void> {
  const collection = db.collection<FactoryAuthorityReconciliationRecord>(COLLECTIONS.authorityReconciliations);
  await collection.put(record, record.id);
  if (!semantic) return;

  const response = await db.semanticDecisions.execute({
    target: { collection: COLLECTIONS.authorityReconciliations, record_id: record.id },
    definition: { kind: 'binary', predicate: 'factory.reconcile' },
    context: {
      authorized: record.health.reconciliation.healthy,
      bounded: true,
      durable: true,
      blocker: record.health.reconciliation.blocker ?? null,
    },
    options: {
      application_id: FACTORY_APPLICATION_ID,
      decision_collection: COLLECTIONS.authorityReconciliations,
      schema_version: 'factory-authority-reconciliation/1',
    },
    runtime: {
      kind: 'recording',
      metadata: {
        runtime: 'factory-authority-reconciler',
        model_revision: 'deterministic-prerequisites/1',
        decision_schema_revision: 'factory-authority-reconciliation/1',
        execution_method: 'structured',
      },
      result: {
        kind: 'binary',
        decision: record.health.reconciliation.healthy,
        option_mass: 1,
        supporting_fields: ['health', 'required', 'actual', 'missing'],
      },
    },
  });
  record.semanticDecision = response.evaluation;
  record.health.reconciliation.semanticDecisionId = response.evaluation.evidence[0]?.decision_id;
  record.updatedAt = new Date().toISOString();
  await collection.put(record, record.id);
}

/**
 * Reconcile Factory exclusively from AuthBoundry's canonical application state.
 * Missing authority may be requested, but is never treated as granted until a
 * later discovery pass reads the resulting authority back from AuthBoundry.
 */
export async function reconcileFactoryAuthority(options: {
  controlPlane: AuthBoundryControlPlane;
  db: StateFirstDB;
  tenantId: string;
  serviceCredentialPresent: boolean;
  semanticDecisions?: boolean;
  now?: () => number;
}): Promise<FactoryAuthorityReconciliation> {
  const { controlPlane, db, tenantId } = options;
  const now = options.now ?? Date.now;
  const health = initialHealth(options.serviceCredentialPresent);
  const timestamp = new Date(now()).toISOString();
  let manifest: AuthBoundryApplicationManifest | null = null;
  let association: VerifiedAssociation | null = null;
  let request: AuthBoundryProvisioningRequest | undefined;
  const discovered: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  const missing: Record<string, unknown> = {};
  const required: Record<string, unknown> = {
    project: FACTORY_PROJECT_ID,
    application: FACTORY_APPLICATION_ID,
    principal: FACTORY_SERVICE_PRINCIPAL,
    capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
  };

  const finish = async (): Promise<FactoryAuthorityReconciliation> => {
    if (!options.serviceCredentialPresent && health.reconciliation.healthy) {
      fail(health, 'service_credential_missing', 'FACTORY_SERVICE_CREDENTIAL is required for autonomous operation');
    }
    const id = `factory-authority:${tenantId}`;
    const collection = db.collection<FactoryAuthorityReconciliationRecord>(COLLECTIONS.authorityReconciliations);
    const previous = await collection.get(id);
    const history = previous
      ? [
          ...(previous.history ?? []),
          {
            observedAt: previous.updatedAt,
            health: previous.health,
            missing: previous.missing,
            ...(previous.request ? { request: previous.request } : {}),
          },
        ]
      : [];
    const record: FactoryAuthorityReconciliationRecord = {
      id,
      tenantId,
      projectId: FACTORY_PROJECT_ID,
      ...(health.application.id ? { applicationId: health.application.id } : {}),
      discovered,
      required,
      actual,
      missing,
      ...(request ? { request } : {}),
      health,
      ...(history.length ? { history } : {}),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    try {
      await persist(db, record, options.semanticDecisions === true);
    } catch (error) {
      fail(
        health,
        'authorization_evidence_invalid',
        `FeltDB semantic decision failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      record.health = health;
      record.updatedAt = new Date().toISOString();
      await db.collection<FactoryAuthorityReconciliationRecord>(COLLECTIONS.authorityReconciliations).put(record, record.id);
      association = null;
    }
    return { health, association, manifest, record };
  };

  if (!controlPlane.listProjects || !controlPlane.listApplications || !controlPlane.getApplicationManifest
    || !controlPlane.listPolicies || !controlPlane.listCapabilities) {
    fail(health, 'authboundry_unreachable', 'AuthBoundry does not expose the canonical application discovery API');
    return finish();
  }

  try {
    const projects = await controlPlane.listProjects(tenantId);
    health.authBoundry.reachable = true;
    actual.projects = projects;
    const project = canonicalProject(projects);
    if (!project) {
      missing.project = FACTORY_PROJECT_ID;
      request = await requestMissing(controlPlane, tenantId, {
        kind: 'application.provision', project_id: FACTORY_PROJECT_ID, application_id: FACTORY_APPLICATION_ID,
      });
      fail(health, request ? 'pending_approval' : 'project_missing', 'AuthBoundry holds no explicit Factory project');
      if (request) health.reconciliation = { ...health.reconciliation, requestId: request.id, requestStatus: request.status };
      return finish();
    }
    discovered.project = project;
    health.project = { discovered: true, expected: project.id === FACTORY_PROJECT_ID, id: project.id };
    if (!health.project.expected) {
      fail(health, 'project_mismatch', `discovered project ${project.id}, expected ${FACTORY_PROJECT_ID}`);
      return finish();
    }

    const applications = await controlPlane.listApplications(tenantId, project.id);
    actual.applications = applications;
    const application = canonicalApplication(applications);
    if (!application) {
      missing.application = FACTORY_APPLICATION_ID;
      request = await requestMissing(controlPlane, tenantId, {
        kind: 'application.provision', project_id: project.id, application_id: FACTORY_APPLICATION_ID,
      });
      fail(health, request ? 'pending_approval' : 'application_missing', 'AuthBoundry holds no unique canonical Factory application');
      if (request) health.reconciliation = { ...health.reconciliation, requestId: request.id, requestStatus: request.status };
      return finish();
    }
    discovered.application = application;
    health.application = {
      discovered: true,
      attached: application.attached === true,
      project: application.project_id,
      id: application.id,
    };
    if (application.project_id !== FACTORY_PROJECT_ID) {
      fail(health, 'application_mismatch', `Factory application belongs to ${application.project_id}, expected ${FACTORY_PROJECT_ID}`);
      return finish();
    }
    if (!application.attached) {
      fail(health, 'application_unattached', 'the canonical Factory application is not attached');
      return finish();
    }

    manifest = await controlPlane.getApplicationManifest(tenantId, application.id);
    if (!manifest || manifest.application_id !== application.id
      || (application.manifest_id && manifest.id !== application.manifest_id)) {
      fail(health, 'manifest_unavailable', 'the canonical Factory application manifest is unavailable or mismatched');
      return finish();
    }
    discovered.manifest = manifest;
    required.manifest = manifest;
    health.manifest = {
      available: true,
      id: manifest.id,
      ...(manifest.environment ? { environment: manifest.environment } : {}),
      ...(manifest.production_url ? { productionUrl: manifest.production_url } : {}),
    };

    const declaredPrincipal = manifest.principals.find((principal) => principal.id === FACTORY_SERVICE_PRINCIPAL);
    if (!declaredPrincipal || (declaredPrincipal.kind && declaredPrincipal.kind !== 'agent')) {
      health.principal.canonical = false;
      fail(health, 'principal_invalid', `manifest does not require canonical ${FACTORY_SERVICE_PRINCIPAL} agent principal`);
      return finish();
    }

    const agents = await controlPlane.listAgents(tenantId);
    actual.principals = agents;
    let principal = agents.find((agent) => agent.id === FACTORY_SERVICE_PRINCIPAL);
    if (!principal) {
      missing.principal = FACTORY_SERVICE_PRINCIPAL;
      try {
        principal = await controlPlane.createAgent(tenantId, { id: FACTORY_SERVICE_PRINCIPAL, name: 'factory-service' });
      } catch (error) {
        request = await requestMissing(controlPlane, tenantId, {
          kind: 'principal.provision', project_id: project.id, application_id: application.id,
          principal: FACTORY_SERVICE_PRINCIPAL,
        });
        fail(health, request ? 'pending_approval' : 'principal_missing', error instanceof Error ? error.message : String(error));
        if (request) health.reconciliation = { ...health.reconciliation, requestId: request.id, requestStatus: request.status };
        return finish();
      }
    }
    if (principal.kind !== 'agent' || principal.name !== 'factory-service' || principal.status !== 'active') {
      fail(health, 'principal_invalid', `${FACTORY_SERVICE_PRINCIPAL} is not the active canonical Factory service principal`);
      return finish();
    }
    health.principal.present = true;

    const [policies, delegations, capabilities] = await Promise.all([
      controlPlane.listPolicies(tenantId, application.id),
      controlPlane.listDelegations(tenantId, FACTORY_SERVICE_PRINCIPAL),
      controlPlane.listCapabilities(tenantId, application.id),
    ]);
    actual.policies = policies;
    actual.delegations = delegations;
    actual.capabilities = capabilities;

    const missingPolicies = manifest.policies
      .filter((requirement) => !policies.some((policy) => policyMatches(requirement, policy)))
      .map((requirement) => requirement.id);
    health.policy = { complete: missingPolicies.length === 0, missing: missingPolicies };
    if (missingPolicies.length) missing.policies = missingPolicies;

    const requiredDelegations = manifest.delegations.filter((delegation) => delegation.delegate === FACTORY_SERVICE_PRINCIPAL);
    const missingDelegations = requiredDelegations
      .filter((requirement) => !delegations.some((delegation) =>
        delegationMatches(requirement, delegation, application.id, now())))
      .map(requiredDelegationKey);
    health.delegation = { complete: missingDelegations.length === 0, missing: missingDelegations };
    if (missingDelegations.length) missing.delegations = missingDelegations;

    const manifestCapabilities = new Set(manifest.capabilities);
    const grantedCapabilities = new Set(
      capabilities.filter((capability) => active(capability.status)).map((capability) => capability.name),
    );
    for (const delegation of delegations.filter((entry) => usable(entry, now()))) {
      for (const capability of delegation.capabilities) grantedCapabilities.add(capability);
    }
    for (const capability of FACTORY_REQUIRED_CAPABILITIES) {
      health.capabilities[capability] = manifestCapabilities.has(capability) && grantedCapabilities.has(capability);
    }
    const missingCapabilities = FACTORY_REQUIRED_CAPABILITIES.filter((capability) => !health.capabilities[capability]);
    if (missingCapabilities.length) missing.capabilities = missingCapabilities;

    if (missingPolicies.length || missingDelegations.length || missingCapabilities.length) {
      request = await requestMissing(controlPlane, tenantId, {
        kind: 'authority.reconcile',
        project_id: project.id,
        application_id: application.id,
        manifest_id: manifest.id,
        principal: FACTORY_SERVICE_PRINCIPAL,
        missing: {
          policies: missingPolicies,
          delegations: missingDelegations,
          capabilities: missingCapabilities,
        },
      });
      const blocker: AuthorityBlocker = request
        ? 'pending_approval'
        : missingPolicies.length ? 'policy_missing'
          : missingDelegations.length ? 'delegation_missing' : 'capability_missing';
      fail(health, blocker, request
        ? `authority request ${request.id} is ${request.status}`
        : 'required AuthBoundry authority is incomplete');
      if (request) health.reconciliation = { ...health.reconciliation, requestId: request.id, requestStatus: request.status };
      return finish();
    }

    if (!options.serviceCredentialPresent) {
      fail(health, 'service_credential_missing', 'FACTORY_SERVICE_CREDENTIAL is required for autonomous operation');
      return finish();
    }

    const delegation = delegations.find((entry) => requiredDelegations.some((requirement) =>
      delegationMatches(requirement, entry, application.id, now())));
    if (!delegation) {
      fail(health, 'delegation_missing', `AuthBoundry holds no usable delegation for ${FACTORY_SERVICE_PRINCIPAL}`);
      return finish();
    }
    if (controlPlane.verifyServiceAuthorization) {
      const evidence = await controlPlane.verifyServiceAuthorization(FACTORY_REQUIRED_CAPABILITIES);
      actual.authorizationEvidence = evidence.evidence;
      const valid = evidence.principal === FACTORY_SERVICE_PRINCIPAL
        && evidence.tenant === tenantId
        && evidence.delegation === delegation.id
        && FACTORY_REQUIRED_CAPABILITIES.every((capability) => evidence.capabilities[capability] === true);
      if (!valid) {
        fail(
          health,
          'authorization_evidence_invalid',
          'the service credential did not produce canonical Factory authorization evidence',
        );
        return finish();
      }
    }
    association = {
      tenantId,
      applicationId: application.id,
      resource: applicationResource(application.id),
      agents: [{
        principalId: FACTORY_SERVICE_PRINCIPAL,
        delegationId: delegation.id,
        applicationId: application.id,
        capabilities: [...delegation.capabilities],
      }],
    };
    health.reconciliation = { healthy: true };
    return finish();
  } catch (error) {
    if (error instanceof AuthBoundryControlPlaneError && (error.status === 401 || error.status === 403)) {
      health.authBoundry.reachable = true;
      fail(health, 'authorization_evidence_invalid', error.message);
    } else {
      fail(health, 'authboundry_unreachable', error instanceof Error ? error.message : String(error));
    }
    association = null;
    return finish();
  }
}
