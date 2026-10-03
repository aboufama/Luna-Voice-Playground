import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSphereField, RADIUS } from '../src/sphere/sphere-field.mjs';
import { createSphereMotion, BANDS, STRIDE, TURN, PLACE, CELL_STRIDE } from '../src/sphere/sphere-motion.mjs';
import { createTileTemplate, tilePoint, PROFILE, MORTAR, SIDES, SHELL } from '../src/sphere/sphere-mesh.mjs';
import { VERTEX_SHADER, FRAGMENT_SHADER, BED_VERTEX_SHADER, BED_FRAGMENT_SHADER, BED_RADIUS } from '../src/sphere/sphere-renderer.mjs';
import { quatRotate, quatToMat3, quatAxis, quatMul, createLens } from '../src/sphere/sphere-math.mjs';

const field = createSphereField();
const FRAME = 1000 / 60;
const voice = level => new Float32Array(BANDS).fill(level);
const silence = voice(0);
// A voice with syllables in it, so that ripples, rings and dials are all in play.
const speech = frame => new Float32Array(BANDS).map((_, band) => .45 + .3 * Math.cos(band * .7 + Math.floor(frame / 14) * 1.9) * (frame % 14 < 11 ? 1 : .2));

// One whole conversation, every state the sphere has, with a pointer wandering over it.
const CONVERSATION = [
  [20, () => ({ state: 'idle' })],
  [80, () => ({ state: 'thinking' })],
  [110, () => ({ state: 'listening', input: silence, output: silence })],
  [110, frame => ({ state: 'listening', input: speech(frame), output: silence, gaze: { x: Math.sin(frame / 9), y: Math.cos(frame / 13) } })],
  [30, () => ({ state: 'listening', input: silence, output: silence })],
  [110, frame => ({ state: 'speaking', input: voice(.2), output: speech(frame + 5) })],
  [80, () => ({ state: 'idle' })],
  [3, () => ({ state: 'listening', input: speech(3), output: silence, reduced: true })],
  [3, () => ({ state: 'speaking', input: silence, output: speech(9), reduced: true })],
];
function converse(motion, watch) {
  let frame = 0;
  for (const [frames, input] of CONVERSATION) for (let i = 0; i < frames; i++, frame++) {
    const now = input(i);
    motion.step({ ...now, time: frame * FRAME });
    watch(frame, now.state);
  }
}

