import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaygroundServices, getPlaygroundScenario } from '../src/playground-services.mjs';
import { readImageMaterial } from '../src/image-imports.mjs';
import { validateMaterials } from '../src/study.js';
import { requestCourseAssignment } from '../src/course-mosaics/assignment.mjs';

const post = (service, route, body, extra = {}) => service.demoFetch(route, { method: 'POST', body: JSON.stringify(body), ...extra });
const source = { id: 'source-1', name: 'notes.txt', text: 'Private material should stay in this browser.' };

test('local organize validates files but never fabricates AI topics, questions, or analysis', async () => {
  const service = createPlaygroundServices();
  const response = await post(service, '/api/organize', { testId: 'one', materials: [source] });
  assert.equal(response.status, 200);
  const { guide } = await response.json();
  assert.equal(guide.mode, 'ui-demo');
  assert.deepEqual(guide.topics, []);
  assert.deepEqual(guide.questions, []);
  assert.equal(guide.sourceCount, 1);
  assert.match(guide.overview, /disabled/);
  assert.doesNotMatch(JSON.stringify(guide), /Private material/);
  assert.equal((await post(service, '/api/organize', { testId: 'one', materials: [] })).status, 400);
});

test('disabled and absolute service URLs never fall through to any network request', async () => {
  const service = createPlaygroundServices();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw Error('Network call must never occur'); };
  try {
    for (const url of ['/api/session', '/api/speak', '/api/material-images', 'https://example.com/api/organize', 'http://127.0.0.1:5190/api/organize']) {
      assert.equal((await post(service, url, { testId: 'one' })).status, 404);
    }
    await post(service, '/api/organize', { testId: 'one', materials: [source] });
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('local API observes cancellation, method, body, and test scope', async () => {
  const service = createPlaygroundServices();
  assert.equal((await service.demoFetch('/api/debug/usage')).status, 405);
  assert.equal((await service.demoFetch('/api/debug/usage', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await post(service, '/api/debug/usage', {})).status, 400);
  assert.deepEqual(await (await post(service, '/api/debug/event', { testId: 'one', event: null })).json(), { accepted: false });
  assert.equal(service.recordPlaygroundVoice('one', null), false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(post(service, '/api/organize', { testId: 'one', materials: [source] }, { signal: controller.signal }), { name: 'AbortError' });
});

test('diagnostic ring is bounded, scoped, and omits raw document and credential fields', async () => {
  const service = createPlaygroundServices({ maxEvents: 2 });
  for (let index = 0; index < 3; index++) await post(service, '/api/debug/event', { testId: 'one', event: { type: 'import.completed', details: { sourceCount: index, text: 'private file body', apiKey: 'not-a-real-secret', payload: { token: 'private' } } } });
  const data = await (await post(service, '/api/debug/activity', { testId: 'one' })).json();
  assert.equal(data.events.length, 2);
  assert.equal(data.truncated, true);
  assert.equal(data.omittedEvents, 1);
  assert.equal(data.events[1].details.sourceCount, 2);
  assert.doesNotMatch(JSON.stringify(data), /private|apiKey|payload/);
  assert.deepEqual((await (await post(service, '/api/debug/diagnostics', { testId: 'two' })).json()).events, []);
});

test('voice data records optional public transcripts without classifier or fabricated spend', async () => {
  const service = createPlaygroundServices();
  service.recordPlaygroundVoice('one', { type: 'voice.started', sessionId: 's1' });
  service.recordPlaygroundVoice('one', { type: 'voice.started', sessionId: 's1' });
  service.recordPlaygroundVoice('one', { type: 'voice.transcript', sessionId: 's1', turnId: 1, role: 'user', text: 'Hello' });
  service.recordPlaygroundVoice('one', { type: 'voice.transcript', sessionId: 's1', turnId: 1, role: 'user', text: 'Hello there' });
  service.recordPlaygroundVoice('one', { type: 'voice.ended', sessionId: 's1' });
  const trace = await (await post(service, '/api/debug/learning-trace', { testId: 'one' })).json();
  assert.equal(trace.summary.sentences, 1);
  assert.equal(trace.summary.classified, 0);
  assert.equal(trace.summary.queued, 0);
  assert.equal(trace.sessions[0].entries[0].text, 'Hello there');
  assert.deepEqual(trace.sessions[0].entries[0].checkedGrades, []);
  assert.ok(trace.sessions[0].endedAt);
  const usage = await (await post(service, '/api/debug/usage', { testId: 'one' })).json();
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.exactUsd, null);
  assert.equal(usage.totals.estimatedUsd, null);
  assert.equal(usage.totals.complete, false);
  assert.equal(usage.categories.find(category => category.id === 'jev').requests, 0);
});

test('image import preserves original local pixels and does not upload or pretend to analyze', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const file = new File([bytes], 'screenshot.png', { type: 'image/png' });
  let uploaded = false;
  const material = await readImageMaterial(file, { testId: 'one', fetchImpl: () => { uploaded = true; throw Error('Image uploaded'); } });
  assert.equal(uploaded, false);
  assert.equal(material.extraction.kind, 'local-image');
  assert.equal(material.extraction.textOrigin, 'local-placeholder');
  assert.equal(material.text, 'Local image preview; not analyzed.');
  assert.deepEqual(new Uint8Array(await material.originalImage.arrayBuffer()), bytes);
  assert.deepEqual(validateMaterials([material]), { sourceCount: 1, totalCharacters: material.text.length });
  assert.equal(material.originalImage.type, 'image/png');
  assert.equal(material.size, bytes.length);
  assert.equal(material.name, file.name);
});

test('image preview rejects invalid, empty, oversized, or canceled local inputs', async () => {
  await assert.rejects(readImageMaterial(new File(['x'], 'file.gif', { type: 'image/gif' }), { testId: 'one' }), /PNG/);
  await assert.rejects(readImageMaterial(new File([], 'image.png', { type: 'image/png' }), { testId: 'one' }), /empty/);
  await assert.rejects(readImageMaterial({ name: 'image.png', type: 'image/png', size: 21 * 1024 * 1024 }, { testId: 'one' }), /20 MB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readImageMaterial(new File(['x'], 'image.png', { type: 'image/png' }), { testId: 'one', signal: controller.signal }), { name: 'AbortError' });
});

test('explicit visual fixtures are fresh local objects and never claim checked mastery', () => {
  assert.equal(getPlaygroundScenario('unknown'), null);
  assert.equal(getPlaygroundScenario('paused').presence.paused, true);
  assert.equal(getPlaygroundScenario('hint').hintState.suggested, true);
  const first = getPlaygroundScenario('board', { clock: 0 });
  first.whiteboard.blocks[0].objects[0].text = 'modified';
  assert.equal(getPlaygroundScenario('board', { clock: 0 }).whiteboard.blocks[0].objects[0].text, 'Keep the equation balanced');
  assert.match(first.subtitle, /Local UI preview/);
  assert.equal(first.mastery, undefined);
});


test('course artwork assignment falls back locally without calling the old backend', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw Error('Old course backend called'); };
  try {
    const result = await requestCourseAssignment({ id: '00000000-0000-4000-8000-000000000001', title: 'Biology' });
    assert.equal(requests, 0);
    assert.equal(result.source, 'fallback');
    assert.equal(result.courseId, null);
  } finally { globalThis.fetch = original; }
});


test('observed provider voice durations remain distinct from unreported charges', async () => {
  const service = createPlaygroundServices();
  service.recordPlaygroundVoice('one', { type: 'voice.metrics', sessionId: 's1', startupMs: 1200, providerSeconds: 12, usageFinal: false });
  service.recordPlaygroundVoice('one', { type: 'voice.metrics', sessionId: 's1', providerSeconds: 15, usageFinal: true });
  service.recordPlaygroundVoice('one', { type: 'voice.metrics', sessionId: 's2', startupMs: 800, providerSeconds: 3, usageFinal: false });
  const usage = await (await post(service, '/api/debug/usage', { testId: 'one' })).json();
  const voice = usage.categories.find(category => category.id === 'voice');
  assert.equal(voice.requests, 2);
  assert.equal(voice.units.sessionDurationMs, 18000);
  assert.equal(voice.exactUsd, null);
  assert.equal(voice.estimatedUsd, null);
  const activity = await (await post(service, '/api/debug/activity', { testId: 'one' })).json();
  assert.equal(activity.events[0].details.startupMs, 1200);
  assert.equal(activity.events[1].details.usageFinal, true);
});
