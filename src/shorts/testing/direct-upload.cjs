const assert = require('node:assert/strict');
const { createCipheriv, createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Test client for the public JSON control flow; media PUTs never use request(). */
exports.directUploadPart = async (request, api, id, index, bytes, token) => {
  const path = `/uploads/${id}/parts/${index}`;
  const prepared = await request(api, `${path}/prepare`, { sha256: hash(bytes) }, token);
  if (prepared.status !== 201) return prepared;
  const descriptor = prepared.body;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(descriptor.key, 'hex'), Buffer.from(descriptor.iv, 'hex'));
  cipher.setAAD(Buffer.from(descriptor.aad, 'base64'));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const body = Buffer.concat([Buffer.from('SHPRIV02'), Buffer.from(descriptor.iv, 'hex'), cipher.getAuthTag(), encrypted]);
  const permission = await request(api, `${path}/authorize`, { checksum: hash(body) }, token);
  if (permission.status !== 201) return permission;
  const result = await fetch(permission.body.url, { method: 'PUT', headers: permission.body.headers, body, redirect: 'error' });
  assert.ok(result.ok || result.status === 412, `Direct storage PUT failed (${result.status})`);
  await result.arrayBuffer();
  return request(api, `${path}/complete`, {}, token);
};
