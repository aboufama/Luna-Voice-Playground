import { TAU, clamp, smooth, follow, hash, quatAxis, quatMul, quatRotate, quatConjugate, quatToMat3 } from './sphere-math.mjs';
import { COURSES, FACE_ARC, PITCH, SHEET_ROW, SHEET_STONE } from './sphere-field.mjs';

export const BANDS = 16;
// One stone's state for one frame, as the renderer uploads it: a unit
// quaternion, a position, how clear of the mortar it stands (for shading), and
// which stone is on each of its two sides.
export const STRIDE = 12, TURN = 0, PLACE = 4, FACES = 8;
// One socket's piece of the shell for one frame: the turn and the shift that
// carry it, with its cell of mortar and its stone, when the shell cracks open.
export const CELL_STRIDE = 8;
// The stones a block can show. A block has two sides; the one in its socket is
// changed out of sight, and it shows it by lifting clear and turning over.
// The last is the pale stone of a document's page.
export const GREY = 0, LIVE = 1, GREEN = 2, WARM = 3, PAGE = 4;

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
// A document is not a part of the machine, and nothing about taking one in runs on the tick: its stones
// fall, the broken shell swings, and what is swallowed spreads, each as such things do.
//
// A document held near the sphere cracks its shell open where it faces the document. The crack reaches this
// far over the surface from its middle, and breaks the shell there into this many pieces. Each piece swings
// out on its far edge like a door on a spring: only cracked when the document is far off, wide when it is
// close, anywhere between in between, a little past where it means to stand before it settles, and never
// quite still while it is open (radians).
export const MOUTH = 44, PIECES = 6, GAPE = { cracked: .24, wide: 1.2, breath: .045 };
// How quickly a piece swings open and how quickly it shuts (radians a millisecond), and how soon each swing dies away.
const SWING = .019, SHUT = .044, SETTLE = .5, SETTLE_SHUT = .9;
// If the document comes to be further than this (radians, seen from the sphere's centre) from the middle
// of the crack, the crack shuts and opens again where the document now is.
const STRAY = .62;
// In the hand, each stone of the sheet follows the pointer in its own time (milliseconds, quickest and slowest).
const TRAIL = [34, 96];
// Dropped, every stone of the sheet starts for the crack at the same instant and gathers speed as if it
// were falling into it: a curve by way of the air this far above the crack, then down the middle of it to
// its place this far inside. The quickest takes FLY ticks, the slowest SLOWEST more, and none waits for another.
export const FLY = 4.5, SLOWEST = 2.5;
const ABOVE = 62, INSIDE = 74, GATHER = 2.3;
// What the sphere has swallowed spreads through it as a ripple: outward from the crack, this many pixels of
// surface a tick, each stone in its own turn rises out of its socket, rolls over to the page's stone and
// seats, and a moment later does the same again to show its own. In ticks: the rise (and the seating), the
// roll, and the moment between.
const SPREAD = 13, RISE = .9, ROLL = 1.3, DWELL = 1.4, ONCE = RISE + ROLL + RISE, RIPPLE = ONCE * 2 + DWELL;
// While a document is still being read, the sphere swallows again this often: once the last ripple has gone right round.
const AGAIN = 46;
// A sheet first seen comes in from this far beyond where it is held.
const BEYOND = 280;
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
 *   a document     is a sheet of pale stones in the hand. Held near, the shell
 *                  cracks open where it faces the sheet: pieces of it, stones
 *                  and mortar together, swing out on their far edges, wider
 *                  the nearer the sheet comes, and the hollow inside shows.
 *                  Dropped, the sheet's stones shoot in one after another and
 *                  the pieces snap shut. What was swallowed then spreads: from
 *                  the crack outward every stone turns to the page's stone and
 *                  back. Last, one stone to a chapter turns to the page's stone
 *                  for good and stands up on its own ring, clockwise from the
 *                  top; the chosen one turns to Luna's colour and stands higher.
 *
 * `tiles`, `sway`, `dial` and `shell` are all the renderer is given.
 */
