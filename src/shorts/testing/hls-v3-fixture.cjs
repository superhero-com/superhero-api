const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');

// A full sixty-second metadata graph; media hashes are opaque fixture identities.
// No large media buffers or external decoder are needed to exercise index bounds.
function fullAdaptivePackage() {
  const playlists = {}, files = [], videos = [
    ['v1080', 1080, 1920, 60, 3000000], ['v720', 720, 1280, 30, 750000],
    ['v480', 480, 852, 30, 375000], ['v360', 360, 640, 30, 125000], ['vrescue', 144, 256, 15, 20000],
  ];
  for (const [track, size] of [...videos.map(video => [video[0], video[4]]), ['amain', 48000], ['arescue', 12000]]) {
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
      ...(track.startsWith('v') ? ['#EXT-X-INDEPENDENT-SEGMENTS'] : []), `#EXT-X-MAP:URI="${track}-init.mp4"`,
      ...Array.from({ length: 30 }, (_, i) => `#EXTINF:2.000000,\n${track}-segment-${String(i).padStart(3, '0')}.m4s`), '#EXT-X-ENDLIST', ''].join('\n');
    playlists[track + '.m3u8'] = playlist;
    files.push({ name: track + '.m3u8', bytes: Buffer.byteLength(playlist), sha256: hash(playlist) },
      { name: track + '-init.mp4', bytes: 800, sha256: '4'.repeat(64) },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `${track}-segment-${String(i).padStart(3, '0')}.m4s`, bytes: size, sha256: '5'.repeat(64) })));
  }
  const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="amain",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="amain.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="arescue",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="1",URI="arescue.m3u8"',
    ...videos.map(([track, width, height, rate, size]) => {
      const audio = track === 'vrescue' ? 'arescue' : 'amain', bandwidth = 4 * (size + (audio === 'amain' ? 48000 : 12000));
      return `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth},CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=${width}x${height},FRAME-RATE=${rate.toFixed(3)},AUDIO="${audio}"\n${track}.m3u8`;
    }), ''].join('\n');
  files.unshift({ name: 'index.m3u8', bytes: Buffer.byteLength(playlist), sha256: hash(playlist) });
  return { version: 3, cid: 'bafy'+'f'.repeat(50), playlist, playlists, files };
}
module.exports = { fullAdaptivePackage };

// Small valid metadata graph for a prepared source. Media bytes remain test identities.
function packageForDescriptor(descriptor) {
  const { masterPlaylist } = require('../hls-protocol/hls-adaptive');
  const audio = descriptor.files.some(f => f.name === 'audio-main.m4a');
  const videos = descriptor.derivatives.videos.map(v => {
    const track = 'v' + v.name.slice(6,-4), rate = v.frameRate.split('/').map(Number);
    return { track, width:v.width, height:v.height, frameRate:Number((rate[0]/rate[1]).toFixed(3)),
      codec:'avc1.64002a',
      ...(audio ? { audio:track==='vrescue'?'arescue':'amain' } : {}),
      bandwidth:4000 + (audio ? (track==='vrescue'?48000:192000) : 0),
      averageBandwidth:4000 + (audio ? (track==='vrescue'?48000:192000) : 0) };
  });
  const tracks = [...videos.map(v=>[v.track,1000]),...(audio?[['amain',48000],['arescue',12000]]:[])];
  const playlists={}, files=[];
  for(const [track,bytes] of tracks){
    const playlist=['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-TARGETDURATION:2','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD',
      ...(track.startsWith('v')?['#EXT-X-INDEPENDENT-SEGMENTS']:[]),`#EXT-X-MAP:URI="${track}-init.mp4"`,
      `#EXTINF:2.000000,\n${track}-segment-000.m4s`,'#EXT-X-ENDLIST',''].join('\n');
    playlists[track+'.m3u8']=playlist;
    files.push({name:track+'.m3u8',bytes:Buffer.byteLength(playlist),sha256:hash(playlist)},
      {name:track+'-init.mp4',bytes:100,sha256:'a'.repeat(64)}, {name:track+'-segment-000.m4s',bytes,sha256:'b'.repeat(64)});
  }
  const playlist=masterPlaylist({videos,audio:audio?[{track:'amain',channels:2},{track:'arescue',channels:1}]:[]});
  files.unshift({name:'index.m3u8',bytes:Buffer.byteLength(playlist),sha256:hash(playlist)});
  return{version:3,cid:'bafy'+'g'.repeat(50),playlist,playlists,files};
}
module.exports.packageForDescriptor=packageForDescriptor;
