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
    { id: 'overview', title: 'Overview', route: '/factory', capabilities: ['factory.ui.read'], entities: ['Project', 'Action', 'Run'] },
    { id: 'projects', title: 'Projects', route: '/factory/projects', capabilities: ['factory.ui.read'], entities: ['Project', 'Repository', 'Environment', 'DesiredState'] },
    { id: 'actions', title: 'Actions', route: '/factory/actions', capabilities: ['factory.ui.read'], entities: ['Action'] },
    { id: 'runs', title: 'Runs', route: '/factory/runs', capabilities: ['factory.ui.read'], entities: ['Run', 'ExecutionRequest'] },
    { id: 'providers', title: 'Providers', route: '/factory/providers', capabilities: ['factory.ui.read'], entities: ['ExecutionContract'] },
    { id: 'work', title: 'Requested work', route: '/factory/work', capabilities: ['factory.ui.read'], entities: ['OperationalWork', 'ActionGraph'] },
    { id: 'evidence', title: 'Evidence', route: '/factory/runs', capabilities: ['evidence.write'], entities: ['Evidence', 'ExecutionContract', 'AuthorizationDecision'] },
    { id: 'settings', title: 'Settings', route: '/factory/settings', capabilities: ['factory.ui.read'] },
  ],
  navigation: [
    { id: 'overview', label: 'Overview', group: 'factory', order: 10, surface: 'overview' },
    { id: 'projects', label: 'Projects', group: 'factory', order: 20, surface: 'projects' },
    { id: 'actions', label: 'Actions', group: 'factory', order: 30, surface: 'actions' },
    { id: 'runs', label: 'Runs', group: 'factory', order: 40, surface: 'runs' },
    { id: 'providers', label: 'Providers', group: 'factory', order: 50, surface: 'providers' },
    { id: 'work', label: 'Requested work', group: 'factory', order: 60, surface: 'work' },
    { id: 'settings', label: 'Settings', group: 'factory', order: 90, surface: 'settings' },
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
