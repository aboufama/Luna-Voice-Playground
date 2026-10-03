// Adapts the existing Luna interface to one fresh, context-free voice session.
// Test/material/mastery/whiteboard data intentionally never enters this client.
export class LiveVoiceSession {
  constructor(hooks = {}, dependencies = {}) {
    this.hooks = hooks;
    this.deps = {
      loadVoiceSession: async () => (await import(/* @vite-ignore */ '/voice-session.js')).VoiceSession,
      createAudio: () => new Audio(),
      AudioContext: globalThis.AudioContext || globalThis.webkitAudioContext,
      document: globalThis.document,
      window: globalThis.window,
      now: () => performance.now(),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      ...dependencies,
    };
    this.closed = false;
    this.paused = false;
    this.resuming = false;
    this.ready = false;
    this.playbackBlocked = false;
    this.captionMaxChars = 76;
    this.assistantText = '';
    this.nativeLevel = { input: 0, output: 0 };
    this.lastSpeechAt = -Infinity;
    this.generation = 0;
    this._visibility = () => { if (this.deps.document?.hidden) void this.pause('page-hidden'); };
    this._pagehide = () => { void this.pause('page-hidden'); };
    this.deps.document?.addEventListener('visibilitychange', this._visibility);
    this.deps.window?.addEventListener('pagehide', this._pagehide);
  }

  async start(_ignoredTest) {
    if (this.closed) return false;
    const generation = ++this.generation;
    this.sessionId = crypto.randomUUID();
    this.sessionStarted = false;
    this.sessionEnded = false;
    this.assistantText = '';
    this.lastSpeechAt = -Infinity;
    this.hooks.onCaption?.({ text: '', phrase: '' });
    this._state('connecting');
    // Resume the optional level meter during the original click gesture.
    // Browser-native media playback still owns all audible output.
    this._openMeter();
    try {
      const VoiceSession = await this.deps.loadVoiceSession();
      if (this.closed || generation !== this.generation) return false;
      this.audio = this.deps.createAudio();
      this.audio.addEventListener?.('loadedmetadata', () => this._attachMeter());
      const voice = new VoiceSession({
        audioElement: this.audio,
        onState: (state, detail) => {
          if (this.closed || this.voice !== voice) return;
          if (state === 'listening') {
            this.ready = true;
            if (!this.sessionStarted) { this.sessionStarted = true; this.hooks.onEvent?.({ type: 'voice.started', sessionId: this.sessionId, transport: 'webrtc' }); }
            this.paused = false;
            this.resuming = false;
            this.hooks.onPresence?.({ paused: false, resuming: false, error: '' });
            this._state('listening');
          } else if (state === 'connecting') this._state('connecting');
          else if (state === 'closing') {
            this.ready = false;
            this.hooks.onLevel?.(0);
          } else if (state === 'idle') {
            this._recordEnd(detail?.reason || 'provider-closed');
            this.ready = false;
            this._closeMeter();
            if (this.paused || detail?.reason === 'page-hidden') {
              this.paused = true;
              this._state('paused');
              this.hooks.onPresence?.({ paused: true, resuming: false, error: '' });
            } else void this.close();
          } else if (state === 'error') {
            this.ready = false;
            this._closeMeter();
            this._state(this.paused ? 'paused' : 'idle');
            // onError follows this event; keep the adapter alive until the
            // error has reached the existing caption area.
          }
        },
        onTranscript: messages => {
          if (this.closed || this.voice !== voice || this.paused) return;
          const last = messages.at(-1);
          this.hooks.onTranscript?.(last || null);
          if (last) this.hooks.onEvent?.({ type: 'voice.transcript', sessionId: this.sessionId, role: last.role, text: last.text, turnId: last.id });
          if (last?.role !== 'assistant') {
            this.assistantText = '';
            this.hooks.onCaption?.({ text: '', phrase: '' });
            return;
          }
          this.assistantText = last.text;
          this._caption();
        },
        onLevel: values => {
          if (this.closed || this.voice !== voice || this.paused) return;
          this.nativeLevel = values;
          this._levels();
        },
        onMetrics: metrics => { if (this.voice === voice) this.hooks.onMetrics?.({ ...metrics, sessionId: this.sessionId }); },
        onError: message => {
          if (this.closed || this.voice !== voice) return;
          this.hooks.onError?.(message);
          if (this.paused) {
            this.resuming = false;
            this.hooks.onPresence?.({ paused: true, resuming: false, error: message });
          } else void this.close('error');
        },
        onPlaybackBlocked: blocked => {
          if (this.closed || this.voice !== voice) return;
          this.playbackBlocked = blocked;
          if (blocked) this.hooks.onError?.('Click the mosaic to enable audio.');
          else if (this.ready) this._caption();
        },
      });
      this.voice = voice;
      // This empty call is the context boundary. Do not pass _ignoredTest,
      // materials, previous transcripts, instructions, or any UI fixtures.
      const ready = await voice.start();
      if (this.closed || generation !== this.generation) return false;
      if (!ready && !this.paused) await this.close();
      return ready;
    } catch {
      if (this.closed || generation !== this.generation) return false;
      this._closeMeter();
      this.hooks.onError?.('The voice playground could not connect. Please try again.');
      if (this.paused) {
        this.resuming = false;
        this.hooks.onPresence?.({ paused: true, resuming: false, error: 'The voice session could not reconnect. Please try again.' });
      } else await this.close();
      return false;
    }
  }

