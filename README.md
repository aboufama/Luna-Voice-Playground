# Luna UX Playground

**http://127.0.0.1:5190/** is a single voice screen using the Luna mosaic. Luna is live whenever the page is in view: there is no start, stop, or mute control. Captions appear while Luna speaks; errors use the same quiet caption area.

There is no top bar, back button, main menu, dock, account control, hat picker, provider selector, or Library. The only study feature is taking in a PDF by dragging it onto the mosaic. Saved study data and old scenario URLs are ignored. The original `../Luna-Study` project is independent.

## Always on

- Opening the page starts the conversation. The browser asks for the microphone the first time; once it is allowed, no click is needed, including for Luna's audio.
- Hiding the tab releases the microphone. Coming back opens a fresh conversation by itself.
- A dropped connection or failed token request retries on its own after 1, 2, 4, 8 and 15 seconds. A blocked microphone or an exhausted account waits for a person; allowing the microphone then starts Luna without a click.
- When ElevenLabs ends a session (the agent's 30-minute limit), Luna reconnects if anyone spoke during it. A session nobody spoke in is treated as an unattended tab: Luna rests until the pointer moves, a key is pressed, or the tab is refocused.
- Clicking the mosaic does nothing while Luna is live. While she is not, a click or key press retries at once.

The policy is `afterVoiceClose` in `src/voice-presence.mjs`. A live session keeps the screen awake (the SDK's wake lock) and is billed by ElevenLabs for as long as the tab stays in view.

## Mosaic

Grey stone means not connected. Colour means Luna is live.

**The rule:** every effect is made by individual stones. A stone can travel, turn, and take a glaze at its own moment. Nothing is scaled, filtered, blurred, or laid over the mosaic, and no stone ever changes size. What looks like the medallion growing is each course stepping outward by its own distance. `tests/mosaic-light.test.mjs` fails if the renderer gains any other canvas call.

- **Listening:** ink-blue glass, with the compass construction and the meander border in gold. Stones take and release their glaze one by one as it breathes.
- **Your voice:** the mirror image of Luna's. A tide of turquoise glaze enters at the rim and travels inward in rings, reaching further the louder you are and never flooding the centre. As it passes, each course turns as one rigid ring, rim first and inner courses further, so the mosaic winds like a vortex and unwinds when you stop. Every course also steps out slightly with the sound of the instant, all the way round, so the outline stays a circle. Loudness is measured against your own recent loudest moment.
- **Luna's voice:** warm glaze leaves the centre and travels outward in rings of parted stones, thinning before the rim, while the courses turn like nested dials.
- **Reduced motion:** the same colours, with no breathing, rings, or travel.

## Study material

Drag a PDF anywhere onto the page (or use the quiet line at the foot of the page to pick one).

- **While you hold it:** the side of the mosaic facing the file opens like a jaw, wider as the file comes closer.
- **On the drop:** the document arrives as a stream of stones that join the mosaic, and the opening closes behind them.
- **Chapters:** one stone per chapter then stands out of the rim, clockwise from the top. Press a stone, or its title in the list at the foot of the page, to choose that chapter; the chosen stone stands further out in the warm stone. The × puts the document away.
- **How chapters are found:** the PDF's own bookmarks if it has at least two; otherwise lines set as headings; otherwise even runs of pages. At most 24.
- **What Luna knows:** the PDF is read in the browser and is never uploaded as a file. When it arrives Luna is told its title and chapter titles. When a chapter is chosen she is sent that chapter's text, up to 15,000 characters in three messages, and told plainly if it was cut short. This is the only study data that reaches ElevenLabs, and it goes through `sendContext` in `src/eleven-voice.js`; starting a conversation still sends nothing. Every new conversation (after a reconnect or a hidden tab) is told again.
- **Limits:** PDFs only, up to 20 MB and 250 pages, text only (scans need OCR, which is not here). The document is held in memory and is gone on reload. Luna's agent prompt is still the casual-conversation one, so she will talk about the chapter but will not run a quiz unless asked.

The reading is in `src/study-material-pdf.js`, the chapter and briefing logic in `src/study-material.mjs`, the hatch and the chapter stones in `src/mosaic-light.mjs`. The sphere at `/?sphere` takes a document in its own way, described below.

## On a phone

Both versions fit a phone held upright (checked at 390×844 and 375×667): the mosaic, two lines of caption, and the document's chapters, with nothing to scroll sideways. On its side a phone is too short for all three, so the page scrolls.

- Nothing can be dragged onto a phone, so the line at the foot of the page reads "Add a PDF to study it with Luna" and opens the file picker. The stones then come up from that line, and the mosaic opens downward to take them.
- A chapter's stone can be tapped from further off than a mouse has to be (26 px instead of 15 or 16).
- Messages say "tap" where they would say "click".

## Sphere

**http://127.0.0.1:5190/?sphere** shows the same mosaic as a sphere of stone tesserae set in mortar, moving as a machine made of stone. The flat medallion stays the default. Voice behaviour is identical; only the picture changes.

- **Stones:** 3,596 rigid hand-cut stones, about a fifth larger than the flat medallion's, each with its own twelve-point outline, chipped corners, slight tilt and height. About 6% of the places are empty. A stone is its rock in colour and in relief: a split face that is domed, dished or ridged, with grain, pits and veins that catch the light, standing clearly proud of the mortar. Each palette colour is a real stone: lapis, yellow marble, a green stone for your voice, terracotta and red marble for Luna's, grey limestone when not connected.
- **Mortar:** a stack of rigid rings, one to a course, each carrying its own stones. Rough and sandy, with recessed joints, mortar squeezed up against the stones, and a socket where each stone sits or is missing. It is made at start-up from the layout itself (`sphere-mortar.mjs`); there are no image files.
- **Light:** one light from the upper left. Stones and mortar shade what lies behind them, and shade gathers in joints and pits.
- **Motion is mechanical.** Everything runs on a tick, twelve a second, and travels from one fixed stop to the next at one speed with a hard stop. Nothing fades, eases, drifts or changes colour in place.
  - A stone has two sides. To show a different stone it lifts clear of its socket, turns over and seats again, a quarter of a second in all; the side in the socket is the only one ever exchanged.
  - A ring turns about the poles in whole places, to a detent, taking its mortar with it.
  - A ring can stand up out of the sphere as a piston, in whole notches.
- **States:**
  - Not connected: grey sides out, rings out of register, still.
  - Connecting: a lock being dialled. Groups of rings stand up a notch and click round, seeking.
  - Going live: the rings find register from the pole outward, and behind that the stones turn over to colour.
  - Quiet: a clock. One ring steps one place a second, carrying one raised stone as its hand.
  - Luna speaking: stones turn to her stone ring by ring from the pole, more rings the louder she is, and each syllable ratchets those rings a place and back.
  - You speaking: the rings at the outline turn to green stone and stand up as pistons, a pair of rings to each part of the spectrum and a notch to each step of loudness; each syllable knocks ring after ring in to the centre, and the sphere tips towards you.
- **The same rule holds.** Two real objects are drawn, the mortar rings and the stones, twice a frame: first as the light sees them (depth only, to know what is in shadow), then the picture. Each stone gets only a rotation, a position and which stone is on each side. No blending, no image files, and nothing drawn after the picture. `tests/sphere-rigid.test.mjs` and `tests/sphere-motion.test.mjs` state these rules and fail if they are broken.
- It also turns one stop towards a moving pointer. Without WebGL2, or if the graphics context is lost and not restored, the flat medallion is shown instead.
- **A PDF:** while a file is held over the page, the stones of the eight rings nearest the outline, on the side facing the file, stand on edge like the slats of a shutter: two rings when the file is far off, all eight when it is close. On the drop the slats lie flat again a ring a tick, outermost first, the sphere knocks three times, and one stone per chapter stands up out of its ring, clockwise from the top. The chosen chapter's stone turns to the warm stone and stands twice as high. Press a stone, or its title at the foot of the page, to choose.

## Voice

ElevenLabs is the only active voice connection. The browser uses the official SDK over WebRTC. The tiny local server serves the page and issues a short-lived token from `POST /api/session`; that endpoint accepts only `{}` and rejects context or overrides. The API key stays in the server's `.env` and is never sent to a browser.

The separate private **Luna UX Playground** agent uses `eleven_v4_turbo`, the existing voice, and hosted `gpt-6-luna` for a brief, casual conversation. Its prompt is in `eleven-agent-config.json`. It has no tools, knowledge sources, retrieval, tests, grading, onboarding, or custom orchestration. Each connection is fresh, with only the current conversation and whatever chapter of a dropped PDF the page has told it about. Voice recording is disabled; transcript/audio deletion and zero-day retention are configured.

## GitHub Pages

A static host has no server to hold the API key, and a key written into a public page would hand the whole ElevenLabs account to anyone who views the source. So the published page uses neither a key nor a token server. It talks to a second, **public** agent by its ID, and ElevenLabs issues the conversation token to the browser directly.

- `node scripts/setup-eleven-agent.mjs --public <hostname>` creates or updates that agent (same voice, model and prompt as the private one) and writes `eleven-public-agent.json`. It needs the key in `.env`, so it runs on this machine only.
- `npm run build:pages` builds the same page into `dist-pages/` with that agent's ID, relative paths (it works under any address), the content policy in the page itself, and only the one file it needs from `public/`. `tests/static-site.test.mjs` fails if a key could reach anything the browser loads.
- `.github/workflows/pages.yml` runs the tests, builds, and publishes on every push to `main`. It uses no secrets.

Anyone who opens the page can talk to Luna, and every minute is drawn from this ElevenLabs account. What bounds that:

- **The agent's own limits**, set by the script (`--concurrent`, `--daily`, `--minutes`, `--silence`). As published: 5 conversations at once, 200 a day, 15 minutes each, and it hangs up after 3 minutes of the visitor saying nothing. The script's own defaults are tighter (3, 50, 10 minutes, 2 minutes). Going past the account's concurrency at double rate is turned off.
- **Clients cannot change Luna.** The prompt, first message, voice and model are fixed on the agent; a page can only talk to her and hand her text.
- **The hostname list is a weak fence.** The agent names the host it is published on, and ElevenLabs enforces that for its WebSocket transport. This page uses WebRTC, which has the better audio and is the one that behaves on phones, and WebRTC presents no origin at all. With "require an origin" switched on, ElevenLabs refuses every WebRTC conversation, this page's included (that is what the first publish did), so it is off, and a WebRTC client on any site that knows the agent ID is let in. The limits above are what bound the cost.
- **The account's plan.** With usage-based billing off, an exhausted month means Luna goes quiet everywhere, including the local playground, until the credits reset.

To take the page offline for visitors without touching the site, delete the public agent in ElevenLabs or run the script again with a different hostname.

## Run

Requires Node.js22.12 or later:

```sh
npm install
npm start
```

The current local `.env` is configured. For a separate setup, copy `.env.example`, supply your ElevenLabs key and agent ID, or run `node scripts/setup-eleven-agent.mjs` to create the private plain-conversation agent. Keep `.env` private.

After frontend edits, run `npm run build` and refresh. Restart after server edits. `npm run check` runs syntax, lifecycle/security tests, and the production build. `npm run build:pages` builds the static site for GitHub Pages.

## Edit

- `src/main.jsx`: mosaic-only screen; starts Luna, and reconnects, rests, or waits when a session ends.
- `src/voice-presence.mjs`: the always-on policy (retry delays, when to rest).
- `src/study-material.mjs`, `src/study-material-pdf.js`: turning a dropped PDF into chapters, and what Luna is told about it.
- `src/eleven-voice.js`: ElevenLabs connection (a token from the local server, or a public agent on a static host), captions, volume and spectrum, pause while hidden, and cleanup.
- `src/VoiceCanvas.jsx`: mosaic renderer; draws each stone as mineral plus up to three glazes.
- `src/mosaic-light.mjs`: living light: colour, breathing, voice rings, and how far the stones travel. Timings and strengths are the constants at the top.
- `src/mosaic-pigment.mjs`: the palette. Each stone's listening, crest, and Luna-speaking colours.
- `src/mosaic-choreography.mjs`, `src/mosaic-rest.mjs`: the original course rotation and rim drift.
- `src/sphere/`: the sphere. `sphere-field.mjs` lays the stones, gaps and motifs on the sphere, `sphere-motion.mjs` is the machine (ticks, stops, and what each state does), `sphere-mesh.mjs` is the stone shape and the mortar rings, `sphere-rock.mjs` and `sphere-mortar.mjs` generate the rock and mortar relief, `sphere-renderer.mjs` is the WebGL2 drawing, `SphereCanvas.jsx` mounts it.
- `src/talk-screen.css`: full-height layout after removing app controls.
- `server.mjs`: static serving and private token exchange.
- `vite.config.js`: the two builds, local and static. `shared/content-policy.mjs`: what the page may load and reach, for both.
- `scripts/setup-eleven-agent.mjs`: creates the private agent, and with `--public` the capped public one. `.github/workflows/pages.yml`: publishing.

The previously copied study components and GPT-Live experiments remain in source for reference but are not mounted or connected by this screen. Changing those files does not add features to this UX fork.

See `verification.json` for actual checks and limits. Microphone acoustic quality requires a real microphone check; synthetic tests do not establish that.

[Official ElevenLabs SDK documentation](https://elevenlabs.io/docs/eleven-agents/libraries/java-script)
