const { fork } = require('node:child_process');
const { join } = require('node:path');
const { buildTx, encode, Encoding, Tag, unpackTx } = require('@aeternity/aepp-sdk');

function envelope(raw) {
  const signed = unpackTx(raw), tx = signed.encodedTx;
  return { signatures: signed.signatures.map(s => encode(s, Encoding.Signature)),
    tx: tx.tag === Tag.PayingForTx
      ? { type: 'PayingForTx', version: 1, payerId: tx.payerId, nonce: tx.nonce, fee: tx.fee,
        tx: envelope(buildTx({ tag: Tag.SignedTx, encodedTx: buildTx(tx.tx.encodedTx), signatures: tx.tx.signatures })) }
      : { ...tx, type: 'ContractCallTx', gas: tx.gasLimit } };
}
exports.signedEnvelope = envelope;

exports.runSponsor = (input, kill = false) => new Promise((resolve, reject) => {
  const child = fork(join(__dirname, '../shorts-like-sponsor-process.fixture.cjs'), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: process.env.SHORTS_TEST_COMPILED === '1' ? [] : process.execArgv,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', SHORTS_TEST_COMPILED: process.env.SHORTS_TEST_COMPILED || '0' },
  });
  // Capture only protocol metadata. SDK diagnostics can contain signed bytes.
  child.stdout.resume(); child.stderr.resume();
  let result;
  const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child fixture deadline')); }, 20000);
  child.on('error', error => { clearTimeout(timeout); reject(error); });
  child.on('message', message => {
    if (message.type === 'error') return;
    result = message;
    if (kill && message.type === 'boundary') child.kill('SIGKILL');
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    if ((kill && signal === 'SIGKILL' && result?.type === 'boundary')
      || (!kill && code === 0 && result?.type === 'done')) resolve(result);
    else reject(new Error('Child fixture did not reach its expected boundary'));
  });
  child.send(input);
});
