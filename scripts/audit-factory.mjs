import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const loc = (file) => read(file).split(/\r?\n/).filter((line) => line.trim()).length;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(read('package-lock.json'));
const lockedVersion = (name) => lock.packages[`node_modules/${name}`]?.version;

const productionFiles = [
  'src/application-contract.ts',
  'src/appport.ts',
  'src/auth.ts',
  'src/authority.ts',
  'src/contract.ts',
  'src/evidence.ts',
  'src/execution.ts',
  'src/felt.ts',
  'src/github.ts',
  'src/server.ts',
  'src/types.ts',
  'src/workspace.ts',
];
const testFiles = [
  'tests/appport.test.ts',
  'tests/authboundry.test.ts',
  'tests/authority.test.ts',
  'tests/evidence.test.ts',
  'tests/execution.test.ts',
  'tests/failure.test.ts',
  'tests/helpers.ts',
  'tests/package-boundary.test.ts',
  'tests/studio.test.ts',
];

const production = Object.fromEntries(productionFiles.map((file) => [file, loc(file)]));
const tests = Object.fromEntries(testFiles.map((file) => [file, loc(file)]));
const integrationFiles = [
  ...productionFiles.filter((file) => [
    'src/application-contract.ts',
    'src/appport.ts',
    'src/auth.ts',
    'src/authority.ts',
    'src/execution.ts',
    'src/felt.ts',
  ].includes(file)),
];
const integration = Object.fromEntries(integrationFiles.map((file) => [file, production[file]]));
const integrationLoc = Object.values(integration).reduce((sum, value) => sum + value, 0);
const baselineCommit = process.env.BASELINE_COMMIT
  ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const report = {
  baseline: {
    factoryCommit: baselineCommit,
    jevIntegrated: false,
    flowPath: '.flow',
    flowSha256: sha256(read('.flow')),
    dependencies: {
      '@feltdb/core': lockedVersion('@feltdb/core'),
      '@authboundry/core': lockedVersion('@authboundry/core'),
      '@appport/sdk': lockedVersion('@appport/sdk'),
      '@appport/services': lockedVersion('@appport/services'),
      '@appport/appboundry': lockedVersion('@appport/appboundry'),
    },
  },
  methodology: {
    loc: 'Non-empty physical lines in tracked TypeScript source/test files; blank lines excluded. Comments and type declarations count.',
    excluded: ['node_modules', 'dist', 'generated code', 'lockfiles', 'vendored code'],
    integrationLoc: 'Deduplicated union of source files whose primary purpose is crossing a named architectural boundary.',
  },
  loc: {
    production: Object.values(production).reduce((sum, value) => sum + value, 0),
    tests: Object.values(tests).reduce((sum, value) => sum + value, 0),
    productionFiles: production,
    testFiles: tests,
    categories: {
      factoryOrchestration: production['src/server.ts'],
      domainModel: production['src/types.ts'],
      httpApi: production['src/server.ts'],
      persistenceIntegration: production['src/felt.ts'],
      contractProjection: production['src/application-contract.ts'],
      executionIntegration: production['src/execution.ts'],
      adapterGlue: integrationLoc,
    },
  },
  integration: {
    glueLoc: integrationLoc,
    glueRatio: integrationLoc / Object.values(production).reduce((sum, value) => sum + value, 0),
    files: integration,
    classifications: {
      direct: 3,
      thinAdapters: 2,
      projections: 2,
      serialization: 1,
      semanticTranslations: 0,
      duplicateModels: 0,
      authorityDuplications: 0,
    },
  },
  boundaries: {
    authorityViolations: 0,
    persistenceViolations: 0,
    shadowState: 0,
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
  concepts: {
    canonical: 11,
    projected: 7,
    duplicated: 0,
    authorityDuplications: 0,
  },
  processState: {
    configuration: ['process.env in src/felt.ts, src/auth.ts, src/execution.ts, src/server.ts'],
    ephemeralExecution: ['child process handles and workspace paths in src/execution.ts and src/workspace.ts'],
    cache: [],
    authority: [],
    durableStateSubstitute: [],
  },
};

writeFileSync(path.join(root, 'docs/factory-composition-audit-pre-jev.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  baselineCommit,
  productionLoc: report.loc.production,
  testLoc: report.loc.tests,
  integrationLoc,
  glueRatio: report.integration.glueRatio,
  flowSha256: report.baseline.flowSha256,
}, null, 2));
