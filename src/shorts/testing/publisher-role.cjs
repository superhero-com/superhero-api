const { randomUUID } = require('node:crypto');

async function publisherRole(admin, { url, schema, scope, kind }) {
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !/^shorts_[a-z_]+_[a-f0-9]+$/.test(schema) || !['api', 'publisher'].includes(kind))
    throw new Error('Isolated publication database required');
  const role = `shpub_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.shorts_publication(text,jsonb) TO ${role}`);
  await admin.query(`INSERT INTO ${schema}.shorts_publisher_principals(role_oid,role_name,network,contract,kind)
    SELECT oid,rolname,$2,$3,$4 FROM pg_roles WHERE rolname=$1`, [role, scope.network, scope.contract, kind]);
  const endpoint = new URL(url); endpoint.username = role; endpoint.password = password;
  return { role, url: endpoint.href, async dispose() { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); } };
}
module.exports = { publisherRole };
