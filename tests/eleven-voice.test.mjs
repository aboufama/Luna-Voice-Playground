import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoiceSession, captionTail, voiceBands } from '../src/eleven-voice.js';

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { this.listeners.get(type)?.forEach(fn => fn()); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture(overrides = {}) {
  const requests = [], options = [], voices = [], states = [], captions = [], levels = [], errors = [], pauses = [], events = [], metrics = [], ended = [];
  let closes = 0;
  const intervals = new Map(), timeouts = new Map();
  const document = new Events(), window = new Events();
  let timer = 0;
  const createVoice = callbacks => {
    const voice = {
      ends: 0, input: 0.14, output: 0.37,
      async endSession() { this.ends++; callbacks.onDisconnect({ reason: 'user' }); },
      getInputVolume() { return this.input; }, getOutputVolume() { return this.output; },
    };
    voices.push(voice);
    return voice;
  };
  const Conversation = {
    async startSession(callbacks) {
      options.push(callbacks);
      const voice = createVoice(callbacks);
      callbacks.onConversationCreated(voice);
      callbacks.onConnect({ conversationId: `conversation-${voices.length}` });
      return voice;
    },
  };
  const session = new LiveVoiceSession({
    onState: value => states.push(value), onLevel: value => levels.push(value),
    onCaption: value => captions.push(value), onError: value => errors.push(value),
    onPause: value => pauses.push(value), onClose: value => { closes++; ended.push(value); },
    onEvent: value => events.push(value), onMetrics: value => metrics.push(value),
  }, {
    loadConversation: async () => Conversation,
    fetch: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ conversationToken: 'ephemeral-test-token' }) }; },
    document, window, now: () => 1000,
    setInterval: (fn, ms) => { intervals.set(++timer, { fn, ms }); return timer; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++timer, { fn, ms }); return timer; },
    clearTimeout: id => timeouts.delete(id),
    ...overrides,
  });
  return { session, requests, options, voices, states, captions, levels, errors, pauses, events, metrics, ended, intervals, timeouts, document, window, createVoice, get closes() { return closes; } };
}

test('one context-free ElevenLabs WebRTC session: empty token request and no model overrides or app state', async () => {
  const h = fixture();
  assert.equal(await h.session.start({ title: 'PRIVATE COURSE', materials: ['PRIVATE SOURCE'] }), true);
  assert.equal(h.requests.length, 1);
  const [url, init] = h.requests[0];
  assert.equal(url, '/api/session');
  assert.equal(init.body, '{}');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  const sdk = h.options[0];
  assert.deepEqual(Object.fromEntries(Object.entries(sdk).filter(([, value]) => typeof value !== 'function')), {
    conversationToken: 'ephemeral-test-token', connectionType: 'webrtc',
    workletPaths: { rawAudioProcessor: '/eleven-raw-audio.js' },
  });
  assert.equal(h.session.test, undefined);
  assert.deepEqual(h.states, ['connecting', 'listening']);
  await h.session.close();
});

test('repeated starts share the same pending connection and never duplicate an active microphone', async () => {
  const pending = deferred();
  const h = fixture({ loadConversation: () => pending.promise });
  const a = h.session.start(), b = h.session.start();
  assert.equal(a, b);
  pending.resolve({ startSession: async () => ({ endSession: async () => {} }) });
  assert.equal(await a, true);
  assert.equal(await h.session.start(), false);
  assert.equal(h.requests.length, 1);
  await h.session.close();
});

test('mosaic follows provider speech mode and actual input/output volume at 60ms', async () => {
  const h = fixture();
  await h.session.start();
  const meter = [...h.intervals.values()][0];
  assert.equal(meter.ms, 60);
  meter.fn();
  assert.equal(h.levels.at(-1), 0.14);
  h.options[0].onModeChange({ mode: 'speaking' });
  meter.fn();
  assert.equal(h.states.at(-1), 'speaking');
  assert.equal(h.levels.at(-1), 0.37);
  h.voices[0].output = Infinity;
  meter.fn();
  assert.equal(h.levels.at(-1), 0);
  h.options[0].onModeChange({ mode: 'listening' });
  assert.equal(h.states.at(-1), 'listening');
  await h.session.close();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.levels.at(-1), 0);
});

