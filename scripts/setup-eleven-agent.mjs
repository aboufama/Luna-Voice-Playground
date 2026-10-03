import { readFile, writeFile, chmod } from 'node:fs/promises';

// node scripts/setup-eleven-agent.mjs
//   The private agent the local playground uses. Only this project's server,
//   holding the API key, can start a conversation with it.
// node scripts/setup-eleven-agent.mjs --public <hostname> [hostname...] [--daily=50] [--concurrent=3] [--minutes=10] [--silence=120]
//   A second, public agent for a static site (GitHub Pages), which has no
//   server to hold a key. Pages on the named hosts can start a conversation
//   with only its ID. Every conversation is billed to this ElevenLabs account,
//   so it is capped: conversations a day, at once, minutes each, and seconds
//   of the person saying nothing before it hangs up on an abandoned tab.
//   The hostname check reads the browser's Origin header, which a script can
//   forge. The caps are what bound the cost.
process.loadEnvFile('.env');
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw Error('Set ELEVENLABS_API_KEY in .env.');

const args = process.argv.slice(2);
const open = args.includes('--public');
const hosts = args.filter(arg => !arg.startsWith('--'));
const option = (name, fallback, most) => {
  const given = args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
  const value = given === undefined ? fallback : Number(given);
  if (!Number.isInteger(value) || value < 1 || value > most) throw Error(`--${name} must be a whole number from 1 to ${most}.`);
  return value;
};
const daily = option('daily', 50, 10_000), concurrent = option('concurrent', 3, 30), minutes = option('minutes', 10, 30), silence = option('silence', 120, 1800);
if (open && (hosts.length < 1 || hosts.length > 10 || hosts.some(host => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host)))) {
  throw Error('Name one to ten hostnames after --public, such as aboufama.github.io (no https://, no path).');
}
if (!open && hosts.length) throw Error('Hostnames only mean something after --public.');

const file = open ? 'eleven-public-agent.json' : 'eleven-agent-config.json';
const privacy = { record_voice: false, retention_days: 0, delete_transcript_and_pii: true, delete_audio: true };
const config = {
  name: open ? 'Luna UX Playground (public page)' : 'Luna UX Playground',
  conversation_config: {
    agent: {
      first_message: "Hey, it's Luna. What's on your mind?",
      language: 'en',
      prompt: {
        prompt: 'You are Luna, a warm conversational voice. Talk naturally about whatever the person brings up. Keep replies brief and leave room for back-and-forth. Follow their lead. This is a casual conversation, without tasks, study plans, quizzes, scoring, or an onboarding flow.',
        llm: 'gpt-6-luna',
        tools: [],
        tool_ids: [],
        knowledge_base: [],
      },
    },
    tts: { voice_id: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb', model_id: 'eleven_v4_turbo' },
    conversation: { max_duration_seconds: open ? minutes * 60 : 1800 },
    // The private agent waits as long as its owner likes. A stranger's forgotten tab is hung up on.
    ...(open ? { turn: { silence_end_call_timeout: silence } } : {}),
  },
  platform_settings: {
    auth: open
      ? { enable_auth: false, allowlist: hosts.map(hostname => ({ hostname })), require_origin_header: true }
      : { enable_auth: true },
    // Going past the account's own concurrency is charged at double rate, so a public page never does.
    ...(open ? { call_limits: { agent_concurrency_limit: concurrent, daily_limit: daily, bursting_enabled: false } } : {}),
    privacy,
    evaluation: { criteria: [] },
    data_collection: {},
  },
};
const headers = { 'xi-api-key': key, 'Content-Type': 'application/json' };
async function request(path, options = {}) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, { ...options, headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok) {
    // Only structured validation locations/status are printed, never inputs or credentials.
    const detail = Array.isArray(body.detail) ? body.detail.map(item => ({ loc: item.loc, message: item.msg })) : { status: body.detail?.status };
    throw Error(JSON.stringify({ status: response.status, detail }));
  }
  return body;
}
async function saved() {
  try { return JSON.parse(await readFile(file, 'utf8')).agent_id; } catch { return undefined; }
}
let agentId = open ? await saved() : process.env.ELEVENLABS_AGENT_ID;
if (!agentId) {
  // Recover a prior successful creation if setup was interrupted before saving.
  const listed = await request('agents?page_size=100');
  agentId = listed.agents?.find(agent => agent.name === config.name)?.agent_id;
}
if (agentId) {
  await request(`agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify(config) });
} else {
  const result = await request('agents/create', { method: 'POST', body: JSON.stringify(config) });
  agentId = result.agent_id;
}
if (!agentId) throw Error('Provider did not return an agent ID.');
if (!open) {
  const env = (await readFile('.env', 'utf8')).split('\n').filter(line => !line.startsWith('ELEVENLABS_AGENT_ID=')).join('\n').trimEnd();
  await writeFile('.env', `${env}\nELEVENLABS_AGENT_ID=${agentId}\n`);
  await chmod('.env', 0o600);
}
await writeFile(file, JSON.stringify({ ...config, agent_id: agentId }, null, 2) + '\n');
const checked = await request(`agents/${encodeURIComponent(agentId)}`);
const settings = checked.platform_settings ?? {};
const report = { configured: true, model: checked.conversation_config?.agent?.prompt?.llm, voiceModel: checked.conversation_config?.tts?.model_id, private: settings.auth?.enable_auth, tools: checked.conversation_config?.agent?.prompt?.tools?.length ?? 0, knowledgeSources: checked.conversation_config?.agent?.prompt?.knowledge_base?.length ?? 0, recordVoice: settings.privacy?.record_voice };
if (open) {
  // Knock the way a page on some other site would, and the way a script sending no origin would.
  // ElevenLabs hands a token to anyone who asks; it is the conversation itself that is refused,
  // so the check has to try to open one. A refusal closes the socket with code 3000.
  const refuses = origin => new Promise(done => {
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`, origin ? { headers: { Origin: origin } } : undefined);
    const timer = setTimeout(() => { socket.close(); done(false); }, 10000);
    const settle = refused => { clearTimeout(timer); done(refused); };
    socket.onmessage = () => { socket.close(); settle(false); };
    socket.onclose = event => settle(event.code === 3000);
    socket.onerror = () => {};
  });
  Object.assign(report, {
    hosts: settings.auth?.allowlist?.map(item => item.hostname),
    conversationsADay: settings.call_limits?.daily_limit,
    atOnce: settings.call_limits?.agent_concurrency_limit,
    doubleRateBursting: settings.call_limits?.bursting_enabled,
    minutesEach: checked.conversation_config?.conversation?.max_duration_seconds / 60,
    hangsUpAfterSilentSeconds: checked.conversation_config?.turn?.silence_end_call_timeout,
    refusesOtherSites: await refuses('https://not-this-page.example'),
    refusesNoOrigin: await refuses(null),
  });
}
console.log(JSON.stringify(report));
