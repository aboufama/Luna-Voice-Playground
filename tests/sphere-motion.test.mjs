import test from 'node:test';
import assert from 'node:assert/strict';
import { createSphereField, COURSES, RADIUS } from '../src/sphere/sphere-field.mjs';
import { createSphereMotion, travel, BANDS, TICK, NOTCH, POP, TURN_TICKS, GREY, LIVE, GREEN, WARM, PAGE, STRIDE, TURN, PLACE, FACES, CELL_STRIDE, MOUTH, CURL } from '../src/sphere/sphere-motion.mjs';
import { MORTAR, SHELL } from '../src/sphere/sphere-mesh.mjs';

const field = createSphereField();
const FRAME = 1000 / 60;
const voice = level => new Float32Array(BANDS).map((_, band) => Math.max(0, level * (1 - band * .035)));
const silence = new Float32Array(BANDS);
// Speech has syllables: about four a second, each followed by a dip.
const speech = level => time => voice(time % 260 < 170 ? level : level * .45);
const quiet = { state: 'listening', input: silence, output: silence };
const person = level => time => ({ state: 'listening', input: speech(level)(time), output: silence });
const luna = level => time => ({ state: 'speaking', input: silence, output: speech(level)(time) });

// One sphere and a clock to run it by. `watch` is called after every frame.
function machine() {
  const motion = createSphereMotion(field);
  let time = 0;
  function run(ms, input, watch) {
    for (const end = time + ms; time < end; time += FRAME) {
      motion.step({ time, ...(typeof input === 'function' ? input(time) : input) });
      watch?.(time);
    }
  }
  const showing = (material, where = () => true) => { let total = 0; for (let index = 0; index < field.count; index++) if (motion.shown[index] === material && where(field.course[index])) total++; return total; };
  const live = () => { run(900, { state: 'thinking' }); run(3200, quiet); };
  return { motion, run, showing, live, time: () => time };
}
// A stone is turning while it is anywhere but flat on one side or the other.
const turning = (motion, index) => Math.abs(Math.sin(motion.angle[index])) > 1e-6;

test('a sphere that is not live is grey stone, seated and still, whatever it hears', () => {
  const { motion, run } = machine();
  run(900, { state: 'idle', level: .6, input: voice(.8), output: voice(.8) }, () => {
    for (let index = 0; index < field.count; index += 7) assert.ok(motion.shown[index] === GREY && motion.height[index] === 0 && motion.angle[index] === 0);
  });
  // Its rings sit out of register, as a lock does before it is dialled, and do not move.
  assert.deepEqual([...motion.steps], [...motion.home]);
  assert.ok(motion.home.filter(place => place !== 0).length > COURSES / 2);
  assert.ok([...motion.dial].every((angle, ring) => Math.abs(angle - motion.home[ring] * motion.pitch[ring]) < 1e-5));
});

test('connecting is a lock being dialled: groups of rings stand up one notch and click round by whole places', () => {
  const { motion, run } = machine();
  let highest = 0;
  const visited = new Set();
  run(2400, { state: 'thinking' }, () => {
    for (let index = 0; index < field.count; index += 3) {
      assert.equal(motion.shown[index], GREY, 'nothing turns to colour while it seeks');
      assert.equal(turning(motion, index), false);
      highest = Math.max(highest, motion.height[index]);
    }
    motion.steps.forEach((place, ring) => { if (place !== motion.home[ring]) visited.add(ring); });
  });
  // One notch up, with only the smallest of settles past it; and a good many rings have been tried.
  assert.ok(highest > NOTCH - 1e-5 && highest < NOTCH * 1.06, `stood ${highest}`);
  assert.ok(visited.size >= 6);
  // A ring is carried by its piston as one piece: every stone of a ring stands at the same height.
  const height = new Map();
  for (let index = 0; index < field.count; index++) {
    const ring = field.course[index];
    if (!height.has(ring)) height.set(ring, motion.height[index]);
    else assert.equal(motion.height[index], height.get(ring));
  }
});