// The thirty-eight points of one stone, in the stone's own space: exactly the template's vertices.
const template = createTileTemplate();
function block(index) {
  const outline = field.outline.subarray(index * SIDES * 2, (index + 1) * SIDES * 2), points = [];
  for (let at = 0; at < template.vertexCount; at++) points.push([...tilePoint(outline, field.height[index], template.vertices[at * 2], template.vertices[at * 2 + 1])]);
  return points;
}
// Exactly what the vertex shader does with a point: turn the tile, carry it to its place, turn the sphere.
function shown(motion, index, point) {
  const at = index * STRIDE, turned = quatRotate(motion.tiles.subarray(at + TURN, at + TURN + 4), point), m = motion.sway;
  const x = turned[0] + motion.tiles[at + PLACE], y = turned[1] + motion.tiles[at + PLACE + 1], z = turned[2] + motion.tiles[at + PLACE + 2];
  return [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const volume = (a, b, c, d) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
};

test('in every state a stone is only turned and carried: its transform is a unit quaternion and a position', () => {
  const motion = createSphereMotion(field);
  let checked = 0, worst = 0;
  converse(motion, frame => {
    if (frame % 3) return;
    for (let index = 0; index < field.count; index++) {
      const at = index * STRIDE;
      const length = Math.hypot(motion.tiles[at + TURN], motion.tiles[at + TURN + 1], motion.tiles[at + TURN + 2], motion.tiles[at + TURN + 3]);
      worst = Math.max(worst, Math.abs(length - 1));
      assert.ok(Number.isFinite(motion.tiles[at + PLACE] + motion.tiles[at + PLACE + 1] + motion.tiles[at + PLACE + 2]));
      checked++;
    }
  });
  assert.ok(checked > 500_000 && worst < 1e-5, `largest departure from unit length ${worst} over ${checked} checks`);
  // The layout the renderer uploads has room for exactly that and the glazes: nothing that could carry a scale.
  assert.equal(STRIDE, 12);
});

test('no stone ever changes size or shape, whatever the sphere is doing', () => {
  const motion = createSphereMotion(field);
  // Tiles from every part of the sphere: both poles, the construction, the meander, the limb, the far side.
  const sample = [0, 1, 2, field.count - 1];
  for (let index = 5; index < field.count; index += 53) sample.push(index);
  const rest = new Map(sample.map(index => [index, block(index)]));
  let worst = 0, pairs = 0, travelled = 0, tipped = 0;
  converse(motion, frame => {
    if (frame % 2) return;
    for (const index of sample) {
      const still = rest.get(index), now = still.map(point => shown(motion, index, point));
      // Every distance between two points of the stone is what it was when the stone was cut.
      for (let a = 0; a < still.length; a += 2) for (let b = a + 1; b < still.length; b += 3) { worst = Math.max(worst, Math.abs(distance(now[a], now[b]) - distance(still[a], still[b]))); pairs++; }
      // And it is not mirrored either: the stone keeps its handedness and its volume.
      const before = volume(still[0], still[1], still[5], still[1 + SIDES + 9]), after = volume(now[0], now[1], now[5], now[1 + SIDES + 9]);
      assert.ok(Math.abs(after - before) < 1e-3 * Math.abs(before) && after * before > 0);
      travelled = Math.max(travelled, Math.abs(Math.hypot(...motion.tiles.subarray(index * STRIDE + PLACE, index * STRIDE + PLACE + 3)) - RADIUS));
      tipped = Math.max(tipped, Math.abs(Math.sin(motion.angle[index])));
    }
  });
  assert.ok(pairs > 2_000_000 && worst < 2e-4, `largest change in any dimension ${worst} px over ${pairs} measurements`);
  // The check means something only if the tiles really did move while it ran.
  assert.ok(travelled > 3 && tipped > .9, `stones travelled up to ${travelled.toFixed(1)} px and stood up to ${tipped.toFixed(2)} of the way on edge`);
});

test('the whole sphere only turns: its sway is a pure rotation', () => {
  const motion = createSphereMotion(field);
  converse(motion, () => {
    const m = motion.sway;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const dot = m[a * 3] * m[b * 3] + m[a * 3 + 1] * m[b * 3 + 1] + m[a * 3 + 2] * m[b * 3 + 2];
      assert.ok(Math.abs(dot - (a === b ? 1 : 0)) < 1e-6);
    }
    const determinant = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
    assert.ok(Math.abs(determinant - 1) < 1e-6);
  });
});

