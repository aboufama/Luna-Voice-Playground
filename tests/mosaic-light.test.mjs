import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMosaicField } from '../src/mosaic-field.mjs';
import { createMosaicLight, LIGHT_BANDS } from '../src/mosaic-light.mjs';
import { stonePigments } from '../src/mosaic-pigment.mjs';
import { afterVoiceClose } from '../src/voice-presence.mjs';

const tiles = createMosaicField().tiles;
const radius = tile => Math.hypot(tile.x, tile.y);
const centre = tiles.map((tile, index) => [radius(tile), index]).filter(([r]) => r > 12 && r < 30).map(([, index]) => index);
const middle = tiles.map((tile, index) => [radius(tile), index]).filter(([r]) => r > 55 && r < 75).map(([, index]) => index);
const rim = tiles.map((tile, index) => [radius(tile), index]).filter(([r]) => r > 125 && r < 140).map(([, index]) => index);
const mean = (values, indices) => indices.reduce((sum, index) => sum + values[index], 0) / indices.length;
const voice = level => new Float32Array(LIGHT_BANDS).fill(level);
const silence = voice(0);

// Advance at the renderer's own pace and report what the caller asks to watch.
function run(light, frames, input, watch, start = 0) {
  const seen = [];
  for (let frame = 0; frame < frames; frame++) {
    light.step({ ...input, time: start + frame * 33 });
    if (watch) seen.push(watch(frame));
  }
  return seen;
}

test('a mosaic that is not live stays plain stone and does not move', () => {
  const light = createMosaicLight(tiles);
  for (const state of ['idle', 'thinking']) {
    run(light, 40, { state, level: .5, input: voice(.9), output: voice(.9) });
    for (const values of [light.cool, light.bright, light.warm, light.lift, light.turn, light.ink]) assert.ok(values.every(value => value === 0), state);
  }
});

test('going live brings colour out from the centre, then it rests and breathes', () => {
  const light = createMosaicLight(tiles);
  const opening = run(light, 12, { state: 'listening', input: silence, output: silence }, () => [mean(light.cool, centre), mean(light.cool, rim)]);
  assert.ok(opening.at(-1)[0] > opening.at(-1)[1] + .15, 'centre colours first');
  const resting = run(light, 320, { state: 'listening', input: silence, output: silence }, () => mean(light.cool, centre), 400);
  const settled = resting.slice(60);
  assert.ok(Math.min(...settled) > .45 && Math.max(...settled) < .85, 'quiet colour stays partial');
  assert.ok(Math.max(...settled) - Math.min(...settled) > .08, 'and visibly breathes');
  assert.ok(light.warm.every(value => value === 0) && light.bright.every(value => value === 0));
  assert.ok(Math.max(...light.lift) < 1.5, 'breathing barely moves the stones');
  // Colour is taken stone by stone, not as one wash: some are fully glazed, others only tinted.
  assert.ok(light.cool.some(value => value > .98) && light.cool.some(value => value < .4) && light.cool.every(value => value > .3));
});

test('a person talking enters at the rim as a tide; the centre stays Luna\'s', () => {
  const light = createMosaicLight(tiles);
  run(light, 60, { state: 'listening', input: silence, output: silence });
  const seen = run(light, 45, { state: 'listening', input: voice(.75), output: silence },
    () => [mean(light.cool, rim), mean(light.cool, centre), mean(light.bright, rim), mean(light.bright, middle), mean(light.bright, centre), mean(light.lift, rim)], 60 * 33);
  const arrival = (column, level) => seen.findIndex(row => row[column] > level);
  assert.ok(arrival(0, .97) >= 0 && arrival(0, .97) <= 3, 'the rim answers within a tenth of a second');
  assert.ok(arrival(1, .9) > arrival(0, .97) + 8, 'the centre follows as the wave travels in');
  // The bright tide floods the rim at once and reaches the middle courses about half a second later.
  assert.ok(arrival(2, .8) >= 0 && arrival(2, .8) <= 3, 'the tide starts where the voice enters');
  assert.ok(arrival(3, .5) > arrival(2, .8) + 8, 'and is carried inward');
  assert.ok(seen.every(row => row[4] < .4), 'but never floods the centre');
  assert.ok(seen[2][5] > 2, 'every course steps out with the first syllable');
  assert.ok(mean(light.lift, rim) > 6, 'and the rim ends up furthest out');
  assert.ok(mean(light.lift, centre) < mean(light.lift, rim) / 4);
  assert.ok(mean(light.warm, rim) < .02, 'a person is never shown in Luna\'s colour');
  run(light, 60, { state: 'listening', input: silence, output: silence }, null, 105 * 33);
  assert.ok(mean(light.lift, rim) < 2 && mean(light.cool, centre) < .85 && light.bright.every(value => value < .02), 'and settles when they stop');
});

