import { stonePigments } from './mosaic-pigment.mjs';

const TAU = Math.PI * 2;
const COURSE_COUNT = 22;
const HISTORY = 64;
const SECTORS = 40;
const PETALS = 5;
const FLOOR_WINDOW = 180;
export const LIGHT_BANDS = 16;

// Colour a quiet, listening mosaic already carries; a voice supplies the rest.
const REST = .54;
const BREATH = .16;
const BREATH_PERIOD = 5200;
// Every live stone holds this much glaze, so the bare ones read as dark glass, not grit.
const TINT = .36;
// A voice crosses the medallion in about a second, as rings seven courses apart.
const HEARD_DELAY = 46;
const HEARD_PERIOD = 330;
const SPOKEN_DELAY = 40;
const SPOKEN_PERIOD = 320;
// Plato's light thins toward the rim, which stays the listener's. A person's
// tide thins toward the centre, which stays Plato’s: the two voices mirror each other.
const SPOKEN_REACH = .62;
const SPOKEN_RIPPLE = .4;
const HEARD_REACH = .72;
const HEARD_RIPPLE = .45;
// A person's voice also turns the courses, rim first, like water finding a
// drain: this many radians at the rim, growing toward the centre.
const HEARD_TWIST = .15;
// A ring is the stones themselves parting: this many pixels of extra gap open
// between two courses at its crest, and almost none between rings.
const HEARD_PARTING = .9;
const SPOKEN_PARTING = 1.1;
const SETTLED = .06;
// Every course also steps out a little with the sound of this very instant, and
// with each breath. Summed over the courses it looks like the medallion growing,
// but nothing is ever scaled: each stone only travels.
const HEARD_PULSE = .15;
const BREATH_SWELL = .055;
// After this much silence the next word starts its first ring at once.
const FRESH_AFTER = 900;
// Stones take their glaze one by one, each at its own level, over this much of the range.
const TAKE = .24;
// A document's chapters stand out of the rim as pegs, one stone each, this many
// pixels proud. The chosen one stands further, and one under the pointer nudges out.
const PEG_OUT = 7;
const PEG_CHOSEN = 13;
const PEG_POINTED = 2.5;
const PEG_STAGGER = 45;
// A document held over the page opens a hatch in the side facing it. Each of
// the outer courses parts there like a jaw hinged at the far side: stones slide
// round by up to this many radians at the opening and by nothing opposite it,
// so the whole ring closes up by a few percent and no two stones collide. The
// stones at the lips also step out towards the document.
const HATCH_OPEN = .2;
const HATCH_DEPTH = 13;
const HATCH_LIPS = 9;
const HATCH_LIP_SPAN = .55;

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const follow = (value, target, dt, duration) => value + (target - value) * (1 - Math.exp(-dt / duration));
const hash = (seed, index) => { const value = Math.sin(seed * 197.17 + index * 89.71) * 43758.5453; return value - Math.floor(value); };
// One ring in seven courses. A higher sharpness keeps less of it: the glaze
// catches about three courses, the parting between stones only the crest.
const crest = (angle, sharpness) => Math.pow(.5 + .5 * Math.sin(angle), sharpness);