test('the quaternion turn the shader uses is a rotation', () => {
  // quatRotate is the shader's `turn` written in JavaScript; a rotation matrix built from the same quaternion must agree with it.
  for (let trial = 0; trial < 200; trial++) {
    const q = quatMul(quatAxis(Math.sin(trial), Math.cos(trial * 1.7), Math.sin(trial * .3) + .2, trial * .37), quatAxis(0, 1, 0, trial * .11));
    const v = [Math.sin(trial * 2.1) * 5, Math.cos(trial * .9) * 4, Math.sin(trial * .5) * 3], m = quatToMat3(q), turned = quatRotate(q, v);
    const byMatrix = [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
    assert.ok(distance(turned, byMatrix) < 1e-5 && Math.abs(Math.hypot(...turned) - Math.hypot(...v)) < 1e-9);
  }
});

test('the vertex shader turns and carries each stone, and has no way to stretch one', () => {
  const lines = VERTEX_SHADER.split('\n').map(line => line.trim());
  // The unit-quaternion rotation, written out.
  assert.ok(lines.includes('vec3 turn(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }'));
  // A point of a stone goes through exactly three steps: its own fixed shape, the stone's turn and place, the sphere's turn.
  const number = value => value.toFixed(4);
  assert.ok(lines.includes(`vec3 local = vec3(here * drawn, up * ${number(PROFILE.top)} * aThickness);`));
  assert.ok(lines.includes('vec3 placed = turn(aTurn, local) + aPlace.xyz;'));
  assert.ok(lines.includes('vec3 seen = uSway * placed;'));
  assert.ok(lines.includes('gl_Position = project(seen);'));
  assert.ok(lines.includes('return vec4(seen.xy * uZoom + uNudge * depth, uLens.z - uLens.y * depth, depth);'), 'a fixed lens, with perspective and nothing else');
  // The shape is built only from what is written once per stone, never from anything that changes.
  const shape = lines.filter(line => /\b(local|here|before|after|up|drawn)\b[^=;]*=/.test(line) && !/placed|seen/.test(line)).join(' ');
  assert.ok(shape.includes('outline(at)') && shape.includes('aThickness'));
  assert.equal(/aTurn|aPlace|aFaces|uSway|uLens|uZoom|uNudge/.test(shape), false);
  // The moving inputs are used where a rigid motion uses them and nowhere else.
  const uses = name => (VERTEX_SHADER.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
  assert.equal(uses('aTurn'), 6, 'declared, then turning the point, its normal and the three axes of its face');
  assert.equal(uses('aPlace\\.xyz'), 1, 'carrying the point');
  assert.equal(uses('uSway'), 6, 'declared, then turning the point, its normal and the three axes of its face');
  assert.equal(uses('placed'), 2);
  // The same piece as sphere-mesh.mjs describes, so the JavaScript check above is a check of what is drawn.
  assert.ok(VERTEX_SHADER.includes(number(PROFILE.top)) && VERTEX_SHADER.includes(number(PROFILE.face)));
  assert.equal(template.vertexCount, 2 + 3 * SIDES);
});

test('a stone\'s grain is its own: read in the stone\'s coordinates, never the screen\'s or the sphere\'s', () => {
  const lines = VERTEX_SHADER.split('\n').map(line => line.trim());
  // Where to read the rock is worked out from the stone's own shape and its own fixed patch, before any turn or travel.
  const across = lines.find(line => line.startsWith('vec2 across =')), rock = lines.find(line => line.startsWith('vRock ='));
  assert.ok(across && rock);
  assert.equal(/aTurn|aPlace|aGlaze|uSway|uLens|placed|seen|gl_Position/.test(across + rock), false);
  assert.ok(across.includes('local') && rock.includes('across') && rock.includes('aRock'));
  // The fragment shader reads the rock and its relief only there, and nowhere on the screen.
  for (const map of ['uRock', 'uRelief']) {
    assert.deepEqual([...FRAGMENT_SHADER.matchAll(new RegExp(`texture\\(${map}, ([^)]+)\\)`, 'g'))].map(match => match[1]), ['vRock']);
  }
  assert.equal(/gl_FragCoord|dFdx|dFdy|fwidth|discard/.test(FRAGMENT_SHADER + BED_FRAGMENT_SHADER), false);
  // Each side of a block is one whole stone, chosen and never mixed with another: there is no glaze amount anywhere.
  assert.match(FRAGMENT_SHADER, /vec4 material = upper \? vUpper : vLower;/);
  assert.match(VERTEX_SHADER, /vUpper = side\(aFaces\.x\); vLower = side\(aFaces\.y\);/);
  assert.equal(/aGlaze|vGlaze|uGlaze/.test(VERTEX_SHADER + FRAGMENT_SHADER), false);
  // Matt stone in relief: lit by the direction of its own surface and by whether the light reaches it, with no glint, and solid.
  assert.equal(/reflect\(|pow\(max\(dot\(normal, normalize\(uKey/.test(FRAGMENT_SHADER), false);
  assert.match(FRAGMENT_SHADER, /colour = vec4\(lit\(body, normal, shade, sunlit\(vSeen, normalize\(vNormal\)\)\), 1\.0\);/);
});

test('the mortar is cells that turn only with their own ring, their own piece of shell and the sphere, so nothing slides over it', () => {
  const lines = BED_VERTEX_SHADER.split('\n').map(line => line.trim());
  // A cell's shape is fixed. Three things move it, all of them rigid: its ring's dial about the axis through the poles,
  // the turn and shift of the piece of shell it belongs to when the shell cracks open, and the sphere's turn.
  assert.ok(lines.includes('float dial = uDial[int(aRing)];'));
  assert.ok(lines.includes(`vec3 turned = vec3(point.x * vDial.x - point.y * vDial.y, point.x * vDial.y + point.y * vDial.x, point.z) * (${BED_RADIUS.toFixed(4)} - ${SHELL.toFixed(4)} * aCorner.z);`));
  assert.ok(lines.includes('vec3 placed = turn(aHinge, turned) + aShift.xyz;'));
  assert.ok(lines.includes('vSeen = uSway * placed;'));
  assert.ok(lines.includes('gl_Position = project(vSeen);'));
  assert.equal(/aTurn|aPlace|aFaces|uTime/.test(BED_VERTEX_SHADER), false);
  // The piece's turn is a unit quaternion and nothing else: every socket's, in every frame, with a document about or not.
  const cracked = createSphereMotion(field);
  let carried = 0, worst = 0;
  for (let frame = 0; frame < 360; frame++) {
    const file = frame > 60 && frame < 200 ? { at: [210, -70, RADIUS + 26], aim: [.66, -.28, .7], near: Math.min(1, (frame - 60) / 60) } : null;
    cracked.step({ state: 'listening', input: silence, output: silence, time: frame * FRAME, file, intake: frame >= 200 ? { id: 'pages', at: [210, -70, RADIUS + 26], aim: [.66, -.28, .7] } : null });
    if (frame % 3) continue;
    for (let socket = 0; socket < field.sockets.count; socket++) {
      const at = socket * CELL_STRIDE, turn = cracked.shell.carried.subarray(at, at + 4);
      worst = Math.max(worst, Math.abs(Math.hypot(...turn) - 1));
      if (turn[3] < .9999) carried++;
    }
  }
  assert.ok(carried > 1000 && worst < 1e-6, `pieces of shell were carried (${carried}) by turns of unit length to within ${worst}`);
  // It is lit by the same light as the stones, lies in their shadow, and is solid.
  const light = source => source.slice(source.indexOf('uniform vec3 uKey'), source.indexOf('}', source.indexOf('vec3 lit(')));
  assert.equal(light(BED_FRAGMENT_SHADER), light(FRAGMENT_SHADER));
  assert.match(BED_FRAGMENT_SHADER, /colour = vec4\(lit\(mortar, normal, shade, sunlit\(vSeen, surface\)\), 1\.0\);/);
  // Its sand, and the sockets and joints pressed into it, are its own: read where the ring itself is, before any turn.
  assert.match(BED_VERTEX_SHADER, /vPoint = point;/);
  assert.match(BED_FRAGMENT_SHADER, /vec3 point = normalize\(vPoint\);/);
  assert.match(BED_FRAGMENT_SHADER, /vec3 at = point \* /);
  for (const map of ['uRock', 'uRelief']) {
    assert.deepEqual([...BED_FRAGMENT_SHADER.matchAll(new RegExp(`texture\\(${map}, ([^)]+)\\)`, 'g'))].map(match => match[1]), ['at.yz', 'at.zx', 'at.xy']);
  }
  assert.equal((BED_FRAGMENT_SHADER.match(/texture\(uMortar,/g) || []).length, 1);
  // The mortar stands well below the stones' faces and above their middles: every stone at rest stands in it and proud of it.
  assert.ok(Math.abs(BED_RADIUS - RADIUS - MORTAR) < 1e-9);
  const still = createSphereMotion(field);
  still.step({ state: 'listening', input: silence, output: silence, time: 0, reduced: true });
  for (let index = 0; index < field.count; index++) {
    const out = Math.hypot(...still.tiles.subarray(index * STRIDE + PLACE, index * STRIDE + PLACE + 3));
    assert.ok(out < BED_RADIUS && out + PROFILE.top * field.height[index] > BED_RADIUS + .15);
  }
  // A ring's stones are carried round by exactly the angle its mortar is turned by: the same `dial` goes to both.
  const motion = createSphereMotion(field);
  let turned = 0, checked = 0;
  converse(motion, frame => {
    if (frame % 5) return;
    for (let index = 3; index < field.count - 3; index += 41) {
      const at = index * STRIDE + PLACE, n = index * 3, dial = motion.dial[field.course[index]];
      if (Math.hypot(field.normal[n], field.normal[n + 1]) < .05) continue;
      const round = Math.atan2(motion.tiles[at + 1], motion.tiles[at]) - Math.atan2(field.normal[n + 1], field.normal[n]) - dial;
      assert.ok(Math.abs(Math.atan2(Math.sin(round), Math.cos(round))) < 1e-4);
      turned = Math.max(turned, Math.abs(dial)); checked++;
    }
  });
  assert.ok(checked > 5000 && turned > .05, 'rings really turned while this was checked');
});

test('the renderer draws the mortar\'s cells and the stones, as the light sees them and then as the viewer does, and nothing else', () => {
  const renderer = readFileSync(new URL('../src/sphere/sphere-renderer.mjs', import.meta.url), 'utf8');
  const used = new Set([...renderer.matchAll(/\bgl\.([A-Za-z0-9]+)\(/g)].map(match => match[1]));
  assert.deepEqual([...used].sort(), [
    'activeTexture', 'attachShader', 'bindBuffer', 'bindFramebuffer', 'bindTexture', 'bindVertexArray', 'bufferData', 'bufferSubData', 'clear',
    'clearColor', 'compileShader', 'createBuffer', 'createFramebuffer', 'createProgram', 'createShader', 'createTexture', 'createVertexArray',
    'deleteBuffer', 'deleteFramebuffer', 'deleteProgram', 'deleteShader', 'deleteTexture', 'deleteVertexArray', 'drawBuffers',
    'drawElementsInstanced', 'enable', 'enableVertexAttribArray', 'framebufferTexture2D', 'generateMipmap', 'getProgramInfoLog',
    'getProgramParameter', 'getShaderInfoLog', 'getShaderParameter', 'getUniformLocation', 'isContextLost', 'linkProgram', 'shaderSource',
    'texImage2D', 'texParameteri', 'uniform1f', 'uniform1fv', 'uniform1i', 'uniform2f', 'uniform3f', 'uniformMatrix3fv',
    'useProgram', 'vertexAttribDivisor', 'vertexAttribPointer', 'viewport',
  ]);
  // Two real objects, each drawn by one call: every cell of the mortar at once, then every stone at once
  // (the sphere's own, and after them the stones of a document's sheet).
  assert.equal((renderer.match(/gl\.draw(Elements|Arrays)/g) || []).length, 2);
  assert.match(renderer, /gl\.drawElementsInstanced\(gl\.TRIANGLES, slab\.indexCount, gl\.UNSIGNED_BYTE, 0, cells\.count\)/);
  assert.match(renderer, /gl\.drawElementsInstanced\(gl\.TRIANGLES, template\.indexCount, gl\.UNSIGNED_BYTE, 0, blocks\)/);
  assert.match(renderer, /const blocks = field\.count \+ field\.sheet\.count;/);
  // That pair is drawn twice a frame: what the light can see, then the picture. The picture is last, straight to the canvas.
  const frame = renderer.slice(renderer.indexOf('draw(tiles, turned, dial, shell, lens, view)'), renderer.indexOf('dispose()'));
  assert.deepEqual([...frame.matchAll(/scene\((\d)/g)].map(match => match[1]), ['1', '0']);
  assert.ok(frame.indexOf('gl.bindFramebuffer(gl.FRAMEBUFFER, null)') > 0 && frame.indexOf('gl.bindFramebuffer(gl.FRAMEBUFFER, null)') < frame.indexOf('scene(0'));
  assert.match(frame, /scene\(0[^;]*;\s*\},/, 'nothing is drawn after the picture');
  // Only depth sorting and back-face culling are switched on: nothing is ever blended, cut out, or copied.
  assert.deepEqual([...renderer.matchAll(/gl\.enable\(gl\.([A-Z_]+)\)/g)].map(match => match[1]).sort(), ['CULL_FACE', 'DEPTH_TEST']);
  assert.equal(/BLEND|blend|readPixels|scissor|stencilFunc|SAMPLE_ALPHA|copyTex|blitFramebuffer|createRenderbuffer|COLOR_ATTACHMENT/.test(renderer.replace(/stencil: false/, '')), false);
  // The one thing drawn off the canvas is the light's own view, and it is depth only: it can say what is in shadow and nothing more.
  assert.equal((renderer.match(/gl\.createFramebuffer\(/g) || []).length, 1);
  assert.match(renderer, /gl\.framebufferTexture2D\(gl\.FRAMEBUFFER, gl\.DEPTH_ATTACHMENT, gl\.TEXTURE_2D, shadow, 0\)/);
  assert.match(renderer, /gl\.drawBuffers\(\[gl\.NONE\]\)/);
  assert.match(renderer, /uniform highp sampler2DShadow uShadow;/);
  assert.equal((renderer.match(/texture\(uShadow,/g) || []).length, 1);
  // The canvas is cleared to nothing: there is no backdrop behind the sphere.
  assert.match(renderer, /gl\.clearColor\(0, 0, 0, 0\)/);
  // Two things are written again after start-up: each stone's turn, place and sides, every frame; and, only when the
  // shell cracks or mends, which piece of it carries each cell. A cell's own shape is never written again.
  assert.equal((renderer.match(/gl\.bufferSubData\(/g) || []).length, 2);
  assert.equal((renderer.match(/gl\.DYNAMIC_DRAW/g) || []).length, 2);
  assert.match(renderer, /if \(shell\.changed !== carriedAt\) \{/);
  assert.match(renderer, /buffer\(gl\.ARRAY_BUFFER, slab\.corners, gl\.STATIC_DRAW\)/);
  assert.match(renderer, /buffer\(gl\.ARRAY_BUFFER, cells\.spans, gl\.STATIC_DRAW\)/);
  // Three maps, all made from numbers at start-up: the rock, the rock's relief, and the mortar as the layout presses it.
  assert.match(renderer, /const rock = createRock\(ROCK_SIZE\);/);
  assert.match(renderer, /map\(0, ROCK_SIZE, ROCK_SIZE, rock, true\);/);
  assert.match(renderer, /map\(1, ROCK_SIZE, ROCK_SIZE, createRelief\(rock, ROCK_SIZE\), true\);/);
  assert.match(renderer, /map\(2, MORTAR_WIDTH, MORTAR_HEIGHT, createMortarMap\(field, MORTAR_WIDTH, MORTAR_HEIGHT\), false\);/);
  assert.equal((renderer.match(/\bmap\(\d,/g) || []).length, 3);
  assert.equal((renderer.match(/gl\.texImage2D\(/g) || []).length, 2, 'the maps, and the empty depth map');
  // No picture and no network anywhere in the sphere.
  for (const name of ['SphereCanvas.jsx', 'sphere-field.mjs', 'sphere-math.mjs', 'sphere-mesh.mjs', 'sphere-mortar.mjs', 'sphere-motion.mjs', 'sphere-renderer.mjs', 'sphere-rock.mjs']) {
    const source = readFileSync(new URL(`../src/sphere/${name}`, import.meta.url), 'utf8');
    assert.equal(/new Image|fetch\(|XMLHttpRequest|createImageBitmap|texSubImage|\.png|\.jpe?g|\.webp/.test(source), false, name);
  }
  // The page puts nothing over or under the canvas and neither scales nor filters it.
  const component = readFileSync(new URL('../src/sphere/SphereCanvas.jsx', import.meta.url), 'utf8');
  assert.equal(/filter|transform|scale\(|mixBlendMode|opacity|boxShadow|background|getContext\('2d'\)/.test(component), false);
  assert.equal((component.match(/<canvas/g) || []).length, 1);
});

test('the camera is a real one: a fixed lens, with perspective and nothing else', () => {
  const lens = createLens({ radius: RADIUS, distance: RADIUS * 6.5, apparent: 142, half: 180 });
  // A sphere's outline is where the line of sight grazes it.
  const graze = RADIUS * RADIUS / lens.distance, rim = Math.sqrt(RADIUS * RADIUS - graze * graze);
  assert.ok(Math.abs(lens.project(rim, 0, graze)[0] - 142) < 1e-9, 'the outline is the flat medallion\'s 142 pixels');
  // Nearer is larger, by the same rule for every tile; the pole of the sphere is the nearest point.
  const near = lens.project(10, 0, RADIUS)[0], level = lens.project(10, 0, 0)[0], far = lens.project(10, 0, -RADIUS)[0];
  assert.ok(near > level && level > far && near / far < 1.4);
  // A tile lifted five pixels towards the viewer looks under one percent larger: travel never reads as scaling.
  assert.ok(lens.project(10, 0, RADIUS + 5)[0] / near < 1.01);
  assert.ok(lens.near > 0 && lens.far > lens.near && lens.near < lens.distance - RADIUS && lens.far > lens.distance + RADIUS);
});