test('assistant captions are bounded; user speech and interruptions clear stale captions', async () => {
  const h = fixture();
  await h.session.start();
  h.session.setCaptionMaxChars(40);
  const message = 'Here is a long spoken sentence from Plato that should fit the original caption area.';
  h.options[0].onMessage({ message, role: 'agent', event_id: 42 });
  assert.equal(h.captions.at(-1).text, message);
  assert.ok(h.captions.at(-1).phrase.length <= 40);
  assert.ok(message.endsWith(h.captions.at(-1).phrase));
  assert.equal(h.events.at(-1).role, 'assistant');
  assert.equal(h.events.at(-1).turnId, 42);
  h.options[0].onMessage({ message: 'My turn', role: 'user', event_id: 43 });
  assert.equal(h.captions.at(-1).text, '');
  h.options[0].onMessage({ message: 'A reply', source: 'ai' });
  h.options[0].onModeChange({ mode: 'speaking' });
  h.options[0].onInterruption();
  assert.equal(h.captions.at(-1).text, '');
  assert.equal(h.states.at(-1), 'listening');
  await h.session.close();
});

test('hiding the tab releases voice, then resume uses a fresh token and no transcript replay', async () => {
  const h = fixture();
  await h.session.start();
  h.options[0].onMessage({ message: 'Previous conversation', role: 'agent' });
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  await settle();
  assert.equal(h.session.paused, true);
  assert.equal(h.states.at(-1), 'paused');
  assert.deepEqual(h.pauses, ['page-hidden']);
  assert.equal(h.voices[0].ends, 1);
  assert.equal(h.closes, 0);
  h.document.hidden = false;
  assert.equal(await h.session.resume(), true);
  assert.equal(h.voices.length, 2);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(([, args]) => args.body === '{}'));
  assert.equal(h.session.paused, false);
  assert.equal(h.captions.at(-1).text, '');
  await h.session.close();
  assert.equal(h.voices[1].ends, 1);
  assert.equal(h.events.filter(event => event.type === 'voice.ended').length, 2);
});

test('pagehide also pauses; closing removes lifecycle listeners and notifies only once', async () => {
  const h = fixture();
  await h.session.start();
  h.window.emit('pagehide');
  await settle();
  assert.equal(h.session.paused, true);
  await h.session.close();
  await h.session.close();
  assert.equal(h.closes, 1);
  assert.equal(h.voices[0].ends, 1);
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  assert.equal(h.window.listeners.get('pagehide').size, 0);
  assert.equal(h.window.listeners.get('pageshow').size, 0);
});

test('coming back to the tab resumes by itself: there is no click to unmute', async () => {
  const h = fixture();
  await h.session.start();
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  await settle();
  assert.equal(h.states.at(-1), 'paused');
  // Still hidden: a restored page must not open the microphone behind the user's back.
  h.window.emit('pageshow');
  await settle();
  assert.equal(h.requests.length, 1);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  await settle();
  await settle();
  assert.equal(h.session.paused, false);
  assert.equal(h.voices.length, 2);
  assert.equal(h.states.at(-1), 'listening');
  assert.equal(h.closes, 0);
  await h.session.close();
});

test('a closing session says why, so the page can decide whether to come straight back', async () => {
  let clock = 1000;
  const spoke = fixture({ now: () => clock });
  await spoke.session.start();
  spoke.options[0].onMessage({ role: 'user', message: 'What is a tessera?' });
  clock += 42_000;
  spoke.options[0].onDisconnect({ reason: 'agent' });
  await settle();
  assert.deepEqual(spoke.ended, [{ reason: 'agent', retry: true, heardUser: true, livedMs: 42_000 }]);
  assert.equal(spoke.errors.length, 0);

  const dropped = fixture();
  await dropped.session.start();
  dropped.options[0].onError('WebRTC transport failed');
  await settle();
  assert.deepEqual(dropped.ended, [{ reason: 'error', retry: true, heardUser: false, livedMs: 0 }]);

  // Nothing fixes these without a person, so they are never retried on a timer.
  const empty = fixture({ fetch: async () => ({ ok: false, json: async () => ({ error: { code: 'quota_exceeded' } }) }) });
  await empty.session.start();
  assert.equal(empty.ended[0].retry, false);
  const busy = fixture({ fetch: async () => ({ ok: false, json: async () => ({ error: { code: 'rate_limited' } }) }) });
  await busy.session.start();
  assert.equal(busy.ended[0].retry, true);
  const blocked = fixture({ mediaDevices: { getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } } });
  await blocked.session.start();
  assert.equal(blocked.ended[0].retry, false);
  const refused = fixture({ loadConversation: async () => ({ startSession: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } }) });
  await refused.session.start();
  assert.equal(refused.ended[0].retry, false);

  const user = fixture();
  await user.session.start();
  await user.session.close();
  assert.equal(user.ended[0].reason, 'user');
});

