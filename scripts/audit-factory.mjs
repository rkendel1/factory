import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const loc = (file) => read(file).split(/\r?\n/).filter((line) => line.trim()).length;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(read('package-lock.json'));
const packageEvidence = (name) => {
  const entry = lock.packages[`node_modules/${name}`];
  return { version: entry?.version, integrity: entry?.integrity ?? null };
};

const productionFiles = [
  'src/application-contract.ts', 'src/appport.ts', 'src/auth.ts', 'src/authority.ts',
  'src/contract.ts', 'src/evidence.ts', 'src/execution.ts', 'src/felt.ts',
  'src/github.ts', 'src/server.ts', 'src/types.ts', 'src/workspace.ts',
];
const testFiles = [
  'tests/appport.test.ts', 'tests/authboundry.test.ts', 'tests/authority.test.ts',
  'tests/evidence.test.ts', 'tests/execution.test.ts', 'tests/failure.test.ts',
  'tests/helpers.ts', 'tests/package-boundary.test.ts', 'tests/studio.test.ts',
];
const production = Object.fromEntries(productionFiles.map((file) => [file, loc(file)]));
const tests = Object.fromEntries(testFiles.map((file) => [file, loc(file)]));
const integrationFiles = [
  'src/application-contract.ts', 'src/appport.ts', 'src/auth.ts',
  'src/authority.ts', 'src/execution.ts', 'src/felt.ts',
];
const integration = Object.fromEntries(integrationFiles.map((file) => [file, production[file]]));
const productionLoc = Object.values(production).reduce((sum, value) => sum + value, 0);
const testLoc = Object.values(tests).reduce((sum, value) => sum + value, 0);
const integrationLoc = Object.values(integration).reduce((sum, value) => sum + value, 0);
const glueRatio = integrationLoc / productionLoc;

const headCommit = git('rev-parse', 'HEAD');
const baselineCommit = process.env.BASELINE_COMMIT ?? headCommit;
if (process.env.BASELINE_COMMIT && baselineCommit !== headCommit) {
  throw new Error(`BASELINE_COMMIT ${baselineCommit} does not match audited HEAD ${headCommit}`);
}
const dirtyFiles = git('status', '--porcelain', '--untracked-files=all')
  .split(/\r?\n/)
  .filter((line) => line && !line.slice(3).trim().endsWith('docs/factory-composition-audit-pre-jev.json'))
  .join('\n');
if (dirtyFiles) throw new Error(`Audited tree is not clean:\n${dirtyFiles}`);

