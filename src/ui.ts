import { composeUi, type AppPortUiContext, type ComposedUi } from '@appport/client';
import {
  UI_PROTOCOL_ID,
  validateUiContribution,
  type UiContribution,
} from '@appport/protocol';

export interface UiContributor {
  contribution(context: AppPortUiContext): UiContribution | Promise<UiContribution>;
}

export const factoryUiContribution: UiContribution = validateUiContribution({
  protocol: UI_PROTOCOL_ID,
  product: { id: 'software_factory', version: '1.0.0' },
  surfaces: [
    { id: 'work', title: 'Work', route: '/factory/work', capabilities: ['repository.read'], entities: ['Work'] },
    { id: 'runs', title: 'Runs', route: '/factory/runs', capabilities: ['repository.read'], entities: ['Run', 'ExecutionRequest'] },
    { id: 'evidence', title: 'Evidence', route: '/factory/evidence', capabilities: ['evidence.write'], entities: ['Evidence', 'ExecutionContract', 'AuthorizationDecision'] },
    { id: 'artifacts', title: 'Artifacts', route: '/factory/artifacts', capabilities: ['artifact.write'], entities: ['Artifact'] },
  ],
  navigation: [
    { id: 'work', label: 'Work', group: 'factory', order: 10, surface: 'work' },
    { id: 'runs', label: 'Runs', group: 'factory', order: 20, surface: 'runs' },
    { id: 'evidence', label: 'Evidence', group: 'factory', order: 30, surface: 'evidence' },
    { id: 'artifacts', label: 'Artifacts', group: 'factory', order: 40, surface: 'artifacts' },
  ],
  composition: { requires: ['identity', 'tenant', 'application', 'environment'] },
});

export const factoryUiContributor: UiContributor = {
  contribution: () => factoryUiContribution,
};

export async function composeProductUi(
  contributors: readonly UiContributor[],
  context: AppPortUiContext,
): Promise<ComposedUi> {
  const contributions = await Promise.all(contributors.map(async (contributor) =>
    validateUiContribution(await contributor.contribution(context))));
  return composeUi(contributions, context);
}
