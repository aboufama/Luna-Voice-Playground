import { validateMaterials } from './study.js';
import { demoBoard, demoSubjects } from './board-demo-data.mjs';

// UI-only replacements for the study app's services. This module has no fetch,
// socket, provider credentials, model calls, storage, or server dependencies.
const ROUTES = new Set(['/api/organize', '/api/debug/event', '/api/debug/usage', '/api/debug/activity', '/api/debug/diagnostics', '/api/debug/learning-trace']);
const NUMERIC_DETAILS = new Set(['sourceCount', 'characters', 'durationMs', 'fileBytes', 'added', 'duplicates', 'failed', 'total', 'latencyMs', 'turnId', 'startupMs', 'providerSeconds', 'initializationSeconds']);
const STRING_DETAILS = new Set(['reason', 'phase', 'source', 'stage', 'fileName', 'fileType', 'indexStatus', 'state', 'transport']);
const clean = (value, length = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, length) : '';
const validTestId = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
function safeDetails(value = {}) {
  const details = {};
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (NUMERIC_DETAILS.has(key) && Number.isFinite(item) && item >= 0) details[key] = item;
    else if (STRING_DETAILS.has(key) && typeof item === 'string') details[key] = clean(item);
    else if (key === 'usageFinal' && typeof item === 'boolean') details[key] = item;
    else if (key === 'sourceIds' && Array.isArray(item)) details[key] = item.filter(id => typeof id === 'string').slice(0, 100).map(id => clean(id, 160));
  }
  return details;
}
const emptyUsage = (id, requests = 0) => ({ id, requests, complete: false, exactUsd: null, estimatedUsd: null, estimatedRequests: 0, unestimatedRequests: requests, reportedCostRequests: 0, unpricedRequests: requests, pendingRequests: 0, missingUsageRequests: requests, units: {}, estimateSources: [] });