  _state(state) {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onEvent?.({ type: 'voice.state', sessionId: this.sessionId, state });
    this.hooks.onState?.(state);
  }

  _caption() {
    this.hooks.onCaption?.({ text: this.assistantText, phrase: captionTail(this.assistantText, this.captionMaxChars), timing: 'provider-transcript' });
  }

  setCaptionMaxChars(value) {
    this.captionMaxChars = Math.max(32, Math.min(120, Number(value) || 76));
    if (!this.closed) this._caption();
  }

  _openMeter() {
    this._closeMeter();
    const AudioContext = this.deps.AudioContext;
    if (!AudioContext) return;
    try {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      void this.context.resume().catch(() => {});
      this.meterTimer = this.deps.setInterval(() => this._levels(), 60);
    } catch { /* Native WebRTC works without an optional animation meter. */ }
  }

  _attachMeter() {
    if (this.closed || this.paused || !this.context || !this.audio?.srcObject) return;
    if (this.meterStream === this.audio.srcObject) return;
    try {
      this.meterSource?.disconnect();
      this.analyser?.disconnect();
      this.meterMute?.disconnect();
      this.meterSource = this.context.createMediaStreamSource(this.audio.srcObject);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.meterSamples = new Float32Array(this.analyser.fftSize);
      this.meterMute = this.context.createGain();
      this.meterMute.gain.value = 0;
      this.meterSource.connect(this.analyser);
      this.analyser.connect(this.meterMute);
      this.meterMute.connect(this.context.destination);
      this.meterStream = this.audio.srcObject;
    } catch { /* getStats remains the fallback for animation levels. */ }
  }

  _levels() {
    if (this.closed || this.paused || !this.ready) return;
    this._attachMeter();
    let output = Number.isFinite(this.nativeLevel.output) ? this.nativeLevel.output : 0;
    if (this.analyser && this.context?.state === 'running') {
      this.analyser.getFloatTimeDomainData(this.meterSamples);
      let energy = 0;
      for (const sample of this.meterSamples) energy += sample * sample;
      output = Math.sqrt(energy / this.meterSamples.length);
    }
    if (output > 0.003) this.lastSpeechAt = this.deps.now();
    const speaking = !this.playbackBlocked && this.deps.now() - this.lastSpeechAt < 450;
    const input = Number.isFinite(this.nativeLevel.input) ? this.nativeLevel.input : 0;
    this.hooks.onLevel?.(Math.max(0, Math.min(1, speaking ? output : input)));
    this._state(speaking ? 'speaking' : 'listening');
  }

  _closeMeter() {
    this.deps.clearInterval(this.meterTimer);
    this.meterSource?.disconnect();
    this.analyser?.disconnect();
    this.meterMute?.disconnect();
    if (this.context) void Promise.resolve(this.context.close()).catch(() => {});
    this.context = null;
    this.meterSource = null;
    this.analyser = null;
    this.meterMute = null;
    this.meterStream = null;
    this.nativeLevel = { input: 0, output: 0 };
  }

  async enableAudio() {
    if (this.closed) return false;
    if (this.context) void this.context.resume().catch(() => {});
    return this.voice?.enableAudio() ?? false;
  }

  async pause(reason = 'user') {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.ready = false;
    this.generation++;
    this._closeMeter();
    this._state('paused');
    this.hooks.onLevel?.(0);
    this.hooks.onPause?.(reason);
    this.hooks.onPresence?.({ paused: true, resuming: false, error: '' });
    await this.voice?.stop(reason);
  }

  async resume() {
    if (this.closed || !this.paused || this.resuming) return false;
    this.resuming = true;
    this.hooks.onPresence?.({ paused: true, resuming: true, error: '' });
    await this.voice?.dispose();
    if (this.closed) return false;
    this.voice = null;
    return this.start();
  }

  _recordEnd(reason) {
    if (this.sessionEnded || !this.sessionId) return;
    this.sessionEnded = true;
    this.hooks.onEvent?.({ type: 'voice.ended', sessionId: this.sessionId, reason });
  }

  async close(reason = 'user') {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.ready = false;
    this.deps.document?.removeEventListener('visibilitychange', this._visibility);
    this.deps.window?.removeEventListener('pagehide', this._pagehide);
    this._closeMeter();
    this.hooks.onLevel?.(0);
    this._state('idle');
    await this.voice?.dispose(reason);
    this._recordEnd(reason);
    if (!this.notifiedClose) { this.notifiedClose = true; this.hooks.onClose?.(); }
  }

  // Keep the original UI contract while the study backend is disconnected.
  updateMaterials() {}
  updateIndexStatus() {}
  setCanvasVisible() {}
  selectCanvas() {}
  noteActivity() {}
  requestHint() { return false; }
}

export function captionTail(text, limit = 76) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  const tail = value.slice(-limit);
  const firstSpace = tail.search(/\s/u);
  return firstSpace >= 0 ? tail.slice(firstSpace + 1).trim() : tail;
}
