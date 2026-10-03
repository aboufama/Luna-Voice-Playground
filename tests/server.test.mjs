import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createPlaygroundServer } from '../server.mjs';

const providerAnswer = { token: 'example-short-lived-conversation-token' };
const browserAnswer = { conversationToken: providerAnswer.token };

function rawPost(origin, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function harness(t, options = {}) {
  const distDirectory = await mkdtemp(join(tmpdir(), 'voice-playground-test-'));
  await mkdir(join(distDirectory, 'assets'));
  await mkdir(join(distDirectory, 'course-mosaics'));
  await Promise.all([
    writeFile(join(distDirectory, 'index.html'), '<!doctype html><title>Voice demo fixture</title>'),
    writeFile(join(distDirectory, 'assets', 'index-abc123.js'), 'export const demo = true;'),
    writeFile(join(distDirectory, 'assets', 'index-abc123.css'), ':root { color: black; }'),
    writeFile(join(distDirectory, 'assets', 'font-abc123.woff2'), Buffer.from([119, 79, 70, 50])),
    writeFile(join(distDirectory, 'course-mosaics', 'manifest.json'), JSON.stringify({ fixtures: [] })),
    writeFile(join(distDirectory, 'server.mjs'), 'secret-fixture-server-code'),
    writeFile(join(distDirectory, '.env'), 'ELEVENLABS_API_KEY=secret-fixture-never-serve'),
  ]);
  const calls = [];
  const server = createPlaygroundServer({ apiKey: 'test-server-only-key', agentId: 'agent_playground_example', distDirectory, fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json(providerAnswer);
  }, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await server.shutdown(); await rm(distDirectory, { recursive: true, force: true }); });
  const post = (body = {}, headers = {}) => fetch(`${origin}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { server, origin, post, calls };
}

test('mints only a fresh ElevenLabs conversation token with server-side credentials', async (t) => {
  const { post, calls } = await harness(t);
  const result = await post();
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), browserAnswer);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_playground_example');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers['xi-api-key'], 'test-server-only-key');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.body, undefined);
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal((await post()).status, 201);
  assert.equal(calls.length, 2, 'Each start gets a new token; server never reuses a token');
});

test('health and dist assets never return secrets or server files', async (t) => {
  const { origin, calls } = await harness(t);
  const health = await fetch(`${origin}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, configured: true, provider: 'elevenlabs' });
  const root = await fetch(origin);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.match(await root.text(), /Voice demo fixture/);
  assert.match(root.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  const connectPolicy = root.headers.get('content-security-policy').split(';').find(part => part.trim().startsWith('connect-src'));
  assert.equal(connectPolicy.trim(), "connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io");
  for (const [path, type] of [['/assets/index-abc123.js', 'text/javascript'], ['/assets/index-abc123.css', 'text/css'], ['/assets/font-abc123.woff2', 'font/woff2']]) {
    const asset = await fetch(`${origin}${path}`);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get('content-type').startsWith(type));
  }
  const manifest = await fetch(`${origin}/course-mosaics/manifest.json`);
  assert.deepEqual(await manifest.json(), { fixtures: [] });
  for (const path of ['/.env', '/server.mjs', '/package.json', '/tests/server.test.mjs', '/%2e%2e/.env', '/public/.env', '/src/main.jsx', '/shared/context.js', '/assets/index-abc123.js.map']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /secret-fixture|test-server-only-key/);
  }
  assert.equal(calls.length, 0);
});

test('rejects foreign and missing origins, bad hosts, and unsupported request shapes before provider calls', async (t) => {
  const { post, origin, calls } = await harness(t);
  for (const host of ['evil.example', '127.0.0.1:1', 'localhost.evil.example']) {
    const response = await rawPost(origin, { Host: host });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'invalid_host');
  }
  for (const badOrigin of ['https://evil.example', 'null', '', 'http://localhost:1']) {
    const response = await post({}, { Origin: badOrigin });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'invalid_origin');
  }
  const missing = await fetch(`${origin}/api/session`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(missing.status, 403);
  for (const body of [null, { sdp: 'v=0\r\ns=voice-demo\r\n' }, { instructions: 'untrusted override' }, { materials: [] }, { history: [] }, { agentId: 'agent_other' }, [], 'bad json', 'true', '"text"']) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${origin}/api/session`)).status, 405);
  for (const path of ['/api/gpt-live', '/api/live-voice', '/api/organize', '/api/speech']) {
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  }
  assert.equal(calls.length, 0);
});

test('accepts matching localhost origin while binding remains loopback', async (t) => {
  const { origin, server, calls } = await harness(t);
  const host = `localhost:${server.address().port}`;
  const result = await rawPost(origin, { Host: host, Origin: `http://${host}` });
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
});