test('going live: the rings find register from the pole outward, and behind that the stones turn over to colour', () => {
  const { motion, run, showing } = machine();
  run(900, { state: 'thinking' });
  const coloured = new Map();
  run(3400, quiet, time => {
    for (const [name, where] of [['front', ring => ring >= 1 && ring <= 4], ['limb', ring => ring >= motion.parts.limb - 3 && ring <= motion.parts.limb]]) {
      if (!coloured.has(name) && showing(GREY, where) === 0) coloured.set(name, time);
    }
  });
  assert.ok(coloured.get('front') + 300 < coloured.get('limb'), 'the front of the sphere colours well before its outline');
  assert.equal(showing(LIVE), field.count);
  // In register: every ring on its zero, except the one that keeps time.
  motion.steps.forEach((place, ring) => { if (ring !== motion.parts.clock) assert.equal(place, 0, `ring ${ring}`); });
});

test('a stone turns over only once it has lifted clear of its socket, and seats again after', () => {
  const { motion, run } = machine();
  let turns = 0;
  const check = () => {
    for (let index = 0; index < field.count; index++) {
      if (!turning(motion, index)) continue;
      turns++;
      assert.ok(motion.height[index] >= POP - 1e-6, `stone ${index} was turning at height ${motion.height[index]}`);
    }
  };
  run(900, { state: 'thinking' }, check);
  run(2600, quiet, check);
  run(1500, luna(.6), check);
  run(1500, person(.7), check);
  run(1500, { state: 'idle' }, check);
  assert.ok(turns > 20_000, 'the check only means something if stones really turned');
  // At the top of that lift even the widest point of the stone, swung straight down, is clear of the mortar.
  for (let index = 0; index < field.count; index++) assert.ok(field.seat[index] + POP - field.reach[index] > MORTAR, `stone ${index}`);
  // Lift, turn, seat: a tick each.
  assert.equal(TURN_TICKS, 3);
});

test('nothing changes colour in place: what a stone shows changes only as it turns over, out of its socket', () => {
  const { motion, run } = machine();
  const before = new Uint8Array(field.count), facing = new Int8Array(field.count);
  let changes = 0;
  const watch = () => {
    for (let index = 0; index < field.count; index++) {
      // Exactly on edge, neither side is towards the viewer: that instant belongs to whichever side comes next.
      const cosine = Math.cos(motion.angle[index]), onEdge = Math.abs(cosine) < 1e-5, side = onEdge ? facing[index] : cosine > 0 ? 1 : -1;
      if (motion.shown[index] !== before[index]) {
        changes++;
        // It is showing something else only because its other side has come round, high above the mortar.
        assert.ok((onEdge || side !== facing[index]) && motion.height[index] >= POP - 1e-4, `stone ${index} changed from ${before[index]} to ${motion.shown[index]} in place (height ${motion.height[index]}, angle ${motion.angle[index]})`);
      }
      before[index] = motion.shown[index]; facing[index] = side;
    }
  };
  motion.step({ state: 'idle', time: -FRAME });
  before.set(motion.shown); facing.fill(1);
  run(900, { state: 'thinking' }, watch);
  run(2600, quiet, watch);
  run(1800, luna(.6), watch);
  run(900, quiet, watch);
  run(1800, person(.7), watch);
  run(2600, quiet, watch);
  run(1500, { state: 'idle' }, watch);
  assert.ok(changes > field.count * 2, 'every stone turned to colour and back, and many turned for a voice');
});

test('quiet is a clock: one ring steps one place a second and carries one raised stone as its hand', () => {
  const { motion, run, showing, live } = machine();
  live();
  const { clock, hand } = motion.parts, places = [];
  run(3600, quiet, () => { if (places.at(-1) !== motion.steps[clock]) places.push(motion.steps[clock]); });
  assert.ok(places.length >= 4 && places.length <= 5 && places.every((place, at) => at === 0 || place === places[at - 1] + 1), `the clock read ${places}`);
  // Just before a step everything is at rest: the hand two notches up, every other stone seated, flat, in its ring's colour.
  run((12 - motion.tick() % 12 - .1) * TICK % (12 * TICK), quiet);
  assert.ok(Math.abs(motion.height[hand] - 2 * NOTCH) < 1e-6 && field.course[hand] === clock);
  for (let index = 0; index < field.count; index++) if (index !== hand) assert.ok(motion.height[index] === 0 && !turning(motion, index));
  assert.equal(showing(LIVE), field.count);
  assert.ok(Math.abs(motion.dial[clock] - motion.steps[clock] * motion.pitch[clock]) < 1e-5, 'exactly on its detent');
  motion.dial.forEach((angle, ring) => { if (ring !== clock) assert.equal(angle, 0); });
});

