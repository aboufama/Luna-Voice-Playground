import React, { useEffect, useRef, useState } from 'react';
import VoiceCanvas from '../VoiceCanvas.jsx';
import { mosaicCircleCenter } from '../mosaic-transition.mjs';
import { createLens } from './sphere-math.mjs';
import { createSphereField, RADIUS } from './sphere-field.mjs';
import { createSphereMotion, BANDS, STRIDE, PLACE } from './sphere-motion.mjs';
import { createSphereRenderer } from './sphere-renderer.mjs';

// The sphere's outline on the page: the flat medallion's radius, in CSS pixels.
const APPARENT = 142;
// Half the side of the square it is drawn in, with room for a tile lifted off the limb.
const HALF = 180;
// The one fixed camera stands this many sphere radii from the centre.
const CAMERA = 6.5;
// A pointer this far from the sphere's centre turns it fully, for this long after it last moved.
const GAZE_RANGE = 320;
const GAZE_HOLD = 2600;
// Sixty frames a second is enough for stone; a faster display does not get more.
const FRAME = 12;
// A graphics context that has not come back after this long is given up for the flat medallion.
const CONTEXT_PATIENCE = 4000;
// A document this far from the sphere's centre has only just been noticed; at the outline it is as near as it gets.
const NOTICED = 570;
// The crack opens where the document faces the sphere, but never further round from the viewer than this (radians).
const FACING = .84;
// A document's sheet is held this far in front of the sphere's centre, and this far from the pointer on the
// sphere's side of it, so that it is not hidden under whatever the pointer is carrying.
const SHEET_Z = RADIUS + 26, AHEAD = 38;
// While a document is about, the canvas covers the page; it is given at most this many pixels.
const MOST_PIXELS = 9e6;
// A chapter's stone can be pressed from this far off, further with a finger than with a mouse.
const PRESS = matchMedia('(pointer: coarse)').matches ? 26 : 16;

let cut = null;

