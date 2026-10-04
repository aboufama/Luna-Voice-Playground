import { Conversation } from '@elevenlabs/client';

// Load the browser SDK up front so its iOS audio-unlock listener is armed.
// The UX fork has one fresh ElevenLabs conversation, with no tools. It starts
// with no study data; the only way any enters is sendContext, when the person
// hands Plato a document.
// It is live whenever its page is visible: hiding the page releases the
// microphone, and coming back opens a new conversation without a click.
// The page's own server hands it a short-lived token for a private agent. A
// page with no server (a static host) names a public agent instead, and the
// SDK asks ElevenLabs for the token itself. Neither way puts a key in the browser.
export class LiveVoiceSession {
  constructor(hooks = {}, dependencies = {}) {
    this.hooks = hooks;
    this.deps = {
      agentId: '',
      workletPath: '/eleven-raw-audio.js',
      loadConversation: async () => Conversation,
      fetch: globalThis.fetch.bind(globalThis),
      document: globalThis.document,
      window: globalThis.window,
      mediaDevices: globalThis.navigator?.mediaDevices,
      permissions: globalThis.navigator?.permissions,
      now: () => performance.now(),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      ...dependencies,
    };
    this.closed = false;
    this.paused = false;
    this.ready = false;
    this.retry = true;
    this.heardUser = false;
    this.connectedAt = null;
    this.state = 'idle';
    this.mode = 'listening';
    this.captionMaxChars = 76;
    this.assistantText = '';
    this.generation = 0;
    this.ending = new WeakMap();
    this._visibility = () => { if (this.deps.document?.hidden) void this.pause('page-hidden'); else void this.resume(); };
    this._pagehide = () => { void this.pause('page-hidden'); };
    this._pageshow = () => { if (!this.deps.document?.hidden) void this.resume(); };
    this.deps.document?.addEventListener('visibilitychange', this._visibility);
    this.deps.window?.addEventListener('pagehide', this._pagehide);
    this.deps.window?.addEventListener('pageshow', this._pageshow);
  }

  start() {
    if (this.closed || this.ready) return Promise.resolve(false);
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.paused = false;
    this.retry = true;
    this.heardUser = false;
    this.connectedAt = null;
    this.mode = 'listening';
    this.assistantText = '';
    this._caption();
    this._state('connecting');
    const run = this._connect(generation);
    this.startPromise = run;
    void run.finally(() => { if (this.startPromise === run) this.startPromise = null; });
    return run;
  }

