// Explicit opt-in; historical ae_uat reads only. No account, signer or broadcast.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { Node, Contract } = require('@aeternity/aepp-sdk');
const {
  SocialGraphReader,
} = require('../../src/plugins/social-graph/social-graph-reader');
const {
  SocialGraphNodeStream,
  FIRST_NODE_CURSOR,
} = require('../../src/plugins/social-graph/social-graph-node-stream');
const {
  SocialGraphLifecycle,
} = require('../../src/plugins/social-graph/social-graph-lifecycle');
const aci = require('../../src/plugins/social-graph/aci/SocialContract.aci.json');
const { evidencePath } = require('./evidence.cjs');
const fixturePath = process.env.SOCIAL_GRAPH_REMOTE_FIXTURE;
if (!fixturePath)
  throw new Error(
    'SOCIAL_GRAPH_REMOTE_FIXTURE must point to a private rehearsal fixture',
  );
const fixture = require(require('node:path').resolve(fixturePath));

(async () => {
  assert.equal(
    process.env.SOCIAL_GRAPH_REMOTE_READ_TEST,
    'true',
    'Explicit remote-read test opt-in required',
  );
  const node = new Node(fixture.nodeUrl);
  const status = await node.getStatus();
  assert.equal(status.networkId, 'ae_uat');
  async function rehearsalReader(address) {
    const reader = new SocialGraphReader(node, {
      network: 'ae_uat',
      contract: address,
    });
    const code = await node.getContractCode(address);
    assert.equal(
      createHash('sha256').update(code.bytecode).digest('hex'),
      fixture.bytecodeSha256,
    );
    // The production adapter MUST reject this 10-block test-only artifact.
    await assert.rejects(
      reader.verifyIdentity(),
      /Unreviewed social graph bytecode/,
    );
    // Deliberate test-only injection AFTER that negative identity assertion.
    reader.contract = Promise.resolve(
      await Contract.initialize({ onNode: node, address, aci }),
    );
    return reader;
  }
  const reader = await rehearsalReader(fixture.source);
  const stream = new SocialGraphNodeStream(node);
  const start = await stream.anchor(fixture.startHeight),
    end = await stream.anchor(fixture.endHeight);
  let cursor = FIRST_NODE_CURSOR,
    pages = 0,
    transactions = 0;
  const events = [],
    began = Date.now();
  do {
    const page = await stream.page(reader, start, end, cursor);
    pages++;
    transactions += page.transactions.length;
    events.push(
      ...page.transactions.flatMap((t) =>
        t.events.map((e) => ({ tx: t.hash, index: e.index, name: e.name })),
      ),
    );
    cursor = page.nextCursor;
    assert(pages <= 40, 'Historical fixture exceeded traversal bound');
  } while (cursor);
  const elapsedMs = Date.now() - began;
  assert.equal(transactions, 28);
  assert.equal(events.filter((e) => e.name === 'Followed').length, 2);
  const precheck = await reader.precheck(
    'follow',
    fixture.actor,
    fixture.owner,
  );
  assert.equal(precheck.reason, 'FROZEN');
  const sourcePolicy = await reader.policy();
  const destinationPolicy = await (
    await rehearsalReader(fixture.destination)
  ).policy();
  const migration = await new SocialGraphLifecycle(node).verify(
    destinationPolicy,
    {
      freezeTx: fixture.freezeTx,
      activationTx: fixture.activationTx,
    },
  );
  assert.equal(migration.proof.source, fixture.source);
  const checkedAt = new Date().toISOString();
  writeFileSync(
    evidencePath('social-graph-remote-delivery.json'),
    JSON.stringify(
      {
        checkedAt,
        network: status.networkId,
        nodeVersion: status.nodeVersion,
        protocols: status.protocols,
        testOnlyBytecode: true,
        productionIdentityRejectionVerified: true,
        productionIdentityBypassedInHarnessOnly: true,
        generation: { start, end, pages, transactions, events, elapsedMs },
        precheck,
        sourcePolicy,
        destinationPolicy,
        migration,
        limitations:
          'Historical test-only build; transport/policy/receipt evidence, not lifecycle qualification of production bytecode or sustained production throughput.',
      },
      null,
      2,
    ) + '\n',
  );
  let receiptReads = 0;
  const readReceipt = node.getTransactionInfoByHash.bind(node);
  node.getTransactionInfoByHash = async (...args) => {
    receiptReads++;
    return readReceipt(...args);
  };
  const wrapped = [];
  for (const expected of fixture.wrappedTransactions) {
    const tx = await node.getTransactionByHash(expected.hash);
    assert.equal(tx.tx.type, expected.type);
    const before = receiptReads;
    let logsExamined = 0;
    await stream.transactionEvents(
      {
        decodeLogs: async (logs) => {
          logsExamined += logs.length;
          return [];
        },
      },
      tx,
    );
    const innerType = tx.tx.tx?.tx?.type ?? tx.tx.tx?.type ?? null;
    const receiptRequested = receiptReads > before;
    assert.equal(
      receiptRequested,
      !(tx.tx.type === 'PayingForTx' && innerType === 'SpendTx'),
    );
    wrapped.push({
      hash: tx.hash,
      height: tx.blockHeight,
      nodeType: tx.tx.type,
      innerType,
      receiptRequested,
      logsExamined,
    });
  }
  writeFileSync(
    evidencePath('social-graph-wrapped-receipts.json'),
    JSON.stringify(
      {
        network: 'ae_uat',
        checkedAt: new Date().toISOString(),
        results: wrapped,
        limitations:
          'Existing public transaction transport only. These unrelated fixtures contain no selected-graph mutations; mutation handling is also tested with synthetic receipts.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      pages,
      transactions,
      events: events.length,
      elapsedMs,
      precheck: precheck.reason,
      migration,
      wrapped: wrapped.length,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