// Luna's mosaic as a sphere of rigid tiles. Same props, place and size as the
// flat VoiceCanvas, which it falls back to where WebGL2 is unavailable.
export default function SphereCanvas(props) {
  const { state, levelRef, audioRef, dragging = false, dragPositionRef, intake = null, onIntakeDone, chapters = 0, chapter = -1, chapterRef, onChapterPoint, reading = false } = props;
  const canvasRef = useRef(null), stateRef = useRef(state), redraw = useRef(null), study = useRef({});
  const [flat, setFlat] = useState(false), [context, setContext] = useState(0);
  stateRef.current = state;
  study.current = { dragging, intake, onIntakeDone, chapters, chapter, onChapterPoint, reading };

  useEffect(() => {
    if (flat) return undefined;
    const canvas = canvasRef.current, surface = canvas.parentElement.parentElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const field = cut ||= createSphereField();
    let renderer;
    try { renderer = createSphereRenderer(canvas, field); } catch (problem) { console.warn('The sphere could not be drawn here; showing the flat mosaic.', problem); setFlat(true); return undefined; }
    const motion = createSphereMotion(field), heard = new Float32Array(BANDS), spoken = new Float32Array(BANDS);
    const lens = createLens({ radius: RADIUS, distance: RADIUS * CAMERA, apparent: APPARENT, half: HALF, reach: 70 });
    const pointer = { x: 0, y: 0, movedAt: -Infinity }, gaze = { x: 0, y: 0 };
    let frame = 0, last = -Infinity, centre = { x: 0, y: 0 }, density = null, giveUp = 0, pointed = -1, done = null, whole = false;
    const view = { zoomX: 1, zoomY: 1, nudgeX: 0, nudgeY: 0 }, sheetAt = new Float64Array(3), facing = new Float64Array(3);
    // A document somewhere on the page, as the motion wants it: where its sheet is held, where on the sphere
    // it faces (both as the camera sees them), and how near it is.
    function about(at) {
      const dx = at.x - centre.x, dy = at.y - centre.y, far = Math.hypot(dx, dy);
      // The sheet keeps to the sphere's side of the pointer.
      const ahead = far > 1 ? Math.min(AHEAD, far) / far : 0;
      lens.place(dx - dx * ahead, -(dy - dy * ahead), SHEET_Z, sheetAt);
      const round = Math.min(FACING, Math.asin(Math.min(1, far / APPARENT))), sine = far > 1 ? Math.sin(round) / far : 0;
      facing[0] = dx * sine; facing[1] = -dy * sine; facing[2] = Math.cos(round);
      return { at: sheetAt, aim: facing, near: 1 - (far - APPARENT) / (NOTICED - APPARENT) };
    }
    // Which chapter's stone, if any, is at a point of the surface: the stones as the camera sees them this frame.
    function chapterAt(x, y) {
      let hit = -1, near = PRESS;
      motion.pegs().forEach((stone, peg) => {
        const at = stone * STRIDE + PLACE, m = motion.sway, px = motion.tiles[at], py = motion.tiles[at + 1], pz = motion.tiles[at + 2];
        const seenZ = m[2] * px + m[5] * py + m[8] * pz;
        if (seenZ <= 0) return;
        const [right, up] = lens.project(m[0] * px + m[3] * py + m[6] * pz, m[1] * px + m[4] * py + m[7] * pz, seenZ);
        const apart = Math.hypot(centre.x + right - x, centre.y - up - y);
        if (apart < near) { near = apart; hit = peg; }
      });
      return hit;
    }
    if (chapterRef) chapterRef.current = { at: chapterAt };

    function draw(time) {
      if (document.hidden || renderer.lost()) return;
      const reduced = still.matches;
      if (!reduced && time - last < FRAME) { frame = requestAnimationFrame(draw); return; }
      last = time;
      const sounding = Boolean(audioRef?.current?.(heard, spoken));
      // A pointer that moved a moment ago draws the sphere's face a little towards it.
      const watching = time - pointer.movedAt < GAZE_HOLD;
      gaze.x = (pointer.x - centre.x) / GAZE_RANGE; gaze.y = (pointer.y - centre.y) / GAZE_RANGE;
      // A document held over the page cracks the sphere open towards it; dropped, it is swallowed from where it fell.
      const now = study.current, held = now.dragging ? dragPositionRef?.current : null;
      // While one is about, its sheet may be anywhere on the page, so the canvas covers the page.
      if (Boolean(held || now.intake) !== whole && !reduced) { whole = !whole; fit(); }
      const file = held ? about(held) : null;
      const taking = now.intake ? { id: now.intake.id, ...(file || about(now.intake)) } : null;
      motion.step({ state: stateRef.current, level: levelRef?.current || 0, input: sounding ? heard : null, output: sounding ? spoken : null, time, reduced, gaze: watching && !held ? gaze : null, file, intake: taking, chapters: now.chapters, chapter: now.chapter, reading: now.reading });
      if (taking && motion.taken() === taking.id && done !== taking.id) { done = taking.id; now.onIntakeDone?.(); }
      const reach = watching ? chapterAt(pointer.x, pointer.y) : -1;
      if (reach !== pointed) { pointed = reach; surface.classList.toggle('on-chapter', pointed >= 0); now.onChapterPoint?.(pointed); }
      renderer.draw(motion.tiles, motion.sway, motion.dial, motion.shell, lens, view);
      // Reduced motion draws one still frame per change and then waits.
      if (!reduced) frame = requestAnimationFrame(draw);
    }
    function restart() { cancelAnimationFrame(frame); last = -Infinity; if (!document.hidden) frame = requestAnimationFrame(draw); }
    // The canvas is the square round the sphere, or the whole page while a document is about. Either
    // way it sits on whole pixels, and the camera is placed in it so the sphere stays exactly where it was.
    function fit() {
      const bounds = surface.getBoundingClientRect();
      centre = mosaicCircleCenter(bounds.width, bounds.height);
      const left = whole ? 0 : Math.round(centre.x - HALF), top = whole ? 0 : Math.round(centre.y - HALF);
      const width = whole ? Math.max(1, Math.round(bounds.width)) : HALF * 2, height = whole ? Math.max(1, Math.round(bounds.height)) : HALF * 2;
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MOST_PIXELS / (width * height)));
      canvas.style.left = `${left}px`; canvas.style.top = `${top}px`; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      view.zoomX = lens.focal * 2 / width; view.zoomY = lens.focal * 2 / height;
      view.nudgeX = (centre.x - left) * 2 / width - 1; view.nudgeY = 1 - (centre.y - top) * 2 / height;
      renderer.resize(Math.round(width * ratio), Math.round(height * ratio));
    }
    function resize() { fit(); restart(); }
    // Moving to a screen of another density changes no layout, so it is watched for by itself.
    function refit() {
      density?.removeEventListener('change', refit);
      density = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
      density.addEventListener('change', refit);
      resize();
    }
    function pointerMove(event) {
      const bounds = surface.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left; pointer.y = event.clientY - bounds.top; pointer.movedAt = performance.now();
    }
    const pointerLeave = () => { pointer.movedAt = -Infinity; };
    const lost = event => { event.preventDefault(); cancelAnimationFrame(frame); giveUp = setTimeout(() => setFlat(true), CONTEXT_PATIENCE); };
    const restored = () => { clearTimeout(giveUp); setContext(value => value + 1); };
    redraw.current = restart;
    const observer = new ResizeObserver(resize); observer.observe(surface); refit();
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
    surface.addEventListener('pointermove', pointerMove, { passive: true }); surface.addEventListener('pointerleave', pointerLeave);
    document.addEventListener('visibilitychange', restart); still.addEventListener('change', restart);
    return () => {
      if (chapterRef) chapterRef.current = null;
      surface.classList.remove('on-chapter');
      redraw.current = null; cancelAnimationFrame(frame); clearTimeout(giveUp); observer.disconnect();
      density?.removeEventListener('change', refit);
      surface.removeEventListener('pointermove', pointerMove); surface.removeEventListener('pointerleave', pointerLeave);
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored);
      document.removeEventListener('visibilitychange', restart); still.removeEventListener('change', restart);
      renderer.dispose();
    };
  }, [flat, context, levelRef, audioRef, dragPositionRef, chapterRef]);
  // Reduced motion needs one fresh still frame when the state or the document changes.
  useEffect(() => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) redraw.current?.(); }, [state, intake, chapters, chapter]);


  if (flat) return <VoiceCanvas {...props}/>;
  return <div className="voice-visual mosaic-surface" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', maxWidth: 'none', pointerEvents: 'none', zIndex: 3 }}>
    <canvas ref={canvasRef} className="voice-canvas sphere-canvas" style={{ position: 'absolute', width: HALF * 2, height: HALF * 2, maxWidth: 'none', pointerEvents: 'none' }}/>
  </div>;
}