test('a louder voice carries the tide further in', () => {
  const reach = level => {
    const light = createMosaicLight(tiles);
    run(light, 60, { state: 'listening', input: silence, output: silence });
    // Teach it this speaker's loudest moment first, as a real sentence would.
    run(light, 20, { state: 'listening', input: voice(.75), output: silence }, null, 60 * 33);
    return Math.max(...run(light, 40, { state: 'listening', input: voice(level), output: silence }, () => mean(light.bright, middle), 80 * 33).slice(25));
  };
  assert.ok(reach(.75) > .6);
  assert.ok(reach(.52) < .2, 'a soft word stays in the rim band');
});

test('a person\'s voice winds the courses like a vortex, each one a rigid ring', () => {
  const light = createMosaicLight(tiles);
  const course = tile => Math.max(0, Math.min(21, Math.floor((radius(tile) - 2.9) / 6.8) + 1));
  const rings = Array.from({ length: 22 }, () => []);
  tiles.forEach((tile, index) => rings[course(tile)].push(index));
  const spread = values => rings.reduce((worst, ring) => ring.length ? Math.max(worst, Math.max(...ring.map(i => values[i])) - Math.min(...ring.map(i => values[i]))) : worst, 0);
  run(light, 60, { state: 'listening', input: silence, output: silence });
  assert.ok(light.turn.every(value => value === 0), 'a quiet mosaic does not turn');
  const shaped = new Float32Array(LIGHT_BANDS).map((_, band) => .9 - band * .04);
  const seen = run(light, 45, { state: 'listening', input: shaped, output: silence }, () => {
    // Whatever the spectrum, a course moves as one piece and the outline stays a circle.
    assert.ok(spread(light.turn) < 1e-9 && spread(light.lift) < 1e-4);
    return [mean(light.turn, rim), mean(light.turn, middle), mean(light.turn, centre)];
  }, 60 * 33);
  const arrival = column => seen.findIndex(row => row[column] > .03);
  assert.ok(arrival(0) >= 0 && arrival(0) <= 3, 'the rim turns at once');
  assert.ok(arrival(1) > arrival(0) + 6 && arrival(2) > arrival(1) + 6, 'and the turn is handed inward course by course');
  const wound = seen.at(-1);
  assert.ok(wound[0] > .05 && wound[1] > wound[0] * 1.4 && wound[2] > wound[1] * 1.2, 'inner courses turn further: the arms of the vortex');
  assert.ok(wound[2] < .3, 'but never far enough to swing a stone\'s light around');
  run(light, 60, { state: 'listening', input: silence, output: silence }, null, 105 * 33);
  assert.ok(light.turn.every(value => Math.abs(value) < .005), 'it unwinds when they stop');
  // Luna's own dials belong to the choreography; her voice adds no winding here.
  run(light, 40, { state: 'speaking', input: silence, output: voice(.75) }, null, 165 * 33);
  assert.ok(light.turn.every(value => Math.abs(value) < .005));
});

test('Luna speaking leaves the centre first, in her own colour', () => {
  const light = createMosaicLight(tiles);
  run(light, 60, { state: 'listening', input: silence, output: silence });
  const seen = run(light, 40, { state: 'speaking', input: silence, output: voice(.75) },
    () => [mean(light.warm, centre), mean(light.warm, middle), mean(light.warm, rim)], 60 * 33);
  const arrival = (column, level) => seen.findIndex(row => row[column] > level);
  assert.ok(arrival(0, .6) >= 0 && arrival(0, .6) <= 6);
  assert.ok(arrival(1, .4) > arrival(0, .6) + 5, 'her voice travels outward');
  const settled = seen.slice(25), average = column => settled.reduce((sum, row) => sum + row[column], 0) / settled.length;
  assert.ok(average(0) > .9 && average(1) < average(0) - .15 && average(2) < average(1) - .15, 'and thins toward the rim, which stays the listener\'s');
  assert.ok(light.bright.every(value => value === 0), 'the bright tide belongs to the person');
  // Between her words the very centre stays lit, so her turn never looks like silence.
  const pause = run(light, 40, { state: 'speaking', input: silence, output: silence }, () => mean(light.warm, centre), 100 * 33);
  assert.ok(pause.at(-1) > .2);
});

