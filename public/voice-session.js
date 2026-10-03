/** A fresh, in-memory GPT-Live conversation over browser-native WebRTC. */
export class VoiceSession {
  constructor(hooks = {}, dependencies = {}) {
    this.hooks = hooks;
    this.audio = hooks.audioElement;
    if (!this.audio) throw new TypeError('VoiceSession requires an audioElement.');
    this.deps = {
      mediaDevices: globalThis.navigator?.mediaDevices,
      PeerConnection: globalThis.RTCPeerConnection,
      MediaStream: globalThis.MediaStream,
      fetch: globalThis.fetch?.bind(globalThis),
      now: () => performance.now(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      document: globalThis.document,
      window: globalThis.window,
      closeTimeoutMs: 5_000,
      connectTimeoutMs: 45_000,
      ...dependencies,
    };
    this.state = 'idle';
    this._active = null;
    this._disposed = false;
    this._hidden = () => {
      if (this.deps.document?.visibilityState === 'hidden') void this.stop('page-hidden');
    };
    this._pagehide = () => { void this.stop('page-hidden'); };
    this.deps.document?.addEventListener('visibilitychange', this._hidden);
    this.deps.window?.addEventListener('pagehide', this._pagehide);
    this.audio.autoplay = true;
    this.audio.playsInline = true;
  }

  _state(state, detail = {}) {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }

  _current(run) { return this._active === run && !run.closed; }
  _working(run) { return this._current(run) && !run.closing; }

  async start() {
    if (this._disposed) return false;
    if (this._active?.closing) await this._active.closedPromise;
    if (this._disposed) return false;
    if (this._active) return this._active.readyPromise;
    if (!this.deps.mediaDevices?.getUserMedia || !this.deps.PeerConnection) {
      this._state('error');
      this.hooks.onError?.('This browser does not support microphone WebRTC. Open this page in a current browser on localhost or HTTPS.');
      return false;
    }
    const run = {
      began: this.deps.now(), abort: new AbortController(),
      closed: false, closing: false, ready: false, muted: false,
      messages: [], byRole: {}, seen: new Set(), nextMessage: 0,
      metrics: { startupMs: null, providerSeconds: null, estimatedVoiceUsd: null, usageFinal: false, initializationSeconds: 0 },
      remoteTracks: new Set(),
    };
    run.readyPromise = new Promise(resolve => { run.resolveReady = resolve; });
    run.closedPromise = new Promise(resolve => { run.resolveClosed = resolve; });
    this._active = run;
    this.hooks.onTranscript?.([]);
    this.hooks.onMetrics?.({ ...run.metrics });
    this.hooks.onPlaybackBlocked?.(false);
    this.hooks.onLevel?.({ input: 0, output: 0 });
    this._state('connecting');
    run.connectTimer = this.deps.setTimeout(() => this._fail(run, 'The voice connection timed out. Please try again.'), this.deps.connectTimeoutMs);
    void this._connect(run);
    return run.readyPromise;
  }

  async _connect(run) {
    try {
      const microphone = await this.deps.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!this._working(run)) { stopTracks(microphone); return; }
      run.microphone = microphone;
      const peer = new this.deps.PeerConnection();
      run.peer = peer;
      peer.addEventListener('track', event => {
        if (!this._working(run)) { event.track?.stop(); return; }
        run.remoteTracks.add(event.track);
        this.audio.srcObject = event.streams?.[0] || new this.deps.MediaStream([event.track]);
        void this._play(run);
      });
      peer.addEventListener('connectionstatechange', () => {
        if (!this._working(run)) return;
        if (peer.connectionState === 'failed') this._fail(run, 'The voice connection was lost. Start a new conversation.');
        // A transient disconnected state is recoverable by ICE. Bound it so
        // the UI cannot remain "listening" indefinitely after network loss.
        if (peer.connectionState === 'disconnected' && !run.disconnectTimer) {
          run.disconnectTimer = this.deps.setTimeout(() => {
            if (peer.connectionState === 'disconnected') this._fail(run, 'The voice connection was interrupted. Start a new conversation.');
          }, 8_000);
        } else if (peer.connectionState === 'connected') {
          this.deps.clearTimeout(run.disconnectTimer);
          run.disconnectTimer = null;
        }
      });
      for (const track of microphone.getAudioTracks()) {
        track.enabled = !run.muted;
        peer.addTrack(track, microphone);
      }
      const events = peer.createDataChannel('oai-events');
      run.events = events;
      events.addEventListener('message', ({ data }) => this._event(run, data));
      events.addEventListener('close', () => {
        if (!this._current(run)) return;
        if (run.closing) this._finish(run, 'idle', { reason: run.stopReason, usageFinal: false });
        else this._fail(run, 'The voice connection closed without final usage. Start a new conversation.');
      });
      events.addEventListener('error', () => this._fail(run, 'The voice event connection failed. Please try again.'));
      const offer = await peer.createOffer();
      if (!this._working(run)) return;
      await peer.setLocalDescription(offer);
      if (!this._working(run)) return;
      await this._gatherIce(run);
      if (!this._working(run)) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('missing-sdp');
      const response = await this.deps.fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }), signal: run.abort.signal,
      });
      if (!this._working(run)) return;
      let result;
      try { result = await response.json(); } catch { throw new Error('invalid-response'); }
      if (!this._working(run)) return;
      if (!response.ok) {
        this._fail(run, publicError({ status: response.status, code: result?.code }));
        return;
      }
      if (!result?.transport?.sdp || typeof result.transport.sdp !== 'string') throw new Error('missing-answer');
      run.metrics.initializationSeconds = 15;
      this._metrics(run);
      await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
      if (!this._working(run)) return;
      // HTTP starts GPT-Live. session.start and PCM events are not sent here.
      if (typeof peer.getStats === 'function') {
        run.levelTimer = this.deps.setInterval(() => { void this._levels(run); }, 150);
      }
    } catch (error) {
      if (!this._working(run)) return;
      this._fail(run, publicError(error));
    }
  }

  _gatherIce(run) {
    if (run.peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.deps.clearTimeout(timer);
        run.peer.removeEventListener('icegatheringstatechange', check);
        run.abort.signal.removeEventListener('abort', aborted);
      };
      const check = () => {
        if (run.peer.iceGatheringState !== 'complete') return;
        cleanup(); resolve();
      };
      const aborted = () => { cleanup(); reject(new Error('aborted')); };
      const timer = this.deps.setTimeout(() => { cleanup(); reject(new Error('ice-timeout')); }, 10_000);
      run.peer.addEventListener('icegatheringstatechange', check);
      run.abort.signal.addEventListener('abort', aborted, { once: true });
      if (run.abort.signal.aborted) aborted();
      else check();
    });
  }

  _event(run, data) {
    if (!this._current(run)) return;
    let event;
    try { event = JSON.parse(data); } catch { this._fail(run, 'The voice service sent an unreadable event. Please reconnect.'); return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      const seconds = event.usage?.seconds;
      if (Number.isFinite(seconds) && seconds >= 0) {
        // Usage updates are cumulative, not increments.
        run.metrics.providerSeconds = Math.max(run.metrics.providerSeconds ?? 0, seconds);
      }
      if (event.type === 'session.closed') run.metrics.usageFinal = Number.isFinite(seconds) && seconds >= 0;
      this._metrics(run);
      if (event.type === 'session.closed') this._finish(run, 'idle', { reason: run.stopReason || 'provider-closed', usageFinal: run.metrics.usageFinal });
      return;
    }
    if (run.closing) return;
    if (event.type === 'session.started' && !run.ready) {
      run.ready = true;
      run.metrics.startupMs = Math.round(this.deps.now() - run.began);
      this.deps.clearTimeout(run.connectTimer);
      this._metrics(run);
      this._state('listening');
      run.resolveReady(true);
    } else if (event.type === 'error') {
      this._fail(run, publicError(event.error || {}));
    } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
      this._transcript(run, role, event);
    }
  }

  _transcript(run, role, event) {
    if (typeof event.delta !== 'string' || !event.delta) return;
    if (event.event_id && run.seen.has(event.event_id)) return;
    if (event.event_id) {
      run.seen.add(event.event_id);
      if (run.seen.size > 512) run.seen.delete(run.seen.values().next().value);
    }
    let row = run.byRole[role];
    const timed = Number.isFinite(event.start_ms) && Number.isFinite(row?.endMs);
    // Caption rows follow the conversation's speaker changes even when
    // timestamps are close. Reusing an earlier same-role row would put a
    // quick answer above the assistant's question and leave a stale caption.
    const separate = run.messages.at(-1)?.role !== role || (timed && event.start_ms - row.endMs > 2_000);
    if (!row || separate || row.text.length >= 4_000) {
      row = { id: String(++run.nextMessage), role, text: '', endMs: null };
      run.messages.push(row);
      run.byRole[role] = row;
    }
    row.text = (row.text + event.delta).slice(0, 4_000);
    if (Number.isFinite(event.end_ms)) row.endMs = event.end_ms;
    while (run.messages.length > 50 || run.messages.reduce((n, item) => n + item.text.length, 0) > 24_000) {
      const removed = run.messages.shift();
      if (run.byRole[removed.role] === removed) delete run.byRole[removed.role];
    }
    this.hooks.onTranscript?.(run.messages.map(({ id, role: speaker, text }) => ({ id, role: speaker, text })));
  }

  _metrics(run) {
    if (!this._current(run)) return;
    if (run.metrics.initializationSeconds) {
      run.metrics.estimatedVoiceUsd = Math.max(run.metrics.initializationSeconds, run.metrics.providerSeconds ?? 0) * 0.05 / 60;
    }
    this.hooks.onMetrics?.({ ...run.metrics });
  }

  async _levels(run) {
    if (!this._working(run) || run.statsPending) return;
    run.statsPending = true;
    try {
      const stats = await run.peer.getStats();
      if (!this._working(run)) return;
      let input = 0; let output = 0;
      const counters = new Map();
      stats.forEach((stat, key) => {
        if (stat.kind !== 'audio' && stat.mediaType !== 'audio') return;
        const id = stat.id ?? key;
        let value = 0;
        const energy = stat.totalAudioEnergy;
        const duration = stat.totalSamplesDuration;
        if (Number.isFinite(energy) && energy >= 0 && Number.isFinite(duration) && duration >= 0) {
          counters.set(id, { energy, duration });
          const previous = run.levelCounters?.get(id);
          // WebKit may omit audioLevel. The cumulative energy/duration
          // difference gives RMS over this polling interval, not all time.
          // A new/reset counter needs a fresh baseline before showing a level.
          if (previous && energy >= previous.energy && duration > previous.duration) {
            value = Math.min(1, Math.sqrt((energy - previous.energy) / (duration - previous.duration)));
          }
        }
        if (Number.isFinite(stat.audioLevel)) value = Math.min(1, Math.max(0, stat.audioLevel));
        if (stat.type === 'media-source') input = Math.max(input, value);
        if (stat.type === 'inbound-rtp') output = Math.max(output, value);
      });
      run.levelCounters = counters;
      this.hooks.onLevel?.({ input: run.muted ? 0 : input, output });
    } catch { /* Audio continues even when a browser has no level statistics. */ }
    finally { run.statsPending = false; }
  }

  mute(muted = true) {
    const run = this._active;
    if (!run || run.closing) return false;
    run.muted = Boolean(muted);
    run.microphone?.getAudioTracks().forEach(track => { track.enabled = !run.muted; });
    return run.muted;
  }

  async _play(run) {
    try {
      await this.audio.play();
      if (this._working(run)) this.hooks.onPlaybackBlocked?.(false);
      return true;
    } catch {
      if (this._working(run)) this.hooks.onPlaybackBlocked?.(true);
      return false;
    }
  }

  async enableAudio() {
    return this._active && this._working(this._active) ? this._play(this._active) : false;
  }

  async stop(reason = 'user') {
    const run = this._active;
    if (!run) return;
    if (run.closing) return run.closedPromise;
    run.closing = true;
    run.stopReason = reason;
    run.abort.abort();
    this.deps.clearTimeout(run.connectTimer);
    stopTracks(run.microphone);
    this.audio.pause?.();
    this.audio.srcObject = null;
    this.hooks.onLevel?.({ input: 0, output: 0 });
    this._state('closing');
    run.resolveReady(false);
    if (run.events?.readyState === 'open' && run.ready) {
      run.closeTimer = this.deps.setTimeout(() => this._finish(run, 'idle', { reason, usageFinal: false }), this.deps.closeTimeoutMs);
      try { run.events.send(JSON.stringify({ type: 'session.close' })); }
      catch { this._finish(run, 'idle', { reason, usageFinal: false }); }
    } else this._finish(run, 'idle', { reason, usageFinal: false });
    return run.closedPromise;
  }

  _fail(run, message) {
    if (!this._working(run)) return;
    this._finish(run, 'error', { usageFinal: false });
    this.hooks.onError?.(message);
  }

  _finish(run, state, detail) {
    if (!this._current(run)) return;
    run.closed = true;
    run.abort.abort();
    this.deps.clearTimeout(run.connectTimer);
    this.deps.clearTimeout(run.closeTimer);
    this.deps.clearTimeout(run.disconnectTimer);
    this.deps.clearInterval(run.levelTimer);
    stopTracks(run.microphone);
    run.remoteTracks.forEach(track => track?.stop());
    try { run.events?.close(); } catch { /* Already closed. */ }
    try { run.peer?.close(); } catch { /* Already closed. */ }
    this.audio.pause?.();
    this.audio.srcObject = null;
    this._active = null;
    this.hooks.onLevel?.({ input: 0, output: 0 });
    this.hooks.onPlaybackBlocked?.(false);
    this._state(state, detail);
    run.resolveReady(false);
    run.resolveClosed();
  }

  async dispose() {
    this._disposed = true;
    this.deps.document?.removeEventListener('visibilitychange', this._hidden);
    this.deps.window?.removeEventListener('pagehide', this._pagehide);
    await this.stop('disposed');
  }
}

function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }

function publicError(error) {
  const code = String(error?.code || '').toLowerCase();
  if (code === 'quota_exceeded' || code.includes('insufficient_quota')) return 'The OpenAI project has no available API quota. Check its billing or usage limit, then start again.';
  if (error?.status === 429 || code.includes('rate_limit')) return 'OpenAI is rate limiting this request. Wait a moment, then try again.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Microphone access was blocked. Allow microphone access for this page, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
  if (error?.name === 'NotReadableError') return 'The microphone is unavailable or in use by another application.';
  if (error?.status === 401 || error?.status === 403) return 'The voice service could not authenticate this project. Check its API access on the server.';
  if (error?.status === 503) return 'The voice service is not configured or temporarily unavailable. Check the local server.';
  return 'The voice connection failed. Check your connection and try again.';
}
