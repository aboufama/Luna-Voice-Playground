import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../public/voice-session.js';

class Emitter {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, value = {}) { this.listeners.get(type)?.forEach(callback => callback(value)); }
}
class Track { enabled = true; stopped = 0; stop() { this.stopped++; } }
class Stream {
  constructor(tracks = [new Track()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class Channel extends Emitter {
  readyState = 'open'; sent = []; closed = false;
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 'closed'; this.emit('close'); }
  event(data) { this.emit('message', { data: JSON.stringify(data) }); }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup({ microphone = new Stream(), getUserMedia, fetch: fetchOverride, autoplay = true, iceComplete = true } = {}) {
  const peers = []; const requests = []; const states = []; const errors = []; const transcripts = []; const metrics = []; const blocked = []; const levels = [];
  class Peer extends Emitter {
    iceGatheringState = iceComplete ? 'complete' : 'gathering'; connectionState = 'new'; added = []; remoteDescriptions = [];
    constructor() { super(); peers.push(this); this.channel = new Channel(); }
    addTrack(track, stream) { this.added.push({ track, stream }); }
    createDataChannel(label) { this.label = label; return this.channel; }
    async createOffer() { this.offerAfterChannel = this.label === 'oai-events'; return { type: 'offer', sdp: 'local-sdp' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.remoteDescriptions.push(answer); }
    close() { this.closed = true; }
  }
  const audio = { srcObject: null, play: async () => { if (!autoplay) throw new Error('blocked'); }, pause() {} };
  const document = new Emitter(); document.visibilityState = 'visible';
  const window = new Emitter();
  const voice = new VoiceSession({
    audioElement: audio, onState: (state, detail) => states.push({ state, detail }),
    onError: value => errors.push(value), onTranscript: value => transcripts.push(value),
    onMetrics: value => metrics.push(value), onPlaybackBlocked: value => blocked.push(value),
    onLevel: value => levels.push(value),
  }, {
    mediaDevices: { getUserMedia: getUserMedia || (async () => microphone) },
    PeerConnection: Peer, MediaStream: Stream,
    fetch: async (...args) => {
      requests.push(args);
      return fetchOverride ? fetchOverride(...args) : { ok: true, status: 201, json: async () => ({ session: { id: 'live_test' }, transport: { sdp: 'remote-sdp' } }) };
    },
    now: () => 200,
    document, window, closeTimeoutMs: 5, connectTimeoutMs: 1_000,
  });
  async function ready() {
    const started = voice.start();
    await tick();
    peers.at(-1).channel.event({ type: 'session.started' });
    assert.equal(await started, true);
    return peers.at(-1);
  }
  async function finish(seconds = 30) {
    const channel = peers.at(-1)?.channel;
    const stopped = voice.stop();
    channel?.event({ type: 'session.closed', usage: { seconds } });
    await stopped;
  }
  return { voice, ready, finish, peers, microphone, audio, requests, states, errors, transcripts, metrics, blocked, levels, document, window };
}

test('WebRTC starts via HTTP SDP, waits for session.started, and sends no session.start or PCM events', async () => {
  const h = setup();
  const ready = h.voice.start();
  await tick();
  assert.equal(h.voice.state, 'connecting');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], '/api/session');
  assert.deepEqual(JSON.parse(h.requests[0][1].body), { sdp: 'local-sdp' });
  const peer = h.peers[0];
  assert.equal(peer.offerAfterChannel, true);
  assert.deepEqual(peer.remoteDescriptions, [{ type: 'answer', sdp: 'remote-sdp' }]);
  assert.deepEqual(peer.channel.sent, []);
  peer.channel.event({ type: 'session.started' });
  assert.equal(await ready, true);
  assert.equal(h.voice.state, 'listening');
  assert.equal(h.metrics.at(-1).startupMs, 0);
  await h.finish();
});

test('stopping while permission is pending releases a late microphone and never calls the provider', async () => {
  const permission = deferred();
  const h = setup({ getUserMedia: () => permission.promise });
  const started = h.voice.start();
  await h.voice.stop();
  assert.equal(await started, false);
  permission.resolve(h.microphone);
  await tick();
  assert.equal(h.microphone.getTracks()[0].stopped, 1);
  assert.equal(h.peers.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.voice.state, 'idle');
});

test('stop aborts a pending session request and ignores a late answer', async () => {
  const response = deferred();
  const h = setup({ fetch: () => response.promise });
  const started = h.voice.start();
  await tick();
  const signal = h.requests[0][1].signal;
  await h.voice.stop();
  assert.equal(await started, false);
  assert.equal(signal.aborted, true);
  assert.equal(h.peers[0].closed, true);
  response.resolve({ ok: true, json: async () => ({ transport: { sdp: 'late' } }) });
  await tick();
  assert.equal(h.peers[0].remoteDescriptions.length, 0);
  assert.equal(h.voice.state, 'idle');
});

test('stop aborts ICE gathering without issuing a session request', async () => {
  const h = setup({ iceComplete: false });
  const started = h.voice.start();
  await tick();
  await h.voice.stop();
  assert.equal(await started, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.peers[0].listeners.get('icegatheringstatechange').size, 0);
});

test('fresh restart clears transcripts and metrics; stale events cannot affect new session', async () => {
  const h = setup();
  const old = await h.ready();
  old.channel.event({ type: 'session.input_transcript.delta', delta: 'old context' });
  old.channel.event({ type: 'session.usage.updated', usage: { seconds: 90 } });
  await h.finish(90);
  const current = await h.ready();
  assert.deepEqual(h.transcripts.at(-1), []);
  assert.equal(h.metrics.at(-1).providerSeconds, null);
  old.channel.event({ type: 'error', error: { message: 'old secret error' } });
  old.channel.event({ type: 'session.closed', usage: { seconds: 500 } });
  old.channel.event({ type: 'session.output_transcript.delta', delta: 'stale' });
  const staleTrack = new Track();
  old.emit('track', { track: staleTrack });
  assert.equal(staleTrack.stopped, 1);
  assert.equal(h.voice.state, 'listening');
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.transcripts.at(-1), []);
  current.channel.event({ type: 'session.input_transcript.delta', delta: 'new question' });
  assert.equal(h.transcripts.at(-1)[0].text, 'new question');
  await h.finish();
});

test('mute toggles microphone tracks without ending or replacing the session', async () => {
  const h = setup();
  const peer = await h.ready();
  assert.equal(h.voice.mute(true), true);
  assert.equal(h.microphone.getTracks()[0].enabled, false);
  assert.equal(h.voice.mute(false), false);
  assert.equal(h.microphone.getTracks()[0].enabled, true);
  assert.equal(peer.closed, undefined);
  assert.equal(peer.channel.sent.length, 0);
  await h.finish();
});

test('graceful close stops microphone immediately and awaits final cumulative usage', async () => {
  const h = setup();
  const peer = await h.ready();
  peer.channel.event({ type: 'session.usage.updated', usage: { seconds: 20 } });
  peer.channel.event({ type: 'session.usage.updated', usage: { seconds: 20 } });
  const stopped = h.voice.stop();
  assert.equal(h.voice.state, 'closing');
  assert.equal(h.microphone.getTracks()[0].stopped, 1);
  assert.equal(peer.closed, undefined);
  assert.deepEqual(peer.channel.sent, [{ type: 'session.close' }]);
  peer.channel.event({ type: 'session.closed', usage: { seconds: 60 } });
  await stopped;
  assert.equal(peer.closed, true);
  assert.equal(h.metrics.at(-1).providerSeconds, 60);
  assert.equal(h.metrics.at(-1).estimatedVoiceUsd, 0.05);
  assert.equal(h.metrics.at(-1).usageFinal, true);
  assert.equal(h.voice.state, 'idle');
});

test('close timeout cleans up and preserves explicitly unconfirmed usage', async () => {
  const h = setup();
  const peer = await h.ready();
  await h.voice.stop();
  assert.equal(peer.closed, true);
  assert.equal(h.metrics.at(-1).usageFinal, false);
  assert.equal(h.states.at(-1).detail.usageFinal, false);
  assert.equal(h.voice.state, 'idle');
});

test('HTTP rate limit versus quota errors are clear and never echo raw provider secrets', async () => {
  for (const [code, phrase] of [['rate_limited', 'rate limiting'], ['quota_exceeded', 'no available API quota']]) {
    const h = setup({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ code, error: 'SECRET detail' }) }) });
    assert.equal(await h.voice.start(), false);
    assert.match(h.errors[0], new RegExp(phrase));
    assert.doesNotMatch(h.errors[0], /SECRET/);
    assert.equal(h.microphone.getTracks()[0].stopped, 1);
    assert.equal(h.peers[0].closed, true);
  }
});

