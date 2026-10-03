import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoiceSession, captionTail } from '../src/playground-voice.js';

class Emitter {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { this.listeners.get(type)?.forEach(fn => fn()); }
}
function fixture(extra = {}) {
  const voices = [], states = [], levels = [], captions = [], errors = [], presences = [], metrics = [], events = [];
  let closes = 0;
  class MockVoice {
    constructor(hooks) { this.hooks = hooks; this.starts = []; this.stops = []; this.disposals = 0; voices.push(this); }
    async start(...args) { this.starts.push(args); this.hooks.onState('connecting'); this.hooks.onState('listening'); return true; }
    async stop(reason) { this.stops.push(reason); this.hooks.onState('closing'); this.hooks.onState('idle', { reason }); }
    async dispose() { this.disposals++; }
    async enableAudio() { this.hooks.onPlaybackBlocked(false); return true; }
  }
  const document = new Emitter(), window = new Emitter();
  const session = new LiveVoiceSession({
    onState: state => states.push(state), onLevel: value => levels.push(value),
    onCaption: value => captions.push(value), onError: value => errors.push(value),
    onPresence: value => presences.push(value), onMetrics: value => metrics.push(value), onEvent: value => events.push(value),
    onClose: () => { closes++; },
  }, { loadVoiceSession: async () => MockVoice, createAudio: () => new Emitter(), AudioContext: null, document, window, ...extra });
  return { session, voices, states, levels, captions, errors, presences, metrics, events, document, window, get closes() { return closes; } };
}

test('old study data and UI update methods never enter the fresh voice session', async () => {
  const h = fixture();
  const privateTest = { title: 'PRIVATE COURSE', materials: [{ text: 'PRIVATE SOURCE' }], whiteboard: { title: 'PRIVATE BOARD' }, mastery: { score: 80 } };
  assert.equal(await h.session.start(privateTest), true);
  const voice = h.voices[0];
  assert.deepEqual(voice.starts, [[]]);
  h.session.updateMaterials(privateTest.materials);
  h.session.updateIndexStatus('ready', 'private-source');
  h.session.setCanvasVisible(true);
  h.session.selectCanvas(privateTest.whiteboard);
  h.session.noteActivity({ foreground: true });
  assert.equal(h.session.requestHint(), false);
  assert.equal(h.session.test, undefined);
  assert.deepEqual(voice.starts, [[]]);
  assert.deepEqual(voice.stops, []);
  await h.session.close();
});

test('actual assistant transcripts map into fit-bounded existing caption hooks', async () => {
  const h = fixture();
  await h.session.start();
  h.session.setCaptionMaxChars(40);
  const spoken = 'These are the exact spoken words returned by the voice model during this conversation.';
  h.voices[0].hooks.onTranscript([{ role: 'assistant', text: spoken }]);
  const shown = h.captions.at(-1);
  assert.equal(shown.text, spoken);
  assert.ok(shown.phrase.length <= 40);
  assert.ok(spoken.endsWith(shown.phrase));
  h.voices[0].hooks.onTranscript([{ role: 'user', text: 'New student input' }]);
  assert.equal(h.captions.at(-1).phrase, '');
  await h.session.close();
});

test('pause and resume create a new context-free session without closing the UI adapter', async () => {
  const h = fixture();
  await h.session.start({ title: 'never retained' });
  await h.session.pause('page-hidden');
  assert.equal(h.states.at(-1), 'paused');
  assert.equal(h.presences.at(-1).paused, true);
  assert.equal(h.closes, 0);
  assert.deepEqual(h.voices[0].stops, ['page-hidden']);
  assert.equal(await h.session.resume(), true);
  assert.equal(h.voices.length, 2);
  assert.equal(h.voices[0].disposals, 1);
  assert.deepEqual(h.voices[1].starts, [[]]);
  assert.equal(h.presences.at(-1).paused, false);
  await h.session.close();
  assert.equal(h.closes, 1);
});

