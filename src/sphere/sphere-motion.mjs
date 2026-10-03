import { TAU, clamp, follow, hash, quatAxis, quatMul, quatToMat3 } from './sphere-math.mjs';
import { COURSES, FACE_ARC, PITCH } from './sphere-field.mjs';

export const BANDS = 16;
// One stone's state for one frame, as the renderer uploads it: a unit
// quaternion, a position, how clear of the mortar it stands (for shading), and
// which stone is on each of its two sides.
export const STRIDE = 12, TURN = 0, PLACE = 4, FACES = 8;
// The stones a block can show. A block has two sides; the one in its socket is
// changed out of sight, and it shows it by lifting clear and turning over.
export const GREY = 0, LIVE = 1, GREEN = 2, WARM = 3;

// The machine runs on a tick. Every part starts moving on one, travels to a
// fixed stop in a whole number of them, and waits there.
export const TICK = 1000 / 12;
// A piston's stops are whole notches of this many pixels.
export const NOTCH = 1.3;
// A stone lifts this far out of its socket, clear of the mortar and its neighbours, before it turns over.
export const POP = 5.8;
// Lift, turn, seat: one tick each.
export const TURN_TICKS = 3;
// The clock's hand is one stone standing this many notches up.
const HAND = 2;
// The person's voice works the rings at the outline in pairs, one pair to each two bands of the spectrum.
const TERRACES = 8;
// Luna's voice turns stones to her colour ring by ring from the pole, this far over the surface at full
// voice: up to the clock's ring, which stays the edge of the drawing. An ordinary speaking level already
// reaches most of the way, so her turn is plain to see.
const LUNA_REACH = 150;
const LUNA_GAIN = 1.5;
// A document held near the sphere opens a hatch in the side facing it: the stones of up to this many
// rings, within this bearing of it, stand on edge like the slats of a louvre. More rings open the nearer it comes.
const HATCH_RINGS = 8, HATCH_HALF = .36;
// Each chapter of a document is one stone standing this many notches up; the chosen one stands this many.
const PEG_UP = 2, PEG_CHOSEN = 4;
// The sphere's attitude has stops too: at rest a little off square, tipped towards a person who is
// speaking, lifted a little when Luna speaks, and turned one stop towards a pointer.
const REST_YAW = -.09, REST_PITCH = -.05, LISTEN = .1, SPEAK = -.045, GAZE_YAW = .12, GAZE_PITCH = .08;

/**
 * How a part travels between two stops: at one speed, then stopped dead, with
 * the smallest of settles. Nothing eases in or out.
 */
export function travel(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < .8) return u / .8;
  const settling = (u - .8) / .2;
  return 1 + .05 * Math.sin(settling * Math.PI) * (1 - settling);
}
// Coming down onto a seat there is no settle: a stone must not dip into its socket.
const seatDown = u => Math.min(1, Math.max(0, u / .8));