export function createPlaygroundServices({ now = Date.now, maxEvents = 300, maxTests = 20 } = {}) {
  const tests = new Map();
  let sequence = 0;
  function testState(testId) {
    let state = tests.get(testId);
    if (!state) {
      state = { trackingStartedAt: new Date(now()).toISOString(), events: [], sessions: [], voiceSessionIds: new Set(), voiceSeconds: new Map(), omittedEvents: 0 };
      tests.set(testId, state);
      if (tests.size > maxTests) tests.delete(tests.keys().next().value);
    }
    return state;
  }
  function record(testId, event = {}, origin = 'local-ui') {
    if (!validTestId(testId) || !event || typeof event !== 'object' || !/^[a-z][a-z0-9._-]{0,70}$/.test(event.type || '')) return false;
    const state = testState(testId);
    state.events.push({ id: `local-event-${++sequence}`, testId, at: new Date(now()).toISOString(), origin, type: event.type, ...(event.sessionId ? { sessionId: clean(event.sessionId, 160) } : {}), details: safeDetails(event.details || event) });
    while (state.events.length > maxEvents) { state.events.shift(); state.omittedEvents++; }
    return true;
  }
  function recordPlaygroundVoice(testId, event = {}) {
    if (!validTestId(testId) || !event || typeof event !== 'object') return false;
    const state = testState(testId);
    const sessionId = clean(event.sessionId, 160) || 'current-voice-session';
    const accepted = record(testId, { ...event, sessionId, type: event.type || 'voice.event' }, 'local-voice-client');
    if (!accepted) return false;
    if (event.type === 'session.started' || event.type === 'voice.started' || event.state === 'connected' || Number.isFinite(event.startupMs) || event.initializationSeconds > 0) state.voiceSessionIds.add(sessionId);
    if (Number.isFinite(event.providerSeconds) && event.providerSeconds >= 0) state.voiceSeconds.set(sessionId, Math.max(state.voiceSeconds.get(sessionId) || 0, event.providerSeconds));
    let session = state.sessions.find(item => item.id === sessionId);
    if (!session) {
      session = { id: sessionId, startedAt: new Date(now()).toISOString(), endedAt: null, entries: [] };
      state.sessions.push(session);
      if (state.sessions.length > 20) state.sessions.shift();
    }
    if (event.type === 'session.closed' || event.type === 'voice.ended') session.endedAt = new Date(now()).toISOString();
    if (['user', 'assistant'].includes(event.role) && typeof event.text === 'string' && event.text.trim()) {
      const text = clean(event.text, 12000);
      const turnId = typeof event.turnId === 'string' || Number.isSafeInteger(event.turnId) ? event.turnId : null;
      const existing = turnId === null ? null : session.entries.find(item => item.turnId === turnId && item.role === event.role);
      if (existing) Object.assign(existing, { text, end: text.length });
      else session.entries.push({ id: `local-transcript-${++sequence}`, role: event.role, text, at: new Date(now()).toISOString(), turnId, sentenceIndex: 0, start: 0, end: text.length, status: 'unclassified', classification: null, checkedGrades: [] });
      if (session.entries.length > 200) session.entries.shift();
    }
    return true;
  }
  async function demoFetch(url, options = {}) {
    options.signal?.throwIfAborted();
    // Relative allowlisted URLs only: an accidental external request cannot
    // silently fall through to the network, including absolute localhost URLs.
    const pathname = typeof url === 'string' && url.startsWith('/api/') ? url.split('?')[0] : '';
    if (!ROUTES.has(pathname)) return Response.json({ error: 'This service is disabled in the UI playground.' }, { status: 404 });
    if ((options.method || 'GET').toUpperCase() !== 'POST') return Response.json({ error: 'Use POST for this local action.' }, { status: 405 });
    let body;
    try { body = JSON.parse(options.body || '{}'); } catch { return Response.json({ error: 'Send valid JSON.' }, { status: 400 }); }
    if (!body || Array.isArray(body) || !validTestId(body.testId)) return Response.json({ error: 'Choose a test to inspect.' }, { status: 400 });
    options.signal?.throwIfAborted();
    const state = testState(body.testId);
    if (pathname === '/api/organize') {
      let stats;
      try { stats = validateMaterials(body.materials); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      record(body.testId, { type: 'local.materials.ready', details: { sourceCount: stats.sourceCount, characters: stats.totalCharacters } });
      return Response.json({ guide: { mode: 'ui-demo', ...stats, overview: 'Stored in this browser for UI testing. AI indexing, retrieval, and question preparation are disabled.', topics: [], questions: [] } });
    }
    if (pathname === '/api/debug/event') return Response.json({ accepted: record(body.testId, body.event) });
    if (pathname === '/api/debug/activity' || pathname === '/api/debug/diagnostics') return Response.json({ testId: body.testId, trackingStartedAt: state.trackingStartedAt, events: state.events, truncated: state.omittedEvents > 0, omittedEvents: state.omittedEvents, storageError: null, measurement: 'Local browser events only, held in memory until reload. No study backend calls or background classification. Voice events do not prove audible playback.' });
    if (pathname === '/api/debug/learning-trace') {
      const count = state.sessions.reduce((total, session) => total + session.entries.length, 0);
      return Response.json({ testId: body.testId, sessions: state.sessions, summary: { sentences: count, classified: 0, queued: 0, classifying: 0, unclassified: count }, worker: { enabled: false }, measurement: 'Optional browser voice transcripts only; no classifier, checked grades, or mastery scoring.' });
    }
    const voiceUsage = emptyUsage('voice', state.voiceSessionIds.size);
    if (state.voiceSeconds.size) voiceUsage.units.sessionDurationMs = [...state.voiceSeconds.values()].reduce((total, seconds) => total + seconds * 1000, 0);
    return Response.json({ testId: body.testId, scope: 'browser-memory', trackingStartedAt: state.trackingStartedAt, categories: [emptyUsage('jev'), emptyUsage('llm'), voiceUsage], totals: emptyUsage('total', state.voiceSessionIds.size), unattributed: emptyUsage('unattributed'), storage: { status: 'memory-only' }, notes: ['The study backend is disconnected. Jev, indexing, and grading are not called.', 'Voice sessions use a real provider. This UI has no billing or token-usage feed; unavailable spend is not zero spend.'] });
  }
  return { demoFetch, recordPlaygroundVoice };
}

const localServices = createPlaygroundServices();
export const demoFetch = localServices.demoFetch;
export const recordPlaygroundVoice = localServices.recordPlaygroundVoice;

// Explicit fixtures for visual regression testing, never model output or grades.
// Callers opt in with a URL scenario; these are not part of the voice context.
export function getPlaygroundScenario(name, { clock = performance.now() } = {}) {
  if (!['board', 'hint', 'practice', 'captions', 'paused'].includes(name)) return null;
  const example = demoSubjects.find(subject => subject.id === 'algebra').examples[0];
  const whiteboard = demoBoard(example, 'local-preview-1');
  const hintState = { questionId: 'ui-preview-question', remaining: 3, available: name === 'hint', busy: false, suggested: name === 'hint', reason: 'ready', retryAt: clock, receivedAt: clock, pending: false };
  return {
    whiteboard: name === 'board' || name === 'hint' ? whiteboard : null,
    hintState,
    practiceState: { current: { questionId: 'ui-preview-question', question: example.prompt, topicTitle: 'UI preview' }, recent: [] },
    presence: name === 'paused' ? { paused: true, resuming: false } : null,
    subtitle: 'Local UI preview. Nothing here is graded or sent to the voice model.',
    voiceState: name === 'paused' ? 'paused' : 'listening',
  };
}
