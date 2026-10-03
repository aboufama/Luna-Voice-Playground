import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import VoiceCanvas from './VoiceCanvas';
import SphereCanvas from './sphere/SphereCanvas.jsx';
import AssistantCaptions from './AssistantCaptions.jsx';
import { LiveVoiceSession } from './eleven-voice.js';
import { afterVoiceClose } from './voice-presence.mjs';
import { mosaicCircleCenter } from './mosaic-transition.mjs';
import { recordPlaygroundVoice } from './playground-services.mjs';
import { outlineBriefing, chapterBriefing, refusal } from './study-material.mjs';
import './style.css';
import './mosaic-stage.css';
import './talk-screen.css';

// /?sphere shows the mosaic as a sphere of tiles; the flat medallion stays the default.
const Mosaic = new URLSearchParams(window.location.search).has('sphere') ? SphereCanvas : VoiceCanvas;
// A build for a static host names a public agent, because there is no server to ask for a token.
const VOICE = { agentId: import.meta.env.VITE_ELEVENLABS_AGENT_ID || '', workletPath: `${import.meta.env.BASE_URL}eleven-raw-audio.js` };
// A phone is touched, not pointed at.
const TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;
// The voice session's messages are written for a desk; a phone is tapped, and keeps its permissions elsewhere.
const say = text => !TOUCH ? text : text.replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap')
  .replace('System Settings > Privacy & Security > Microphone', 'this browser’s settings on your phone');
const RESTING = TOUCH ? 'Resting. Touch the screen and Luna is back.' : 'Resting. Move the pointer or press a key and Luna is back.';
const RECONNECTING = 'Lost the connection. Reconnecting…';
const ENDED = 'The voice connection ended. Click the mosaic to reconnect.';
const PUT_AWAY = 'The person has put the document away. Do not refer to it again unless they hand you one.';
// Two presses on the mosaic this close together, in time and in place, ask for a document.
const TWICE = 400, TWICE_APART = 30, MOSAIC_REACH = 150;
// How long a document's or a chapter's name stays up after it is taken in or chosen.
const NAMED = 3200;

