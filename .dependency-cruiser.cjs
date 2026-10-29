// dependency-cruiser (2026-10-28, Phase 0): import rules for OUR code (Ajay's in-transit + migrations not checked).
// Known existing violations are in .dependency-cruiser-known-violations.json (baseline); new ones fail `npm run deps`.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // entities point at each other on purpose (TypeORM relations load lazily: () => Entity)
    { name: 'no-circular', severity: 'error', comment: 'A import B import A: load-order bugs (undefined at start-up).', from: { pathNot: '^src/entities/' }, to: { circular: true } },
    { name: 'no-unresolvable', severity: 'error', comment: 'An import that does not resolve.', from: {}, to: { couldNotResolve: true } },
    { name: 'modules-not-to-routes', severity: 'error', comment: 'Business code must not depend on HTTP routes (routes call modules, never the other way).',
      from: { path: '^src/(modules|utils|config|constants|entities)/' }, to: { path: '^src/routes/' } },
    { name: 'app-not-to-scripts', severity: 'error', comment: 'The server must not import command-line scripts.',
      from: { path: '^src/', pathNot: '^src/scripts/' }, to: { path: '^src/scripts/' } },
    { name: 'no-dev-tools', severity: 'error', comment: 'src must not import dev-tools (git-ignored helpers).', from: { path: '^src/' }, to: { path: '^dev-tools/' } },
    { name: 'not-to-tests', severity: 'error', comment: 'App code must not import test files.',
      from: { pathNot: '(__tests__|^test/)' }, to: { path: '(__tests__|^test/)' } },
    { name: 'constants-are-leaves', severity: 'error', comment: 'constants/ only import other constants (no modules / DB).',
      from: { path: '^src/constants/' }, to: { path: '^src/(modules|routes|config|entities|utils)/' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(src/modules/intransit|src/migrations|src/scripts/intransit-|src/routes/intransit\.routes)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