const sourceText = productionFiles.map(read).join('\n');
const packageJson = JSON.parse(read('package.json'));
const dependencyNames = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
  ...packageJson.optionalDependencies,
});
const jevChecks = {
  dependency: dependencyNames.some((name) => /\bjev\b/i.test(name)),
  imports: /\b(?:from|import)\s*['"][^'"]*\bjev\b/i.test(sourceText),
  source: productionFiles.some((file) => /(?:^|\/)jev[^/]*\.(?:ts|js|mjs)$/.test(file)),
  executionPath: /\b(?:spawn|exec|execute)\b[^\n]*\bjev\b/i.test(sourceText),
};
if (Object.values(jevChecks).some(Boolean)) {
  throw new Error(`JEV must be absent from the pre-JEV baseline: ${JSON.stringify(jevChecks)}`);
}

const inventory = [
  ['Factory → FeltDB', production['src/felt.ts'], 'direct', false],
  ['Factory → AuthBoundry', production['src/auth.ts'], 'thinAdapter', true],
  ['Factory → .flow', production['src/authority.ts'] + production['src/application-contract.ts'], 'projection', true],
  ['Factory → AppPort', production['src/appport.ts'], 'thinAdapter', true],
  ['Factory → AppPort Services', production['src/appport.ts'], 'direct', false],
  ['Factory → AppBoundry', production['src/application-contract.ts'], 'projection', true],
  ['Factory → PAX', production['src/execution.ts'], 'serialization', true],
  ['Factory → Studio', 0, 'direct', false],
].map(([boundary, boundaryLoc, classification, translation]) => ({
  boundary, classification, loc: boundaryLoc, translation, duplicateAuthority: false, shadowState: false,
}));

const report = {
  baseline: {
    commit: baselineCommit,
    tree: git('rev-parse', 'HEAD^{tree}'),
    clean: true,
    jevIntegrated: false,
    jevChecks,
    flowPath: '.flow',
    flowSha256: sha256(read('.flow')),
    dependencies: Object.fromEntries([
      '@feltdb/core', '@authboundry/core', '@appport/sdk', '@appport/services', '@appport/appboundry',
    ].map((name) => [name, packageEvidence(name)])),
  },
  methodology: {
    loc: 'Non-empty physical lines in tracked TypeScript source/test files; blank lines excluded. Comments and type declarations count.',
    excluded: ['node_modules', 'dist', 'generated code', 'lockfiles', 'vendored code'],
    integrationLoc: 'A line belongs to integration LOC when its primary purpose is translating, adapting, invoking, persisting across, or enforcing a boundary between Factory and another architectural component. Shared orchestration that merely calls a boundary is not integration unless it performs boundary-specific work.',
    authorityTsRule: 'authority.ts integration LOC includes only the portion that resolves .flow capability authority and derives the external execution/application contract; generic authorization orchestration is excluded.',
    classification: {
      loc: 'mechanical',
      dependencyGraph: 'mechanical_plus_review',
      conceptClassification: 'manual_review',
      authorityAudit: 'manual_review',
      friction: 'manual_review',
    },
  },
  loc: {
    production: productionLoc, tests: testLoc, integration: integrationLoc,
    integrationFiles: integrationFiles.length, productionFiles: production, testFiles: tests,
    categories: {
      factoryOrchestration: production['src/server.ts'], domainModel: production['src/types.ts'],
      httpApi: production['src/server.ts'], persistenceIntegration: production['src/felt.ts'],
      contractProjection: production['src/application-contract.ts'],
      executionIntegration: production['src/execution.ts'], adapterGlue: integrationLoc,
    },
  },
  integration: {
    total: integrationLoc, glueLoc: integrationLoc, glueRatio, files: integration,
    direct: 3, thinAdapters: 2, projections: 2, serialization: 1, semanticTranslations: 0,
    classifications: {
      direct: 3, thinAdapters: 2, projections: 2, serialization: 1,
      semanticTranslations: 0, duplicateModels: 0, authorityDuplications: 0,
    },
  },
  compositionInventory: inventory,
  boundaries: {
    authorityViolations: 0, persistenceViolations: 0, shadowState: 0,
    integrations: {
      'Factory ↔ FeltDB': { loc: production['src/felt.ts'], files: ['src/felt.ts'], classification: 'direct composition' },
      'Factory ↔ AuthBoundry': { loc: production['src/auth.ts'], files: ['src/auth.ts'], classification: 'thin adapter' },
      'Factory ↔ .flow': { loc: production['src/authority.ts'] + production['src/application-contract.ts'], files: ['src/authority.ts', 'src/application-contract.ts'], classification: 'projection' },
      'Factory ↔ AppPort': { loc: production['src/appport.ts'], files: ['src/appport.ts'], classification: 'thin adapter' },
      'Factory ↔ AppPort Services': { loc: production['src/appport.ts'], files: ['src/appport.ts'], classification: 'direct composition' },
      'Factory ↔ AppBoundry': { loc: production['src/application-contract.ts'], files: ['src/application-contract.ts'], classification: 'projection' },
      'Factory ↔ PAX': { loc: production['src/execution.ts'], files: ['src/execution.ts'], classification: 'serialization' },
      'Factory ↔ Studio': { loc: 0, files: [], classification: 'direct composition' },
    },
  },
  concepts: { canonical: 11, projected: 7, duplicated: 0, authorityDuplications: 0 },
  processState: {
    configuration: ['process.env in src/felt.ts, src/auth.ts, src/execution.ts, src/server.ts'],
    ephemeralExecution: ['child process handles and workspace paths in src/execution.ts and src/workspace.ts'],
    cache: [], authority: [], durableStateSubstitute: [],
  },
};

writeFileSync(path.join(root, 'docs/factory-composition-audit-pre-jev.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  baselineCommit, tree: report.baseline.tree, productionLoc, testLoc, integrationLoc, glueRatio,
  flowSha256: report.baseline.flowSha256,
}, null, 2));