test('microphone denial and provider errors release resources and resolve pending start', async () => {
  const denial = setup({ getUserMedia: async () => { throw Object.assign(new Error('private detail'), { name: 'NotAllowedError' }); } });
  assert.equal(await denial.voice.start(), false);
  assert.match(denial.errors[0], /Microphone access was blocked/);
  assert.equal(denial.requests.length, 0);
  const h = setup();
  const peer = await h.ready();
  peer.channel.event({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'private account data' } });
  assert.equal(h.voice.state, 'error');
  assert.equal(peer.closed, true);
  assert.match(h.errors[0], /rate limiting/);
  assert.doesNotMatch(h.errors[0], /private/);
});

test('transcripts accumulate by role, deduplicate events, and stay bounded in memory', async () => {
  const h = setup();
  const peer = await h.ready();
  const event = { type: 'session.input_transcript.delta', event_id: 'first', delta: 'Hello', start_ms: 0, end_ms: 100 };
  peer.channel.event(event); peer.channel.event(event);
  peer.channel.event({ type: event.type, delta: ' there', start_ms: 100, end_ms: 200 });
  peer.channel.event({ type: 'session.output_transcript.delta', delta: 'Hi!', start_ms: 400, end_ms: 500 });
  assert.deepEqual(h.transcripts.at(-1).map(({ role, text }) => ({ role, text })), [{ role: 'user', text: 'Hello there' }, { role: 'assistant', text: 'Hi!' }]);
  for (let i = 0; i < 70; i++) peer.channel.event({ type: event.type, delta: 'x'.repeat(1_000), start_ms: i * 4_000 + 10_000, end_ms: i * 4_000 + 11_000 });
  assert.ok(h.transcripts.at(-1).length <= 50);
  assert.ok(h.transcripts.at(-1).reduce((n, row) => n + row.text.length, 0) <= 24_000);
  await h.finish();
});

