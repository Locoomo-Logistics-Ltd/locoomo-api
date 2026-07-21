/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment:
        "Cross-module calls must go through the target module's public surface " +
        '(its .module.ts or barrel export) — never into another module\'s domain/ ' +
        'or infrastructure/ directly. See CLAUDE.md architecture decision #1.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(domain|infrastructure)/',
        pathNot: '^src/modules/$1/',
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
