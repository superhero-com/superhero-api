const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortsIndexSchema } = require('./shorts-index-schema');
const { ShortsIndexService } = require('./shorts-index.service');

const artifact = version => ({ aci: [{ contract: { kind: 'contract_main', name: 'Shorts',
  functions: [{ name: version === 2 ? 'get_video' : 'get_short', arguments: [{ type: 'string' }], payable: false, stateful: false }],
  event: { variant: [{ PaidLike: version === 2 ? ['address','int','int','string'] : ['address','int','string'] },
    { Published: version === 2 ? ['address','int','string'] : ['address','string'] }, { Claimed: ['address','int'] }, { Withdrawn: ['string'] }] },
} }] });

test('predecessor accounting layout comes from each verified ABI, including mixed V2 and V1', () => {
  const v1 = artifact(1), v2 = artifact(2), earliest = artifact(1);
  earliest.aci[0].contract.event.variant.splice(1, 1);
  assert.equal(shortsIndexSchema(v1), 1); assert.equal(shortsIndexSchema(v2), 2); assert.equal(shortsIndexSchema(earliest), 1);
  const free = artifact(2); free.aci[0].contract.event.variant[0] = { Liked: ['address','int','string'] };
  assert.equal(shortsIndexSchema(free), 2);
  const chain = { release: { contract: 'ct_free', schemaVersion: 2 }, rewardContracts: () => [
    { contract: { $options: { address: 'ct_paid2' } }, artifact: v2 },
    { contract: { $options: { address: 'ct_paid1' } }, artifact: v1 },
  ] };
  const index = new ShortsIndexService({}, chain, {});
  assert.equal(index.schema('ct_free'), 2); assert.equal(index.schema('ct_paid2'), 2); assert.equal(index.schema('ct_paid1'), 1);
  assert.throws(() => index.schema('ct_unknown'), /Unbound/);
});

test('missing, duplicate, mutable and inconsistent accounting ABIs fail closed', () => {
  for (const change of [
    a => { delete a.aci; },
    a => a.aci.push(structuredClone(a.aci[0])),
    a => a.aci[0].contract.functions.push({ ...a.aci[0].contract.functions[0], name: 'get_short' }),
    a => a.aci[0].contract.functions.push(structuredClone(a.aci[0].contract.functions[0])),
    a => { a.aci[0].contract.functions[0].stateful = true; },
    a => { a.aci[0].contract.functions[0].payable = true; },
    a => { a.aci[0].contract.functions[0].arguments = []; },
    a => { a.aci[0].contract.event.variant[0].PaidLike = ['address','int','string']; },
    a => { a.aci[0].contract.event.variant[1].Published = ['address','string']; },
    a => a.aci[0].contract.event.variant.push({ PaidLike: ['address','int','int','string'] }),
    a => a.aci[0].contract.event.variant.push({ Liked: ['address','int','string'] }),
    a => { a.aci[0].contract.event.variant.splice(0, 1); },
    a => { delete a.aci[0].contract.event; },
  ]) { const value = artifact(2); change(value); assert.throws(() => shortsIndexSchema(value), /accounting/); }
});