test('blocked audio playback is recoverable without creating another session', async () => {
  const h = setup({ autoplay: false });
  const peer = await h.ready();
  const track = new Track();
  const stream = new Stream([track]);
  peer.emit('track', { track, streams: [stream] });
  await tick();
  assert.equal(h.audio.srcObject, stream);
  assert.equal(h.blocked.at(-1), true);
  h.audio.play = async () => {};
  assert.equal(await h.voice.enableAudio(), true);
  assert.equal(h.blocked.at(-1), false);
  assert.equal(h.requests.length, 1);
  await h.finish();
  assert.equal(h.audio.srcObject, null);
  assert.equal(track.stopped, 1);
});

test('hidden page releases its microphone immediately and disposes listeners', async () => {
  const h = setup();
  const peer = await h.ready();
  h.document.visibilityState = 'hidden';
  h.document.emit('visibilitychange');
  assert.equal(h.microphone.getTracks()[0].stopped, 1);
  assert.equal(h.voice.state, 'closing');
  peer.channel.event({ type: 'session.closed', usage: { seconds: 4 } });
  await h.voice.dispose();
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  assert.equal(h.window.listeners.get('pagehide').size, 0);
  assert.equal(await h.voice.start(), false);
  assert.equal(h.metrics.at(-1).providerSeconds, 4);
  assert.equal(h.metrics.at(-1).estimatedVoiceUsd, 15 * 0.05 / 60);
});