test('the mosaic reads both voices as a few voice bands, and nothing when disconnected', async () => {
  const flat = new Uint8Array(1024).fill(255);
  assert.deepEqual([...voiceBands(flat, new Float32Array(4))], [1, 1, 1, 1]);
  // 100-8000 Hz arrives linear; a low note belongs to the first band only.
  const low = new Uint8Array(1024); low.fill(204, 0, 4);
  const bands = voiceBands(low, new Float32Array(16));
  assert.ok(Math.abs(bands[0] - .8) < 1e-6 && bands.slice(1).every(value => value === 0));
  assert.deepEqual([...voiceBands(new Uint8Array(0), new Float32Array(3).fill(.5))], [0, 0, 0]);

  const h = fixture();
  const heard = new Float32Array(16).fill(.5), spoken = new Float32Array(16).fill(.5);
  assert.equal(h.session.readSpectrum(heard, spoken), false);
  await h.session.start();
  assert.equal(h.session.readSpectrum(heard, spoken), false, 'a voice without analysers leaves the buffers alone');
  assert.equal(heard[0], .5);
  h.voices[0].getInputByteFrequencyData = () => flat;
  h.voices[0].getOutputByteFrequencyData = () => new Uint8Array(1024);
  assert.equal(h.session.readSpectrum(heard, spoken), true);
  assert.ok(heard.every(value => value === 1) && spoken.every(value => value === 0));
  h.voices[0].getOutputByteFrequencyData = () => { throw new Error('analyser closed'); };
  assert.equal(h.session.readSpectrum(heard, spoken), false);
  await h.session.close();
  assert.equal(h.session.readSpectrum(heard, spoken), false);
});

test('a document reaches Plato only through sendContext, and only while a conversation is live', async () => {
  const h = fixture();
  assert.equal(h.session.sendContext('Chapter list'), false, 'nothing is live yet');
  await h.session.start();
  assert.equal(h.session.sendContext('Chapter list'), false, 'a voice that cannot take context is left alone');
  const told = [];
  h.voices[0].sendContextualUpdate = text => told.push(text);
  assert.equal(h.session.sendContext('Chapter list'), true);
  assert.equal(h.session.sendContext('   '), false);
  assert.equal(h.session.sendContext({ text: 'not a string' }), false);
  assert.deepEqual(told, ['Chapter list']);
  // Starting a conversation still carries nothing from the page.
  assert.equal(h.requests[0][1].body, '{}');
  h.voices[0].sendContextualUpdate = () => { throw new Error('channel closed'); };
  assert.equal(h.session.sendContext('Chapter list'), false);
  await h.session.close();
  assert.equal(h.session.sendContext('Chapter list'), false);
});

test('a touch releases audio a browser held back, and leaves playing audio alone', async () => {
  let plays = 0;
  const held = { paused: true, play: async () => { plays++; } }, playing = { paused: false, play: async () => { plays += 10; } };
  const document = Object.assign(new Events(), { querySelectorAll: selector => selector === 'audio' ? [held, playing] : [] });
  const h = fixture({ document });
  h.session.enableAudio();
  assert.equal(plays, 1);
  fixture().session.enableAudio();
});

test('cancel before token response aborts request and prevents SDK microphone startup', async () => {
  const response = deferred();
  let signal, starts = 0;
  const h = fixture({
    fetch: async (_url, options) => { signal = options.signal; return response.promise; },
    loadConversation: async () => ({ startSession: async () => { starts++; } }),
  });
  const start = h.session.start();
  await h.session.close();
  assert.equal(signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ conversationToken: 'late-token' }) });
  assert.equal(await start, false);
  assert.equal(starts, 0);
  assert.equal(h.errors.length, 0);
});

test('cancel during SDK startup ends the late session exactly once and suppresses callbacks', async () => {
  const ready = deferred();
  let callbacks;
  const h = fixture({ loadConversation: async () => ({ startSession: options => { callbacks = options; return ready.promise; } }) });
  const start = h.session.start();
  await settle();
  await h.session.close();
  const voice = h.createVoice(callbacks);
  callbacks.onConversationCreated(voice);
  callbacks.onConnect({ conversationId: 'late' });
  callbacks.onMessage({ message: 'Late words', role: 'agent' });
  callbacks.onError('Late failure');
  ready.resolve(voice);
  assert.equal(await start, false);
  assert.equal(voice.ends, 1);
  assert.equal(h.states.at(-1), 'idle');
  assert.equal(h.captions.at(-1).text, '');
  assert.equal(h.errors.length, 0);
  assert.equal(h.closes, 1);
});

test('resume waits for the paused microphone teardown before creating a new session', async () => {
  const h = fixture();
  await h.session.start();
  const ended = deferred();
  h.voices[0].endSession = () => ended.promise;
  const pause = h.session.pause();
  const resume = h.session.resume();
  await settle();
  assert.equal(h.requests.length, 1);
  ended.resolve();
  await pause;
  assert.equal(await resume, true);
  assert.equal(h.requests.length, 2);
  await h.session.close();
});