test('a steady voice still arrives as rings, and a soft one fills the mosaic like a loud one', () => {
  const hold = (level, frames = 70) => {
    const light = createMosaicLight(tiles);
    run(light, 60, { state: 'listening', input: silence, output: silence });
    return run(light, frames, { state: 'listening', input: voice(level), output: silence }, () => mean(light.lift, rim), 60 * 33).slice(30);
  };
  const loud = hold(.75), soft = hold(.6);
  // The level never changes, yet the rim keeps pulsing as each ring passes.
  assert.ok(Math.max(...loud) - Math.min(...loud) > .3);
  assert.ok(Math.min(...soft) > Math.min(...loud) * .8, 'measured against the speaker, not an absolute level');
  // Room noise just above the gate must not light the mosaic.
  assert.ok(Math.max(...hold(.18)) < 2);
});

test('a ring is the stones themselves parting, and it travels: nothing is scaled or washed over', () => {
  // One stone per course along a single bearing, centre to rim.
  const spoke = [];
  for (const [index, tile] of tiles.entries()) {
    const course = Math.floor((radius(tile) - 2.9) / 6.8) + 1, off = Math.abs(Math.atan2(tile.y, tile.x) - .4);
    if (course >= 1 && course <= 21 && (!spoke[course] || off < spoke[course].off)) spoke[course] = { index, off };
  }
  const light = createMosaicLight(tiles);
  run(light, 60, { state: 'listening', input: silence, output: silence });
  const gaps = () => spoke.slice(2).map((stone, i) => light.lift[stone.index] - light.lift[spoke[i + 1].index]);
  const crests = run(light, 60, { state: 'listening', input: voice(.75), output: silence }, frame => {
    const now = gaps();
    return frame < 34 ? null : { widest: Math.max(...now), at: now.indexOf(Math.max(...now)), tightest: Math.min(...now) };
  }, 60 * 33).filter(Boolean);
  // At a crest two courses stand most of a pixel further apart than between rings.
  assert.ok(crests.every(frame => frame.widest > .75 && frame.tightest < .3));
  // The widest parting only ever moves inward, until a new ring entering at the rim takes over.
  const steps = crests.slice(1).map((frame, i) => frame.at - crests[i].at);
  assert.ok(steps.every(step => step <= 0 || step > 3) && steps.filter(step => step < 0).length > steps.length / 2 && steps.some(step => step > 3));
  // Every stone on the spoke is carried out and back by a passing ring: none is merely recoloured.
  const middle = spoke[11].index, travelled = run(light, 22, { state: 'listening', input: voice(.75), output: silence }, () => light.lift[middle], 120 * 33);
  assert.ok(Math.max(...travelled) - Math.min(...travelled) > .6);
});

test('the renderer has no way to scale, filter or lay anything over the mosaic', () => {
  // On screen it may only clear, place one stone, set that stone's ink, and stamp it.
  const source = readFileSync(new URL('../src/VoiceCanvas.jsx', import.meta.url), 'utf8');
  const used = new Set([...source.matchAll(/\bcontext\.([A-Za-z]+)/g)].map(match => match[1]));
  assert.deepEqual([...used].sort(), ['clearRect', 'drawImage', 'globalAlpha', 'setTransform']);
  // Every stamp is one whole sprite at the stone's one fixed size.
  const stamps = [...source.matchAll(/context\.drawImage\(([^;]+)\);/g)].map(match => match[1]);
  assert.equal(stamps.length, 1);
  assert.ok(stamps[0].endsWith('atlas.cell,atlas.cell,-atlas.size/2,-atlas.size/2,atlas.size,atlas.size'));
  // The page's own styles neither scale nor filter the canvas, nor the press target over it.
  const styles = ['talk-screen.css', 'mosaic-stage.css'].map(name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.equal(/filter|mix-blend|scale\(/.test(styles.replace(/\.orb-button:active[^}]*transform:none/, '')), false);
  assert.match(styles, /\.orb-button:active[^}]*transform:none/);
});

test('courses spread apart but an inner stone never overtakes an outer one', () => {
  const light = createMosaicLight(tiles);
  const shaped = new Float32Array(LIGHT_BANDS).map((_, band) => .9 - band * .04);
  run(light, 40, { state: 'listening', input: silence, output: silence });
  for (let frame = 0; frame < 40; frame++) {
    light.step({ state: 'listening', input: frame % 9 < 5 ? shaped : silence, output: silence, time: (40 + frame) * 33 });
    // Compare stones on the same bearing, a course apart.
    for (let outer = 0; outer < tiles.length; outer += 7) {
      const a = tiles[outer], bearing = Math.atan2(a.y, a.x);
      const inner = tiles.findIndex(b => Math.abs(radius(a) - radius(b) - 6.8) < 2 && Math.abs(Math.atan2(b.y, b.x) - bearing) < .03);
      if (inner >= 0) assert.ok(light.lift[outer] >= light.lift[inner] - .35, `frame ${frame}`);
    }
  }
});

