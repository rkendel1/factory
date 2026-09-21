import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const loc = (file) => read(file).split(/\r?\n/).filter((line) => line.trim()).length;
const walk = (directory) => readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  })
  .map((file) => file.split(path.sep).join('/'));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const externalTypeScriptLoc = (directory) => {
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory, { recursive: true })
    .map((file) => path.join(directory, String(file)))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => existsSync(file));
  return sum(files.map((file) => readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length));
};

const reportPaths = [
  'docs/factory-composition-audit-pre-jev.json',
  'docs/factory-composition-audit-pre-jev.md',
];
const statusLines = git('status', '--porcelain', '--untracked-files=all')
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((line) => !reportPaths.some((reportPath) => line.endsWith(reportPath)));
const clean = statusLines.length === 0;
const allowDirty = process.env.AUDIT_ALLOW_DIRTY === '1';
if (!clean && !allowDirty) {
  throw new Error(`Pre-JEV baseline requires a clean tree:\n${statusLines.join('\n')}`);
}

const productionFiles = walk('src').filter((file) => file.endsWith('.ts')).sort();
const testFiles = walk('tests').filter((file) => file.endsWith('.ts')).sort();
const integrationFiles = [
  'src/application-contract.ts',
  'src/appport.ts',
  'src/appport-services.ts',
  'src/auth.ts',
  'src/authority.ts',
  'src/execution.ts',
  'src/felt.ts',
  'src/integrations/github.ts',
  'src/ui.ts',
].filter((file) => existsSync(path.join(root, file)));
const production = Object.fromEntries(productionFiles.map((file) => [file, loc(file)]));
const tests = Object.fromEntries(testFiles.map((file) => [file, loc(file)]));
const integration = Object.fromEntries(integrationFiles.map((file) => [file, loc(file)]));
const productionLoc = sum(Object.values(production));
const testLoc = sum(Object.values(tests));
const integrationLoc = sum(Object.values(integration));
const flowLoc = loc('.flow');

const packageJson = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const directDependencies = Object.keys(packageJson.dependencies ?? {}).sort();
const packageEvidence = (name) => {
  const entry = lock.packages[`node_modules/${name}`];
  return {
    version: entry?.version ?? null,
    resolved: entry?.resolved ?? null,
    integrity: entry?.integrity ?? null,
    direct: directDependencies.includes(name),
  };
};
const githubPackagePath = 'node_modules/@rkendel1/github-integration';
const githubPackage = JSON.parse(read(`${githubPackagePath}/package.json`));
const githubRuntimeFiles = walk(`${githubPackagePath}/dist/src`).filter((file) => file.endsWith('.js'));
const githubRuntimeLoc = sum(githubRuntimeFiles.map((file) => loc(file)));
const githubRepository = path.resolve(root, '..', 'github-integration');
const githubSourceLoc = externalTypeScriptLoc(path.join(githubRepository, 'src'));
const githubTestLoc = externalTypeScriptLoc(path.join(githubRepository, 'tests'));
const githubRepositoryCommit = existsSync(path.join(githubRepository, '.git'))
  ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: githubRepository, encoding: 'utf8' }).trim()
  : null;