test('provider disconnect closes the UI and clears meters without replaying stale output', async () => {
  const h = fixture();
  await h.session.start();
  h.options[0].onDisconnect({ reason: 'error', message: 'private provider details' });
  await settle();
  assert.equal(h.closes, 1);
  assert.match(h.errors[0], /Click the mosaic to reconnect/);
  assert.equal(h.intervals.size, 0);
  const before = h.captions.length;
  h.options[0].onMessage({ role: 'agent', message: 'late' });
  assert.equal(h.captions.length, before);
});

test('token errors are useful and sanitized, without opening a microphone', async () => {
  const h = fixture({ fetch: async () => ({ ok: false, json: async () => ({ error: { code: 'rate_limited', message: 'secret data' } }) }) });
  assert.equal(await h.session.start(), false);
  assert.match(h.errors[0], /ElevenLabs is busy/);
  assert.equal(h.errors[0].includes('secret'), false);
  assert.equal(h.voices.length, 0);
  assert.equal(h.closes, 1);
});

test('microphone denial reports a recoverable action and ends the failed adapter', async () => {
  const h = fixture({ loadConversation: async () => ({ startSession: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } }) });
  assert.equal(await h.session.start(), false);
  assert.match(h.errors[0], /Allow microphone access/);
  assert.equal(h.states.at(-1), 'idle');
  assert.equal(h.closes, 1);
  assert.equal(h.timeouts.size, 0);
});

test('missing token is rejected instead of falling back to a public agent or old provider', async () => {
  const h = fixture({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(await h.session.start(), false);
  assert.equal(h.voices.length, 0);
  assert.match(h.errors[0], /unavailable/);
});

test('caption capacity bounds single words and preserves short utterances', () => {
  assert.equal(captionTail('x'.repeat(100), 40).length, 40);
  assert.equal(captionTail('Hello there', 40), 'Hello there');
});

test('the microphone is requested before the token, and its probe is released after connecting', async () => {
  const order = [], stopped = [];
  const h = fixture({
    mediaDevices: { getUserMedia: async constraints => { order.push(constraints); await settle(); return { getTracks: () => [{ stop: () => stopped.push(1) }] }; } },
    permissions: { query: async () => ({ state: 'prompt' }) },
  });
  const started = h.session.start();
  assert.deepEqual(order, [{ audio: true }]);
  assert.equal(h.requests.length, 0);
  assert.equal(await started, true);
  assert.equal(h.requests.length, 1);
  assert.equal(stopped.length, 1);
  assert.ok(h.captions.some(caption => /Allow the microphone/.test(caption.phrase)));
  assert.equal(h.captions.at(-1).phrase, '');
});

test('a blocked microphone names the fix and never requests a token', async () => {
  for (const [state, expected] of [['denied', /blocked for this site/], ['prompt', /System Settings/]]) {
    const h = fixture({
      mediaDevices: { getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } },
      permissions: { query: async () => ({ state }) },
    });
    assert.equal(await h.session.start(), false);
    assert.match(h.errors[0], expected);
    assert.equal(h.requests.length, 0);
    assert.equal(h.voices.length, 0);
    assert.equal(h.states.at(-1), 'idle');
  }
});

test('a static page names a public agent: no token request, no key, and the worklet beside the page', async () => {
  const h = fixture({ agentId: 'agent_public_example', workletPath: './eleven-raw-audio.js' });
  assert.equal(await h.session.start(), true);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(h.options[0]).filter(([, value]) => typeof value !== 'function')), {
    agentId: 'agent_public_example', connectionType: 'webrtc',
    workletPaths: { rawAudioProcessor: './eleven-raw-audio.js' },
  });
  assert.deepEqual(h.states, ['connecting', 'listening']);
  await h.session.close();
  assert.equal(h.timeouts.size, 0);
});

test('a public agent that turns the page away is told to the person once, not retried', async () => {
  const refusing = why => fixture({ agentId: 'agent_public_example', loadConversation: async () => ({
    startSession: async () => { throw new Error(`Failed to fetch conversation token for agent agent_public_example: ${why}`); },
  }) });
  for (const [why, expected] of [
    ['Your agent has authentication enabled, but no signed URL or conversation token was provided.', /not open to this page/],
    ['ElevenLabs API returned 403 Origin not allowed', /not open to this page/],
    ['ElevenLabs API returned 429 Daily limit reached', /busy right now/],
  ]) {
    const h = refusing(why);
    assert.equal(await h.session.start(), false);
    assert.match(h.errors[0], expected);
    assert.equal(h.ended[0].retry, false);
    assert.equal(h.requests.length, 0);
  }
  // Anything else, such as the network dropping, is worth another try.
  const h = refusing('Failed to fetch');
  assert.equal(await h.session.start(), false);
  assert.match(h.errors[0], /connection failed/);
  assert.equal(h.ended[0].retry, true);
});
