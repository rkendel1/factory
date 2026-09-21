import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, seedWork } from './helpers.js';
import { COLLECTIONS } from '../src/felt.js';
import {
  applicationResource,
  associationDelegationId,
  provisionFactoryAssociation,
  resolveFactoryAssociation,
  type AuthBoundryAgent,
  type AuthBoundryControlPlane,
  type AuthBoundryDelegation,
} from '../src/provisioning.js';
import { factoryAssociation } from '../src/association.js';
import { loadFactoryFlow } from '../src/felt.js';
import type { AuthorizationDecisionRecord, StructuredEvidence } from '../src/types.js';
import type { Authenticator } from '../src/auth.js';

const TENANT = 'tenant-a';
const FACTORY_PRINCIPAL = 'agent:factory-service';

/**
 * A stand-in for AuthBoundry's control plane that keeps its observable rules:
 * an agent is stored under the id it was given, and a delegation is only ever
 * read — Factory has no way to create one.
 */
function controlPlane(options: {
  agents?: AuthBoundryAgent[];
  delegations?: AuthBoundryDelegation[];
} = {}): AuthBoundryControlPlane & { calls: string[]; agents: AuthBoundryAgent[] } {
  const agents = [...(options.agents ?? [])];
  const delegations = [...(options.delegations ?? [])];
  const calls: string[] = [];
  return {
    calls,
    agents,
    async listAgents(tenant) {
      calls.push(`listAgents:${tenant}`);
      return agents.filter((agent) => agent.tenant === tenant);
    },
    async createAgent(tenant, agent) {
      calls.push(`createAgent:${agent.id}`);
      const record: AuthBoundryAgent = {
        id: agent.id, kind: 'agent', name: agent.name, tenant, status: 'active',
      };
      agents.push(record);
      return record;
    },
    async listDelegations(tenant, delegate) {
      calls.push(`listDelegations:${delegate}`);
      return delegations.filter((entry) => entry.tenant === tenant && entry.delegate === delegate);
    },
  };
}

function factoryAgent(status = 'active'): AuthBoundryAgent {
  return { id: FACTORY_PRINCIPAL, kind: 'agent', name: 'factory-service', tenant: TENANT, status };
}

function factoryDelegation(overrides: Partial<AuthBoundryDelegation> = {}): AuthBoundryDelegation {
  const association = factoryAssociation(loadFactoryFlow());
  return {
    id: associationDelegationId(TENANT),
    delegator: 'system',
    delegate: FACTORY_PRINCIPAL,
    application: association.applicationId,
    tenant: TENANT,
    capabilities: [...association.capabilities],
    ...overrides,
  };
}

function declared() {
  return factoryAssociation(loadFactoryFlow());
}

function boundaryAuthenticator(context: {
  principal?: string;
  delegationId?: string | null;
  authority?: string;
} = {}): Authenticator {
  return {
    async authenticate() {
      return {
        principal: context.principal ?? FACTORY_PRINCIPAL,
        tenant: TENANT,
        claims: {},
        session: { id: 'session-1' },
        delegation: null,
        boundaryVerified: true,
        authorizedCapabilities: [...declared().capabilities],
        authority: context.authority ?? 'delegated',
        delegationId: context.delegationId === undefined
          ? associationDelegationId(TENANT)
          : context.delegationId,
      };
    },
  };
}

test('a Factory principal associated with the Factory application resolves as connected', async () => {
  const plane = controlPlane({ agents: [factoryAgent()], delegations: [factoryDelegation()] });
  const resolved = await resolveFactoryAssociation({
    controlPlane: plane, association: declared(), tenantId: TENANT,
  });
  assert.ok(resolved.association, resolved.reason ?? 'expected an association');
  assert.equal(resolved.association.applicationId, 'factory');
  assert.equal(resolved.association.resource, applicationResource('factory'));
  assert.deepEqual(resolved.association.agents.map((agent) => agent.principalId), [FACTORY_PRINCIPAL]);
  assert.equal(resolved.association.agents[0]?.delegationId, associationDelegationId(TENANT));

  const service = await createService({
    authBoundryControlPlane: plane,
    authBoundryTenantId: TENANT,
    authenticator: boundaryAuthenticator(),
  });
  const state = await service.refreshConnection();
  assert.equal(state.status, 'associated');
  assert.equal((await service.health()).authorities && true, true);
  assert.equal(service.connectionDocument().status, 'associated');
});