test('dispose while a restart waits for graceful close cannot reopen the microphone', async () => {
  const h = setup();
  const peer = await h.ready();
  const stopped = h.voice.stop();
  const restarted = h.voice.start();
  const disposed = h.voice.dispose();
  peer.channel.event({ type: 'session.closed', usage: { seconds: 15 } });
  await Promise.all([stopped, disposed]);
  assert.equal(await restarted, false);
  assert.equal(h.peers.length, 1);
  assert.equal(h.voice.state, 'idle');
});

test('late permission from an old attempt cannot replace or close a newer live session', async () => {
  const oldPermission = deferred();
  const newMicrophone = new Stream();
  let attempts = 0;
  const h = setup({ getUserMedia: () => ++attempts === 1 ? oldPermission.promise : Promise.resolve(newMicrophone) });
  const oldStart = h.voice.start();
  await h.voice.stop();
  assert.equal(await oldStart, false);
  await h.ready();
  oldPermission.resolve(h.microphone);
  await tick();
  assert.equal(h.microphone.getTracks()[0].stopped, 1);
  assert.equal(newMicrophone.getTracks()[0].stopped, 0);
  assert.equal(h.voice.state, 'listening');
  assert.equal(h.requests.length, 1);
  await h.finish();
});

test('peer connection failure releases both media directions and reports a recoverable error', async () => {
  const h = setup();
  const peer = await h.ready();
  const remote = new Track();
  peer.emit('track', { track: remote });
  peer.connectionState = 'failed';
  peer.emit('connectionstatechange');
  assert.equal(h.voice.state, 'error');
  assert.equal(peer.closed, true);
  assert.equal(h.microphone.getTracks()[0].stopped, 1);
  assert.equal(remote.stopped, 1);
  assert.equal(h.audio.srcObject, null);
  assert.match(h.errors.at(-1), /connection was lost/);
});

test('timestamped quick speaker changes keep a new student answer after the assistant question', async () => {
  const h = setup();
  const peer = await h.ready();
  peer.channel.event({ type: 'session.input_transcript.delta', delta: 'Hi', start_ms: 0, end_ms: 1_000 });
  peer.channel.event({ type: 'session.output_transcript.delta', delta: 'Hello', start_ms: 1_100, end_ms: 1_600 });
  peer.channel.event({ type: 'session.input_transcript.delta', delta: 'Yes', start_ms: 1_700, end_ms: 1_900 });
  peer.channel.event({ type: 'session.input_transcript.delta', delta: ', please.', start_ms: 1_900, end_ms: 2_100 });
  assert.deepEqual(h.transcripts.at(-1).map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: 'Hello' },
    { role: 'user', text: 'Yes, please.' },
  ]);
  assert.equal(h.transcripts.at(-1).at(-1).text, 'Yes, please.');
  await h.finish();
});

test('a page restored after pagehide can start a fresh conversation', async () => {
  const streams = [new Stream(), new Stream()];
  let microphoneCalls = 0;
  const h = setup({ getUserMedia: async () => streams[microphoneCalls++] });
  const oldPeer = await h.ready();
  oldPeer.channel.event({ type: 'session.input_transcript.delta', delta: 'Before navigation' });
  h.window.emit('pagehide', { persisted: true });
  assert.equal(streams[0].getTracks()[0].stopped, 1);
  assert.equal(h.voice.state, 'closing');
  oldPeer.channel.event({ type: 'session.closed', usage: { seconds: 30 } });
  assert.equal(h.voice.state, 'idle');
  const newPeer = await h.ready();
  assert.notEqual(newPeer, oldPeer);
  assert.equal(microphoneCalls, 2);
  assert.equal(streams[1].getTracks()[0].stopped, 0);
  assert.deepEqual(h.transcripts.at(-1), []);
  assert.equal(h.voice.state, 'listening');
  await h.finish();
});