export function createSphereMotion(field) {
  const { count, radius, course, courseArc, places, normal, frame, seat, theta, sockets } = field;
  const sheet = field.sheet.count, socketOf = field.socket;
  // The sphere's own stones, and after them the stones of a document's sheet.
  const tiles = new Float32Array((count + sheet) * STRIDE), sway = new Float32Array(9), dial = new Float32Array(COURSES);
  // Every socket's piece of the shell: at rest, no turn and no shift.
  const shell = { carried: new Float32Array(sockets.count * CELL_STRIDE), changed: 0 };
  for (let socket = 0; socket < sockets.count; socket++) shell.carried[socket * CELL_STRIDE + 3] = 1;
  const courseAt = arc => courseArc.reduce((best, at, k) => Math.abs(at - arc) < Math.abs(courseArc[best] - arc) ? k : best, 0);
  // The last ring a viewer can see, the rings Luna can reach, and the clock's ring just outside the drawing.
  const LIMB = courseAt(Math.PI * radius / 2 - PITCH / 2), LUNA = courseAt(LUNA_REACH), CLOCK = courseAt(FACE_ARC + 1.5 * PITCH), KNOCK = LIMB - 2 * TERRACES;
  // The ring the chapters' stones stand on: on the face, clear of the clock.
  const PEGS = CLOCK + 3;
  const lag = k => Math.floor(Math.min(k, LIMB + 8) / 3), lagOut = k => k <= LIMB ? (LIMB - k) >> 1 : 0;

  // Stones: the two sides, which is out, when it began to turn, and its place in a cascade.
  const sideA = new Uint8Array(count), sideB = new Uint8Array(count), parity = new Uint8Array(count), turnTick = new Int32Array(count).fill(-1), stagger = new Uint8Array(count);
  const angle = new Float32Array(count), height = new Float32Array(count), shown = new Uint8Array(count);
  // The crack: which piece of the broken shell each socket belongs to (none, when the shell is whole),
  // and the crack itself: its middle, its pieces, and how wide it means to stand.
  const pieceOf = new Int8Array(sockets.count).fill(-1);
  let mouth = null, hungry = false, near = 0;
  // Where on the sphere the document faces it (in the sphere's own space), and the sphere's attitude and its undoing.
  const faced = new Float64Array([0, 0, 1]), pose = new Float64Array([0, 0, 0, 1]), unposed = new Float64Array([0, 0, 0, 1]);
  // The sheet: where its middle is held (as the camera sees it), where each of its stones is and how it
  // is turned (in the sphere's own space), and where each began its flight and when.
  const held = new Float64Array(sheet * 3), sheetPlace = new Float64Array(sheet * 3), sheetTurn = new Float64Array(sheet * 4);
  const flightFrom = new Float64Array(sheet * 3), flightTurn = new Float64Array(sheet * 4), flightBegan = new Float64Array(sheet).fill(-1), flightLasts = new Float64Array(sheet).fill(FLY);
  const flightTo = new Float64Array([0, 0, 1]);
  let sheetIs = 'inside', sheetLeft = -999, heldFor = 0;
  for (let stone = 0; stone < sheet; stone++) { settle(stone, [0, 0, 1], sheetPlace, stone * 3); sheetTurn[stone * 4 + 3] = 1; }
  // What has been swallowed, spreading: when it reaches each stone, and which stones it is rolling over just now.
  const spreadAt = new Float32Array(count).fill(-1), rippling = new Uint8Array(count);
  let spreadTick = -999, spreadFrom = null, studying = false;
  // Chapters: which chapter a stone stands for, and each chapter's stone and its stops, like the clock's hand.
  const pegOf = new Int8Array(count).fill(-1);
  let pegStones = [], pegNow = [], pegFrom = [], pegTo = [], pegTick = [], pegBorn = -999, chosen = -1;
  let taking = null, taken = null;
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
  const yaw = new Float64Array(4), pitching = new Float64Array(4), scratch = new Float64Array(3), twist = new Float64Array(4);

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
  // Two directions square to a third, and to each other.
  function square(along) {
    const flat = Math.abs(along[2]) > .9, ax = flat ? 1 : 0, az = flat ? 0 : 1;
    let ux = along[1] * az - along[2] * 0, uy = along[2] * ax - along[0] * az, uz = along[0] * 0 - along[1] * ax;
    const length = Math.hypot(ux, uy, uz); ux /= length; uy /= length; uz /= length;
    return [[ux, uy, uz], [along[1] * uz - along[2] * uy, along[2] * ux - along[0] * uz, along[0] * uy - along[1] * ux]];
  }
  // Where one of the sheet's stones lies inside the sphere once it has gone in along `along`: a loose heap under the crack.
  function settle(stone, along, out, at) {
    const [u, v] = square(along), deep = radius - INSIDE - 9 * (stone % 3), aside = (hash(stone + 1, 41) - .5) * 26, across = (hash(stone + 1, 43) - .5) * 26;
    for (let axis = 0; axis < 3; axis++) out[at + axis] = along[axis] * deep + u[axis] * aside + v[axis] * across;
  }
  // Where a socket is just now: its own place, carried round by its ring.
  function facing(normals, at, k, towards) {
    const turned = steps[k] * pitch[k], c = Math.cos(turned), sine = Math.sin(turned);
    return (c * normals[at] - sine * normals[at + 1]) * towards[0] + (sine * normals[at] + c * normals[at + 1]) * towards[1] + normals[at + 2] * towards[2];
  }
  // The shell breaks where the document faces it, into pieces round the middle of the crack like the slices
  // of a pie cut by an unsteady hand. Each piece is the sockets of one slice, stones and mortar together,
  // hinged along its far edge. The break runs between places, so it is as jagged as the stones are.
  function crack(t) {
    const middle = Float64Array.from(taking && taking.depart >= 0 ? flightTo : faced), [east, north] = square(middle), born = hash(t + 1, 5) * TAU;
    const widths = Array.from({ length: PIECES }, (_, piece) => .7 + hash(t + piece * 7 + 3, 9) * .6), whole = widths.reduce((sum, width) => sum + width, 0);
    const pieces = [];
    let from = 0;
    for (let piece = 0; piece < PIECES; piece++) {
      const width = widths[piece] / whole * TAU, reach = MOUTH * (.8 + hash(t + piece * 13 + 1, 11) * .4), mid = born + from + width / 2, lean = reach / radius;
      const out = [0, 1, 2].map(axis => Math.cos(mid) * east[axis] + Math.sin(mid) * north[axis]);
      pieces.push({
        from, to: from + width, reach, angle: 0, speed: 0, drawn: -1, quick: .82 + hash(t + piece * 3 + 2, 15) * .36, sway: hash(t + piece * 5 + 4, 17) * TAU,
        // The hinge lies on the surface at the piece's far edge, square to the way back to the middle.
        hinge: [0, 1, 2].map(axis => (Math.cos(lean) * middle[axis] + Math.sin(lean) * out[axis]) * radius),
        axis: [middle[1] * out[2] - middle[2] * out[1], middle[2] * out[0] - middle[0] * out[2], middle[0] * out[1] - middle[1] * out[0]],
        turn: new Float64Array([0, 0, 0, 1]), shift: new Float64Array(3),
      });
      from += width;
    }
    const members = [], reachable = Math.cos(MOUTH * 1.25 / radius);
    for (let socket = 0; socket < sockets.count; socket++) {
      const k = sockets.course[socket], n = socket * 3, towards = facing(sockets.normal, n, k, middle);
      if (towards < reachable) continue;
      let round = Math.atan2(facing(sockets.normal, n, k, north), facing(sockets.normal, n, k, east)) - born;
      round -= Math.floor(round / TAU) * TAU;
      const piece = Math.max(0, pieces.findIndex(part => round < part.to));
      if (Math.acos(Math.min(1, towards)) * radius >= pieces[piece].reach) continue;
      pieceOf[socket] = piece; members.push(socket);
    }
    mouth = { middle, pieces, members, wide: GAPE.cracked, shutting: false, strayed: false };
  }
  // The pieces are back in the shell: it is whole again.
  function mend() {
    for (const socket of mouth.members) {
      pieceOf[socket] = -1;
      shell.carried.fill(0, socket * CELL_STRIDE, (socket + 1) * CELL_STRIDE); shell.carried[socket * CELL_STRIDE + 3] = 1;
    }
    shell.changed++; mouth = null;
  }
  // The sheet's stones all leave the hand at once, each a little quicker or slower than the next, for the crack at `towards`.
  function launch(at, towards) {
    for (let stone = 0; stone < sheet; stone++) { flightBegan[stone] = at + hash(stone + 1, 57) * .4; flightLasts[stone] = FLY + hash(stone + 1, 59) * SLOWEST; }
    flightFrom.set(sheetPlace); flightTurn.set(sheetTurn); flightTo.set(towards);
    sheetIs = 'flying';
  }
  // What was swallowed spreads from where it went in: it reaches each stone when it has crossed the surface to it.
  function spread(t, from) {
    spreadTick = t; spreadFrom = from;
    for (let index = 0; index < count; index++) if (!rippling[index]) spreadAt[index] = t + .5 + Math.acos(clamp(facing(normal, index * 3, course[index], from), -1, 1)) * radius / SPREAD;
  }

  // Where a stone of the sheet lies in the sheet, laid out as a page: across, and up.
  const across = stone => (stone % SHEET_ROW - (SHEET_ROW - 1) / 2) * (SHEET_STONE + .8), up = stone => ((sheet / SHEET_ROW - 1) / 2 - Math.floor(stone / SHEET_ROW)) * (SHEET_STONE + .8);
  // The pieces of a cracked shell swing towards how wide the crack means to stand, each a little in its own time.
  function swing(dt, time) {
    const closing = mouth.wide <= 0;
    for (const piece of mouth.pieces) {
      const mean = closing ? 0 : mouth.wide + GAPE.breath * Math.sin(time * .0045 + piece.sway), rate = (closing ? SHUT : SWING) * piece.quick, drag = 2 * (closing ? SETTLE_SHUT : SETTLE) * rate;
      for (let left = dt; left > 0; left -= 4) {
        const span = Math.min(4, left);
        piece.speed += (-rate * rate * (piece.angle - mean) - drag * piece.speed) * span;
        piece.angle += piece.speed * span;
        // A piece cannot swing into the shell it came from; and shutting, the last hair's breadth is a click.
        if (piece.angle <= (closing ? .004 : 0)) { piece.angle = 0; piece.speed = Math.max(0, piece.speed); }
      }
    }
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

    // A document about. The shell cracks where it faces it, once the rings have come to rest, and holds them
    // still while it is open; wider the nearer the document comes; and if the document strays, it shuts to open there.
    const about = hungry || Boolean(taking);
    if (!mouth && about && dialTick.every((began, k) => t - began >= dialTicks[k])) crack(t);
    if (mouth) {
      const off = Math.acos(clamp(mouth.middle[0] * faced[0] + mouth.middle[1] * faced[1] + mouth.middle[2] * faced[2], -1, 1));
      const swallowing = taking && taking.depart >= 0;
      // Dropped, the sheet's stones are already on their way. As the last of them goes in the crack shuts behind
      // it, and what was swallowed starts to spread from there at the same moment.
      if (swallowing && taking.shut < 0 && t >= taking.depart + FLY + SLOWEST) {
        taking.shut = t; sheetIs = 'inside';
        for (let stone = 0; stone < sheet; stone++) settle(stone, mouth.middle, sheetPlace, stone * 3);
        spread(t, mouth.middle);
      }
      mouth.shutting = Boolean(taking && taking.shut >= 0);
      mouth.strayed = Boolean(about && off > STRAY && !taking);
      // Shut again, every piece back in its place: the shell is whole, and the document, if there was one, is taken.
      if ((mouth.shutting || mouth.strayed || !about) && mouth.pieces.every(piece => piece.angle === 0)) {
        mend();
        if (taking && taking.shut >= 0) { taken = taking.id; taking = null; }
      }
    }
    // Still being read: the sphere swallows again. Read, and long enough since: it is all taken in.
    if (spreadTick >= 0 && !taking && t >= spreadTick + AGAIN) { if (studying && spreadFrom) spread(t, spreadFrom); else spreadTick = -999; }
    // The sheet, let go of without being dropped, is gone once it is out of sight.
    if (sheetIs === 'leaving' && t >= sheetLeft + 6) { sheetIs = 'inside'; for (let stone = 0; stone < sheet; stone++) settle(stone, [0, 0, 1], sheetPlace, stone * 3); }
    const marking = pegStones.length > 0 && !taking;

    // Stones: finish a turn, or begin one if the stone is seated and its turn has come.
    busy.fill(0);
    for (let index = 0; index < count; index++) {
      const k = course[index];
      if (turnTick[index] >= 0) {
        if (t - turnTick[index] < TURN_TICKS) { busy[k]++; continue; }
        parity[index] ^= 1; turnTick[index] = -1;
      }
      const peg = pegOf[index], seated = pin[k] === 0 && t - pinTick[k] >= 1 && (index !== hand || (handNow === 0 && t - handTick >= 1)) && (peg < 0 || (pegNow[peg] === 0 && t - pegTick[peg] >= 1));
      // What has been swallowed rolls each stone over to the page's stone and back as it passes. While it has a
      // stone the machine leaves that stone alone; just before it arrives, the side in the socket becomes the page's stone.
      if (rippling[index]) { if (t < spreadAt[index] + RIPPLE) { busy[k]++; continue; } rippling[index] = 0; }
      else if (spreadTick >= 0 && peg < 0 && index !== hand && t < spreadAt[index] && t + 1 >= spreadAt[index]) {
        if (parity[index]) sideA[index] = PAGE; else sideB[index] = PAGE;
        rippling[index] = 1; busy[k]++; continue;
      }
      // A chapter's stone keeps the page's stone once the ripple has reached it; the chosen chapter's shows
      // Luna's colour instead. Otherwise a stone shows what its ring is showing.
      const reached = spreadTick < 0 || t >= spreadAt[index];
      const wish = peg >= 0 && marking && reached ? (peg === chosen && live ? WARM : PAGE) : want[k];
      if ((parity[index] ? sideB[index] : sideA[index]) === wish) continue;
      busy[k]++;
      if (!seated || (wish === want[k] && t - wantTick[k] < (cascade[k] ? stagger[index] : 0))) continue;
      // The side in the socket is exchanged out of sight; the turn that follows shows it.
      if (parity[index]) sideA[index] = wish; else sideB[index] = wish;
      turnTick[index] = t;
    }
    // Chapters: each stone stands up once it shows the right side, one after another round the ring.
    for (let peg = 0; peg < pegStones.length; peg++) {
      const stone = pegStones[peg], wish = peg === chosen && live ? WARM : PAGE;
      const ready = marking && (spreadTick < 0 || t >= spreadAt[stone]) && turnTick[stone] < 0 && (parity[stone] ? sideB[stone] : sideA[stone]) === wish && t >= pegBorn + TURN_TICKS + peg;
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
      // A ring cannot turn through a break in the shell: every ring waits until it is whole again.
      if (steps[k] !== wanted[k] && t - dialTick[k] >= dialTicks[k] && !about && !mouth) {
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
    if (mouth) mend();
    taking = null; hungry = false; spreadTick = -999; spreadFrom = null; flightBegan.fill(-1); heldFor = 0; rippling.fill(0);
    if (sheetIs !== 'inside') { sheetIs = 'inside'; for (let stone = 0; stone < sheet; stone++) settle(stone, [0, 0, 1], sheetPlace, stone * 3); }
    for (let k = 0; k < COURSES; k++) {
      steps[k] = wanted[k] = live ? 0 : home[k]; dialFrom[k] = dialTo[k] = steps[k] * pitch[k]; dialTick[k] = pinTick[k] = wantTick[k] = -99;
      pin[k] = 0; pinFrom[k] = pinTo[k] = 0;
      want[k] = !live ? GREY : mode === 'speaking' && k < Math.round(LUNA * .6) ? WARM : LIVE;
    }
    for (let index = 0; index < count; index++) { sideA[index] = want[course[index]]; sideB[index] = GREY; parity[index] = 0; turnTick[index] = -1; }
    // The chapters' stones are already standing in the page's stone, the chosen one in Luna's colour.
    pegStones.forEach((stone, peg) => {
      sideA[stone] = peg === chosen && live ? WARM : PAGE;
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
    quatConjugate(pose, unposed);
    // The pieces of a cracked shell, each swung out on its hinge as far as it has got.
    if (mouth) {
      let moved = false;
      for (const piece of mouth.pieces) {
        if (piece.angle === piece.drawn) continue;
        piece.drawn = piece.angle; moved = true;
        quatAxis(piece.axis[0], piece.axis[1], piece.axis[2], piece.angle, piece.turn);
        quatRotate(piece.turn, piece.hinge, piece.shift);
        for (let axis = 0; axis < 3; axis++) piece.shift[axis] = piece.hinge[axis] - piece.shift[axis];
      }
      if (moved) {
        for (const socket of mouth.members) {
          const piece = mouth.pieces[pieceOf[socket]], at = socket * CELL_STRIDE;
          shell.carried[at] = piece.turn[0]; shell.carried[at + 1] = piece.turn[1]; shell.carried[at + 2] = piece.turn[2]; shell.carried[at + 3] = piece.turn[3];
          shell.carried[at + 4] = piece.shift[0]; shell.carried[at + 5] = piece.shift[1]; shell.carried[at + 6] = piece.shift[2];
        }
        shell.changed++;
      }
    }
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
      // The ripple: out of its socket, over, and seated; a moment; then the same again. Each part starts and ends gently.
      if (rippling[index]) {
        const since = now - spreadAt[index];
        if (since > 0 && since < RIPPLE) {
          const again = since >= ONCE + DWELL, within = again ? since - ONCE - DWELL : Math.min(since, ONCE);
          const rolled = smooth((within - RISE) / ROLL);
          lifted = Math.max(lifted, POP * (within < RISE ? smooth(within / RISE) : within < RISE + ROLL ? 1 : 1 - smooth((within - RISE - ROLL) / RISE)));
          over += (again ? 1 + rolled : rolled) * Math.PI;
        }
      }
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
      // A stone set in a piece of broken shell goes where the piece goes: the piece's turn after its own, about the piece's hinge.
      const piece = mouth ? pieceOf[socketOf[index]] : -1;
      if (piece >= 0) {
        const h = mouth.pieces[piece].turn, shift = mouth.pieces[piece].shift;
        const tx = tiles[at + TURN], ty = tiles[at + TURN + 1], tz = tiles[at + TURN + 2], tw = tiles[at + TURN + 3];
        tiles[at + TURN] = h[3] * tx + h[0] * tw + h[1] * tz - h[2] * ty;
        tiles[at + TURN + 1] = h[3] * ty - h[0] * tz + h[1] * tw + h[2] * tx;
        tiles[at + TURN + 2] = h[3] * tz + h[0] * ty - h[1] * tx + h[2] * tw;
        tiles[at + TURN + 3] = h[3] * tw - h[0] * tx - h[1] * ty - h[2] * tz;
        const px = tiles[at + PLACE], py = tiles[at + PLACE + 1], pz = tiles[at + PLACE + 2];
        const cx = h[1] * pz - h[2] * py + h[3] * px, cy = h[2] * px - h[0] * pz + h[3] * py, cz2 = h[0] * py - h[1] * px + h[3] * pz;
        tiles[at + PLACE] = px + 2 * (h[1] * cz2 - h[2] * cy) + shift[0];
        tiles[at + PLACE + 1] = py + 2 * (h[2] * cx - h[0] * cz2) + shift[1];
        tiles[at + PLACE + 2] = pz + 2 * (h[0] * cy - h[1] * cx) + shift[2];
      }
    }
    // The sheet's stones: in the hand, in flight, or lying inside.
    for (let stone = 0; stone < sheet; stone++) {
      const at = (count + stone) * STRIDE, p = stone * 3, q = stone * 4;
      if (sheetIs === 'held' || sheetIs === 'leaving') {
        // Where it has got to, as the camera sees it, and a little out of true.
        scratch[0] = held[p]; scratch[1] = held[p + 1]; scratch[2] = held[p + 2];
        quatRotate(unposed, scratch, scratch);
        sheetPlace[p] = scratch[0]; sheetPlace[p + 1] = scratch[1]; sheetPlace[p + 2] = scratch[2];
        quatMul(unposed, quatAxis(0, 0, 1, (hash(stone + 1, 53) - .5) * .16, twist), twist);
        sheetTurn.set(twist, q);
        if (stone === 0) heldFor++;
      } else if (sheetIs === 'flying' && flightBegan[stone] >= 0) {
        // Falling into the crack: slowly at first, then faster and faster, along a curve that ends straight down the middle of it.
        const gone = clamp((now - flightBegan[stone]) / flightLasts[stone]), fall = Math.pow(gone, GATHER), yet = 1 - fall;
        settle(stone, flightTo, scratch, 0);
        for (let axis = 0; axis < 3; axis++) sheetPlace[p + axis] = yet * yet * flightFrom[p + axis] + 2 * yet * fall * flightTo[axis] * (radius + ABOVE) + fall * fall * scratch[axis];
        quatMul(flightTurn.subarray(q, q + 4), quatAxis(1, .3 + .4 * hash(stone + 1, 61), 0, fall * 5.2, twist), twist);
        sheetTurn.set(twist, q);
      }
      tiles[at + TURN] = sheetTurn[q]; tiles[at + TURN + 1] = sheetTurn[q + 1]; tiles[at + TURN + 2] = sheetTurn[q + 2]; tiles[at + TURN + 3] = sheetTurn[q + 3];
      tiles[at + PLACE] = sheetPlace[p]; tiles[at + PLACE + 1] = sheetPlace[p + 1]; tiles[at + PLACE + 2] = sheetPlace[p + 2]; tiles[at + PLACE + 3] = 1;
      tiles[at + FACES] = PAGE; tiles[at + FACES + 1] = PAGE;
    }
  }

  // `gaze` is where a moving pointer is, from -1 to 1 across the sphere's surroundings, or null.
  // `file` is a document held over the page: { at, aim, near }. `at` is where its sheet is held and `aim`
  // the way from the sphere's centre to where on the sphere it faces, both as the camera sees them (x right,
  // y up, z towards the viewer); `near` is how near it is, from 0 to 1. `intake` is { id, at, aim } from the
  // moment a document is dropped. `chapters` and `chapter` are how many chapters the document in hand has
  // and which is chosen; `reading` is whether it is still being read.
  function step({ state, level = 0, input = null, output = null, time, reduced = false, gaze = null, file = null, intake = null, chapters = 0, chapter = -1, reading = false } = {}) {
    const now = Number.isFinite(time) ? time : previous || 0;
    const dt = previous === null ? 16 : Math.max(0, Math.min(80, now - previous));
    previous = now;
    if (origin === null) origin = now;
    mode = state;
    setPegs(chapters, done + 1);
    chosen = chapter; studying = Boolean(reading);
    if (reduced) { if (intake && intake.id !== taken) taken = intake.id; rest(); origin = now - (done + 1) * TICK; compose(done + 1); return; }
    const dropped = intake && intake.id !== taken ? intake : null, about = file || dropped;
    if (dropped && !taking) taking = { id: dropped.id, depart: -1, shut: -1 };
    // The instant it is let go (and there is a crack to fall into), every stone of the sheet starts for it.
    if (taking && taking.depart < 0 && sheetIs === 'held' && heldFor > 0 && mouth) { taking.depart = (now - origin) / TICK; launch(taking.depart, mouth.middle); }
    hungry = Boolean(file);
    if (about) {
      quatRotate(unposed, about.aim, faced);
      const length = Math.hypot(faced[0], faced[1], faced[2]) || 1;
      faced[0] /= length; faced[1] /= length; faced[2] /= length;
      near = file ? clamp(file.near) : 1;
    }
    // The sheet is where the document is held, laid out as a page. First seen, it comes in from beyond there.
    // Each stone follows the hand in its own time, so the sheet trails and gathers as it is moved, and none
    // of them is ever quite still. Let go of without being dropped, they go back the way they came.
    if (about && sheetIs !== 'flying' && !(taking && taking.depart >= 0)) {
      if (sheetIs !== 'held') {
        const far = Math.hypot(about.at[0], about.at[1]), ox = far > 1 ? about.at[0] / far : 0, oy = far > 1 ? about.at[1] / far : -1;
        for (let stone = 0; stone < sheet; stone++) {
          const beyond = BEYOND * (1 + hash(stone + 1, 55) * .5);
          held[stone * 3] = about.at[0] + across(stone) + ox * beyond; held[stone * 3 + 1] = about.at[1] + up(stone) + oy * beyond; held[stone * 3 + 2] = about.at[2];
        }
        sheetIs = 'held'; heldFor = 0;
      }
      for (let stone = 0; stone < sheet; stone++) {
        const lag = TRAIL[0] + (TRAIL[1] - TRAIL[0]) * hash(stone + 1, 63), at = stone * 3;
        held[at] = follow(held[at], about.at[0] + across(stone) + .7 * Math.sin(now * .0031 + stone * 2.1), dt, lag);
        held[at + 1] = follow(held[at + 1], about.at[1] + up(stone) + .9 * Math.sin(now * .0037 + stone * 1.3), dt, lag);
        held[at + 2] = follow(held[at + 2], about.at[2] + 1.2 * Math.sin(now * .0043 + stone * 1.7), dt, lag);
      }
    } else if (sheetIs === 'held' && !taking) { sheetIs = 'leaving'; sheetLeft = done; }
    if (sheetIs === 'leaving') for (let stone = 0; stone < sheet; stone++) {
      const at = stone * 3, far = Math.hypot(held[at], held[at + 1]) || 1, haste = dt * (1.8 + hash(stone + 1, 65) * 1.4);
      held[at] += held[at] / far * haste; held[at + 1] += held[at + 1] / far * haste;
    }
    // The crack means to stand as wide as the document is near, and its pieces swing towards that.
    if (mouth) {
      mouth.wide = mouth.shutting || mouth.strayed || !about ? 0 : taking ? GAPE.wide : GAPE.cracked + (GAPE.wide - GAPE.cracked) * smooth(near);
      swing(dt, now);
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
    step, tiles, sway, dial, shell,
    // For the tests: every stone's turn, height above its seat and outward side; every ring's stop and piston; and the named parts.
    angle, height, shown, sideA, sideB, steps, pin, want, pitch, home, pieceOf,
    parts: { limb: LIMB, luna: LUNA, clock: CLOCK, knock: KNOCK, hand, terraceOf, pegs: PEGS },
    tick: () => done,
    // The stone standing for each chapter; the crack, while there is one; where the sheet is; and the last document swallowed.
    pegs: () => pegStones,
    mouth: () => mouth,
    sheet: () => sheetIs,
    taken: () => taken,
  };
}