test('the same Factory principal cannot operate against another application', async () => {
  // AuthBoundry holds a delegation for this agent, but scoped to another
  // application. It is not the Factory association and must not resolve as one.
  const plane = controlPlane({
    agents: [factoryAgent()],
    delegations: [factoryDelegation({ id: 'other-application-delegation', application: 'other' })],
  });
  const resolved = await resolveFactoryAssociation({
    controlPlane: plane, association: declared(), tenantId: TENANT,
  });
  assert.equal(resolved.association, null);
  assert.match(resolved.reason ?? '', /application:factory delegation/);

  const service = await createService({
    authBoundryControlPlane: plane,
    authBoundryTenantId: TENANT,
    authenticator: boundaryAuthenticator({ delegationId: 'other-application-delegation' }),
  });
  // The delegation AuthBoundry holds is scoped to another application, so there
  // is no Factory application context for this principal and it cannot act.
  assert.equal((await service.refreshConnection()).status, 'unassociated');
  await assert.rejects(
    () => service.authenticator().authenticate({ headers: {} } as never, 'factory.run'),
    /association/i,
  );
});

test('a missing association denies the Factory principal', async () => {
  const plane = controlPlane({ agents: [factoryAgent()], delegations: [] });
  const resolved = await resolveFactoryAssociation({
    controlPlane: plane, association: declared(), tenantId: TENANT,
  });
  assert.equal(resolved.association, null);

  const service = await createService({
    authBoundryControlPlane: plane,
    authBoundryTenantId: TENANT,
    authenticator: boundaryAuthenticator(),
  });
  const state = await service.refreshConnection();
  assert.equal(state.status, 'unassociated');
  await assert.rejects(
    () => service.authenticator().authenticate({ headers: {} } as never, 'factory.run'),
    /association/i,
  );
});

test('an inactive Factory principal is denied', async () => {
  for (const status of ['suspended', 'revoked', 'retired']) {
    const plane = controlPlane({
      agents: [factoryAgent(status)],
      delegations: [factoryDelegation()],
    });
    const resolved = await resolveFactoryAssociation({
      controlPlane: plane, association: declared(), tenantId: TENANT,
    });
    assert.equal(resolved.association, null, `${status} principal must not resolve`);
    assert.match(resolved.reason ?? '', new RegExp(status));

    const service = await createService({
      authBoundryControlPlane: plane,
      authBoundryTenantId: TENANT,
      authenticator: boundaryAuthenticator(),
    });
    assert.equal((await service.refreshConnection()).status, 'unassociated');
  }
});

test('an authorized Factory action records the authorizing association in FeltDB evidence', async () => {
  const plane = controlPlane({ agents: [factoryAgent()], delegations: [factoryDelegation()] });
  const service = await createService({
    authBoundryControlPlane: plane,
    authBoundryTenantId: TENANT,
    authenticator: boundaryAuthenticator(),
  });
  await service.refreshConnection();
  await seedWork(service, { tenantId: TENANT, ownerPrincipal: FACTORY_PRINCIPAL });

  const context = await service.authenticator().authenticate({ headers: {} } as never, 'factory.run');
  const run = await service.startRun({
    workId: 'work_123',
    repository: { provider: 'local', owner: 'rkendel1', name: 'factory', ref: 'main' },
    operation: 'repo-echo',
  }, context);

  const db = (service as unknown as { db: import('@feltdb/core').StateFirstDB }).db;
  const decision = await db
    .collection<AuthorizationDecisionRecord>(COLLECTIONS.authorizationDecisions)
    .get(run.id);
  assert.equal(decision?.decision, 'granted');
  assert.equal(decision?.authority, 'delegated');
  assert.equal(decision?.delegationId, associationDelegationId(TENANT));

  const evidence = await db.collection<StructuredEvidence>(COLLECTIONS.evidence).get(run.id);
  assert.equal(evidence?.authorizedApplication?.applicationId, 'factory');
  assert.equal(evidence?.authorizedApplication?.resource, applicationResource('factory'));
  assert.equal(evidence?.authorizedApplication?.delegationId, associationDelegationId(TENANT));
  assert.equal(evidence?.authorizedApplication?.principalId, FACTORY_PRINCIPAL);
});

test('re-running provisioning registers the principal once and never mints a second association', async () => {
  const plane = controlPlane({ delegations: [factoryDelegation()] });

  const first = await provisionFactoryAssociation({
    controlPlane: plane, association: declared(), tenantId: TENANT,
  });
  assert.deepEqual(first.registeredAgents, [FACTORY_PRINCIPAL]);
  assert.ok(first.association);

  const second = await provisionFactoryAssociation({
    controlPlane: plane, association: declared(), tenantId: TENANT,
  });
  assert.deepEqual(second.registeredAgents, [], 'an existing principal is not registered again');
  assert.deepEqual(second.association, first.association);

  assert.equal(
    plane.calls.filter((call) => call.startsWith('createAgent')).length,
    1,
    'the agent principal is created exactly once across provisioning runs',
  );
  assert.equal(
    plane.agents.filter((agent) => agent.id === FACTORY_PRINCIPAL).length,
    1,
    'no duplicate Factory principal exists',
  );
  // Factory has no way to create a delegation: the association stays the one
  // AuthBoundry maintains.
  assert.equal('createDelegation' in plane, false);
});