test('Luna speaking: stones turn to her colour ring by ring from the pole, and each syllable clicks those rings a place', () => {
  const { motion, run, showing, live } = machine();
  live();
  const reached = [], clicked = new Set();
  run(2600, luna(.6), time => {
    reached.push([time, showing(WARM, ring => ring <= 2), showing(WARM, ring => ring >= 9 && ring < motion.parts.luna)]);
    motion.steps.forEach((place, ring) => { if (ring !== motion.parts.clock && place !== 0) clicked.add(ring); });
    for (let index = 0; index < field.count; index += 5) assert.ok(motion.shown[index] !== GREEN, 'the green stone is the person\'s');
  });
  const first = column => reached.find(row => row[column] > 0)?.[0];
  assert.ok(first(1) + 250 < first(2), 'the pole turns first and the front moves outward');
  assert.ok(showing(WARM) > 400, `her colour reaches a good part of the face: ${showing(WARM)} stones`);
  assert.equal(showing(WARM, ring => ring >= motion.parts.luna), 0, 'and stops inside the clock\'s ring, at the edge of the drawing');
  assert.ok(clicked.size >= 3 && [...clicked].every(ring => ring < motion.parts.luna));
  run(2600, quiet);
  assert.equal(showing(WARM), 0);
  motion.steps.forEach((place, ring) => { if (ring !== motion.parts.clock) assert.equal(place, 0); });
});

test('her turn is told by her sound, not by the provider\'s mode, which flickers between her words', () => {
  const { motion, run, showing, live } = machine();
  live();
  run(2400, time => ({ state: time % 700 < 420 ? 'speaking' : 'listening', input: silence, output: speech(.55)(time) }));
  assert.ok(showing(WARM) > 300, `${showing(WARM)} stones`);
});

test('a louder voice is more steps: Luna reaches more rings, a person stands their rings more notches up', () => {
  const warm = level => { const { run, showing, live } = machine(); live(); run(2600, luna(level)); return showing(WARM); };
  assert.ok(warm(.6) > warm(.3) * 1.5 && warm(.3) > 0);
  // Measured against the speaker's own loudest: teach it that first, let the softer voice settle, then look.
  const stood = level => {
    const { motion, run, live } = machine();
    live(); run(1500, person(.75)); run(1800, person(level));
    let highest = 0;
    run(900, person(level), () => { for (let index = 0; index < field.count; index += 3) if (!turning(motion, index) && motion.height[index] < POP * .9) highest = Math.max(highest, motion.height[index]); });
    return highest;
  };
  const loud = stood(.75), soft = stood(.36);
  assert.ok(loud > soft + NOTCH * .9 && soft > 0, `loud ${loud}, soft ${soft}`);
  // Whole notches, with only the smallest of settles past the stop.
  assert.ok(loud > 3 * NOTCH - 1e-5 && loud < 3 * NOTCH * 1.06);
  assert.ok([1, 2].some(notches => Math.abs(soft - notches * NOTCH) < NOTCH * .06), `a soft voice stands a whole number of notches: ${soft}`);
});

test('a person speaking: the rings at the outline turn green and stand up as pistons, and each syllable knocks its way in to the centre', () => {
  const { motion, run, showing, live } = machine();
  live();
  const { limb, knock } = motion.parts;
  let knocked = 0, first = null;
  run(2600, person(.7), time => {
    if (first === null && showing(GREEN) > 0) first = time;
    // A knock is an inner ring, still in its own colour, standing one notch up for a tick.
    for (let index = 0; index < field.count; index += 2) {
      if (field.course[index] <= knock && field.course[index] > 0 && motion.shown[index] === LIVE && !turning(motion, index) && motion.height[index] > NOTCH * .5 && index !== motion.parts.hand) knocked++;
      assert.ok(motion.shown[index] !== WARM, 'the warm stone is Luna\'s');
    }
  });
  assert.ok(first !== null && showing(GREEN) > 800, `${showing(GREEN)} green stones`);
  assert.equal(showing(GREEN, ring => ring <= knock), 0, 'the centre stays Luna\'s');
  assert.ok(showing(GREEN, ring => ring > knock && ring <= limb + 3) === showing(GREEN));
  assert.ok(knocked > 100, 'syllables travelled inward as knocks');
  run(3000, quiet);
  assert.equal(showing(GREEN), 0);
  assert.equal(showing(LIVE), field.count);
});

