// Return cleanup authority only after Docker confirms this fixture created it.
const assert = require('node:assert/strict');

exports.ownedEdgeName = name => {
  assert.match(name, /^sh-shorts-edge-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return name;
};

exports.startOwnedEdge = async (exec, name, args) => {
  exports.ownedEdgeName(name);
  // A name collision or failed/uncertain create grants no removal authority.
  await exec('docker', ['run', '--rm', '-d', '--pull=never', '--name', name, ...args], { timeout: 15000 });
  return () => exec('docker', ['rm', '-f', name], { timeout: 15000 });
};