// One voice: its loudness measured against the speaker's own range, the shape
// of its spectrum, and the moments that spectrum changes, where syllables begin.
function createVoice(contrast) {
  const BUCKETS = 24, BUCKET = 250;
  const quiet = new Float32Array(BUCKETS).fill(1), usual = new Float32Array(BANDS), shape = new Float32Array(BANDS);
  let level = 0, floor = 0, ceiling = .55, bucket = 0, bucketEnds = -Infinity, change = 0, rising = false, onset = false;

  function push(bands, scalar, now, dt) {
    let target = 0;
    onset = false;
    if (bands) {
      let loudness = 0, flux = 0;
      for (let band = 0; band < BANDS; band++) {
        const value = clamp(bands[band]);
        loudness += value;
        // How far this instant stands above the sound of the last moment.
        flux += Math.max(0, value - usual[band]);
        usual[band] = follow(usual[band], value, dt, 60);
      }
      loudness /= BANDS;
      change = flux / BANDS / (loudness + .1);
      // The room's own hum sets the gate: the quietest moment of the last six seconds.
      if (now >= bucketEnds) { bucket = (bucket + 1) % BUCKETS; quiet[bucket] = 1; bucketEnds = now + BUCKET; }
      if (loudness < quiet[bucket]) quiet[bucket] = loudness;
      let quietest = 1;
      for (let index = 0; index < BUCKETS; index++) if (quiet[index] < quietest) quietest = quiet[index];
      quietest = Math.min(.2, quietest);
      floor = follow(floor, quietest, dt, quietest < floor ? 120 : 900);
      // Measured against this speaker's own recent loudest moment, a soft voice works the machine like a loud one.
      ceiling = Math.max(loudness, follow(ceiling, floor + .55, dt, 4000));
      target = Math.pow(clamp((loudness - floor - .1) / (ceiling - floor - .1)), contrast);
      for (let band = 0; band < BANDS; band++) {
        const share = clamp((clamp(bands[band]) - floor - .1) / (ceiling - floor - .1));
        shape[band] = follow(shape[band], share, dt, share > shape[band] ? 25 : 140);
      }
    } else {
      const before = level;
      target = Math.pow(clamp(((Number.isFinite(scalar) ? scalar : 0) - .03) / .3), .8);
      change = Math.max(0, target - before) * .5;
      shape.fill(target);
    }
    level = follow(level, target, dt, target > level ? 30 : 110);
    // A syllable begins where the change rises through its threshold.
    const above = change > .04;
    if (above && !rising && target > .12) onset = true;
    rising = above;
  }
  function reset() { quiet.fill(1); usual.fill(0); shape.fill(0); level = floor = change = 0; ceiling = .55; bucketEnds = -Infinity; rising = onset = false; }
  return { push, reset, shape, level: () => level, onset: () => onset };
}

/**
 * The sphere as a machine of stone. Its parts are rigid and could be built:
 *
 *   rings   every course is a ring carrying its own stones and mortar. A ring
 *           turns about the axis through the poles in whole places, to a detent.
 *   stones  every stone has two sides. It can stand up out of its socket as a
 *           piston, to a whole number of notches; or lift clear, turn over, and
 *           seat again, to show its other side. The side in the socket is the
 *           only one that is ever exchanged.
 *   the sphere itself, which turns between a few fixed attitudes.
 *
 * Nothing changes colour in place, nothing drifts, and nothing moves except
 * from one stop to another on the tick.
 *
 *   not connected  grey sides out, rings out of register, still.
 *   connecting     a lock being dialled: groups of rings click round, seeking.
 *   going live     the rings find register from the pole outward, and behind
 *                  that the stones turn over to colour in a cascade.
 *   quiet          a clock: one ring outside the drawing steps one place a
 *                  second, carrying one raised stone round as its hand.
 *   Luna           her stones turn to her colour ring by ring from the pole,
 *                  one ring to each step of loudness, and each syllable
 *                  ratchets those rings one place and back.
 *   a person       the rings at the outline turn to their colour and stand up
 *                  as pistons, a pair of rings to each part of the spectrum, a
 *                  notch to each step of loudness; each syllable knocks one
 *                  ring after another, in to the centre.
 *   a document     held near, it opens a hatch: the stones facing it stand on
 *                  edge, ring by ring, more rings the nearer it comes. Dropped,
 *                  the hatch shuts over it from the outside in and three knocks
 *                  carry it to the centre. Then one stone to a chapter stands
 *                  up on its own ring, clockwise from the top; the chosen one
 *                  turns to Luna's colour and stands higher.
 *
 * `tiles`, `sway` and `dial` are all the renderer is given.
 */