function App() {
  const [state, setState] = useState('idle');
  const [subtitle, setSubtitle] = useState('');
  const [error, setError] = useState('');
  // A document Luna has been handed: its title and chapters, and the chapter being studied.
  const [material, setMaterial] = useState(null);
  const [chapter, setChapter] = useState(-1);
  const [reading, setReading] = useState('');
  const [dragging, setDragging] = useState(false);
  const [intake, setIntake] = useState(null);
  // Nothing is written at the foot of the page. A name appears for a moment where Luna's words go:
  // the document's when it has been read, a chapter's when its stone is chosen or pointed at.
  const [named, setNamed] = useState(null);
  const [pointed, setPointed] = useState(-1);
  const screen = useRef(null), orb = useRef(null), session = useRef(null), picker = useRef(null), pegs = useRef(null), held = useRef(null);
  const naming = useRef(null), pressed = useRef({ at: -Infinity, x: 0, y: 0 });
  const level = useRef(0), captionCapacity = useRef(76);
  // Without a session the page is retrying on a timer, resting until someone
  // is back, or waiting for a person to fix something.
  const away = useRef({ mode: null, timer: null, failures: 0 });
  const audio = useRef((heard, spoken) => session.current?.readSpectrum(heard, spoken) ?? false);
  // Every conversation starts knowing nothing, so a new one is told again.
  const study = useRef({ material: null, chapter: -1 });

  // Luna knows only what she is told here: the chapter list, then the chosen chapter's text.
  function brief(live) {
    const { material: held, chapter: chosen } = study.current;
    if (!held) return;
    live.sendContext(outlineBriefing(held));
    for (const part of chapterBriefing(held, chosen)) live.sendContext(part);
  }

  // Luna is live whenever this page is in view. Nothing here stops her.
  function connect() {
    if (session.current) return;
    clearTimeout(away.current.timer);
    away.current.timer = null;
    // A tab opened in the background waits for its first look before using the microphone.
    if (document.hidden) { away.current.mode = 'resting'; return; }
    away.current.mode = null;
    setError('');
    setSubtitle('');
    const live = new LiveVoiceSession({
      onState: value => { if (session.current === live) setState(value); },
      onLevel: value => { if (session.current === live) level.current = value; },
      onCaption: message => {
        if (session.current !== live) return;
        setSubtitle(message.phrase ?? message.text ?? '');
        if (message.text) setError('');
      },
      onError: message => { if (session.current === live) setError(message); },
      onClose: ended => {
        if (session.current !== live) return;
        session.current = null;
        level.current = 0;
        setState('idle');
        const next = afterVoiceClose({ ...ended, failures: away.current.failures });
        away.current.failures = next.failures;
        if (next.action === 'reconnect') {
          away.current.mode = 'retrying';
          away.current.timer = setTimeout(connect, next.delayMs);
          // Nothing for the person to do yet, so do not ask them to click.
          if (ended.reason === 'error') setError(RECONNECTING);
        } else if (next.action === 'rest') {
          away.current.mode = 'resting';
          setSubtitle(RESTING);
        } else if (next.action === 'wait') {
          away.current.mode = 'waiting';
          setError(message => message || ENDED);
        }
      },
      onEvent: event => {
        if (event.type === 'voice.started' && session.current === live) brief(live);
        recordPlaygroundVoice('voice-playground', event);
      },
      onMetrics: metrics => recordPlaygroundVoice('voice-playground', { type: 'voice.metrics', ...metrics }),
    }, VOICE);
    session.current = live;
    live.setCaptionMaxChars(captionCapacity.current);
    void live.start();
  }

  function name(number, title) {
    clearTimeout(naming.current);
    setNamed({ number, title });
    naming.current = setTimeout(() => setNamed(null), NAMED);
  }

  // Where on the mosaic's surface something happened.
  function point(event) {
    const bounds = screen.current.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  // The stones take the document in while it is read here, in the browser.
  async function take(file, at) {
    const refused = refusal(file);
    if (refused) { setError(refused); return; }
    setError('');
    setReading(file.name);
    setIntake({ id: crypto.randomUUID(), x: at.x, y: at.y, count: 6 });
    try {
      const { readPdfMaterial } = await import('./study-material-pdf.js');
      const held = await readPdfMaterial(file);
      study.current = { material: held, chapter: -1 };
      setMaterial(held);
      setChapter(-1);
      name(0, held.title);
      session.current?.sendContext(outlineBriefing(held));
    } catch (problem) {
      setError(problem?.message || 'Could not read that PDF.');
    } finally { setReading(''); }
  }

  function choose(index) {
    const { material: held, chapter: chosen } = study.current;
    if (!held?.chapters[index] || index === chosen) return;
    study.current = { material: held, chapter: index };
    setChapter(index);
    name(index + 1, held.chapters[index].title);
    for (const part of chapterBriefing(held, index)) session.current?.sendContext(part);
  }

  function putAway() {
    if (!study.current.material) return;
    study.current = { material: null, chapter: -1 };
    setMaterial(null);
    setChapter(-1);
    clearTimeout(naming.current);
    setNamed(null);
    session.current?.sendContext(PUT_AWAY);
  }

  useEffect(() => {
    connect();
    // A deliberate touch retries at once. Simply being there ends a rest.
    const touch = () => { if (session.current) session.current.enableAudio(); else connect(); };
    const present = () => { if (!session.current && away.current.mode === 'resting') connect(); };
    let permission = null;
    const granted = () => { if (permission?.state === 'granted') connect(); };
    navigator.permissions?.query({ name: 'microphone' })
      .then(status => { permission = status; status.addEventListener('change', granted); }).catch(() => {});
    // A file can be dropped anywhere on the page; a chapter is chosen by pressing its stone.
    const carriesFile = event => [...(event.dataTransfer?.types || [])].includes('Files');
    // The mosaic opens towards wherever the file is being held.
    const over = event => { if (carriesFile(event)) { event.preventDefault(); held.current = point(event); setDragging(true); } };
    const left = event => { if (!event.relatedTarget) { held.current = null; setDragging(false); } };
    const drop = event => {
      if (!carriesFile(event)) return;
      event.preventDefault();
      held.current = null;
      setDragging(false);
      const files = [...event.dataTransfer.files], file = files.find(candidate => !refusal(candidate)) || files[0];
      if (file) void take(file, point(event));
    };
    const press = event => {
      const at = point(event), hit = pegs.current?.at(at.x, at.y) ?? -1, last = pressed.current;
      if (hit >= 0) { pressed.current = { at: -Infinity, x: 0, y: 0 }; choose(hit); return; }
      // Pressing the mosaic twice opens the file picker: the way in where nothing can be dragged.
      const bounds = screen.current.getBoundingClientRect(), centre = mosaicCircleCenter(bounds.width, bounds.height);
      const onMosaic = Math.hypot(at.x - centre.x, at.y - centre.y) < MOSAIC_REACH, now = performance.now();
      if (onMosaic && now - last.at < TWICE && Math.hypot(at.x - last.x, at.y - last.y) < TWICE_APART) {
        pressed.current = { at: -Infinity, x: 0, y: 0 };
        picker.current?.click();
      } else pressed.current = { at: onMosaic ? now : -Infinity, x: at.x, y: at.y };
    };
    document.addEventListener('pointerdown', touch);
    document.addEventListener('keydown', touch);
    document.addEventListener('pointermove', present, { passive: true });
    document.addEventListener('visibilitychange', present);
    window.addEventListener('focus', present);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', left);
    document.addEventListener('drop', drop);
    document.addEventListener('click', press);
    return () => {
      permission?.removeEventListener('change', granted);
      document.removeEventListener('pointerdown', touch);
      document.removeEventListener('keydown', touch);
      document.removeEventListener('pointermove', present);
      document.removeEventListener('visibilitychange', present);
      window.removeEventListener('focus', present);
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', left);
      document.removeEventListener('drop', drop);
      document.removeEventListener('click', press);
      clearTimeout(away.current.timer);
      clearTimeout(naming.current);
      const live = session.current;
      session.current = null;
      void live?.close();
    };
  }, []);

  const live = state === 'listening' || state === 'speaking';
  const label = state === 'speaking' ? 'Luna is speaking' : state === 'listening' ? 'Luna is listening'
    : state === 'connecting' ? 'Connecting to Luna' : 'Start voice session';
  // A file chosen from the picker comes up from the foot of the page, as a dropped one comes from where it was let go.
  const picked = event => {
    const file = event.target.files?.[0], bounds = screen.current.getBoundingClientRect();
    event.target.value = '';
    if (file) void take(file, { x: bounds.width / 2, y: bounds.height });
  };
  const shown = pointed >= 0 && material?.chapters[pointed] ? { number: pointed + 1, title: material.chapters[pointed].title } : named;
  return <div className="app mosaic-only">
    <main ref={screen} className="study-screen" aria-label="Voice conversation">
      <Mosaic state={state === 'paused' ? 'idle' : state === 'connecting' ? 'thinking' : state} levelRef={level} audioRef={audio} orbRef={orb}
        dragging={dragging} dragPositionRef={held} intake={intake} onIntakeDone={() => setIntake(null)}
        chapters={material?.chapters.length || 0} chapter={chapter} chapterRef={pegs} onChapterPoint={setPointed}/>
      <div className="voice-stage">
        {/* Only a mosaic that is not live can be pressed, and pressing it can only start Luna. */}
        {live || state === 'connecting'
          ? <div ref={orb} className="orb-button is-live" role="img" aria-label={label}/>
          : <button ref={orb} className="orb-button" onClick={connect} aria-label={label}/>}
        <AssistantCaptions text={subtitle} state={state} error={say(error)} visible={!shown} hostRef={screen}
          onCapacity={limit => { captionCapacity.current = limit; session.current?.setCaptionMaxChars(limit); }}/>
        {shown && !error && <p className="study-name" role="status">
          {shown.number > 0 && <span className="study-number">{shown.number}</span>}{shown.title}
        </p>}
      </div>
      {/* Nothing is shown here. A keyboard or a screen reader still needs something to land on, and it shows only while a key has it. */}
      <section className="study-keys" aria-label="Study material">
        <button onClick={() => picker.current?.click()}>Add a PDF to study with Luna</button>
        {material && <>
          {material.chapters.map((item, index) =>
            <button key={`${material.id}-${index}`} aria-pressed={index === chapter} onClick={() => choose(index)}>
              <span className="study-number">{index + 1}</span>{item.title}
            </button>)}
          <button onClick={putAway}>Put away {material.title}</button>
        </>}
        <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={picked}/>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
