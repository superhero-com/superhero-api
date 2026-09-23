const { mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, relative, isAbsolute, join } = require('node:path');
const repository = resolve(__dirname, '../..');
function evidencePath(name) {
  const directory = resolve(
    process.env.SOCIAL_GRAPH_EVIDENCE_DIR ||
      join(tmpdir(), 'superhero-social-graph-evidence'),
  );
  const inside = relative(repository, directory);
  if (
    !inside ||
    (!inside.startsWith('..' + require('node:path').sep) && !isAbsolute(inside))
  )
    throw new Error('Private evidence must be stored outside the repository');
  if (name !== require('node:path').basename(name))
    throw new Error('Invalid evidence name');
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
}
module.exports = { evidencePath };