  async _connect(generation) {
    const current = () => !this.closed && !this.paused && generation === this.generation;
    const startedAt = this.deps.now();
    const controller = new AbortController();
    this.request = controller;
    let timeout, probe;
    try {
      // Ask for the microphone first, inside the click, so the browser prompt appears before anything else.
      const microphone = this._microphone(current);
      if (microphone) probe = await microphone;
      if (!current()) return false;
      timeout = this.deps.setTimeout(() => controller.abort(), 20_000);
      const agentId = this.deps.agentId;
      const [Conversation, access] = await Promise.all([
        this.deps.loadConversation(),
        agentId ? { agentId } : this._token(controller.signal),
      ]);
      this.deps.clearTimeout(timeout);
      if (!current()) return false;
      // These are the only values the conversation starts with. No application state is among them.
      const voice = await Conversation.startSession({
        ...access,
        connectionType: 'webrtc',
        workletPaths: { rawAudioProcessor: this.deps.workletPath },
        onConversationCreated: conversation => {
          if (current()) this.voice = conversation;
          else void this._end(conversation);
        },
        onConnect: ({ conversationId } = {}) => {
          if (!current()) return;
          this.sessionId = conversationId;
          this.ready = true;
          this.connectedAt = this.deps.now();
          this._state(this.mode);
          this.hooks.onEvent?.({ type: 'voice.started', sessionId: conversationId, provider: 'elevenlabs', transport: 'webrtc' });
          this.hooks.onMetrics?.({ startupMs: this.deps.now() - startedAt, sessionId: conversationId });
        },
        onDisconnect: details => {
          if (!current()) return;
          if (details?.reason === 'error') this.hooks.onError?.('The voice connection ended. Click the mosaic to reconnect.');
          void this.close(details?.reason || 'provider-closed');
        },
        onError: message => {
          if (!current()) return;
          this.retry = !needsPerson(message);
          this.hooks.onError?.(voiceError(message));
          void this.close('error');
        },
        onModeChange: ({ mode }) => {
          if (!current() || !['speaking', 'listening'].includes(mode)) return;
          this.mode = mode;
          if (this.ready) this._state(mode);
        },
        onMessage: message => {
          if (!current()) return;
          const role = message.role === 'agent' || message.source === 'ai' ? 'assistant' : 'user';
          const text = String(message.message || '');
          if (role === 'user') this.heardUser = true;
          this.assistantText = role === 'assistant' ? text : '';
          this._caption();
          this.hooks.onEvent?.({ type: 'voice.transcript', sessionId: this.sessionId, role, text, turnId: message.response_id ?? message.event_id });
        },
        onInterruption: () => {
          if (!current()) return;
          this.assistantText = '';
          this._caption();
          this.mode = 'listening';
          if (this.ready) this._state('listening');
        },
      });
      if (!current()) { await this._end(voice); return false; }
      this.voice = voice;
      this.ready = true;
      this._state(this.mode);
      this.meter = this.deps.setInterval(() => {
        if (!current() || !this.ready) return;
        try {
          const value = this.mode === 'speaking' ? voice.getOutputVolume() : voice.getInputVolume();
          this.hooks.onLevel?.(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
        } catch { this.hooks.onLevel?.(0); }
      }, 60);
      return true;
    } catch (error) {
      if (!current()) return false;
      const known = error instanceof ConnectionError ? error : turnedAway(error?.message);
      this.retry = known ? known.retry : !needsPerson(error?.name || error?.message);
      this.hooks.onError?.(known ? known.message : voiceError(error?.name || error?.message));
      await this.close('error');
      return false;
    } finally {
      // The SDK opens its own microphone track; the probe only holds the permission until then.
      probe?.getTracks().forEach(track => track.stop());
      this.deps.clearTimeout(timeout);
      if (this.request === controller) this.request = null;
    }
  }

  // The only thing this page ever asks its server for: an empty request, a token back.
  async _token(signal) {
    const response = await this.deps.fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal,
    });
    const body = await response.json();
    if (!response.ok) {
      const code = body?.error?.code || body?.code;
      throw new ConnectionError(serverError(code), !SETUP_FAILURES.has(code));
    }
    if (typeof body.conversationToken !== 'string' || !body.conversationToken) {
      throw new ConnectionError('The voice connection was unavailable. Click the mosaic to try again.');
    }
    return { conversationToken: body.conversationToken };
  }

  _microphone(current) {
    const media = this.deps.mediaDevices;
    if (!media?.getUserMedia) return null;
    const permission = async () => {
      try { return (await this.deps.permissions?.query({ name: 'microphone' }))?.state; } catch { return undefined; }
    };
    let waiting = true;
    const request = media.getUserMedia({ audio: true });
    void permission().then(state => {
      if (waiting && state === 'prompt' && current()) this.hooks.onCaption?.({ text: '', phrase: 'Allow the microphone in the browser prompt to start.' });
    });
    return request.then(stream => {
      waiting = false;
      if (current()) this._caption();
      return stream;
    }, async error => {
      waiting = false;
      throw new ConnectionError(microphoneError(error?.name, await permission()), false);
    });
  }

  _state(state) {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onState?.(state);
  }

  _caption() {
    this.hooks.onCaption?.({ text: this.assistantText, phrase: captionTail(this.assistantText, this.captionMaxChars) });
  }

  setCaptionMaxChars(value) {
    this.captionMaxChars = Math.max(32, Math.min(120, Number(value) || 76));
    if (!this.closed) this._caption();
  }

  _end(voice) {
    if (!voice) return Promise.resolve();
    if (!this.ending.has(voice)) {
      this.ending.set(voice, Promise.resolve().then(() => voice.endSession()).catch(() => {}));
    }
    return this.ending.get(voice);
  }

  _release(reason) {
    this.generation++;
    this.ready = false;
    this.request?.abort();
    this.request = null;
    this.deps.clearInterval(this.meter);
    this.meter = null;
    this.hooks.onLevel?.(0);
    const voice = this.voice;
    this.voice = null;
    if (this.sessionId) {
      this.hooks.onEvent?.({ type: 'voice.ended', sessionId: this.sessionId, reason });
      this.sessionId = null;
    }
    this.releasePromise = this._end(voice);
    return this.releasePromise;
  }

  async pause(reason = 'user') {
    if (this.closed || this.paused) return;
    this.paused = true;
    const release = this._release(reason);
    this._state('paused');
    this.hooks.onPause?.(reason);
    await release;
  }

  async resume() {
    if (this.closed || !this.paused || this.resuming) return false;
    this.resuming = true;
    try {
      // Let a cancelled SDK startup clean itself up before requesting another microphone session.
      await this.releasePromise;
      await this.startPromise;
      if (this.closed || !this.paused) return false;
      this.startPromise = null;
      return await this.start();
    } finally { this.resuming = false; }
  }

  // The SDK plays Plato through its own hidden audio element. A browser that
  // held it back until the page was touched lets it through on the next touch.
  enableAudio() {
    for (const element of this.deps.document?.querySelectorAll?.('audio') ?? []) {
      if (element.paused) void element.play?.()?.catch(() => {});
    }
  }

  // Tell Plato something without it counting as the person speaking, and without
  // prompting a reply. False when there is no live conversation to tell.
  sendContext(text) {
    const voice = this.ready ? this.voice : null;
    if (!voice?.sendContextualUpdate || typeof text !== 'string' || !text.trim()) return false;
    try { voice.sendContextualUpdate(text); return true; } catch { return false; }
  }

  // Both voices as the SDK's analysers hear them, reduced to a few bands for the
  // mosaic. Returns false, leaving the buffers alone, when nothing is connected.
  readSpectrum(heard, spoken) {
    const voice = this.ready ? this.voice : null;
    if (!voice?.getInputByteFrequencyData || !voice.getOutputByteFrequencyData) return false;
    try {
      voiceBands(voice.getInputByteFrequencyData(), heard);
      voiceBands(voice.getOutputByteFrequencyData(), spoken);
      return true;
    } catch { return false; }
  }

  async close(reason = 'user') {
    if (this.closed) return;
    this.closed = true;
    this.deps.document?.removeEventListener('visibilitychange', this._visibility);
    this.deps.window?.removeEventListener('pagehide', this._pagehide);
    this.deps.window?.removeEventListener('pageshow', this._pageshow);
    const livedMs = this.connectedAt === null ? 0 : this.deps.now() - this.connectedAt;
    const release = this._release(reason);
    this._state('idle');
    // Enough for the page to decide whether to come straight back.
    this.hooks.onClose?.({ reason, retry: this.retry, heardUser: this.heardUser, livedMs });
    await release;
  }
}

