// Real public HTTP clients, with no browser, fabricated receipts or media keys.
// Establish which automation is rejected and which still resembles a viewer.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');

exports.assembledMeasurements = async (f, { edgeBase, get }) => {
  const { owner, scope, id, b, c, request, creatorToken, pause } = f;
  const metrics = async () => {
    const replicas = [];
    for (const api of [b, c]) {
      const response = await request(api, '/operator/measurements', undefined, f.operatorToken);
      assert.equal(response.status, 200); assert.equal(response.body.scope, 'process');
      replicas.push(response.body);
    }
    assert.notEqual(replicas[0].instance, replicas[1].instance);
    return Object.fromEntries(Object.keys(replicas[0].cumulative).map(key => [key,
      replicas.reduce((sum, replica) => sum + replica.cumulative[key], 0)]));
  };
  const snapshot = async () => {
    const [rows] = await owner.query(`SELECT
      (SELECT count(*)::integer FROM shorts_measurement_plays WHERE network=$1 AND contract=$2) AS plays,
      (SELECT count(*)::integer FROM shorts_measurement_viewers WHERE network=$1 AND contract=$2) AS viewers`,
    [scope.network, scope.contract]);
    const report = await request(b, '/performance?days=7', undefined, creatorToken);
    assert.equal(report.status, 200);
    const { earned, paidLikes, series, entries } = report.body.finance;
    return { ...rows, views: report.body.summary.views, finance: { earned, paidLikes, series, entries } };
  };
  const mint = async () => {
    const event = { id: randomUUID(), session: randomUUID(), seconds: 60, source: 'shared' };
    const issued = await get(edgeBase + `/videos/${id}/playback`, {
      method: 'POST', headers: { 'X-Playback-Viewer': createHash('sha256').update(event.session).digest('hex') },
    });
    assert.equal(issued.status, 200);
    const session = JSON.parse(issued.text), manifest = new URL(session.manifest, edgeBase);
    return { event, manifest, token: manifest.searchParams.get('token') };
  };
  const proof = async bot => {
    const response = await get(edgeBase + `/videos/${id}/measurement`, { headers: { 'X-Playback-Token': bot.token } });
    assert.equal(response.status, 200); return JSON.parse(response.text).proof;
  };
  assert.equal((await request(b, '/operator/measurements')).status, 401);
  assert.equal((await request(c, '/operator/measurements', undefined, creatorToken)).status, 403);
  const before = await snapshot(), beforeMetrics = await metrics();
  for (let i = 0; i < 20; i++) {
    const response = await request(i % 2 ? b : c, `/${id}/playback`, {
      id: randomUUID(), session: randomUUID(), seconds: 60, source: 'shared',
    });
    assert.equal(response.status, 401);
  }
  for (let i = 0; i < 8; i++) {
    const bot = await mint();
    const response = await request(i % 2 ? b : c, `/${id}/playback`, { ...bot.event, proof: await proof(bot) });
    assert.equal(response.status, 201); assert.equal(response.body.accepted, true);
  }
  assert.deepEqual(await snapshot(), before, 'proof-only bots cannot allocate persistent viewer/play records');
  const emptyMetrics = await metrics();
  assert.equal(emptyMetrics.invalid_evidence - beforeMetrics.invalid_evidence, 20);
  assert.equal(emptyMetrics.ignored_below_threshold - beforeMetrics.ignored_below_threshold, 8);

  const bots = [];
  for (let i = 0; i < 3; i++) {
    const bot = await mint(); bots.push(bot);
    const manifest = await get(bot.manifest); assert.equal(manifest.status, 200);
    for (const line of manifest.text.split('\n').filter(line => line.startsWith('segment-')))
      assert.equal((await get(new URL(line, bot.manifest))).status, 200);
  }
  await pause(2200);
  for (const [i, bot] of bots.entries()) {
    const evidence = await proof(bot);
    const response = await request(i % 2 ? b : c, `/${id}/playback`, { ...bot.event, seconds: 2, proof: evidence });
    assert.equal(response.status, 201); assert.equal(response.body.accepted, true);
    assert.equal((await request(b, `/${id}/playback`, { ...bot.event, seconds: 2, proof: evidence })).body.views, response.body.views);
    const newEvent = await request(c, `/${id}/playback`, { ...bot.event, id: randomUUID(), seconds: 2, proof: evidence });
    assert.equal(newEvent.status, 201); assert.equal(newEvent.body.accepted, false);
    assert.equal(newEvent.body.views, response.body.views);
  }
  const after = await snapshot();
  assert.equal(after.views, before.views + 3, 'segment-fetching bots with rotated browser IDs still resemble three viewers');
  assert.equal(after.plays, before.plays + 3); assert.equal(after.viewers, before.viewers + 3);
  assert.deepEqual(after.finance, before.finance, 'estimated audience metrics never create earnings or paid Likes');
  for (const bot of bots) {
    assert.equal((await request(c, '/analytics/forget', { session: bot.event.session })).status, 201);
    const late = await request(b, `/${id}/playback`, { ...bot.event, seconds: 2, proof: await proof(bot) });
    assert.equal(late.status, 201); assert.equal(late.body.accepted, false);
  }
  const forgotten = await snapshot();
  assert.equal(forgotten.views, before.views); assert.equal(forgotten.plays, before.plays);
  assert.deepEqual(forgotten.finance, before.finance);
  const observed = await metrics();
  assert.equal(observed.accepted_update - beforeMetrics.accepted_update, 6, 'repeat heartbeats count as updates, not new views');
  assert.equal(observed.rejected_duplicate_or_forgotten - beforeMetrics.rejected_duplicate_or_forgotten, 6);
  assert.equal(observed.server_error - beforeMetrics.server_error, 0);
  assert.equal(observed.service_unavailable - beforeMetrics.service_unavailable, 0);
};
