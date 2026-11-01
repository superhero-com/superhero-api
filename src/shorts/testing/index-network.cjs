// Shared SQL fixture: real persistent binding, controlled node identity.
const { ShortsIndexNetwork1791763228000 } = require('../../migrations/1791763228000-ShortsIndexNetwork');
const { ShortsIndexNetworkService } = require('../shorts-index-network.service');

exports.indexNetworkFixture = async (db, chain) => {
  await db.query('CREATE TABLE IF NOT EXISTS key_blocks(height integer PRIMARY KEY,hash text NOT NULL)');
  if (!(await db.query("SELECT to_regclass('shorts_index_network') AS name"))[0].name)
    await new ShortsIndexNetwork1791763228000().up({ query: (...args) => db.query(...args) });
  const host = 'http://127.0.0.1:12345';
  chain.release.node ??= host;
  chain.sdk ??= { api: { $host: chain.release.node, getStatus: async () => ({ networkId: chain.release.network }) } };
  chain.readNode ??= async task => task();
  const network = new ShortsIndexNetworkService(db, chain);
  await network.ensure();
  return network;
};