class ConnectionError extends Error {
  constructor(message, retry = true) { super(message); this.retry = retry; }
}

// Trying again cannot fix these; a person has to change something first.
const SETUP_FAILURES = new Set(['quota_exceeded', 'not_configured', 'missing_configuration']);
const needsPerson = (message = '') => /NotAllowed|permission|denied|NotFound|device not found/i.test(message);

// A public agent answers the browser itself, so its refusals arrive as the
// SDK's own error text: "Failed to fetch conversation token for agent <id>: <why>".
function turnedAway(message = '') {
  const why = /conversation token for agent \S+\s+(.*)$/is.exec(message)?.[1];
  if (!why) return null;
  if (/\b429\b|limit|quota|capacity/i.test(why)) return new ConnectionError('Plato is busy right now. Click the mosaic to try again in a while.', false);
  if (/\b40[134]\b|authentication enabled/i.test(why)) return new ConnectionError('Plato’s voice is not open to this page.', false);
  return null;
}

// The SDK reports 100-8000 Hz linearly. Voices are heard in octaves, so each
// band here is one step of a logarithmic scale, as a 0-1 share of full level.
export function voiceBands(bytes, bands) {
  const size = bytes?.length || 0, count = bands.length;
  if (!size) { bands.fill(0); return bands; }
  const edge = step => Math.round((80 ** (step / count) - 1) / 79 * size);
  for (let band = 0; band < count; band++) {
    const from = Math.min(size - 1, edge(band)), to = Math.min(size, Math.max(from + 1, edge(band + 1)));
    let sum = 0;
    for (let index = from; index < to; index++) sum += bytes[index];
    bands[band] = sum / (to - from) / 255;
  }
  return bands;
}

function voiceError(message = '') {
  if (/NotAllowed|permission|denied/i.test(message)) return 'Allow microphone access, then click the mosaic to try again.';
  if (/NotFound|device not found/i.test(message)) return 'Connect a microphone, then click the mosaic to try again.';
  if (/AbortError|timeout/i.test(message)) return 'The voice connection timed out. Click the mosaic to try again.';
  return 'The voice connection failed. Click the mosaic to try again.';
}

function microphoneError(name = '', permission) {
  if (/NotFound|Overconstrained/i.test(name)) return 'No microphone was found. Connect one, then click the mosaic to try again.';
  if (/NotReadable|Abort/i.test(name)) return 'The microphone is busy or unavailable. Close other apps using it, then click the mosaic.';
  if (permission === 'denied') return 'The microphone is blocked for this site. Allow it from the address bar, then click the mosaic.';
  return 'The browser could not use the microphone. Allow it in the prompt, or in System Settings > Privacy & Security > Microphone, then click the mosaic.';
}

function serverError(code) {
  if (code === 'rate_limited') return 'ElevenLabs is busy. Wait a moment, then click the mosaic to try again.';
  if (code === 'quota_exceeded') return 'The ElevenLabs account has reached its usage limit.';
  if (code === 'not_configured' || code === 'missing_configuration') return 'The ElevenLabs voice is not configured yet.';
  return 'The voice connection was unavailable. Click the mosaic to try again.';
}

export function captionTail(text, limit = 76) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  const tail = value.slice(-limit);
  const firstSpace = tail.search(/\s/u);
  return firstSpace >= 0 ? tail.slice(firstSpace + 1).trim() : tail;
}