test('closed adapters suppress late captions and errors and notify closure only once', async () => {
  const h = fixture();
  await h.session.start();
  const voice = h.voices[0];
  await h.session.close();
  const count = h.captions.length;
  voice.hooks.onTranscript([{ role: 'assistant', text: 'late' }]);
  voice.hooks.onError('late failure');
  voice.hooks.onState('listening');
  await h.session.close();
  assert.equal(h.captions.length, count);
  assert.equal(h.errors.length, 0);
  assert.equal(h.states.at(-1), 'idle');
  assert.equal(h.closes, 1);
  assert.equal(voice.disposals, 1);
});

test('close while module loading prevents any microphone session from starting', async () => {
  let load;
  let constructions = 0;
  const h = fixture({ loadVoiceSession: () => new Promise(resolve => { load = resolve; }) });
  const start = h.session.start();
  await h.session.close();
  load(class { constructor() { constructions++; } });
  assert.equal(await start, false);
  assert.equal(constructions, 0);
  assert.equal(h.closes, 1);
});

test('rate limit errors reach existing captions before onClose removes the adapter', async () => {
  const h = fixture();
  await h.session.start();
  h.voices[0].hooks.onState('error');
  h.voices[0].hooks.onError('OpenAI is rate limiting this request.');
  await Promise.resolve();
  assert.deepEqual(h.errors, ['OpenAI is rate limiting this request.']);
  assert.equal(h.closes, 1);
});

test('native levels map to the original scalar level and speaking/listening states', async () => {
  let now = 1_000;
  const h = fixture({ now: () => now });
  await h.session.start();
  h.voices[0].hooks.onLevel({ input: 0.1, output: 0.2 });
  assert.equal(h.states.at(-1), 'speaking');
  assert.equal(h.levels.at(-1), 0.2);
  now += 600;
  h.voices[0].hooks.onLevel({ input: 0.12, output: 0 });
  assert.equal(h.states.at(-1), 'listening');
  assert.equal(h.levels.at(-1), 0.12);
  await h.session.close();
});

test('autoplay retry uses the existing session and clears its blocked state', async () => {
  const h = fixture();
  await h.session.start();
  h.voices[0].hooks.onPlaybackBlocked(true);
  assert.equal(h.session.playbackBlocked, true);
  assert.match(h.errors.at(-1), /Click the mosaic/);
  assert.equal(await h.session.enableAudio(), true);
  assert.equal(h.session.playbackBlocked, false);
  assert.equal(h.voices.length, 1);
  await h.session.close();
});

test('caption capacity remains bounded for long unbroken text', () => {
  assert.equal(captionTail('x'.repeat(100), 40).length, 40);
  assert.equal(captionTail('Short spoken phrase', 40), 'Short spoken phrase');
});

test('local diagnostics identify each fresh voice session and retain cumulative transcript row IDs', async () => {
  const h = fixture();
  await h.session.start();
  const first = h.events.find(event => event.type === 'voice.started').sessionId;
  h.voices[0].hooks.onTranscript([{ id: '1', role: 'assistant', text: 'Hello' }]);
  h.voices[0].hooks.onTranscript([{ id: '1', role: 'assistant', text: 'Hello there' }]);
  h.voices[0].hooks.onMetrics({ startupMs: 1500, providerSeconds: 15 });
  assert.equal(h.events.at(-1).sessionId, first);
  assert.equal(h.events.at(-1).turnId, '1');
  assert.equal(h.events.at(-1).text, 'Hello there');
  assert.equal(h.metrics.at(-1).sessionId, first);
  await h.session.pause();
  assert.equal(h.events.filter(event => event.type === 'voice.ended' && event.sessionId === first).length, 1);
  await h.session.resume();
  const second = h.events.filter(event => event.type === 'voice.started').at(-1).sessionId;
  assert.notEqual(second, first);
  await h.session.close();
  assert.equal(h.events.filter(event => event.type === 'voice.ended' && event.sessionId === second).length, 1);
});
