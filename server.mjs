import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_SECURITY_HEADER } from './shared/content-policy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const provider = 'elevenlabs';
const MAX_BODY_BYTES = 64 * 1024;
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.gif', 'image/gif'], ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.wasm', 'application/wasm'],
]);
const frontendRoutes = new Set(['/mosaic-lab', '/mosaic-lab/', '/course-mosaics', '/course-mosaics/']);
const privatePaths = new Set(['src', 'shared', 'tests', 'node_modules', 'server.mjs', 'package.json', 'package-lock.json', 'vite.config.js']);

async function readStaticAsset(distDirectory, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\//, '') || 'index.html'; }
  catch { return null; }
  const segments = relative.split('/');
  if (relative.includes('\\') || relative.includes('\0') || segments.some(part => !part || part.startsWith('.')) || privatePaths.has(segments[0])) return null;
  const type = mimeTypes.get(extname(relative).toLowerCase());
  if (!type || (type.startsWith('text/html') && relative !== 'index.html')) return null;
  try {
    const root = await realpath(distDirectory);
    const file = await realpath(join(root, relative));
    // A copied public symlink must never escape the built-site directory.
    if (!file.startsWith(`${root}${sep}`)) return null;
    return { body: await readFile(file), type };
  } catch { return null; }
}

function reply(response, status, body, contentType = 'application/json; charset=utf-8') {
  if (response.destroyed || response.writableEnded) return;
  const payload = contentType.startsWith('application/json') && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_HEADER,
  });
  response.end(payload);
}

function fail(response, status, code, error) {
  reply(response, status, { error, code });
}

function requestOrigin(request) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return null;
  const port = request.socket.localPort;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = request.headers.host;
  return typeof host === 'string' && allowed.has(host) ? `http://${host}` : null;
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    request.resume();
    throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    };
    const onError = () => {
      cleanup();
      rejectBody(Object.assign(new Error('Incomplete request'), { status: 400 }));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        rejectBody(Object.assign(new Error('Request too large'), { status: 413 }));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectBody(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
  });
}

function upstreamError(status, payload) {
  const code = payload?.detail?.status ?? payload?.error?.code;
  if (['quota_exceeded', 'insufficient_credits', 'insufficient_quota'].includes(code)) {
    return [429, 'quota_exceeded', 'ElevenLabs has no available voice credits. Check the account’s billing or usage limit before trying again.'];
  }
  if (status === 429) {
    return [429, 'rate_limited', 'ElevenLabs temporarily rate limited this request. Wait a moment, then try starting again.'];
  }
  if (status === 401) return [502, 'provider_auth', 'ElevenLabs rejected the server API key. Check the key in this project’s .env file.'];
  if (status === 403 || status === 404) return [503, 'agent_unavailable', 'The Plato voice agent is unavailable. Check agent access for the server API key.'];
  return [502, 'provider_error', 'ElevenLabs could not start the voice session. Try starting again.'];
}

/** Local development server; no tutor code, saved conversations, or audio proxy. */
export function createPlaygroundServer({
  apiKey = process.env.ELEVENLABS_API_KEY,
  agentId = process.env.ELEVENLABS_AGENT_ID,
  fetchImpl = globalThis.fetch,
  distDirectory = join(directory, 'dist'),
  requestTimeoutMs = 30_000,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const agent = typeof agentId === 'string' ? agentId.trim() : '';
  const configured = Boolean(key && /^[A-Za-z0-9_-]{1,256}$/.test(agent));
  const pending = new Set();
  const server = createServer(async (request, response) => {
    try {
      const origin = requestOrigin(request);
      if (!origin) return fail(response, 403, 'invalid_host', 'Use the local playground address.');
      const path = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && path === '/api/health') {
        return reply(response, 200, { ok: true, configured, provider });
      }
      if (request.method === 'GET' && !path.startsWith('/api/')) {
        const asset = await readStaticAsset(distDirectory, frontendRoutes.has(path) ? '/index.html' : path);
        if (asset) return reply(response, 200, asset.body, asset.type);
        return fail(response, 404, 'not_found', 'File not found. Build the playground with npm run build if needed.');
      }
      if (path !== '/api/session') return fail(response, 404, 'not_found', 'Not found.');
      if (request.method !== 'POST') return fail(response, 405, 'method_not_allowed', 'Use POST for session creation.');
      if (request.headers.origin !== origin) return fail(response, 403, 'invalid_origin', 'Session requests must come from this page.');
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return fail(response, 415, 'invalid_content_type', 'Send an empty JSON object to start voice.');
      }
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        return fail(response, error.status ?? 400, error.status === 413 ? 'request_too_large' : 'invalid_json', error.status === 413 ? 'The session request exceeds 64 KB.' : 'The session request is not valid JSON.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        return fail(response, 400, 'invalid_session_request', 'Send only an empty JSON object. This voice playground accepts no study context or session overrides.');
      }
      if (!configured) return fail(response, 503, 'not_configured', 'Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in this project’s .env file, then restart the server.');
      const controller = new AbortController();
      pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnected);
      try {
        const upstream = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversation/token?${new URLSearchParams({ agent_id: agent })}`, {
          method: 'GET',
          headers: { 'xi-api-key': key, Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
        let payload;
        try { payload = await upstream.json(); } catch { payload = null; }
        if (!upstream.ok) return fail(response, ...upstreamError(upstream.status, payload));
        if (typeof payload?.token !== 'string' || !payload.token.trim() || payload.token.length > 16_384 || /\s/.test(payload.token)) {
          return fail(response, 502, 'invalid_provider_response', 'ElevenLabs returned an invalid voice token. Try starting again.');
        }
        // A fresh, short-lived conversation token is the only browser credential.
        // The API key, agent configuration, and provider metadata stay server-side.
        return reply(response, 201, { conversationToken: payload.token });
      } catch {
        return fail(response, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'provider_timeout' : 'provider_unreachable', controller.signal.aborted ? 'Starting the voice session timed out. Try starting again.' : 'Could not reach ElevenLabs. Check the connection, then try starting again.');
      } finally {
        clearTimeout(timeout);
        response.off('close', disconnected);
        pending.delete(controller);
      }
    } catch {
      fail(response, 500, 'server_error', 'The local server could not handle this request.');
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.shutdown = () => {
    for (const controller of pending) controller.abort();
    return new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeIdleConnections();
    });
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5190);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createPlaygroundServer();
  server.listen(port, '127.0.0.1', () => console.log(`Voice playground: http://127.0.0.1:${port}`));
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : 'The voice playground server could not start.');
    process.exitCode = 1;
  });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    await server.shutdown();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