// One voice: a short history of loudness and spectral shape, so each course
// can show the sound as it was a few moments ago and the wave visibly travels.
function createChannel(contrast) {
  const envelope = new Float32Array(HISTORY), shapes = new Float32Array(HISTORY * LIGHT_BANDS);
  const times = new Float64Array(HISTORY).fill(-Infinity);
  const recent = new Float32Array(FLOOR_WINDOW).fill(1), shape = new Float32Array(LIGHT_BANDS);
  let head = 0, cursor = 0, level = 0, floor = 0, ceiling = .55;

  function push(bands, scalar, now, dt) {
    let target = 0;
    if (bands) {
      let loudness = 0, peak = 0;
      for (let band = 0; band < LIGHT_BANDS; band++) { const value = clamp(bands[band]); loudness += value; if (value > peak) peak = value; }
      loudness /= LIGHT_BANDS;
      // The room's own hum sets the gate, but a long sentence must not raise it.
      recent[cursor] = loudness; cursor = (cursor + 1) % FLOOR_WINDOW;
      let quietest = 1;
      for (let index = 0; index < FLOOR_WINDOW; index++) if (recent[index] < quietest) quietest = recent[index];
      quietest = Math.min(.2, quietest);
      floor = follow(floor, quietest, dt, quietest < floor ? 120 : 900);
      // Measure against this speaker's own recent loudest moment. A soft voice
      // then fills the mosaic like a loud one, and the dips between syllables
      // stay visible instead of clipping flat.
      ceiling = Math.max(loudness, follow(ceiling, floor + .55, dt, 4000));
      target = Math.pow(clamp((loudness - floor - .1) / (ceiling - floor - .1)), contrast);
      for (let band = 0; band < LIGHT_BANDS; band++) {
        const left = bands[Math.max(0, band - 1)], right = bands[Math.min(LIGHT_BANDS - 1, band + 1)];
        const value = clamp(left * .25 + bands[band] * .5 + right * .25);
        // Keep the bands within 28 dB of the loudest: the outline of the voice.
        shape[band] = follow(shape[band], clamp((value - peak + .4) / .4), dt, 50);
      }
    } else {
      target = Math.pow(clamp(((Number.isFinite(scalar) ? scalar : 0) - .03) / .3), .8);
      shape.fill(1);
    }
    level = follow(level, target, dt, target > level ? 30 : 110);
    envelope[head] = level; times[head] = now; shapes.set(shape, head * LIGHT_BANDS);
    head = (head + 1) % HISTORY;
  }

  // The two recorded frames around a past moment, and the blend between them.
  function locate(at, out) {
    let newer = (head + HISTORY - 1) % HISTORY;
    if (at >= times[newer]) { out.a = out.b = newer; out.mix = 0; return; }
    for (let step = 1; step < HISTORY; step++) {
      const older = (newer + HISTORY - 1) % HISTORY;
      if (!Number.isFinite(times[older])) break;
      if (times[older] <= at) { out.a = older; out.b = newer; out.mix = clamp((at - times[older]) / Math.max(1, times[newer] - times[older])); return; }
      newer = older;
    }
    out.a = out.b = -1; out.mix = 0;
  }
  function reset() { envelope.fill(0); shapes.fill(0); times.fill(-Infinity); recent.fill(1); shape.fill(0); level = floor = 0; ceiling = .55; }
  return { push, locate, reset, envelope, shapes, level: () => level };
}

/**
 * Living light for the voice medallion. Outputs are per stone and reused:
 * `cool`, `bright` and `warm` are glaze amounts (0-1), `lift` is outward
 * travel in pixels, `turn` is travel around the course in radians, `ink` is
 * added opacity.
 *
 * Nothing here is a layer over the mosaic. There is no scale, filter, glow or
 * wash: every effect is one stone travelling or one stone taking a glaze at
 * its own moment. What looks like the medallion growing is each course
 * stepping outward by its own distance.
 *
 * Colour means Plato is live. The two voices mirror each other. A person's
 * voice enters at the rim as a tide of bright glaze, reaching further in the
 * louder it is, and turns each course as it passes so the mosaic winds like a
 * vortex. Plato's voice leaves the centre as warm glaze and travels outward.
 * Lift is the sum of the gaps opened further in, so courses spread apart but
 * never overlap, and a turning course keeps its radius.
 *
 * A document Plato has been handed shows as pegs: one stone of the outermost
 * course per chapter, clockwise from the top, standing out of the rim whether
 * or not Plato is live. `pegs` lists those stones so the page can tell which one
 * is under the pointer.
 *
 * `hatch` is { angle, open }: the bearing of a document being brought to the
 * mosaic and how far (0-1) the side facing it has opened to take it in.
 */
