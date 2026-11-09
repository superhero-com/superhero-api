const { descriptor } = require('./hls-v3.json');

function originalRecord(id = descriptor.id, fields = {}) {
  const record = { ...structuredClone(descriptor), id, ...fields };
  record.derivatives.generation.job = id;
  return record;
}
module.exports = { originalRecord };
