import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { CONTENT_SECURITY_POLICY } from './shared/content-policy.mjs';

// The public agent the static site talks to, as scripts/setup-eleven-agent.mjs --public left it.
// An agent ID is an address, not a credential: the API key never reaches a build.
function publicAgent() {
  let id = process.env.VITE_ELEVENLABS_AGENT_ID;
  if (!id) {
    try { id = JSON.parse(readFileSync(new URL('./eleven-public-agent.json', import.meta.url), 'utf8')).agent_id; } catch {}
  }
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
    throw new Error('No public agent to build for. Run: node scripts/setup-eleven-agent.mjs --public <hostname>');
  }
  return id;
}

// A static host sends no headers of its own, so the page carries its policy,
// and it takes the one file the voice page needs from public/ instead of all of it.
function staticSite() {
  return {
    name: 'plato-static-site',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' }],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'eleven-raw-audio.js', source: readFileSync(new URL('./public/eleven-raw-audio.js', import.meta.url)) });
    },
  };
}

// `vite build` is the local playground: server.mjs serves dist and hands out
// tokens on the same loopback origin. `vite build --mode pages` is the same
// page for a static host such as GitHub Pages: relative paths, so it works
// under any address, and a public agent in place of the token server.
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    base: pages ? './' : '/',
    publicDir: pages ? false : 'public',
    plugins: [react(), ...(pages ? [staticSite()] : [])],
    define: pages ? { 'import.meta.env.VITE_ELEVENLABS_AGENT_ID': JSON.stringify(publicAgent()) } : {},
    build: { target: 'es2022', outDir: pages ? 'dist-pages' : 'dist', emptyOutDir: true },
  };
});