test('her own voice in the room does not read as someone answering, and room noise does not move the machine', () => {
  const echo = machine();
  echo.live();
  echo.run(2200, time => ({ state: 'speaking', input: voice(.3), output: speech(.6)(time) }));
  assert.equal(echo.showing(GREEN), 0);
  const hum = machine();
  hum.live();
  hum.run(2200, { state: 'listening', input: voice(.16), output: silence });
  assert.equal(hum.showing(GREEN), 0);
  assert.equal(hum.showing(WARM), 0);
});

test('without a spectrum the plain level still works both mechanisms', () => {
  const hers = machine();
  hers.live();
  hers.run(2200, { state: 'speaking', level: .4 });
  assert.ok(hers.showing(WARM) > 100);
  const theirs = machine();
  theirs.live();
  theirs.run(2200, { state: 'listening', level: .4 });
  assert.ok(theirs.showing(GREEN) > 100);
});

test('leaving live turns the sphere back to stone and its rings back out of register', () => {
  const { motion, run, showing, live } = machine();
  live();
  run(1200, luna(.6));
  run(4200, { state: 'idle' });
  assert.equal(showing(GREY), field.count);
  assert.deepEqual([...motion.steps], [...motion.home]);
  for (let index = 0; index < field.count; index += 3) assert.ok(motion.height[index] === 0 && !turning(motion, index));
});

test('reduced motion shows each state at rest, already on its stops, and nothing on its way anywhere', () => {
  const motion = createSphereMotion(field);
  const at = state => { motion.step({ state, time: 0, input: voice(.8), output: voice(.8), reduced: true }); return { shown: [...motion.shown], tiles: [...motion.tiles], dial: [...motion.dial] }; };
  const settled = () => { for (let index = 0; index < field.count; index++) assert.ok(motion.height[index] === 0 && !turning(motion, index)); };
  const idle = at('idle');
  assert.ok(idle.shown.every(material => material === GREY)); settled();
  const listening = at('listening');
  assert.ok(listening.shown.every(material => material === LIVE) && listening.dial.every(angle => angle === 0)); settled();
  const speaking = at('speaking');
  assert.ok(speaking.shown.some(material => material === WARM) && speaking.shown.every(material => material === WARM || material === LIVE)); settled();
  // Asked again a moment later, it has not moved.
  motion.step({ state: 'speaking', time: 5000, input: voice(.8), output: voice(.8), reduced: true });
  assert.deepEqual([...motion.tiles], speaking.tiles);
});

test('a part travels at one speed and stops dead: nothing eases like water', () => {
  assert.equal(travel(-1), 0); assert.equal(travel(0), 0); assert.equal(travel(1), 1); assert.equal(travel(3), 1);
  // One speed all the way to the stop, which it reaches with a fifth of the time still to go.
  for (let u = .05; u < .8; u += .05) assert.ok(Math.abs(travel(u) - u / .8) < 1e-12);
  // Then the smallest of settles: never more than a twentieth past the stop, and it does not creep.
  let furthest = 0;
  for (let u = .8; u <= 1; u += .005) furthest = Math.max(furthest, travel(u));
  assert.ok(furthest > 1 && furthest <= 1.05);
  // Twelve ticks a second: every move starts on one and takes a whole number of them.
  assert.ok(Math.abs(TICK * 12 - 1000) < 1e-9);
});