test('bounds JSON payloads including chunked requests', async (t) => {
  const { post, origin, calls } = await harness(t);
  assert.equal((await post({ context: 'x'.repeat(65536) })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"context":"');
    req.write('x'.repeat(65536));
    req.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(calls.length, 0);
});

test('missing key or missing and malformed agent configuration makes no provider request', async (t) => {
  for (const options of [{ apiKey: '' }, { agentId: '' }, { agentId: '../private?agent_id=other' }]) {
    const { origin, post, calls } = await harness(t, options);
    assert.equal((await (await fetch(`${origin}/api/health`)).json()).configured, false);
    const response = await post();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'not_configured');
    assert.equal(calls.length, 0);
  }
});

test('provider errors distinguish quota from throttling without exposing messages or retrying', async (t) => {
  for (const [status, providerCode, expectedStatus, expectedCode] of [
    [429, 'too_many_concurrent_requests', 429, 'rate_limited'],
    [401, 'quota_exceeded', 429, 'quota_exceeded'],
    [401, 'invalid_api_key', 502, 'provider_auth'],
    [403, 'missing_permissions', 503, 'agent_unavailable'],
    [404, 'agent_not_found', 503, 'agent_unavailable'],
    [500, 'internal_error', 502, 'provider_error'],
  ]) {
    await t.test(providerCode, async (t) => {
      let count = 0;
      const { post } = await harness(t, { fetchImpl: async () => {
        count += 1;
        return Response.json({ detail: { status: providerCode, message: 'secret-fixture-private-upstream-details' } }, { status });
      } });
      const result = await post();
      assert.equal(result.status, expectedStatus);
      const payload = await result.json();
      assert.equal(payload.code, expectedCode);
      assert.doesNotMatch(JSON.stringify(payload), /secret-fixture/);
      assert.equal(count, 1);
    });
  }
});

test('strips extra provider fields and rejects malformed successful responses', async (t) => {
  const first = await harness(t, { fetchImpl: async () => Response.json({ ...providerAnswer, secret: 'do-not-return', agent: { internal: 'do-not-return' } }) });
  assert.deepEqual(await (await first.post()).json(), browserAnswer);
  for (const token of [undefined, null, '', ' ', 'bad token', 42, 'x'.repeat(16_385)]) {
    const { post } = await harness(t, { fetchImpl: async () => Response.json({ token }) });
    const response = await post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'invalid_provider_response');
  }
});

test('network errors and timeouts are bounded and sanitized', async (t) => {
  const network = await harness(t, { fetchImpl: async () => { throw new Error('secret-private-url'); } });
  const response = await network.post();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'provider_unreachable');
  const timeout = await harness(t, { requestTimeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const timedOut = await timeout.post();
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).code, 'provider_timeout');
});


test('dist asset symlinks cannot expose files outside the build root', async (t) => {
  const outerDirectory = await mkdtemp(join(tmpdir(), 'voice-playground-outside-'));
  const distDirectory = join(outerDirectory, 'dist');
  await mkdir(distDirectory);
  await writeFile(join(outerDirectory, 'private.js'), 'secret-private-outside');
  await symlink(join(outerDirectory, 'private.js'), join(distDirectory, 'leak.js'));
  t.after(() => rm(outerDirectory, { recursive: true, force: true }));
  const { origin } = await harness(t, { distDirectory });
  const response = await fetch(`${origin}/leak.js`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /secret-private-outside/);
});


test('serves only the two explicit client-side preview routes from the app entry', async (t) => {
  const { origin, calls } = await harness(t);
  for (const path of ['/mosaic-lab', '/mosaic-lab/', '/course-mosaics', '/course-mosaics/?view=all']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await response.text(), /Voice demo fixture/);
  }
  for (const path of ['/unknown-route', '/mosaic-lab/unknown', '/course-mosaics/missing.png', '/api/mosaic-lab']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  assert.equal(calls.length, 0);
});
