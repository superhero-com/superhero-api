// Test wiring stays in CJS while product modules can come from a fresh build.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, sep } = require('node:path');
const root = join(__dirname, '../../..');
const compiled = process.env.SHORTS_TEST_COMPILED === '1';
exports.runtimeRequire = createRequire(join(root, compiled ? 'dist' : 'src', 'shorts/testing/fixture-runtime.cjs'));
exports.runtimeEvidence = () => {
  const paths = Object.keys(require.cache);
  const sourceModules = paths.filter(path => path.startsWith(join(root, 'src') + sep) && path.endsWith('.ts')).length;
  const compiledModules = paths.filter(path => path.startsWith(join(root, 'dist') + sep) && path.endsWith('.js')).length;
  if (compiled) {
    assert.equal(sourceModules, 0, 'compiled fixtures cannot load product TypeScript');
    assert.ok(compiledModules > 0, 'compiled fixtures must load the built product');
    assert.equal(process.execArgv.some(arg => arg.includes('ts-node')), false);
    assert.equal(typeof require.extensions['.ts'], 'undefined', 'compiled fixtures cannot install a TypeScript loader');
  }
  return { mode: compiled ? 'compiled' : 'typescript', sourceModules, compiledModules };
};