test('the sphere holds a few fixed attitudes: tipped to a person, turned a stop to a pointer, otherwise at rest', () => {
  const { motion, run, live } = machine();
  live();
  run(600, quiet);
  const rest = [...motion.sway];
  run(900, quiet, () => assert.deepEqual([...motion.sway], rest, 'no wander while it is quiet'));
  run(1500, person(.7));
  const attentive = [...motion.sway];
  assert.ok(attentive.some((value, at) => Math.abs(value - rest[at]) > .02), 'it tips towards someone speaking');
  run(600, person(.7), () => assert.deepEqual([...motion.sway], attentive, 'and holds that attitude'));
  // A pointer a little off centre does not move it; one well to the side turns it one stop and no further.
  const still = machine();
  still.live(); still.run(600, quiet);
  const before = [...still.motion.sway];
  still.run(900, { ...quiet, gaze: { x: .2, y: -.1 } });
  assert.deepEqual([...still.motion.sway], before);
  still.run(900, { ...quiet, gaze: { x: .7, y: 0 } });
  const turned = [...still.motion.sway];
  assert.ok(turned.some((value, at) => Math.abs(value - before[at]) > .02));
  still.run(900, { ...quiet, gaze: { x: 1, y: 0 } });
  assert.deepEqual([...still.motion.sway], turned);
  // Its face stays towards the viewer in every one of them.
  for (const pose of [rest, attentive, turned]) assert.ok(pose[8] > .95);
});

// How far round the face a stone is from a bearing, as the viewer sees it: its own place, plus however far its ring has been turned.
const off = (index, bearing, motion) => { const at = field.theta[index] + (motion ? motion.dial[field.course[index]] : 0) - bearing; return Math.abs(Math.atan2(Math.sin(at), Math.cos(at))); };
// A document held to the lower right of the sphere, as the page hands it to the motion: where its sheet is, where on the sphere it faces, how near.
const document = (near, round = .5) => ({ at: [210 * Math.cos(round), -210 * Math.sin(round), RADIUS + 26], aim: [Math.sin(.8) * Math.cos(round), -Math.sin(.8) * Math.sin(round), Math.cos(.8)], near });
const place = (motion, block) => motion.tiles.subarray(block * STRIDE + PLACE, block * STRIDE + PLACE + 3);
const seen = (motion, v) => { const m = motion.sway; return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]; };
const whole = motion => motion.mouth() === null && motion.peeled.every(open => !open) && motion.shell.carried.every((value, at) => value === (at % CELL_STRIDE === 3 ? 1 : 0));

