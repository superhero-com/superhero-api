const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsIndexService } = require('./shorts-index.service');

test('the index reads events for the active contract only', () => {
  const contract = { $options: { address: 'ct_active' } };
  const release = { contract: contract.$options.address, schemaVersion: 2 };
  const index = new ShortsIndexService({}, { contract, release }, {});
  assert.deepEqual(index.contracts(), [contract]);
  assert.equal(index.schema('ct_active'), 2);
  assert.throws(() => index.schema('ct_other'), /Unbound/);
});
