import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTempWorkspace } from './helpers.js';
import { createFactoryDB, COLLECTIONS } from '../src/felt.js';
import {
  FACTORY_APPLICATION_ID,
  FACTORY_PROJECT_ID,
  FACTORY_REQUIRED_CAPABILITIES,
  FACTORY_SERVICE_PRINCIPAL,
  reconcileFactoryAuthority,
  type FactoryAuthorityReconciliationRecord,
} from '../src/authority-reconciliation.js';
import type {
  AuthBoundryAgent,
  AuthBoundryApplication,
  AuthBoundryApplicationManifest,
  AuthBoundryCapability,
  AuthBoundryControlPlane,
  AuthBoundryDelegation,
  AuthBoundryPolicy,
  AuthBoundryProject,
  AuthBoundryProvisioningRequest,
} from '../src/provisioning.js';

const TENANT = 'tenant-factory';

class CanonicalAuthority implements AuthBoundryControlPlane {
  reachable = true;
  authorizationPrincipal = FACTORY_SERVICE_PRINCIPAL;
  projects: AuthBoundryProject[] = [{ id: FACTORY_PROJECT_ID, name: 'Factory', status: 'active' }];
  applications: AuthBoundryApplication[] = [{
    id: FACTORY_APPLICATION_ID,
    project_id: FACTORY_PROJECT_ID,
    attached: true,
    manifest_id: 'factory-manifest',
    canonical: true,
  }];
  manifest: AuthBoundryApplicationManifest | null = {
    id: 'factory-manifest',
    application_id: FACTORY_APPLICATION_ID,
    principals: [{ id: FACTORY_SERVICE_PRINCIPAL, kind: 'agent', name: 'factory-service' }],
    policies: [{
      id: 'policy.factory.execution',
      principal: FACTORY_SERVICE_PRINCIPAL,
      capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
    }],
    delegations: [{
      id: 'delegation.operator-factory-service',
      delegator: 'operator',
      delegate: FACTORY_SERVICE_PRINCIPAL,
      capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
    }],
    capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
    environment: 'production',
    production_url: 'https://factory.example',
  };
  agents: AuthBoundryAgent[] = [{
    id: FACTORY_SERVICE_PRINCIPAL,
    kind: 'agent',
    name: 'factory-service',
    tenant: TENANT,
    status: 'active',
  }];
  policies: AuthBoundryPolicy[] = [{
    id: 'policy.factory.execution',
    application: FACTORY_APPLICATION_ID,
    principal: FACTORY_SERVICE_PRINCIPAL,
    capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
    status: 'active',
  }];
  delegations: AuthBoundryDelegation[] = [{
    id: 'delegation.operator-factory-service',
    delegator: 'operator',
    delegate: FACTORY_SERVICE_PRINCIPAL,
    application: FACTORY_APPLICATION_ID,
    tenant: TENANT,
    capabilities: [...FACTORY_REQUIRED_CAPABILITIES],
  }];
  capabilities: AuthBoundryCapability[] = FACTORY_REQUIRED_CAPABILITIES.map((name) => ({
    name,
    application: FACTORY_APPLICATION_ID,
    status: 'active',
  }));
  requests: AuthBoundryProvisioningRequest[] = [];

  private check(): void {
    if (!this.reachable) throw new Error('AuthBoundry unavailable');
  }

  async listProjects(): Promise<AuthBoundryProject[]> { this.check(); return this.projects; }
  async listApplications(): Promise<AuthBoundryApplication[]> { this.check(); return this.applications; }
  async getApplicationManifest(): Promise<AuthBoundryApplicationManifest | null> { this.check(); return this.manifest; }
  async listAgents(): Promise<AuthBoundryAgent[]> { this.check(); return this.agents; }
  async createAgent(tenant: string, agent: { id: string; name: string }): Promise<AuthBoundryAgent> {
    this.check();
    const created = { ...agent, kind: 'agent', tenant, status: 'active' };
    this.agents.push(created);
    return created;
  }
  async listPolicies(): Promise<AuthBoundryPolicy[]> { this.check(); return this.policies; }
  async listDelegations(): Promise<AuthBoundryDelegation[]> { this.check(); return this.delegations; }
  async listCapabilities(): Promise<AuthBoundryCapability[]> { this.check(); return this.capabilities; }
  async requestProvisioning(): Promise<AuthBoundryProvisioningRequest> {
    this.check();
    const request = { id: `request-${this.requests.length + 1}`, status: 'pending_approval' };
    this.requests.push(request);
    return request;
  }
  async verifyServiceAuthorization(capabilities: readonly string[]) {
    this.check();
    return {
      principal: this.authorizationPrincipal,
      tenant: TENANT,
      delegation: this.delegations[0]?.id ?? null,
      capabilities: Object.fromEntries(capabilities.map((capability) => [capability, true])),
      evidence: { authority: 'delegated', principal: this.authorizationPrincipal },
    };
  }
}