test('a document held near opens the shell where it faces it: the shell there peels back like a flower, as far as the document is near, and follows it', () => {
  const { motion, run, live } = machine();
  live();
  assert.ok(whole(motion));
  const open = () => [...motion.peeled.keys()].filter(socket => motion.peeled[socket]);
  const out = stone => Math.hypot(...place(motion, stone)) - RADIUS - field.seat[stone];
  const stonesOf = sockets => sockets.map(socket => field.sockets.stone[socket]).filter(stone => stone >= 0);
  run(1500, { ...quiet, file: document(0) });
  const mouth = motion.mouth(), far = open();
  // Far off, the shell is only cracked: a small place, a little curled, a few stones lifted a little.
  assert.ok(Math.abs(mouth.reach - MOUTH.cracked) < 1 && Math.abs(mouth.curl - CURL.cracked) < .05, `reach ${mouth.reach.toFixed(1)}, curl ${mouth.curl.toFixed(2)}`);
  assert.ok(far.length > 8 && far.length < 40, `${far.length} sockets of the shell are open`);
  const cracked = Math.max(...stonesOf(far).map(out));
  assert.ok(cracked > 2 && cracked < 10, `stones stand up to ${cracked.toFixed(1)} px out`);
  // It is where the document faces the sphere, as the viewer sees it; and no stone outside it has moved.
  const middle = seen(motion, mouth.middle), facing = document(0).aim;
  assert.ok(middle[0] * facing[0] + middle[1] * facing[1] + middle[2] * facing[2] > .995);
  for (let index = 0; index < field.count; index += 7) if (!motion.peeled[field.socket[index]] && index !== motion.parts.hand) assert.ok(Math.abs(out(index)) < 1e-3);
  // A socket of the opening is only turned and carried: the stone set in it is turned by the same turn, and carried with it.
  for (const socket of far) {
    const at = socket * CELL_STRIDE, turn = motion.shell.carried.subarray(at, at + 4);
    assert.ok(Math.abs(Math.hypot(...turn) - 1) < 1e-6);
    // The turn is about a line lying on the surface: it has no part along the way out from the middle of the opening.
    assert.ok(Math.abs(turn[0] * mouth.middle[0] + turn[1] * mouth.middle[1] + turn[2] * mouth.middle[2]) < 1e-6);
  }
  // Nearer, it is the same opening grown: wider, more curled, with no steps in it. Brought in evenly, nothing jumps,
  // and the rings wait while the shell is open.
  const stepsBefore = Array.from(motion.steps), watched = stonesOf(far).slice(0, 6);
  let before = watched.map(stone => Array.from(place(motion, stone))), jump = 0, reachBefore = mouth.reach, back = 0;
  for (let step = 1; step <= 60; step++) run(50, { ...quiet, file: document(step / 60) }, () => {
    watched.forEach((stone, index) => { const now = Array.from(place(motion, stone)); jump = Math.max(jump, Math.hypot(now[0] - before[index][0], now[1] - before[index][1], now[2] - before[index][2])); before[index] = now; });
    back = Math.max(back, reachBefore - mouth.reach); reachBefore = mouth.reach;
  });
  assert.ok(jump < 2.5, `no stone of the opening moved more than ${jump.toFixed(2)} px in a frame`);
  assert.ok(back < .05, 'the opening only grew as the document came nearer');
  run(1500, { ...quiet, file: document(1) });
  const wide = open(), widest = Math.max(...stonesOf(wide).map(out));
  assert.ok(motion.mouth() === mouth && Math.abs(mouth.reach - MOUTH.wide) < 1.5 && Math.abs(mouth.curl - CURL.wide) < .08);
  assert.ok(wide.length > far.length * 3 && widest > cracked * 3 && widest < MOUTH.wide, `${wide.length} sockets open, stones up to ${widest.toFixed(1)} px out`);
  assert.deepEqual(Array.from(motion.steps), stepsBefore, 'no ring turned through the opening');
  // The further in from the rim a socket lies, the further it has been turned: the shell curls, it does not hinge.
  const turned = socket => 2 * Math.acos(Math.min(1, Math.abs(motion.shell.carried[socket * CELL_STRIDE + 3])));
  const reachOf = socket => { const n = socket * 3, k = field.sockets.course[socket], d = motion.dial[k], x = Math.cos(d) * field.sockets.normal[n] - Math.sin(d) * field.sockets.normal[n + 1], y = Math.sin(d) * field.sockets.normal[n] + Math.cos(d) * field.sockets.normal[n + 1]; return Math.acos(Math.min(1, x * mouth.middle[0] + y * mouth.middle[1] + field.sockets.normal[n + 2] * mouth.middle[2])) * RADIUS; };
  const inner = wide.filter(socket => reachOf(socket) < 12), outer = wide.filter(socket => reachOf(socket) > 32);
  assert.ok(inner.length > 2 && outer.length > 10 && Math.min(...inner.map(turned)) > Math.max(...outer.map(turned)), 'sockets near the middle are turned further than any near the rim');
  assert.ok(Math.max(...inner.map(turned)) > 1.5 && Math.min(...outer.map(turned)) < .8);
  // It is never quite still, and it is not the same all the way round.
  const first = wide.slice(0, 12).map(turned);
  run(400, { ...quiet, file: document(1) });
  assert.ok(wide.slice(0, 12).some((socket, index) => Math.abs(turned(socket) - first[index]) > 1e-3));
  // The sheet of pale stones is in the hand, laid out as a page, all showing the page's stone.
  assert.equal(motion.sheet(), 'held');
  for (let stone = 0; stone < field.sheet.count; stone++) {
    const at = seen(motion, place(motion, field.count + stone)), held = document(1).at;
    assert.ok(Math.hypot(at[0] - held[0], at[1] - held[1]) < 14 && Math.abs(at[2] - held[2]) < 2);
    assert.deepEqual(Array.from(motion.tiles.subarray((field.count + stone) * STRIDE + FACES, (field.count + stone) * STRIDE + FACES + 2)), [PAGE, PAGE]);
  }
  // Moved round to the other side, the same opening goes after it over the surface: it does not shut and open again.
  let shutOnTheWay = false;
  run(2200, { ...quiet, file: document(1, 3.4) }, () => { if (motion.mouth() !== mouth || mouth.reach < MOUTH.wide * .8) shutOnTheWay = true; });
  const there = seen(motion, mouth.middle), now = document(1, 3.4).aim;
  assert.ok(!shutOnTheWay && there[0] * now[0] + there[1] * now[1] + there[2] * now[2] > .995, 'it followed, open all the way');
  assert.ok(open().every(socket => !wide.includes(socket)), 'and the shell where it used to be has closed behind it');
  // Taken away, the shell closes and is whole: every stone seated, nothing carried.
  run(1500, quiet);
  assert.ok(whole(motion));
  assert.equal(motion.sheet(), 'inside');
  for (let index = 0; index < field.count; index++) if (index !== motion.parts.hand) assert.ok(motion.height[index] === 0 && Math.abs(Math.hypot(...place(motion, index)) - RADIUS - field.seat[index]) < 1e-3);
});