test('native timer defaults retain the browser global receiver', async () => {
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const originals = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const called = new Set();
  let h;
  try {
    for (const name of names) {
      globalThis[name] = function (...args) {
        assert.equal(this, globalThis, `${name} must use the window/global receiver`);
        called.add(name);
        return originals[name].apply(globalThis, args);
      };
    }
    h = setup();
  } finally {
    for (const name of names) globalThis[name] = originals[name];
  }
  await h.ready();
  const interval = h.voice.deps.setInterval(() => {}, 1_000);
  h.voice.deps.clearInterval(interval);
  await h.finish();
  assert.deepEqual([...called].sort(), [...names].sort());
});

test('audio levels fall back to interval RMS from WebRTC cumulative energy counters', async () => {
  const h = setup();
  const peer = await h.ready();
  let records;
  peer.getStats = async () => new Map(records.map(stat => [stat.id, stat]));
  const sample = async (inputEnergy, inputDuration, outputEnergy, outputDuration) => {
    records = [
      { id: 'mic', type: 'media-source', kind: 'audio', totalAudioEnergy: inputEnergy, totalSamplesDuration: inputDuration },
      { id: 'speaker', type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: outputEnergy, totalSamplesDuration: outputDuration },
    ];
    await h.voice._levels(h.voice._active);
    return h.levels.at(-1);
  };
  assert.deepEqual(await sample(1, 10, 2, 10), { input: 0, output: 0 });
  const levels = await sample(1.09, 11, 2.25, 11);
  assert.ok(Math.abs(levels.input - 0.3) < 1e-10);
  assert.ok(Math.abs(levels.output - 0.5) < 1e-10);
  h.voice.mute(true);
  assert.deepEqual(await sample(1.18, 12, 2.5, 12), { input: 0, output: 0.5 });
  await h.finish();
});

test('audio energy fallback handles resets, unchanged clocks, missing and invalid stats without NaN', async () => {
  const h = setup();
  const peer = await h.ready();
  let record = {};
  peer.getStats = async () => new Map([['speaker', { id: 'speaker', type: 'inbound-rtp', kind: 'audio', ...record }]]);
  const sample = async (energy, duration, extra = {}) => {
    record = { totalAudioEnergy: energy, totalSamplesDuration: duration, ...extra };
    await h.voice._levels(h.voice._active);
    const levels = h.levels.at(-1);
    assert.equal(Number.isFinite(levels.input), true);
    assert.equal(Number.isFinite(levels.output), true);
    return levels.output;
  };
  assert.equal(await sample(4, 20), 0);
  assert.equal(await sample(1, 21), 0, 'decreasing energy resets baseline');
  assert.equal(await sample(1.25, 22), 0.5);
  assert.equal(await sample(1.5, 10), 0, 'decreasing duration resets baseline');
  assert.equal(await sample(1.75, 10), 0, 'unchanged duration cannot produce RMS');
  assert.equal(await sample(2, 11), 0.5);
  assert.equal(await sample(NaN, 12), 0);
  assert.equal(await sample(3, 13), 0, 'invalid prior measurement requires fresh baseline');
  assert.equal(await sample(3.25, Infinity), 0);
  assert.equal(await sample(-1, 15), 0);
  assert.equal(await sample(undefined, undefined), 0);
  assert.equal(await sample(5, 18), 0);
  assert.equal(await sample(5.25, 19, { audioLevel: 0 }), 0, 'reported silence overrides estimated RMS');
  assert.equal(await sample(undefined, undefined, { audioLevel: 0.7 }), 0.7);
  await h.finish();
});