async function database(root: string) {
  return createFactoryDB({
    mode: 'local',
    namespace: path.basename(root),
    environmentId: 'test',
    tenantId: TENANT,
    workingDirectory: root,
    flowPath: path.resolve(process.cwd(), '.flow'),
  });
}

test('canonical authority is rediscovered after restart and every removed prerequisite fails closed', async () => {
  const root = await createTempWorkspace('factory-authority-lifecycle');
  const authority = new CanonicalAuthority();
  const firstDb = await database(root);
  const reconcile = (db = firstDb, serviceCredentialPresent = true) => reconcileFactoryAuthority({
    controlPlane: authority,
    db,
    tenantId: TENANT,
    serviceCredentialPresent,
  });

  const first = await reconcile();
  assert.equal(first.health.reconciliation.healthy, true);
  assert.equal(first.health.application.attached, true);
  assert.equal(first.health.application.project, FACTORY_PROJECT_ID);
  assert.equal(first.association?.agents[0]?.principalId, FACTORY_SERVICE_PRINCIPAL);

  // A new database handle represents a restarted Factory process. The result
  // is rediscovered from AuthBoundry and the explanatory state is still in FeltDB.
  const restartedDb = await database(root);
  const restarted = await reconcile(restartedDb);
  assert.equal(restarted.health.reconciliation.healthy, true);
  const durable = await restartedDb
    .collection<FactoryAuthorityReconciliationRecord>(COLLECTIONS.authorityReconciliations)
    .get(`factory-authority:${TENANT}`);
  assert.equal(durable?.health.reconciliation.healthy, true);
  assert.equal(durable?.health.manifest.productionUrl, 'https://factory.example');

  const cases: Array<{ name: string; remove(): () => void; blocker: string }> = [
    {
      name: 'AuthBoundry reachability',
      remove: () => { authority.reachable = false; return () => { authority.reachable = true; }; },
      blocker: 'authboundry_unreachable',
    },
    {
      name: 'project',
      remove: () => { const value = authority.projects; authority.projects = []; return () => { authority.projects = value; }; },
      blocker: 'pending_approval',
    },
    {
      name: 'application',
      remove: () => { const value = authority.applications; authority.applications = []; return () => { authority.applications = value; }; },
      blocker: 'pending_approval',
    },
    {
      name: 'attachment',
      remove: () => { authority.applications[0]!.attached = false; return () => { authority.applications[0]!.attached = true; }; },
      blocker: 'application_unattached',
    },
    {
      name: 'manifest',
      remove: () => { const value = authority.manifest; authority.manifest = null; return () => { authority.manifest = value; }; },
      blocker: 'manifest_unavailable',
    },
    {
      name: 'principal',
      remove: () => {
        const value = authority.agents;
        authority.agents = [];
        const create = authority.createAgent;
        authority.createAgent = async () => { throw new Error('approval required'); };
        return () => { authority.agents = value; authority.createAgent = create; };
      },
      blocker: 'pending_approval',
    },
    {
      name: 'policy',
      remove: () => { const value = authority.policies; authority.policies = []; return () => { authority.policies = value; }; },
      blocker: 'pending_approval',
    },
    {
      name: 'delegation',
      remove: () => { const value = authority.delegations; authority.delegations = []; return () => { authority.delegations = value; }; },
      blocker: 'pending_approval',
    },
    {
      name: 'factory.run',
      remove: () => {
        const value = authority.capabilities;
        authority.capabilities = value.filter((capability) => capability.name !== 'factory.run');
        authority.delegations[0]!.capabilities = ['factory.action.autonomous'];
        return () => { authority.capabilities = value; authority.delegations[0]!.capabilities = [...FACTORY_REQUIRED_CAPABILITIES]; };
      },
      blocker: 'pending_approval',
    },
    {
      name: 'factory.action.autonomous',
      remove: () => {
        const value = authority.capabilities;
        authority.capabilities = value.filter((capability) => capability.name !== 'factory.action.autonomous');
        authority.delegations[0]!.capabilities = ['factory.run'];
        return () => { authority.capabilities = value; authority.delegations[0]!.capabilities = [...FACTORY_REQUIRED_CAPABILITIES]; };
      },
      blocker: 'pending_approval',
    },
    {
      name: 'authorization evidence',
      remove: () => {
        authority.authorizationPrincipal = 'agent:someone-else';
        return () => { authority.authorizationPrincipal = FACTORY_SERVICE_PRINCIPAL; };
      },
      blocker: 'authorization_evidence_invalid',
    },
  ];

  for (const scenario of cases) {
    const restore = scenario.remove();
    const result = await reconcile(restartedDb);
    assert.equal(result.health.reconciliation.healthy, false, scenario.name);
    assert.equal(result.health.reconciliation.blocker, scenario.blocker, scenario.name);
    assert.equal(result.association, null, scenario.name);
    restore();
  }

  const noCredential = await reconcile(restartedDb, false);
  assert.equal(noCredential.health.reconciliation.blocker, 'service_credential_missing');
  assert.equal(noCredential.association, null);
});