test('dropped, every stone of the sheet starts for the opening at once and gathers speed into it; the ripple leaves as the first goes in; the shell shuts behind the last', () => {
  const { motion, run, live } = machine();
  live();
  run(1500, { ...quiet, file: document(1) });
  const intake = { id: 'reader', at: document(1).at, aim: document(1).aim }, sheet = [...Array(field.sheet.count).keys()].map(stone => field.count + stone);
  const entered = new Map(), began = sheet.map(stone => Array.from(place(motion, stone))), gone = [];
  let reported = null, shutAt = null, most = 0, pageBefore = 0, pageAtShut = 0, frames = 0, dropped = null;
  run(5200, { ...quiet, intake }, time => {
    dropped ??= time;
    // How far each stone of the sheet has come from where it was let go, frame by frame.
    if (frames++ < 30) gone.push(sheet.map((stone, index) => Math.hypot(...[0, 1, 2].map(axis => place(motion, stone)[axis] - began[index][axis]))));
    for (const stone of sheet) if (!entered.has(stone) && Math.hypot(...place(motion, stone)) < RADIUS - SHELL) entered.set(stone, time);
    if (entered.size === 0) pageBefore = Math.max(pageBefore, motion.shown.filter(side => side === PAGE).length);
    if (shutAt === null && motion.mouth() === null) { shutAt = time; pageAtShut = motion.shown.filter(side => side === PAGE).length; }
    if (reported === null && motion.taken() === 'reader') reported = time;
    most = Math.max(most, motion.shown.filter(side => side === PAGE).length);
  });
  // The instant it is dropped every stone is on its way, none waiting for another: a tenth of a second on, all nine have moved.
  assert.ok(gone[6].every(far => far > .05), `after a tenth of a second the nine had come ${gone[6].map(far => far.toFixed(1)).join(', ')} px`);
  // Each gathers speed as it goes, as a thing falling does: further in every frame than in the one before, until it is in.
  for (let index = 0; index < sheet.length; index++) for (let frame = 3; frame < 16; frame++) {
    assert.ok(gone[frame + 1][index] - gone[frame][index] > gone[frame][index] - gone[frame - 1][index] - 1e-6, 'never slowing on the way in');
  }
  // They all go in, not in step with one another, before the shell shuts; and they stay inside it.
  const times = [...entered.values()].sort((a, b) => a - b);
  assert.equal(entered.size, field.sheet.count);
  assert.ok(new Set(times).size > 3 && times.at(-1) <= shutAt && times.at(-1) - dropped < 900, 'all in within a second of the drop, before it shut');
  assert.ok(sheet.every(stone => Math.hypot(...place(motion, stone)) < RADIUS - SHELL - 30) && motion.sheet() === 'inside');
  assert.ok(whole(motion) && reported !== null && reported >= shutAt, 'the shell is whole again, and the page is told once it is in');
  // It spreads as it is swallowed: no stone showed the page before the first of the sheet was in; many already did
  // by the time the shell had shut; hundreds did at once; and none is left showing it.
  assert.equal(pageBefore, 0);
  assert.ok(pageAtShut > 40, `${pageAtShut} stones already showed the page's stone when the shell shut`);
  assert.ok(most > 200, `up to ${most} stones showed the page's stone at once`);
  assert.equal(motion.shown.filter(side => side === PAGE).length, 0);
  for (let index = 0; index < field.count; index++) if (index !== motion.parts.hand) assert.ok(motion.height[index] === 0 && !turning(motion, index));
  // Chosen from a file picker there is no drag: the sheet comes from beyond the foot of the page, the shell cracks towards it, and it is swallowed the same way.
  const picked = machine();
  picked.live();
  let opened = 0;
  picked.run(5200, { ...quiet, intake: { id: 'picked', at: [0, -330, RADIUS + 26], aim: [0, -Math.sin(.84), Math.cos(.84)] } }, () => { opened = Math.max(opened, picked.motion.mouth() ? picked.motion.mouth().reach : 0); });
  assert.ok(opened > MOUTH.wide - 3 && picked.motion.taken() === 'picked' && whole(picked.motion));
  // Without motion nothing cracks: the document is simply taken.
  const still = createSphereMotion(field);
  still.step({ state: 'listening', time: 0, intake, reduced: true });
  assert.ok(still.taken() === 'reader' && whole(still));
});

