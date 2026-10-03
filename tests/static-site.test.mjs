import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { CONTENT_SECURITY_HEADER, CONTENT_SECURITY_POLICY } from '../shared/content-policy.mjs';

const root = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

async function browserFiles(directory) {
  const found = [];
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await browserFiles(`${directory}${entry.name}/`));
    else if (/\.(m?js|jsx|html|css|json)$/.test(entry.name)) found.push(`${directory}${entry.name}`);
  }
  return found;
}

test('nothing the browser loads can carry the API key: the page is public, the key is not', async () => {
  const files = ['index.html', 'vite.config.js', ...await browserFiles('src/'), ...await browserFiles('shared/'), ...await browserFiles('public/')];
  assert.ok(files.length > 50);
  for (const file of files) {
    assert.doesNotMatch(await text(file), /API_KEY|xi-api-key|\bsk_[A-Za-z0-9]{16,}/, `${file} must not mention a key`);
  }
  // The publishing workflow has nothing secret to pass to a build either.
  assert.doesNotMatch(await text('.github/workflows/pages.yml'), /secrets\.|API_KEY/);
  assert.match(await text('.github/workflows/pages.yml'), /npm run build:pages/);
  assert.match(await text('.gitignore'), /^\.env$/m);
});

test('the static build names a public agent by its ID and nothing else changes for the local one', async () => {
  const { default: config } = await import('../vite.config.js');
  const before = process.env.VITE_ELEVENLABS_AGENT_ID;
  try {
    process.env.VITE_ELEVENLABS_AGENT_ID = 'agent_public_example';
    const pages = config({ mode: 'pages', command: 'build' });
    assert.deepEqual(pages.define, { 'import.meta.env.VITE_ELEVENLABS_AGENT_ID': '"agent_public_example"' });
    // Relative paths, so the page works under whatever address the host gives it.
    assert.equal(pages.base, './');
    assert.equal(pages.build.outDir, 'dist-pages');
    assert.equal(pages.publicDir, false);
    for (const forged of ['../other?agent_id=x', 'agent id', '"><script>']) {
      process.env.VITE_ELEVENLABS_AGENT_ID = forged;
      assert.throws(() => config({ mode: 'pages', command: 'build' }), /No public agent/);
    }
    process.env.VITE_ELEVENLABS_AGENT_ID = 'agent_public_example';
    const local = config({ mode: 'production', command: 'build' });
    assert.deepEqual(local.define, {});
    assert.equal(local.base, '/');
    assert.equal(local.build.outDir, 'dist');
  } finally {
    if (before === undefined) delete process.env.VITE_ELEVENLABS_AGENT_ID; else process.env.VITE_ELEVENLABS_AGENT_ID = before;
  }
});

test('the static page carries the same policy the local server sends, less the one a page cannot state', () => {
  assert.equal(CONTENT_SECURITY_POLICY.includes('frame-ancestors'), false);
  assert.equal(CONTENT_SECURITY_HEADER.includes("frame-ancestors 'none'"), true);
  const directives = policy => policy.split(';').map(part => part.trim()).filter(part => !part.startsWith('frame-ancestors'));
  assert.deepEqual(directives(CONTENT_SECURITY_POLICY), directives(CONTENT_SECURITY_HEADER));
  assert.ok(directives(CONTENT_SECURITY_POLICY).includes("script-src 'self'"));
});

test('the voice page takes its agent and its worklet path from the build, not from the address bar', async () => {
  const main = await text('src/main.jsx');
  assert.match(main, /agentId: import\.meta\.env\.VITE_ELEVENLABS_AGENT_ID \|\| ''/);
  assert.match(main, /workletPath: `\$\{import\.meta\.env\.BASE_URL\}eleven-raw-audio\.js`/);
  assert.match(main, /new LiveVoiceSession\(\{[\s\S]*?\}, VOICE\);/);
});