test('without a spectrum the plain level still drives the wave', () => {
  const light = createMosaicLight(tiles);
  run(light, 60, { state: 'listening' });
  run(light, 20, { state: 'listening', level: .4 }, null, 60 * 33);
  assert.ok(mean(light.cool, rim) > .85 && mean(light.lift, rim) > 4);
});

test('reduced motion shows the live colour without bloom, waves or travel', () => {
  const light = createMosaicLight(tiles);
  light.step({ state: 'listening', input: voice(.9), output: silence, time: 0, reduced: true });
  const still = [...light.cool];
  assert.ok(mean(light.cool, centre) > .45 && mean(light.cool, centre) < .85);
  assert.ok([light.lift, light.turn, light.warm, light.bright].every(values => values.every(value => value === 0)));
  light.step({ state: 'listening', input: silence, output: silence, time: 4000, reduced: true });
  assert.deepEqual([...light.cool], still, 'nothing breathes or ripples');
  light.step({ state: 'idle', time: 33, reduced: true });
  assert.ok(light.cool.every(value => value === 0));
});

test('every stone has three fixed glazes; the construction lines are the gilded ones', () => {
  const glazes = tiles.map(stonePigments);
  for (const glaze of glazes) for (const colour of [glaze.cool, glaze.bright, glaze.warm]) {
    assert.equal(colour.length, 3);
    assert.ok(colour.every(channel => channel >= 0 && channel <= 255));
  }
  assert.deepEqual(stonePigments(tiles[40]), glazes[40]);
  const gilded = glazes.filter(glaze => glaze.gilded).length / glazes.length;
  assert.ok(gilded > .08 && gilded < .4, `gilded share ${gilded.toFixed(2)}`);
  const strongest = tiles.reduce((best, tile, index) => tile.motifStrength > tiles[best].motifStrength ? index : best, 0);
  assert.equal(glazes[strongest].gilded, true);
  // Blue field, gold lines: the two families must not blur into each other.
  const blue = glazes.filter(glaze => !glaze.gilded), gold = glazes.filter(glaze => glaze.gilded);
  assert.ok(blue.filter(glaze => glaze.cool[2] > glaze.cool[0] + 40).length / blue.length > .9);
  assert.ok(gold.every(glaze => glaze.cool[0] > glaze.cool[2] + 80));
  // On a white page light is stronger colour: the tide is lighter than the stone under it but never near white.
  const luma = colour => colour[0] * .3 + colour[1] * .59 + colour[2] * .11;
  assert.ok(glazes.every(glaze => luma(glaze.bright) > luma(glaze.cool) && Math.min(...glaze.bright) < 180));
});

test('always on: errors back off, a spoken session reconnects, a silent one rests', () => {
  assert.deepEqual(afterVoiceClose({ reason: 'user' }), { action: 'none', failures: 0 });
  // Connection trouble retries with a doubling delay, then stops asking.
  let failures = 0;
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = afterVoiceClose({ reason: 'error', failures });
    assert.equal(next.action, 'reconnect');
    delays.push(next.delayMs); failures = next.failures;
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
  assert.deepEqual(afterVoiceClose({ reason: 'error', failures }), { action: 'wait', failures: 0 });
  // A blocked microphone or an empty account is never retried automatically.
  assert.deepEqual(afterVoiceClose({ reason: 'error', retry: false, failures: 2 }), { action: 'wait', failures: 0 });
  // A drop after a real conversation starts the count again.
  assert.deepEqual(afterVoiceClose({ reason: 'error', livedMs: 600_000, failures: 4 }), { action: 'reconnect', delayMs: 1000, failures: 1 });
  // An agent that hangs up immediately is a failure, not a conversation.
  assert.equal(afterVoiceClose({ reason: 'agent', livedMs: 900, heardUser: true, failures: 0 }).failures, 1);
  assert.deepEqual(afterVoiceClose({ reason: 'agent', livedMs: 1_800_000, heardUser: true, failures: 3 }), { action: 'reconnect', delayMs: 600, failures: 0 });
  assert.deepEqual(afterVoiceClose({ reason: 'agent', livedMs: 1_800_000, heardUser: false }), { action: 'rest', failures: 0 });
});