test('each chapter is one stone in the page\'s stone standing on its own ring, clockwise from the top; the chosen one turns to her colour and stands higher', () => {
  const { motion, run, live } = machine();
  live();
  assert.equal(motion.pegs().length, 0);
  const risen = [];
  run(1500, { ...quiet, chapters: 6 }, time => { motion.pegs().forEach((stone, peg) => { if (risen[peg] === undefined && motion.shown[stone] === PAGE && !turning(motion, stone) && Math.abs(motion.height[stone] - 2 * NOTCH) < 1e-4) risen[peg] = time; }); });
  const pegs = motion.pegs();
  assert.equal(new Set(pegs).size, 6);
  pegs.forEach((stone, peg) => {
    assert.equal(field.course[stone], motion.parts.pegs);
    assert.ok(off(stone, -Math.PI / 2 + peg / 6 * Math.PI * 2) < .12, `chapter ${peg + 1} near its sixth of the ring`);
    assert.ok(Math.abs(motion.height[stone] - 2 * NOTCH) < 1e-4 && motion.shown[stone] === PAGE);
  });
  assert.ok(risen.every((time, peg) => peg === 0 || time > risen[peg - 1]), 'they stand up one after another, round the ring');
  // Choosing: the stone seats, turns over to Luna's colour out of its socket, and stands higher. The others do not move.
  run(1500, { ...quiet, chapters: 6, chapter: 2 });
  pegs.forEach((stone, peg) => {
    assert.ok(Math.abs(motion.height[stone] - (peg === 2 ? 4 : 2) * NOTCH) < 1e-4);
    assert.equal(motion.shown[stone], peg === 2 ? WARM : PAGE);
  });
  run(1500, { ...quiet, chapters: 6, chapter: 4 });
  assert.ok(motion.shown[pegs[2]] === PAGE && motion.shown[pegs[4]] === WARM && Math.abs(motion.height[pegs[4]] - 4 * NOTCH) < 1e-4);
  // When the person's voice stands that ring up, the chapters' stones still stand above it.
  run(1800, time => ({ ...person(.7)(time), chapters: 6, chapter: 4 }));
  const ring = [...field.course.keys()].find(index => field.course[index] === motion.parts.pegs && !pegs.includes(index) && !turning(motion, index));
  assert.ok(pegs.filter(stone => !turning(motion, stone)).every(stone => motion.height[stone] > motion.height[ring] + NOTCH));
  // Shown without motion they are already up; put away, every one seats again.
  const still = createSphereMotion(field);
  still.step({ state: 'listening', time: 0, chapters: 6, chapter: 1, reduced: true });
  still.pegs().forEach((stone, peg) => assert.ok(Math.abs(still.height[stone] - (peg === 1 ? 4 : 2) * NOTCH) < 1e-4 && still.shown[stone] === (peg === 1 ? WARM : PAGE)));
  run(2600, quiet);
  assert.equal(motion.pegs().length, 0);
  assert.ok(pegs.every(stone => motion.height[stone] === 0 && motion.shown[stone] === LIVE));
});