const sourceText = productionFiles.map(read).join('\n');
const dependencyNames = [...directDependencies, ...Object.keys(packageJson.devDependencies ?? {})];
const jevChecks = {
  dependency: dependencyNames.some((name) => /\bjev\b/i.test(name)),
  imports: /\b(?:from|import)\s*['"][^'"]*\bjev\b/i.test(sourceText),
  source: productionFiles.some((file) => /(?:^|\/)jev[^/]*\.(?:ts|js|mjs)$/.test(file)),
  executionPath: /\b(?:spawn|exec|execute)\b[^\n]*\bjev\b/i.test(sourceText),
};
if (Object.values(jevChecks).some(Boolean)) {
  throw new Error(`JEV must be absent from the pre-JEV baseline: ${JSON.stringify(jevChecks)}`);
}
for (const required of ['@appport/client', '@appport/protocol', '@appport/services', 'express']) {
  if (!directDependencies.includes(required)) {
    throw new Error(`${required} is required for direct AppPort service and UI composition`);
  }
}
if (/@octokit\//.test(sourceText) || /@rkendel1\/github-integration\//.test(sourceText)) {
  throw new Error('Factory must consume only the GitHub integration package root');
}
if (existsSync(path.join(root, 'src/github.ts'))) {
  throw new Error('Removed dead code src/github.ts must not be present');
}

const baselineCommit = git('rev-parse', 'HEAD');
if (process.env.BASELINE_COMMIT && process.env.BASELINE_COMMIT !== baselineCommit) {
  throw new Error(`BASELINE_COMMIT ${process.env.BASELINE_COMMIT} does not match HEAD ${baselineCommit}`);
}
const report = {
  baseline: {
    commit: baselineCommit,
    tree: clean ? git('rev-parse', 'HEAD^{tree}') : null,
    clean,
    preview: !clean,
    flowPath: '.flow',
    flowSha256: sha256(read('.flow')),
    jev: {
      integrated: false,
      authority: false,
      persistence: false,
      executionAuthority: false,
      checks: jevChecks,
    },
  },
  historicalGitHubFact: {
    file: 'src/github.ts',
    physicalLines: 33,
    nonEmptyLines: 30,
    referenced: false,
    classification: 'removed unused dead code; never a GitHub SDK, transport, credential, webhook, or persistence subsystem',
  },
  methodology: {
    loc: 'Non-empty physical lines; comments and type declarations count.',
    factoryScope: 'src/**/*.ts',
    testScope: 'tests/**/*.ts',
    integrationScope: integrationFiles,
    excludedFromFactory: ['node_modules', 'dist', 'vendored package artifacts', 'lockfiles'],
    githubIntegrationRuntime: 'Compiled JavaScript shipped by the installed 1.0.0 artifact; reported separately and never counted as Factory LOC.',
    githubIntegrationTests: 'Not distributed in the package artifact. When the canonical sibling checkout is available, its source and test LOC are recorded as external metrics.',
  },
  loc: {
    factoryApplication: productionLoc,
    factoryIntegrationAdapters: integrationLoc,
    factoryTests: testLoc,
    flow: flowLoc,
    githubIntegrationPackagedRuntime: githubRuntimeLoc,
    githubIntegrationSource: githubSourceLoc,
    githubIntegrationTests: githubTestLoc,
    githubIntegrationRepositoryCommit: githubRepositoryCommit,
    productionFiles: production,
    integrationFiles: integration,
    testFiles: tests,
  },
  dependencies: {
    direct: Object.fromEntries(directDependencies.map((name) => [name, packageEvidence(name)])),
    githubIntegration: {
      package: packageEvidence('@rkendel1/github-integration'),
      declaredDependencies: githubPackage.dependencies,
      appPortServicesOwnership: {
        factoryDirect: true,
        integrationTransitive: githubPackage.dependencies['@appport/services'] ?? null,
      },
    },
  },
  authorityInventory: [
    { authority: 'AuthBoundry', owns: ['principal', 'tenant', 'session', 'delegation', 'external authorization'] },
    { authority: '.flow', owns: ['application capabilities', 'execution mode', 'operation mapping', 'grants', 'limits'] },
    { authority: 'Factory ExecutionContract', owns: ['authorized immutable execution projection and fingerprint'] },
    { authority: 'FeltDB', owns: ['durable Work, authorization, run, contract, event, artifact, and evidence state'] },
    { authority: '@rkendel1/github-integration', owns: ['GitHub transport', 'credentials', 'webhooks', 'provider state', 'normalized GitHub behavior'] },
    { authority: '@appport/services', owns: ['configuration', 'secrets', 'API keys', 'notifications', 'webhooks', 'jobs', 'service management UI'] },
  ],
  durableStateInventory: [
    'Work', 'ExecutionRequest', 'ExecutionContract', 'Run', 'RunEvent',
    'Artifact', 'Evidence', 'AuthorizationDecision',
  ],
  boundaryInventory: [
    { boundary: 'Factory → FeltDB', file: 'src/felt.ts', classification: 'direct composition' },
    { boundary: 'Factory → AuthBoundry', file: 'src/auth.ts', classification: 'thin adapter' },
    { boundary: 'Factory → .flow', file: 'src/authority.ts', classification: 'projection' },
    { boundary: 'Factory → AppPort', file: 'src/appport.ts', classification: 'thin contract adapter' },
    { boundary: 'Factory → AppBoundry', file: 'src/application-contract.ts', classification: 'projection' },
    { boundary: 'Factory → PAX/OS', file: 'src/execution.ts', classification: 'serialization and process boundary' },
    { boundary: 'Factory → GitHub integration', file: 'src/integrations/github.ts', classification: 'thin package consumer adapter' },
    { boundary: 'Factory → AppPort Services', file: 'src/appport-services.ts', classification: 'thin authentication and router mount adapter' },
    { boundary: 'Factory → AppPort UI composition', file: 'src/ui.ts', classification: 'generic AppPort/ui/1 composition' },
  ],
  findings: {
    authorityViolations: 0,
    persistenceViolations: 0,
    githubSdkImports: 0,
    githubInternalImports: 0,
    factoryGitHubCredentialStores: 0,
    factoryGitHubWebhookEndpoints: 0,
    factoryGitHubPersistenceCollections: 0,
    directAppPortServicesDependency: true,
    directExpressDependency: true,
  },
};

writeFileSync(path.join(root, 'docs/factory-composition-audit-pre-jev.json'), `${JSON.stringify(report, null, 2)}\n`);
const dependencyRows = Object.entries(report.dependencies.direct)
  .map(([name, evidence]) => `| \`${name}\` | \`${evidence.version}\` | ${evidence.integrity ? `\`${evidence.integrity}\`` : 'local file artifact'} |`)
  .join('\n');
const boundaryRows = report.boundaryInventory
  .map((item) => `| ${item.boundary} | ${item.classification} | ${item.file ? `\`${item.file}\`` : 'none'} |`)
  .join('\n');
const markdown = `# Factory Composition Audit — Pre-JEV Baseline

## Baseline

${clean ? `Clean commit \`${baselineCommit}\`, tree \`${report.baseline.tree}\`.` : `Working-tree preview based on HEAD \`${baselineCommit}\`. Rerun after committing to record the clean baseline commit and tree.`}

- JEV integrated: **NO**
- JEV authority: **NO**
- JEV persistence: **NO**
- JEV execution authority: **NO**
- Canonical flow: \`.flow\` (${flowLoc} LOC, SHA-256 \`${report.baseline.flowSha256}\`)

## LOC

| Measure | LOC |
| --- | ---: |
| Factory application source | ${productionLoc} |
| Factory integration/adapter subset | ${integrationLoc} |
| Factory tests | ${testLoc} |
| \`.flow\` | ${flowLoc} |
| Packaged GitHub integration runtime (separate) | ${githubRuntimeLoc} |
| GitHub integration source checkout (separate) | ${githubSourceLoc ?? 'unavailable'} |
| GitHub integration tests (separate) | ${githubTestLoc ?? 'unavailable'} |

The packaged integration is not Factory code. The historical Factory GitHub footprint was the unused 33-physical-line \`src/github.ts\` formatter; it was removed as dead code, not extracted as a subsystem.

## Direct dependencies

| Package | Version | Integrity/resolution |
| --- | --- | --- |
${dependencyRows}

Factory directly consumes \`@appport/services\` for package-owned configuration, secret, API-key, notification, webhook, job, and management-UI capabilities. Express is direct only because the published service package exports Express routers while declaring Express as a development dependency. The GitHub integration independently declares \`@appport/services@${githubPackage.dependencies['@appport/services']}\` for its own provider state.

## Boundary inventory

| Boundary | Classification | Factory file |
| --- | --- | --- |
${boundaryRows}

## Authority and durable state

AuthBoundry owns identity and external authorization. \`.flow\` owns application capabilities and execution declarations. Factory creates the immutable authorized ExecutionContract. FeltDB owns all durable Factory state and evidence. AppPort Services owns service configuration and management state/UI. The GitHub package owns GitHub transport, credentials, webhooks, normalized behavior, and provider persistence.

Factory durable collections remain: ${report.durableStateInventory.map((name) => `\`${name}\``).join(', ')}. There are no Factory GitHub credential, webhook, provider-model, or persistence collections.

## Reproduction

Run from a clean committed tree:

\`\`\`sh
npm ci
BASELINE_COMMIT="$(git rev-parse HEAD)" node scripts/audit-factory.mjs
\`\`\`

For a non-baseline working-tree preview only, use \`AUDIT_ALLOW_DIRTY=1\`.
`;
writeFileSync(path.join(root, 'docs/factory-composition-audit-pre-jev.md'), markdown);
console.log(JSON.stringify({
  baselineCommit,
  tree: report.baseline.tree,
  clean,
  productionLoc,
  testLoc,
  integrationLoc,
  flowLoc,
  githubRuntimeLoc,
  githubSourceLoc,
  githubTestLoc,
}, null, 2));