export function createMosaicLight(tiles) {
  const count = tiles.length;
  const cool = new Float32Array(count), bright = new Float32Array(count), warm = new Float32Array(count);
  const lift = new Float32Array(count), turn = new Float32Array(count), ink = new Float32Array(count);
  const courses = new Uint8Array(count), angles = new Float32Array(count);
  const takesCool = new Float32Array(count), takesBright = new Float32Array(count), takesWarm = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const tile = tiles[index], radius = Math.hypot(tile.x, tile.y), seed = Number.isFinite(tile.seed) ? tile.seed : .5;
    courses[index] = Math.max(0, Math.min(COURSE_COUNT - 1, Math.floor((radius - 2.9) / 6.8) + 1));
    angles[index] = Math.atan2(tile.y, tile.x);
    // A fixed order, never frame noise: the gilded construction lines show first.
    takesCool[index] = stonePigments(tile).gilded ? .14 + hash(seed, 41) * .32 : .14 + hash(seed, 41) * .72;
    // Either voice moves as one front, a couple of stones deep, never as confetti.
    takesBright[index] = .36 + hash(seed, 47) * .14;
    takesWarm[index] = .36 + hash(seed, 43) * .14;
  }
  const heard = createChannel(1.6), spoken = createChannel(1.15);
  const heardAt = Array.from({ length: COURSE_COUNT }, () => ({ a: -1, b: -1, mix: 0 }));
  const spokenAt = Array.from({ length: COURSE_COUNT }, () => ({ a: -1, b: -1, mix: 0 }));
  const life = new Float32Array(COURSE_COUNT), breath = new Float32Array(COURSE_COUNT);
  const entering = new Float32Array(COURSE_COUNT), tide = new Float32Array(COURSE_COUNT), parting = new Float32Array(COURSE_COUNT);
  const winding = new Float32Array(COURSE_COUNT);
  const leaving = new Float32Array(COURSE_COUNT), hearth = new Float32Array(COURSE_COUNT), opening = new Float32Array(COURSE_COUNT);
  const swell = new Float32Array(SECTORS * COURSE_COUNT);
  let previous = null, bloom = 0, speaking = 0, spin = 0, phase = 0, heardPhase = 0, spokenPhase = 0;
  let heardQuiet = FRESH_AFTER, spokenQuiet = FRESH_AFTER;
  // The outermost course, clockwise from twelve o'clock: where pegs are taken from.
  const fromTop = theta => ((theta + Math.PI / 2) % TAU + TAU) % TAU;
  const rim = [];
  for (let index = 0; index < count; index++) if (courses[index] === COURSE_COUNT - 1) rim.push(index);
  rim.sort((a, b) => fromTop(angles[a]) - fromTop(angles[b]));
  const pegs = [], pegOf = new Int16Array(count).fill(-1), pegOut = [];
  let pegAge = 0;
  function setPegs(wanted) {
    const total = Math.max(0, Math.min(rim.length, Math.floor(Number(wanted) || 0)));
    if (total === pegs.length) return;
    for (const stone of pegs) pegOf[stone] = -1;
    pegs.length = pegOut.length = 0; pegAge = 0;
    for (let peg = 0; peg < total; peg++) {
      // Even spacing is asked for; the nearest free stone is what there is.
      const want = peg / total * TAU;
      let best = -1, near = Infinity;
      for (const stone of rim) {
        if (pegOf[stone] >= 0) continue;
        const apart = Math.abs(fromTop(angles[stone]) - want), around = Math.min(apart, TAU - apart);
        if (around < near) { near = around; best = stone; }
      }
      pegOf[best] = peg; pegs.push(best); pegOut.push(0);
    }
  }

  // Loudness and spectral shape of one voice at a past frame, for one band position.
  function wave(channel, frame, position, base) {
    if (frame.a < 0) return 0;
    const low = Math.floor(position), high = Math.min(LIGHT_BANDS - 1, low + 1), part = position - low;
    const a = frame.a * LIGHT_BANDS, b = frame.b * LIGHT_BANDS, shapes = channel.shapes;
    const early = shapes[a + low] + (shapes[a + high] - shapes[a + low]) * part;
    const late = shapes[b + low] + (shapes[b + high] - shapes[b + low]) * part;
    const loudness = channel.envelope[frame.a] + (channel.envelope[frame.b] - channel.envelope[frame.a]) * frame.mix;
    return loudness * (base + (1 - base) * (early + (late - early) * frame.mix));
  }
  const loudnessAt = (channel, frame) => frame.a < 0 ? 0
    : channel.envelope[frame.a] + (channel.envelope[frame.b] - channel.envelope[frame.a]) * frame.mix;
  // Low notes sit at the middle of each petal, high notes between petals.
  const bandAt = theta => { const turn = (theta + spin) * PETALS / TAU; return Math.abs(turn - Math.floor(turn) - .5) * 2 * (LIGHT_BANDS - 1); };
  const takes = (amount, level) => smooth((amount - level) / TAKE + .5);

  // Pegs come out one after another round the rim, then hold their stops.
  function pegsStep(dt, chosen, pointed, reduced) {
    pegAge += dt;
    for (let peg = 0; peg < pegs.length; peg++) {
      const stop = (peg === chosen ? PEG_CHOSEN : PEG_OUT) + (peg === pointed ? PEG_POINTED : 0);
      pegOut[peg] = reduced ? stop : pegAge < peg * PEG_STAGGER ? 0 : follow(pegOut[peg], stop, dt, 90);
      const stone = pegs[peg], present = Math.min(1, pegOut[peg] / PEG_OUT);
      lift[stone] += pegOut[peg];
      // The outermost stones are faint by nature; a peg has to be seen.
      ink[stone] += .55 * present;
      cool[stone] = Math.max(cool[stone], life[courses[stone]] * present);
      if (peg === chosen) warm[stone] = Math.max(warm[stone], life[courses[stone]] * present);
    }
  }

  // Stones each side of the bearing slide away from it along their own course,
  // furthest at the rim: a wedge of open page pointing at the document.
  function hatchStep(hatch) {
    const open = clamp(hatch?.open || 0);
    if (!open || !Number.isFinite(hatch.angle)) return;
    for (let index = 0; index < count; index++) {
      const inward = COURSE_COUNT - 1 - courses[index];
      if (inward >= HATCH_DEPTH) continue;
      const aside = Math.atan2(Math.sin(angles[index] - hatch.angle), Math.cos(angles[index] - hatch.angle));
      const depth = 1 - inward / HATCH_DEPTH, lips = Math.max(0, 1 - Math.abs(aside) / HATCH_LIP_SPAN);
      turn[index] += Math.sign(aside || 1) * open * HATCH_OPEN * (1 - Math.abs(aside) / Math.PI) * depth * depth;
      lift[index] += open * HATCH_LIPS * lips * lips * depth;
    }
  }

  function step({ state, level = 0, input = null, output = null, time, reduced = false, chapters = 0, chapter = -1, pointed = -1, hatch = null } = {}) {
    const now = Number.isFinite(time) ? time : previous || 0;
    const dt = previous === null ? 16 : Math.max(0, Math.min(80, now - previous));
    previous = now;
    const live = state === 'listening' || state === 'speaking';
    setPegs(chapters);
    if (reduced) {
      heard.reset(); spoken.reset(); bloom = Number(live); speaking = Number(state === 'speaking');
      heardQuiet = spokenQuiet = FRESH_AFTER;
      for (let index = 0; index < count; index++) {
        cool[index] = live ? TINT + (1 - TINT) * takes(REST + BREATH / 2, takesCool[index]) : 0;
        warm[index] = speaking * takes(.7 * (1 - SPOKEN_REACH * courses[index] / (COURSE_COUNT - 1)), takesWarm[index]);
      }
      bright.fill(0); lift.fill(0); turn.fill(0); ink.fill(live ? .04 : 0);
      life.fill(Number(live));
      pegsStep(dt, chapter, pointed, true);
      hatchStep(hatch);
      return;
    }
    // Colour opens from the centre in under a second, and leaves by the rim.
    bloom = clamp(bloom + (live ? dt / 900 : -dt / 600));
    speaking = follow(speaking, Number(state === 'speaking'), dt, state === 'speaking' ? 140 : 320);
    spin = (spin + dt * .00005) % TAU;
    phase = (phase + dt / BREATH_PERIOD * TAU) % TAU;
    heardPhase = (heardPhase + dt / HEARD_PERIOD * TAU) % TAU;
    spokenPhase = (spokenPhase + dt / SPOKEN_PERIOD * TAU) % TAU;
    heard.push(live ? input : null, live && !input && state === 'listening' ? level : 0, now, dt);
    spoken.push(live ? output : null, live && !output && state === 'speaking' ? level : 0, now, dt);
    // No ring is in flight after a pause, so a first word can put its crest
    // exactly where the sound begins: at the rim for a person, the centre for Plato.
    if (heard.level() < .04) heardQuiet += dt; else { if (heardQuiet >= FRESH_AFTER) heardPhase = Math.PI / 2; heardQuiet = 0; }
    if (spoken.level() < .04) spokenQuiet += dt; else { if (spokenQuiet >= FRESH_AFTER) spokenPhase = Math.PI / 2; spokenQuiet = 0; }
    // The assistant’s own voice in the room must not read as someone answering.
    const attention = 1 - .7 * spoken.level();
    for (let course = 0; course < COURSE_COUNT; course++) {
      const depth = course / (COURSE_COUNT - 1);
      life[course] = smooth(bloom * 1.6 - depth * .6);
      breath[course] = .5 + .5 * Math.sin(phase + course * .36);
      // Each ring keeps the phase it was born with and carries it across at
      // the speed of the sound's own history, so loudness and ring move together.
      const since = (COURSE_COUNT - 1 - course) * HEARD_DELAY, after = course * SPOKEN_DELAY;
      heard.locate(now - since, heardAt[course]);
      spoken.locate(now - after, spokenAt[course]);
      // What is heard is strongest where it enters, what is said where it starts.
      entering[course] = attention * (.62 + .38 * depth);
      const arriving = heardPhase - since / HEARD_PERIOD * TAU, departing = spokenPhase - after / SPOKEN_PERIOD * TAU;
      tide[course] = attention * (1 - HEARD_REACH * (1 - depth)) * (1 - HEARD_RIPPLE * (1 - crest(arriving, 1.5)));
      parting[course] = entering[course] * (SETTLED + HEARD_PARTING * crest(arriving, 5));
      // One angle for the whole course, so it turns as a rigid ring. Inner
      // courses turn further, and later: the arms of the vortex.
      winding[course] = life[course] * attention * HEARD_TWIST * (.5 + 1.2 * Math.pow(1 - depth, 1.2)) * loudnessAt(heard, heardAt[course]);
      leaving[course] = (1 - SPOKEN_REACH * depth) * (1 - SPOKEN_RIPPLE * (1 - crest(departing, 1.5)));
      opening[course] = (1 - SPOKEN_REACH * depth) * (SETTLED + SPOKEN_PARTING * crest(departing, 5));
      // While it is Plato’s turn the very centre stays lit, even between words.
      hearth[course] = speaking * Math.max(0, .56 - depth * 1.3);
    }
    const inhale = .5 - .5 * Math.cos(phase), instant = heardAt[COURSE_COUNT - 1];
    for (let sector = 0; sector < SECTORS; sector++) {
      const position = bandAt(sector / SECTORS * TAU - Math.PI);
      // A person's voice moves every stone of a course alike, so the outline stays a circle.
      const pulse = HEARD_PULSE * attention * loudnessAt(heard, instant) + BREATH_SWELL * inhale;
      let travel = 0;
      for (let course = 0; course < COURSE_COUNT; course++) {
        travel += life[course] * (parting[course] * loudnessAt(heard, heardAt[course])
          + opening[course] * wave(spoken, spokenAt[course], position, .7) + pulse);
        swell[sector * COURSE_COUNT + course] = travel;
      }
    }
    for (let index = 0; index < count; index++) {
      const course = courses[index], theta = angles[index], position = bandAt(theta);
      const taken = entering[course] * wave(heard, heardAt[course], position, .38);
      const given = Math.max(hearth[course], leaving[course] * wave(spoken, spokenAt[course], position, .7));
      const alive = life[course];
      cool[index] = alive * TINT + (1 - TINT) * takes(alive * (REST + BREATH * breath[course] + (1 - REST) * taken), takesCool[index]);
      bright[index] = takes(alive * tide[course] * wave(heard, heardAt[course], position, .8), takesBright[index]);
      turn[index] = winding[course];
      warm[index] = takes(alive * given, takesWarm[index]);
      ink[index] = alive * (.04 + taken * .12 + given * .1);
      const place = (theta + Math.PI) / TAU * SECTORS, sector = Math.floor(place) % SECTORS, part = place - Math.floor(place);
      const near = swell[sector * COURSE_COUNT + course], far = swell[(sector + 1) % SECTORS * COURSE_COUNT + course];
      lift[index] = near + (far - near) * part;
    }
    pegsStep(dt, chapter, pointed, false);
    hatchStep(hatch);
  }

  return { step, cool, bright, warm, lift, turn, ink, pegs };
}