export function createSphereMotion(field) {
  const { count, radius, course, courseArc, places, normal, frame, seat, theta } = field;
  const tiles = new Float32Array(count * STRIDE), sway = new Float32Array(9), dial = new Float32Array(COURSES);
  const courseAt = arc => courseArc.reduce((best, at, k) => Math.abs(at - arc) < Math.abs(courseArc[best] - arc) ? k : best, 0);
  // The last ring a viewer can see, the rings Luna can reach, and the clock's ring just outside the drawing.
  const LIMB = courseAt(Math.PI * radius / 2 - PITCH / 2), LUNA = courseAt(LUNA_REACH), CLOCK = courseAt(FACE_ARC + 1.5 * PITCH), KNOCK = LIMB - 2 * TERRACES;
  // The hatch's outermost ring, and the ring the chapters' stones stand on: both on the face, clear of the clock.
  const HATCH = LIMB - 2, PEGS = CLOCK + 3;
  const lag = k => Math.floor(Math.min(k, LIMB + 8) / 3), lagOut = k => k <= LIMB ? (LIMB - k) >> 1 : 0;

  // Stones: the two sides, which is out, when it began to turn, and its place in a cascade.
  const sideA = new Uint8Array(count), sideB = new Uint8Array(count), parity = new Uint8Array(count), turnTick = new Int32Array(count).fill(-1), stagger = new Uint8Array(count);
  const angle = new Float32Array(count), height = new Float32Array(count), shown = new Uint8Array(count);
  // A slat: whether it stands on edge, which way it is moving, and since when.
  const ajar = new Uint8Array(count), ajarGo = new Uint8Array(count), ajarTick = new Int32Array(count).fill(-1);
  // Chapters: which chapter a stone stands for, and each chapter's stone and its stops, like the clock's hand.
  const pegOf = new Int8Array(count).fill(-1);
  let pegStones = [], pegNow = [], pegFrom = [], pegTo = [], pegTick = [], pegBorn = -999, chosen = -1;
  let hatchAngle = Math.PI / 2, hatchRings = 0, hatchTick = -999, taking = null, taken = null;
  let hand = 0;
  for (let index = 0; index < count; index++) {
    const round = theta[index] / TAU + 1 + course[index] * .137;
    stagger[index] = Math.floor((round - Math.floor(round)) * 4);
    // The hand is the stone of the clock's ring nearest twelve o'clock.
    if (course[index] === CLOCK && (course[hand] !== CLOCK || Math.abs(theta[index] + Math.PI / 2) < Math.abs(theta[hand] + Math.PI / 2))) hand = index;
  }
  // Rings: one place round, where each sits when the machine is not live, the stop it is at, and its piston.
  const pitch = Float64Array.from(places, held => TAU / Math.max(1, held));
  const home = Int16Array.from({ length: COURSES }, (_, k) => k === 0 || k === COURSES - 1 ? 0 : Math.floor(hash(k + 1, 7) * 7) - 3);
  const steps = Int16Array.from(home), wanted = Int16Array.from(home), seek = new Int16Array(COURSES), ratchet = new Int8Array(COURSES);
  const dialFrom = Float64Array.from(home, (held, k) => held * pitch[k]), dialTo = Float64Array.from(dialFrom), dialTick = new Int32Array(COURSES).fill(-99), dialTicks = new Uint8Array(COURSES).fill(1);
  const pin = new Uint8Array(COURSES), pinFrom = new Float32Array(COURSES), pinTo = new Float32Array(COURSES), pinTick = new Int32Array(COURSES).fill(-99);
  const want = new Uint8Array(COURSES), wantTick = new Int32Array(COURSES).fill(-99), cascade = new Uint8Array(COURSES), busy = new Uint16Array(COURSES);
  const terraceOf = Int8Array.from({ length: COURSES }, (_, k) => k > LIMB ? (k <= LIMB + 3 ? 0 : -1) : k > KNOCK ? (LIMB - k) >> 1 : -1);
  const notch = new Uint8Array(TERRACES), notchLow = new Uint8Array(TERRACES), greenHold = new Uint8Array(TERRACES), knocks = new Int32Array(8).fill(-999);
  const heard = createVoice(1.6), spoken = createVoice(1.15);
  const pose = new Float64Array(4), yaw = new Float64Array(4), pitching = new Float64Array(4);

  let previous = null, origin = null, done = -1, mode = 'idle', wasLive = false, liveTick = -999, leaveTick = -999, thinkTick = -999;
  let hearing = 0, mine = 1, heardClick = false, spokenClick = false, attentive = 0, reach = 0, reachLow = 0, nextKnock = 0, clock = 0;
  let handNow = 0, handFrom = 0, handTo = 0, handTick = -99, gazeX = 0, gazeY = 0;
  let yawFrom = REST_YAW, yawTo = REST_YAW, pitchFrom = REST_PITCH, pitchTo = REST_PITCH, poseTick = -99;

  // One stone of the chapters' ring for each chapter, clockwise from twelve o'clock.
  function setPegs(wanted, t) {
    const total = Math.max(0, Math.min(24, Math.floor(Number(wanted) || 0)));
    if (total === pegStones.length) return;
    for (const stone of pegStones) pegOf[stone] = -1;
    pegStones = []; pegNow = []; pegFrom = []; pegTo = []; pegTick = []; pegBorn = t;
    for (let peg = 0; peg < total; peg++) {
      const want = -Math.PI / 2 + peg / total * TAU;
      let best = -1, near = Infinity;
      for (let index = 0; index < count; index++) {
        if (course[index] !== PEGS || pegOf[index] >= 0 || index === hand) continue;
        const apart = Math.abs(Math.atan2(Math.sin(theta[index] - want), Math.cos(theta[index] - want)));
        if (apart < near) { near = apart; best = index; }
      }
      pegOf[best] = peg; pegStones.push(best); pegNow.push(0); pegFrom.push(0); pegTo.push(0); pegTick.push(-99);
    }
  }
  // Whether a stone is one of the hatch's slats just now: on an open ring, and facing the document.
  function slat(index, t) {
    const k = course[index];
    if (k > HATCH || k <= HATCH - hatchRings || index === hand || pegOf[index] >= 0) return false;
    // Dropped, the hatch shuts from the outermost ring inward, a ring a tick.
    if (taking && taking.shut >= 0 && t >= taking.shut + (HATCH - k)) return false;
    // Opening, the outermost ring goes first.
    if (t < hatchTick + (HATCH - k)) return false;
    const bearing = theta[index] + steps[k] * pitch[k] - hatchAngle;
    return Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) < HATCH_HALF;
  }

  // One tick of the machine: decide what every part should be doing and start whatever is free to start.
  function onTick(t) {
    const live = mode === 'listening' || mode === 'speaking', present = live && hearing > .08;
    // Her turn is told by her sound, not by the provider's mode, which flickers between her words.
    const speaking = live && spoken.level() > .1;
    if (live && !wasLive) { liveTick = t; clock = 0; seek.fill(0); }
    if (!live && wasLive) leaveTick = t;
    if (mode === 'thinking' && thinkTick < 0) thinkTick = t;
    if (mode !== 'thinking') { thinkTick = -999; if (!live) seek.fill(0); }
    wasLive = live;
    attentive = present ? 10 : Math.max(0, attentive - 1);

    // Luna: loudness is a number of rings. The front moves one ring a tick; a syllable is a click of the ratchet.
    const aim = speaking ? Math.max(3, Math.round(Math.min(1, spoken.level() * LUNA_GAIN) * LUNA)) : 0;
    if (aim > reach) { reach++; reachLow = 0; } else if (aim < reach) { if (!speaking || ++reachLow >= 2) reach--; } else reachLow = 0;
    for (let k = 0; k < COURSES; k++) ratchet[k] = k >= reach || k === 0 ? 0 : spokenClick && speaking ? (ratchet[k] ? 0 : k & 1 ? -1 : 1) : ratchet[k];
    spokenClick = false;

    // A person: each pair of rings follows its part of the spectrum, a notch to a step of loudness.
    for (let terrace = 0; terrace < TERRACES; terrace++) {
      const share = present ? Math.max(heard.shape[terrace * 2], heard.shape[terrace * 2 + 1]) * mine : 0;
      const stop = share > .72 ? 3 : share > .46 ? 2 : share > .2 ? 1 : 0;
      if (stop >= notch[terrace]) { notch[terrace] = stop; notchLow[terrace] = 0; } else if (++notchLow[terrace] >= 2) { notch[terrace]--; notchLow[terrace] = 0; }
      greenHold[terrace] = notch[terrace] > 0 ? 6 : Math.max(0, greenHold[terrace] - 1);
    }
    if (heardClick && present) { knocks[nextKnock] = t; nextKnock = (nextKnock + 1) % knocks.length; }
    heardClick = false;

    // Which stone each ring should be showing.
    for (let k = 0; k < COURSES; k++) {
      let face = want[k];
      if (live) {
        if (t >= liveTick + lag(k) + 2) face = terraceOf[k] >= 0 && greenHold[terraceOf[k]] > 0 ? GREEN : k < reach ? WARM : LIVE;
      } else if (t >= leaveTick + lagOut(k)) face = GREY;
      if (face !== want[k]) { cascade[k] = Number(face <= LIVE && want[k] <= LIVE); want[k] = face; wantTick[k] = t; }
    }

    // A document that has been dropped: the hatch opens fully if it was not already, shuts over it, and three knocks carry it in.
    if (taking) {
      if (taking.shut < 0 && t >= taking.since + (taking.wasOpen ? 1 : HATCH_RINGS + 3)) taking.shut = t;
      const closed = taking.shut >= 0 ? taking.shut + HATCH_RINGS + 2 : Infinity;
      if (live) for (let knock = 0; knock < 3; knock++) if (t === closed + knock * 3) { knocks[nextKnock] = t; nextKnock = (nextKnock + 1) % knocks.length; }
      if (t >= closed + 8) { taken = taking.id; taking = null; hatchRings = 0; }
    }

    // Stones: finish a turn, or begin one if the stone is seated and its turn has come.
    busy.fill(0);
    for (let index = 0; index < count; index++) {
      const k = course[index];
      if (turnTick[index] >= 0) {
        if (t - turnTick[index] < TURN_TICKS) { busy[k]++; continue; }
        parity[index] ^= 1; turnTick[index] = -1;
      }
      const peg = pegOf[index], seated = pin[k] === 0 && t - pinTick[k] >= 1 && (index !== hand || (handNow === 0 && t - handTick >= 1)) && (peg < 0 || (pegNow[peg] === 0 && t - pegTick[peg] >= 1));
      // A slat lifts clear and stands on edge, or comes back flat and seats: two ticks either way.
      if (ajarTick[index] >= 0) {
        if (t - ajarTick[index] < 2) { busy[k]++; continue; }
        ajar[index] = ajarGo[index]; ajarTick[index] = -1;
      }
      const open = (hatchRings > 0 || taking) && slat(index, t);
      if (ajar[index] || open) {
        if (ajar[index] !== Number(open) && (ajar[index] || seated)) { ajarGo[index] = Number(open); ajarTick[index] = t; }
        if (ajar[index] || ajarTick[index] >= 0) { busy[k]++; continue; }
      }
      // The chosen chapter's stone shows Luna's colour, whatever its ring is showing.
      const wish = peg >= 0 && peg === chosen && live ? WARM : want[k];
      if ((parity[index] ? sideB[index] : sideA[index]) === wish) continue;
      busy[k]++;
      if (!seated || t - wantTick[k] < (cascade[k] ? stagger[index] : 0)) continue;
      // The side in the socket is exchanged out of sight; the turn that follows shows it.
      if (parity[index]) sideA[index] = wish; else sideB[index] = wish;
      turnTick[index] = t;
    }
    // Chapters: each stone stands up once it shows the right side, one after another round the ring.
    for (let peg = 0; peg < pegStones.length; peg++) {
      const stone = pegStones[peg], wish = peg === chosen && live ? WARM : want[PEGS];
      const ready = turnTick[stone] < 0 && (parity[stone] ? sideB[stone] : sideA[stone]) === wish && t >= pegBorn + peg;
      const stop = ready ? (peg === chosen ? PEG_CHOSEN : PEG_UP) : 0;
      if (stop !== pegNow[peg] && t - pegTick[peg] >= 1) { pegFrom[peg] = pegNow[peg] * NOTCH; pegNow[peg] = stop; pegTo[peg] = stop * NOTCH; pegTick[peg] = t; }
    }

    // Connecting, two groups of three rings are dialled at a time: the group stands up a notch,
    // clicks round four places, seats, and the next groups take their turn.
    const since = t - thinkTick, beat = since % 12, groups = Math.ceil((LIMB + 3) / 3);
    const first = mode === 'thinking' ? Math.floor(since / 12) % groups : -1, second = first < 0 ? -1 : (first + (groups >> 1)) % groups;

    // Pistons: a ring whose stones are all seated on the right side may stand up, to a whole notch.
    for (let k = 0; k < COURSES; k++) {
      let stop = 0;
      const group = k > 0 && k < LIMB + 3 ? Math.floor(k / 3) : -2;
      if ((group === first || group === second) && beat < 9 && !busy[k]) stop = 1;
      if (live && !busy[k]) {
        if (terraceOf[k] >= 0 && want[k] === GREEN) stop = notch[terraceOf[k]];
        if (k <= KNOCK) for (let index = 0; index < knocks.length; index++) if (t - knocks[index] === KNOCK - k) stop = Math.max(stop, 1);
      }
      if (stop !== pin[k] && t - pinTick[k] >= 1) { pinFrom[k] = pin[k] * NOTCH; pin[k] = stop; pinTo[k] = stop * NOTCH; pinTick[k] = t; }
    }
    const up = live && !busy[CLOCK] && want[CLOCK] === LIVE && pin[CLOCK] === 0 ? HAND : 0;
    if (up !== handNow && t - handTick >= 1) { handFrom = handNow * NOTCH; handNow = up; handTo = up * NOTCH; handTick = t; }

    // Rings: the groups being dialled click one place on every other tick while they stand up.
    if (mode === 'thinking' && beat < 9 && beat % 2 === 1) for (let k = 1; k < LIMB + 3; k++) { const group = Math.floor(k / 3); if (group === first) seek[k]++; else if (group === second) seek[k]--; }
    // Quiet or not, the clock's ring steps one place a second.
    if (live && t > liveTick + lag(CLOCK) + 8 && (t - liveTick) % 12 === 0) clock++;
    for (let k = 0; k < COURSES; k++) {
      if (live) { if (t >= liveTick + lag(k)) wanted[k] = k === CLOCK ? clock : ratchet[k]; }
      else if (mode === 'thinking') wanted[k] = home[k] + seek[k];
      else if (t >= leaveTick + 8 + lagOut(k)) wanted[k] = home[k];
      if (steps[k] !== wanted[k] && t - dialTick[k] >= dialTicks[k]) {
        dialTicks[k] = Math.abs(wanted[k] - steps[k]) > 1 ? 2 : 1;
        dialFrom[k] = steps[k] * pitch[k]; steps[k] = wanted[k]; dialTo[k] = steps[k] * pitch[k]; dialTick[k] = t;
      }
    }

    // The sphere's own attitude, one stop to the next.
    const yawAim = REST_YAW + GAZE_YAW * gazeX, pitchAim = REST_PITCH + GAZE_PITCH * gazeY + (attentive ? LISTEN : speaking ? SPEAK : 0);
    if ((yawAim !== yawTo || pitchAim !== pitchTo) && t - poseTick >= 2) { yawFrom = yawTo; pitchFrom = pitchTo; yawTo = yawAim; pitchTo = pitchAim; poseTick = t; }
  }

  // Reduced motion: every part already on the stop its state calls for, and nothing on its way anywhere.
  function rest() {
    const live = mode === 'listening' || mode === 'speaking';
    heard.reset(); spoken.reset(); knocks.fill(-999); notch.fill(0); greenHold.fill(0); ratchet.fill(0); seek.fill(0); busy.fill(0);
    hearing = attentive = reach = clock = handNow = handFrom = handTo = gazeX = gazeY = 0; heardClick = spokenClick = false;
    wasLive = live; liveTick = live ? done - 999 : -999; leaveTick = -999; thinkTick = -999;
    ajar.fill(0); ajarTick.fill(-1); hatchRings = 0; taking = null;
    for (let k = 0; k < COURSES; k++) {
      steps[k] = wanted[k] = live ? 0 : home[k]; dialFrom[k] = dialTo[k] = steps[k] * pitch[k]; dialTick[k] = pinTick[k] = wantTick[k] = -99;
      pin[k] = 0; pinFrom[k] = pinTo[k] = 0;
      want[k] = !live ? GREY : mode === 'speaking' && k < Math.round(LUNA * .6) ? WARM : LIVE;
    }
    for (let index = 0; index < count; index++) { sideA[index] = want[course[index]]; sideB[index] = GREY; parity[index] = 0; turnTick[index] = -1; }
    // The chapters' stones are already standing, the chosen one in Luna's colour.
    pegStones.forEach((stone, peg) => {
      if (peg === chosen && live) sideA[stone] = WARM;
      pegNow[peg] = peg === chosen ? PEG_CHOSEN : PEG_UP; pegFrom[peg] = pegTo[peg] = pegNow[peg] * NOTCH; pegTick[peg] = -99;
    });
    yawFrom = yawTo = REST_YAW; pitchFrom = pitchTo = REST_PITCH; poseTick = handTick = -99;
  }

  // Where every part is at this instant, between its last stop and its next.
  function compose(now) {
    for (let k = 0; k < COURSES; k++) dial[k] = dialFrom[k] + (dialTo[k] - dialFrom[k]) * travel((now - dialTick[k]) / dialTicks[k]);
    const handHeight = handTo >= handFrom ? handFrom + (handTo - handFrom) * travel(now - handTick) : handFrom + (handTo - handFrom) * seatDown(now - handTick);
    const moving = (now - poseTick) / 2;
    quatAxis(0, 1, 0, yawFrom + (yawTo - yawFrom) * travel(moving), yaw);
    quatAxis(1, 0, 0, pitchFrom + (pitchTo - pitchFrom) * travel(moving), pitching);
    quatToMat3(quatMul(yaw, pitching, pose), sway);
    let ring = -1, cz = 1, sz = 0, c1 = 1, s1 = 0, piston = 0;
    for (let index = 0; index < count; index++) {
      const k = course[index], at = index * STRIDE, n = index * 3, f = index * 4;
      if (k !== ring) {
        ring = k; cz = Math.cos(dial[k] / 2); sz = Math.sin(dial[k] / 2); c1 = cz * cz - sz * sz; s1 = 2 * sz * cz;
        piston = pinTo[k] >= pinFrom[k] ? pinFrom[k] + (pinTo[k] - pinFrom[k]) * travel(now - pinTick[k]) : pinFrom[k] + (pinTo[k] - pinFrom[k]) * seatDown(now - pinTick[k]);
      }
      // Up as a piston; or lifted clear, turned over about its meridian, and seated.
      let lifted = index === hand ? Math.max(piston, handHeight) : piston, over = parity[index] * Math.PI;
      const peg = pegOf[index];
      if (peg >= 0) lifted = piston + (pegTo[peg] >= pegFrom[peg] ? pegFrom[peg] + (pegTo[peg] - pegFrom[peg]) * travel(now - pegTick[peg]) : pegFrom[peg] + (pegTo[peg] - pegFrom[peg]) * seatDown(now - pegTick[peg]));
      if (turnTick[index] >= 0) {
        const since = now - turnTick[index];
        lifted = Math.max(lifted, since < 1 ? travel(since) * POP : since < 2 ? POP : (1 - seatDown(since - 2)) * POP);
        if (since >= 1) over += (since < 2 ? travel(since - 1) : 1) * Math.PI;
      }
      // A slat of the hatch: lifted clear and stood on edge, or on its way there or back.
      if (ajarTick[index] >= 0) {
        const since = now - ajarTick[index];
        if (ajarGo[index]) { lifted = Math.max(lifted, since < 1 ? travel(since) * POP : POP); if (since >= 1) over += travel(since - 1) * Math.PI / 2; }
        else { lifted = Math.max(lifted, since < 1 ? POP : (1 - seatDown(since - 1)) * POP); if (since < 1) over += (1 - Math.min(1, since / .8)) * Math.PI / 2; }
      } else if (ajar[index]) { lifted = Math.max(lifted, POP); over += Math.PI / 2; }
      angle[index] = over; height[index] = lifted; shown[index] = Math.cos(over) >= 0 ? sideA[index] : sideB[index];
      // The ring's turn about the axis through the poles, then the stone's own.
      const bx = frame[f], by = frame[f + 1], bz = frame[f + 2], bw = frame[f + 3];
      const qx = cz * bx - sz * by, qy = cz * by + sz * bx, qz = cz * bz + sz * bw, qw = cz * bw - sz * bz;
      const cg = over === 0 ? 1 : Math.cos(over / 2), sg = over === 0 ? 0 : Math.sin(over / 2);
      tiles[at + TURN] = qx * cg - qz * sg;
      tiles[at + TURN + 1] = qw * sg + qy * cg;
      tiles[at + TURN + 2] = qx * sg + qz * cg;
      tiles[at + TURN + 3] = qw * cg - qy * sg;
      const out = radius + seat[index] + lifted;
      tiles[at + PLACE] = (c1 * normal[n] - s1 * normal[n + 1]) * out;
      tiles[at + PLACE + 1] = (s1 * normal[n] + c1 * normal[n + 1]) * out;
      tiles[at + PLACE + 2] = normal[n + 2] * out;
      tiles[at + PLACE + 3] = Math.min(1, lifted / 2.6);
      tiles[at + FACES] = sideA[index]; tiles[at + FACES + 1] = sideB[index];
    }
  }

  // `gaze` is where a moving pointer is, from -1 to 1 across the sphere's surroundings, or null.
  // `hatch` is { angle, near } while a document is held over the page: its bearing from the sphere's
  // centre, clockwise from the right as the viewer sees it, and how near it is from 0 to 1.
  // `intake` is { id, angle } from the moment a document is dropped. `chapters` and `chapter` are
  // how many chapters the document in hand has and which is chosen.
  function step({ state, level = 0, input = null, output = null, time, reduced = false, gaze = null, hatch = null, intake = null, chapters = 0, chapter = -1 } = {}) {
    const now = Number.isFinite(time) ? time : previous || 0;
    const dt = previous === null ? 16 : Math.max(0, Math.min(80, now - previous));
    previous = now;
    if (origin === null) origin = now;
    mode = state;
    setPegs(chapters, done + 1);
    chosen = chapter;
    if (reduced) { if (intake && intake.id !== taken) taken = intake.id; rest(); origin = now - (done + 1) * TICK; compose(done + 1); return; }
    // The hatch opens in whole rings: two for a document anywhere on the page, all of them when it is close.
    if (intake && intake.id !== taken && (!taking || taking.id !== intake.id)) {
      taking = { id: intake.id, since: done + 1, shut: -1, wasOpen: hatchRings === HATCH_RINGS };
      if (Number.isFinite(intake.angle)) hatchAngle = intake.angle;
      if (!hatchRings) hatchTick = done + 1;
      hatchRings = HATCH_RINGS;
    } else if (!taking) {
      const rings = hatch ? Math.max(2, Math.min(HATCH_RINGS, 2 + Math.round(clamp(hatch.near) * (HATCH_RINGS - 2)))) : 0;
      if (rings && !hatchRings) hatchTick = done + 1;
      if (hatch && Number.isFinite(hatch.angle)) hatchAngle = hatch.angle;
      hatchRings = rings;
    }
    const live = state === 'listening' || state === 'speaking';
    heard.push(live ? input : null, live && !input && state === 'listening' ? level : 0, now, dt);
    spoken.push(live ? output : null, live && !output && state === 'speaking' ? level : 0, now, dt);
    // Her own voice in the room must not read as someone answering.
    mine = 1 - .85 * spoken.level(); hearing = heard.level() * mine;
    // A syllable is held until the next tick takes it.
    if (heard.onset()) heardClick = true;
    if (spoken.onset()) spokenClick = true;
    // A pointer turns the sphere one stop towards it, and it must come well back before the sphere does.
    const stop = (held, where) => where === null ? 0 : where > (held > 0 ? .25 : .4) ? 1 : where < (held < 0 ? -.25 : -.4) ? -1 : 0;
    gazeX = stop(gazeX, gaze ? gaze.x : null); gazeY = stop(gazeY, gaze ? gaze.y : null);
    // After a long gap (a hidden tab) the machine picks up where it stopped rather than racing to catch up.
    let at = (now - origin) / TICK;
    if (Math.floor(at) - done > 36) { origin = now - (done + 36) * TICK; at = (now - origin) / TICK; }
    while (done < Math.floor(at)) onTick(++done);
    compose(at);
  }

  return {
    step, tiles, sway, dial,
    // For the tests: every stone's turn, height above its seat and outward side; every ring's stop and piston; and the named parts.
    angle, height, shown, sideA, sideB, steps, pin, want, pitch, home, ajar,
    parts: { limb: LIMB, luna: LUNA, clock: CLOCK, knock: KNOCK, hand, terraceOf, hatch: HATCH, pegs: PEGS },
    tick: () => done,
    // The stone standing for each chapter, and the last document the hatch finished taking in.
    pegs: () => pegStones,
    taken: () => taken,
  };
}
