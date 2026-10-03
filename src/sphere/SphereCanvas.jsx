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
const HATCH_FAR = 570;
// A chapter's stone can be pressed from this far off, further with a finger than with a mouse.
const PRESS = matchMedia('(pointer: coarse)').matches ? 26 : 16;

let cut = null;

// Luna's mosaic as a sphere of rigid tiles. Same props, place and size as the
// flat VoiceCanvas, which it falls back to where WebGL2 is unavailable.
export default function SphereCanvas(props) {
  const { state, levelRef, audioRef, dragging = false, dragPositionRef, intake = null, onIntakeDone, chapters = 0, chapter = -1, chapterRef } = props;
  const canvasRef = useRef(null), stateRef = useRef(state), redraw = useRef(null), study = useRef({});
  const [flat, setFlat] = useState(false), [context, setContext] = useState(0);
  stateRef.current = state;
  study.current = { dragging, intake, onIntakeDone, chapters, chapter };

  useEffect(() => {
    if (flat) return undefined;
    const canvas = canvasRef.current, surface = canvas.parentElement.parentElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const field = cut ||= createSphereField();
    let renderer;
    try { renderer = createSphereRenderer(canvas, field); } catch { setFlat(true); return undefined; }
    const motion = createSphereMotion(field), heard = new Float32Array(BANDS), spoken = new Float32Array(BANDS);
    const lens = createLens({ radius: RADIUS, distance: RADIUS * CAMERA, apparent: APPARENT, half: HALF });
    const pointer = { x: 0, y: 0, movedAt: -Infinity }, gaze = { x: 0, y: 0 };
    let frame = 0, last = -Infinity, nudgeX = 0, nudgeY = 0, centre = { x: 0, y: 0 }, density = null, giveUp = 0, pointed = -1, done = null;
    // Where something on the page lies from the sphere: its bearing as the viewer sees it. Straight below, if it is at the centre.
    const bearing = at => { const dx = at.x - centre.x, dy = at.y - centre.y; return Math.hypot(dx, dy) < 1 ? Math.PI / 2 : Math.atan2(dy, dx); };
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
      // A document held over the page opens the hatch towards it; dropped, it is taken in from where it fell.
      const now = study.current, held = now.dragging ? dragPositionRef?.current : null;
      const hatch = held ? { angle: bearing(held), near: 1 - (Math.hypot(held.x - centre.x, held.y - centre.y) - APPARENT) / (HATCH_FAR - APPARENT) } : null;
      const taking = now.intake ? { id: now.intake.id, angle: bearing(now.intake) } : null;
      motion.step({ state: stateRef.current, level: levelRef?.current || 0, input: sounding ? heard : null, output: sounding ? spoken : null, time, reduced, gaze: watching && !held ? gaze : null, hatch, intake: taking, chapters: now.chapters, chapter: now.chapter });
      if (taking && motion.taken() === taking.id && done !== taking.id) { done = taking.id; now.onIntakeDone?.(); }
      const reach = watching ? chapterAt(pointer.x, pointer.y) : -1;
      if (reach !== pointed) { pointed = reach; surface.classList.toggle('on-chapter', pointed >= 0); }
      renderer.draw(motion.tiles, motion.sway, motion.dial, lens, nudgeX, nudgeY);
      // Reduced motion draws one still frame per change and then waits.
      if (!reduced) frame = requestAnimationFrame(draw);
    }
    function restart() { cancelAnimationFrame(frame); last = -Infinity; if (!document.hidden) frame = requestAnimationFrame(draw); }
    function resize() {
      const bounds = surface.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
      centre = mosaicCircleCenter(bounds.width, bounds.height);
      // The canvas sits on whole pixels; the camera takes up the remainder.
      const left = Math.round(centre.x - HALF), top = Math.round(centre.y - HALF);
      canvas.style.left = `${left}px`; canvas.style.top = `${top}px`;
      nudgeX = (centre.x - HALF - left) / HALF; nudgeY = (top - centre.y + HALF) / HALF;
      renderer.resize(Math.round(HALF * 2 * ratio));
      restart();
    }
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
