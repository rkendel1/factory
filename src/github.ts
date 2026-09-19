import type { RunRecord, StructuredEvidence } from './types.js';

export function formatGitHubResult(run: RunRecord, evidence?: StructuredEvidence): string {
  const lines = [
    'Software Factory',
    `Run: ${run.id}`,
    'Authority:',
    '  .flow → FeltDB',
    `  authorization: ${run.authorizationDecisionId ? 'granted' : 'rejected'}`,
    'Execution:',
    `  ${process.platform}-${process.arch}`,
    '  ephemeral workspace',
    `Result: ${evidence?.finalResult ?? run.status.toUpperCase()}`,
  ];

  if (evidence?.invariant?.name) {
    lines.push(`Failed invariant: ${evidence.invariant.name}`);
  }
  if (evidence?.invariant?.expected) {
    lines.push(`Expected: ${evidence.invariant.expected}`);
  }
  if (evidence?.invariant?.observed) {
    lines.push(`Observed: ${evidence.invariant.observed}`);
  }
  if (evidence?.jev.status) {
    lines.push(`JEV: ${evidence.jev.status}`);
  }
  if (evidence?.jev.explanation) {
    lines.push(`Why: ${evidence.jev.explanation}`);
  }

  return lines.join('\n');
}
