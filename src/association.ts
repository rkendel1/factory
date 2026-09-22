import type { FlowSpec } from '@feltdb/core';
import { createCanonicalApplicationContract } from './application-contract.js';

/**
 * AuthBoundry derives an agent principal id from the agent's name, so a Factory
 * service principal declared in `.flow` as `factory-service` is the AuthBoundry
 * principal `agent:factory-service`. The two spellings are never collapsed: one
 * is the Factory capability declaration, the other is the authority's identity.
 */
export const AGENT_PRINCIPAL_PREFIX = 'agent:';

export function factoryAgentPrincipalId(declaredPrincipal: string): string {
  return `${AGENT_PRINCIPAL_PREFIX}${declaredPrincipal.trim().replace(/\s+/g, '-')}`;
}

export function isFactoryAgentPrincipal(principal: string, association: FactoryAssociation): boolean {
  return association.agents.some((agent) => agent.principalId === principal);
}

export interface FactoryAgent {
  readonly name: string;
  readonly principalId: string;
}

/**
 * The association Factory requires of AuthBoundry: each `.flow` service
 * principal, as an AuthBoundry agent, delegated the declared application
 * capabilities and scoped to the Factory application.
 *
 * This is a statement of what `.flow` declares, not of what AuthBoundry holds.
 * Only `VerifiedAssociation` records what the authority actually answered.
 */
export interface FactoryAssociation {
  readonly applicationId: string;
  readonly capabilities: readonly string[];
  readonly agents: readonly FactoryAgent[];
}

/** A single agent's association as AuthBoundry reported it. */
export interface VerifiedAgentAssociation {
  readonly principalId: string;
  readonly delegationId: string;
  readonly applicationId: string;
  readonly capabilities: readonly string[];
}

export interface VerifiedAssociation {
  readonly tenantId: string;
  readonly applicationId: string;
  /** The AuthBoundry resource the delegation is scoped to. */
  readonly resource: string;
  readonly agents: readonly VerifiedAgentAssociation[];
}

/**
 * The application context AuthBoundry authorized a principal to act in.
 *
 * Factory carries this into execution rather than the application id `.flow`
 * declares. The two normally agree; when they do not, the authority's answer is
 * the one that counts, and when the authority has no answer there is no context
 * to execute in.
 */
export interface AuthorizedApplicationContext {
  readonly applicationId: string;
  readonly resource: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly delegationId: string;
  readonly capabilities: readonly string[];
}

export function authorizedApplicationContext(
  verified: VerifiedAssociation | null,
  principalId: string,
): AuthorizedApplicationContext | null {
  const agent = verified?.agents.find((candidate) => candidate.principalId === principalId);
  if (!verified || !agent) return null;
  return {
    applicationId: verified.applicationId,
    resource: verified.resource,
    tenantId: verified.tenantId,
    principalId: agent.principalId,
    delegationId: agent.delegationId,
    capabilities: agent.capabilities,
  };
}

/**
 * The capability that lets an Action execute without a person.
 *
 * Factory asks AuthBoundry this question instead of deciding for itself which
 * Actions need human judgement. The default answer is the safe one and needs no
 * coordination: an authority that does not grant this capability denies it, so
 * an Action waits for a person until someone deliberately grants autonomy.
 *
 * Factory determines what needs to happen. AuthBoundry determines what may
 * cause it to happen without a human.
 */
export const AUTONOMOUS_EXECUTION_CAPABILITY = 'factory.action.autonomous';

/**
 * Factory's connection to its authority, as the authority answered it.
 *
 * `associated` means AuthBoundry holds the delegation; `unassociated` means it
 * answered and does not; `unverified` means Factory could not ask. Only the
 * first permits a Factory service principal to act, so an authority Factory
 * cannot reach is never mistaken for one that agrees.
 */
export type FactoryConnectionState =
  | { readonly status: 'associated'; readonly association: VerifiedAssociation }
  | { readonly status: 'unassociated'; readonly reason: string }
  | { readonly status: 'unverified'; readonly reason: string };

export type AssociationDenialReason =
  | 'association_unverified'
  | 'delegation_missing'
  | 'tenant_mismatch';

export class FactoryAssociationError extends Error {
  readonly status = 403;

  constructor(readonly reason: AssociationDenialReason, message: string) {
    super(message);
    this.name = 'FactoryAssociationError';
  }
}

function declaredServicePrincipals(flowSpec: FlowSpec): string[] {
  const principals = new Set<string>();
  for (const block of flowSpec.capabilities) {
    for (const statement of block.statements) {
      if (statement.startsWith('principal ')) {
        const value = statement.slice('principal '.length).trim();
        if (value) principals.add(value);
      }
    }
  }
  return [...principals].sort();
}

/** Derive the association `.flow` declares. `.flow` remains authoritative. */
export function factoryAssociation(flowSpec: FlowSpec): FactoryAssociation {
  const application = createCanonicalApplicationContract(flowSpec);
  const agents = declaredServicePrincipals(flowSpec).map((name) => ({
    name,
    principalId: factoryAgentPrincipalId(name),
  }));
  // A `.flow` that declares no service principal has no association to hold;
  // it is not an error, and nothing is then subject to the agent check below.
  return {
    applicationId: application.authorization.applicationId,
    capabilities: application.authorization.capabilities,
    agents,
  };
}

/**
 * Fail closed for a Factory service principal.
 *
 * Factory asks one question here, and it is not an authorization question:
 * does AuthBoundry hold the Factory application association this principal
 * would act under? Whether a capability is granted, and on what basis, stays
 * AuthBoundry's answer — re-deciding it here would be a second authorization
 * model, and a grant AuthBoundry makes on a policy claim is no less valid than
 * one it makes on the delegation.
 *
 * What Factory refuses is acting with no authorized application context at all,
 * which is the case an application id taken from `.flow` would otherwise paper
 * over.
 *
 * A principal that is not a declared Factory agent (a human signing in through
 * the browser) is not subject to this check.
 */
export function assertFactoryAssociation(
  grant: { principal: string; tenant: string },
  association: FactoryAssociation,
  verified: VerifiedAssociation | null,
): void {
  if (!isFactoryAgentPrincipal(grant.principal, association)) {
    return;
  }
  if (!verified) {
    throw new FactoryAssociationError(
      'association_unverified',
      `the Factory application association for ${grant.principal} is not verified`,
    );
  }
  if (verified.tenantId !== grant.tenant) {
    throw new FactoryAssociationError(
      'tenant_mismatch',
      `the Factory application association is not held in tenant ${grant.tenant}`,
    );
  }
  const agent = verified.agents.find((candidate) => candidate.principalId === grant.principal);
  if (!agent) {
    throw new FactoryAssociationError(
      'delegation_missing',
      `${grant.principal} holds no Factory application association`,
    );
  }
}
