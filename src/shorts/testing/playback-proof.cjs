const { createHmac, createHash, randomBytes } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
exports.playbackProof = (key, short, session, contract, changes = {}) => {
  const nonce = randomBytes(16).toString('hex'), now = Date.now();
  const value = { v: 1, id: short.id, cid: short.cid, network: 'ae_uat', contract, nonce,
    viewer: digest(`shorts-viewer:v1\n${nonce}\n${digest(session)}`),
    startedAt: now - 10000, issuedAt: now, expiresAt: now + 100000, admittedMs: 10000, ...changes };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `m1.${payload}.${createHmac('sha256', key).update(`shorts-measurement:v1\0${payload}`).digest('base64url')}`;
};
