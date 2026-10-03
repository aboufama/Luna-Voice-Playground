import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMosaicField } from '../src/mosaic-field.mjs';
import { stonePigments } from '../src/mosaic-pigment.mjs';
import { createSphereField, motifStrength, faceMotif, onSphere, RADIUS, PITCH, CENTRE, RINGS, COURSES, FACE_ARC, SCALE, KIND } from '../src/sphere/sphere-field.mjs';
import { createTileTemplate, createCellTemplate, createCells, cellPoint, tilePoint, SIDES, PROFILE, MORTAR, RECESS, RING, SHELL } from '../src/sphere/sphere-mesh.mjs';
import { createRock, ROCK_SIZE } from '../src/sphere/sphere-rock.mjs';
import { quatRotate } from '../src/sphere/sphere-math.mjs';

const field = createSphereField();
const flat = createMosaicField().tiles;
const tiles = Array.from({ length: field.count }, (_, index) => index);
const outline = index => field.outline.subarray(index * SIDES * 2, (index + 1) * SIDES * 2);
const area = index => { const c = outline(index); let sum = 0; for (let k = 0; k < SIDES; k++) { const j = (k + 1) % SIDES; sum += c[k * 2] * c[j * 2 + 1] - c[j * 2] * c[k * 2 + 1]; } return sum / 2; };
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const places = field.count + field.lost.length / 2;

test('the sphere carries the flat medallion\'s own motifs', () => {
  // The flat field keeps its motif function private, so the sphere repeats it. They must never drift apart.
  for (const tile of flat) assert.equal(motifStrength(tile.x, tile.y), tile.motifStrength);
  // On the sphere the same function is read through a layout: the construction enlarged with the stones,
  // the meander enlarged, drawn in, and turned through fewer repeats.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} against ${b}`);
  near(faceMotif(40 * SCALE, .7), Math.min(1, 1.18 * motifStrength(40 * Math.cos(.7), 40 * Math.sin(.7))));
  near(faceMotif(FACE_ARC - 14 * SCALE, 1), motifStrength(130 * Math.cos(.7), 130 * Math.sin(.7)));
  assert.equal(faceMotif(FACE_ARC + 2, 1), 0);
});

test('the medallion is the face: construction on the front cap, the meander as a band, plain courses over the back', () => {
  const gilded = tiles.filter(index => field.gilded[index]);
  assert.ok(gilded.every(index => field.arc[index] < FACE_ARC), 'no motif beyond the face');
  const cap = tiles.filter(index => field.arc[index] < FACE_ARC);
  const share = gilded.length / cap.length;
  assert.ok(share > .08 && share < .4, `gilded share of the face ${share.toFixed(2)}`);
  // The compass arcs and the triangle sit well inside the face, around the pole towards the viewer.
  const construction = gilded.filter(index => field.arc[index] < 72 * SCALE);
  assert.ok(construction.length > 18 && construction.every(index => field.normal[index * 3 + 2] > Math.cos(36 * Math.PI / 180)), `${construction.length} gilded stones in the construction`);
  // The meander is a band of latitude well inside the outline, so it is seen and not lost at the limb.
  const meander = gilded.filter(index => field.arc[index] > 114);
  assert.ok(meander.length > 90, `${meander.length} gilded stones in the meander`);
  const acrossOutline = meander.map(index => Math.hypot(field.normal[index * 3], field.normal[index * 3 + 1]));
  assert.ok(Math.min(...acrossOutline) > .68 && Math.max(...acrossOutline) < .86, 'between two thirds and five sixths of the way out');
  // Legible at the new size: a key of the meander still gets as many stones along it as on the flat medallion,
  const along = 2 * Math.PI * RADIUS * Math.sin(133 / RADIUS) / 14 / (7.3 * SCALE), flatAlong = 2 * Math.PI * 130 / 20 / 7.3;
  assert.ok(along > flatAlong * .95, `${along.toFixed(1)} stones to a key, ${flatAlong.toFixed(1)} on the medallion`);
  // and gold runs all the way round, in most of its fourteen repeats.
  const repeats = new Set(meander.map(index => Math.floor(((field.theta[index] * 14 / 20 / (Math.PI * 2) + 1.018) % 1) * 20)));
  assert.ok(repeats.size >= 9, `${repeats.size} repeats carry gold`);
  // A motif line is unbroken where it is strong: a gilded stone there has a gilded neighbour.
  const lonely = construction.filter(index => !construction.some(other => other !== index
    && Math.hypot(field.normal[index * 3] - field.normal[other * 3], field.normal[index * 3 + 1] - field.normal[other * 3 + 1], field.normal[index * 3 + 2] - field.normal[other * 3 + 2]) * RADIUS < 13));
  assert.ok(lonely.length <= construction.length * .2, `${lonely.length} stray gilded stones of ${construction.length}`);
  const strongest = tiles.reduce((best, index) => field.motif[index] > field.motif[best] ? index : best, 0);
  assert.equal(field.gilded[strongest], 1);
});

test('the whole sphere is set with stones a fifth larger than the medallion\'s, and so noticeably fewer', () => {
  assert.equal(COURSES, RINGS + 2);
  assert.ok(Math.abs(Math.PI * RADIUS - (RINGS * PITCH + 2 * CENTRE)) < 1e-9, 'a whole number of courses from pole to pole');
  assert.ok(Math.abs(PITCH / 6.8 - SCALE) < 1e-9 && SCALE >= 1.2 && SCALE <= 1.25);
  // At the medallion's size the sphere held 5,628.
  assert.ok(places > 3600 && places < 4100 && field.count < 3800, `${field.count} stones in ${places} places`);
  const perCourse = new Array(COURSES).fill(0);
  for (const index of tiles) perCourse[field.course[index]]++;
  assert.equal(perCourse[0], 1); assert.equal(perCourse[COURSES - 1], 1);
  assert.ok(Math.max(...perCourse) > 92 && Math.max(...perCourse) < 110);
  for (let k = 3; k <= RINGS / 2; k++) assert.ok(Math.abs(perCourse[k] - perCourse[COURSES - 1 - k]) <= 12, 'as many behind as in front, give or take the lost ones');
  // Every stone sits on the sphere, in its own course.
  for (const index of tiles) {
    const n = field.normal.subarray(index * 3, index * 3 + 3);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
    const k = field.course[index];
    if (k > 0 && k < COURSES - 1) assert.ok(field.arc[index] > CENTRE + (k - 1) * PITCH + 1.5 && field.arc[index] < CENTRE + k * PITCH - 1.5);
    assert.ok(Math.abs(field.arc[index] - field.courseArc[k]) < PITCH);
  }
  // A stone is about one and a third times the flat stone's area; the rest of the sphere is mortar.
  const flatSizes = flat.slice(1).map(tile => { let sum = 0; for (let i = 0; i < 4; i++) { const a = tile.vertices[i], b = tile.vertices[(i + 1) % 4]; sum += a.x * b.y - b.x * a.y; } return Math.abs(sum / 2); });
  const ratio = mean(tiles.filter(index => field.course[index] > 0 && field.course[index] < COURSES - 1).map(area)) / mean(flatSizes);
  assert.ok(ratio > 1.15 && ratio < 1.5, `${ratio.toFixed(2)} times the flat stone`);
  const covered = tiles.reduce((sum, index) => sum + area(index), 0) / (4 * Math.PI * RADIUS * RADIUS);
  assert.ok(covered > .62 && covered < .82, `stones cover ${covered.toFixed(2)} of the sphere`);
});

test('a few stones have been lost, sparsely and unevenly, and hardly ever from the gilded lines', () => {
  const share = field.lost.length / 2 / places;
  assert.ok(share > .05 && share < .08, `${(share * 100).toFixed(1)}% lost, against one in four on the flat medallion`);
  let fromMotif = 0;
  const quarters = [0, 0, 0, 0];
  for (let at = 0; at < field.lost.length; at += 2) {
    if (faceMotif(field.lost[at], field.lost[at + 1]) > .34) fromMotif++;
    if (field.lost[at] < Math.PI * RADIUS / 2) quarters[Math.floor(((field.lost[at + 1] + Math.PI) / (Math.PI * 2)) * 4) % 4]++;
  }
  assert.ok(fromMotif <= 4, `${fromMotif} lost from the drawing`);
  // Wear is uneven: some parts of the face have lost more than others, but none is spared or stripped.
  assert.ok(Math.min(...quarters) >= 12 && Math.max(...quarters) > Math.min(...quarters) * 1.2, quarters.join(' '));
  // The stones at the two poles are always there.
  assert.equal(field.course[0], 0); assert.equal(field.course[field.count - 1], COURSES - 1);
});

test('every stone is cut by hand and set by hand: no two alike, none square, none quite true', () => {
  const shapes = new Set();
  let bowed = 0, chipped = 0, leaning = 0;
  for (const index of tiles) {
    const c = outline(index);
    assert.ok(area(index) > 10, 'counter-clockwise seen from outside');
    shapes.add(Array.from(c, value => value.toFixed(3)).join(','));
    // Its outline stays about the point where the stone touches the sphere.
    let cx = 0, cy = 0;
    for (let k = 0; k < SIDES; k++) { cx += c[k * 2]; cy += c[k * 2 + 1]; }
    assert.ok(Math.hypot(cx, cy) / SIDES < 1.2);
    for (let corner = 0; corner < 4; corner++) {
      // Each corner is two points, a cut apart; each edge has a point that leaves the straight line.
      const a = corner * 3, b = a + 1, m = a + 2, n = (a + 3) % SIDES;
      const cut = Math.hypot(c[a * 2] - c[b * 2], c[a * 2 + 1] - c[b * 2 + 1]);
      assert.ok(cut > .25, 'no corner is left sharp');
      if (cut > 1.6) chipped++;
      const ex = c[n * 2] - c[b * 2], ey = c[n * 2 + 1] - c[b * 2 + 1];
      const off = Math.abs((c[m * 2] - c[b * 2]) * ey - (c[m * 2 + 1] - c[b * 2 + 1]) * ex) / Math.hypot(ex, ey);
      if (off > .1) bowed++;
    }
    // Set by hand: tilted a few degrees and pressed a hair in or out, never more.
    const q = field.frame.subarray(index * 4, index * 4 + 4);
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
    const up = quatRotate(q, [0, 0, 1]);
    const outward = up[0] * field.normal[index * 3] + up[1] * field.normal[index * 3 + 1] + up[2] * field.normal[index * 3 + 2];
    assert.ok(outward > Math.cos(.1) && outward <= 1 + 1e-9);
    if (outward < Math.cos(.025)) leaning++;
    assert.ok(Math.abs(field.seat[index]) <= .26 && field.height[index] > .87 && field.height[index] < 1.13);
    // It stands proud of the mortar, with its middle set down in it.
    assert.ok(field.seat[index] + PROFILE.top * field.height[index] > MORTAR + .15 && field.seat[index] < MORTAR);
  }
  assert.equal(shapes.size, field.count, 'no two stones are the same');
  assert.ok(bowed > field.count * 2 && chipped > field.count * .3 && leaning > field.count * .5, `${bowed} bowed edges, ${chipped} chipped corners, ${leaning} leaning stones`);
  // Neighbours in a course keep a joint of mortar between them.
  for (let index = 2; index < field.count - 1; index++) {
    if (field.course[index] !== field.course[index - 1] || field.course[index] < 3 || field.course[index] > COURSES - 4) continue;
    const a = field.normal.subarray(index * 3, index * 3 + 3), b = field.normal.subarray(index * 3 - 3, index * 3);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * RADIUS > 7.2);
  }
  // The pole of the medallion faces the viewer and the far pole faces away.
  assert.ok(field.normal[2] > .9999 && field.normal[(field.count - 1) * 3 + 2] < -.9999);
  const pole = onSphere(0, 0), right = onSphere(RADIUS * Math.PI / 2, 0), below = onSphere(RADIUS * Math.PI / 2, Math.PI / 2);
  assert.ok(Math.hypot(pole[0], pole[1], pole[2] - RADIUS) < 1e-9, 'the medallion\'s centre is the point nearest the viewer');
  // The medallion's x runs right and its y runs down the screen, as on the flat canvas.
  assert.ok(Math.hypot(right[0] - RADIUS, right[1], right[2]) < 1e-9 && Math.hypot(below[0], below[1] + RADIUS, below[2]) < 1e-9);
});

test('each colour of the shared palette is a real stone, and no two pieces of it are quite the same', () => {
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const byColour = new Map();
  for (const index of tiles) {
    const pigments = stonePigments({ seed: field.seed[index], r: field.arc[index] / 150, motifStrength: field.motif[index] });
    assert.equal(field.gilded[index], Number(pigments.gilded));
    for (const name of ['cool', 'bright', 'warm']) {
      const stone = field[name].subarray(index * 4, index * 4 + 4);
      // Recognisably the palette's colour, but greyer and chalkier than enamel.
      assert.ok(distance(stone, pigments[name]) < 85, `${name} of stone ${index}`);
      const vivid = colour => Math.max(...colour) - Math.min(...colour);
      assert.ok(vivid(stone.subarray(0, 3)) < vivid(pigments[name]) + 8);
      const key = name + pigments[name].map(Math.round).join(',');
      byColour.set(key, [...(byColour.get(key) || []), [...stone.subarray(0, 3)].join(',')]);
    }
    // The blues are lapis or a green-blue stone, the gilded lines marble, a person's glaze green stone, Luna's terracotta and marble.
    const [cool, bright, warm] = ['cool', 'bright', 'warm'].map(name => field[name][index * 4 + 3]);
    if (pigments.gilded) assert.ok(cool === KIND.marble || cool === KIND.terracotta); else assert.ok(cool === KIND.lapis || cool === KIND.greenstone);
    assert.ok(pigments.gilded ? bright === KIND.marble : bright === KIND.greenstone);
    assert.ok(warm === KIND.terracotta || warm === KIND.marble);
    // Not live means grey limestone or basalt: near neutral, never a colour.
    const mineral = field.mineral.subarray(index * 4, index * 4 + 4);
    assert.equal(mineral[3], KIND.limestone);
    assert.ok(Math.max(...mineral.subarray(0, 3)) - Math.min(...mineral.subarray(0, 3)) < 40 && mineral[1] < 190 && mineral[1] > 70);
  }
  // Where many stones share one palette colour they are still different pieces: lighter and darker, warmer and cooler.
  const shared = [...byColour.values()].filter(stones => stones.length > 20);
  assert.ok(shared.length > 5);
  for (const stones of shared) {
    assert.ok(new Set(stones).size > Math.min(stones.length * .7, 150), `${new Set(stones).size} variants among ${stones.length}`);
    const greens = stones.map(stone => Number(stone.split(',')[1]));
    assert.ok(Math.max(...greens) - Math.min(...greens) >= 10);
  }
});

test('one stone is a closed solid: two faces and a rounded shoulder between them', () => {
  const template = createTileTemplate();
  assert.equal(template.vertexCount, 2 + 3 * SIDES); assert.equal(template.indexCount, SIDES * 18);
  const vertex = at => template.vertices.subarray(at * 2, at * 2 + 2);
  // Closed: every edge is shared by exactly two triangles, so there is no way to see inside a stone.
  const edges = new Map();
  for (let at = 0; at < template.indexCount; at += 3) for (let k = 0; k < 3; k++) {
    const key = [template.indices[at + k], template.indices[at + (k + 1) % 3]].sort((a, b) => a - b).join('-');
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  assert.ok([...edges.values()].every(shared => shared === 2));
  for (const index of [0, 9, 733, 2800, field.count - 1]) {
    const point = at => [...tilePoint(outline(index), field.height[index], vertex(at)[0], vertex(at)[1])];
    const top = PROFILE.top * field.height[index];
    for (let at = 0; at < template.indexCount; at += 3) {
      const [a, b, c] = [0, 1, 2].map(k => point(template.indices[at + k]));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const middle = [0, 1, 2].map(axis => (a[axis] + b[axis] + c[axis]) / 3);
      // Wound to face outward: a face looks up or down, the shoulder away from the middle of the stone.
      const rings = [0, 1, 2].map(k => vertex(template.indices[at + k])[1]);
      if (rings.every(ring => ring <= RING.face)) assert.ok(normal[2] > 0 && Math.abs(middle[2] - top) < 1e-6);
      else if (rings.every(ring => ring >= RING.under)) assert.ok(normal[2] < 0 && Math.abs(middle[2] + top) < 1e-6);
      else assert.ok(normal[0] * middle[0] + normal[1] * middle[1] > 0);
    }
  }
});

test('the mortar is a shell of rigid cells, one to a place, that together make the hollow sphere', () => {
  const edges = Array.from(field.courseEdge, edge => edge / RADIUS), cells = createCells(field, edges), slab = createCellTemplate();
  // The rings run from the pole facing the viewer to the far one, with no gap and no overlap.
  assert.equal(edges.length, COURSES + 1);
  assert.ok(edges[0] === 0 && Math.abs(edges.at(-1) - Math.PI) < 1e-6 && edges.every((edge, ring) => ring === 0 || edge > edges[ring - 1]));
  // Every socket has its cell; the cap at each pole is cut along its neighbouring ring's places; and the cells of a ring go exactly once round it.
  assert.equal(cells.count, field.sockets.count - 2 + field.places[1] + field.places[COURSES - 2]);
  assert.equal(new Set(cells.socket).size, field.sockets.count);
  const round = new Float64Array(COURSES);
  for (let cell = 0; cell < cells.count; cell++) {
    const [from, to, start, stop] = cells.spans.subarray(cell * 4, cell * 4 + 4), ring = cells.ring[cell];
    assert.ok(Math.abs(from - edges[ring]) < 1e-6 && Math.abs(to - edges[ring + 1]) < 1e-6 && stop > start);
    assert.equal(field.sockets.course[cells.socket[cell]], ring);
    round[ring] += stop - start;
  }
  assert.ok(round.every(turn => Math.abs(turn - Math.PI * 2) < 1e-3));
  // A cell is a solid slab: a top at the mortar's surface, an underside a shell's thickness below, and four cut
  // sides, every one of them facing outward from the slab. Nothing joins two cells, so any can be carried off alone.
  let faces = 0;
  for (let cell = 0; cell < cells.count; cell += 7) {
    const span = cells.spans.subarray(cell * 4, cell * 4 + 4);
    for (let at = 0; at < slab.indexCount; at += 3) {
      const corners = [0, 1, 2].map(k => slab.corners.subarray(slab.indices[at + k] * 4, slab.indices[at + k] * 4 + 4));
      assert.ok(corners.every(corner => corner[3] === corners[0][3]), 'a triangle lies in one face');
      const [a, b, c] = corners.map(corner => cellPoint(span, corner, RADIUS + MORTAR).point);
      for (const [point, corner] of [[a, corners[0]], [b, corners[1]], [c, corners[2]]]) assert.ok(Math.abs(Math.hypot(...point) - (RADIUS + MORTAR - SHELL * corner[2])) < 1e-6);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], area = Math.hypot(...normal);
      // (At a pole a cell narrows to a point, and the triangles there vanish.)
      if (area < 1e-3) continue;
      const middle = [0, 1, 2, 3].map(k => k === 3 ? corners[0][3] : (corners[0][k] + corners[1][k] + corners[2][k]) / 3), faced = cellPoint(span, middle, RADIUS + MORTAR).face;
      assert.ok((normal[0] * faced[0] + normal[1] * faced[1] + normal[2] * faced[2]) / area > .8);
      faces++;
    }
  }
  assert.ok(faces > 15_000);
});

test('the rock is made from numbers at start-up: seamless, fine-grained, sparsely veined and flecked', () => {
  const rock = createRock();
  assert.equal(rock.length, ROCK_SIZE * ROCK_SIZE * 4);
  assert.deepEqual(createRock(64), createRock(64), 'the same rock every time');
  const at = (x, y, channel) => rock[(((y % ROCK_SIZE) + ROCK_SIZE) % ROCK_SIZE * ROCK_SIZE + ((x % ROCK_SIZE) + ROCK_SIZE) % ROCK_SIZE) * 4 + channel];
  // Seamless: the mottling changes no more across the edge of the square than inside it.
  let inside = 0, across = 0;
  for (let y = 0; y < ROCK_SIZE; y++) { inside += Math.abs(at(100, y, 0) - at(101, y, 0)); across += Math.abs(at(ROCK_SIZE - 1, y, 0) - at(ROCK_SIZE, y, 0)); }
  assert.ok(across < inside * 2 + ROCK_SIZE);
  const share = (channel, above) => { let n = 0; for (let i = channel; i < rock.length; i += 4) if (rock[i] > above) n++; return n / (ROCK_SIZE * ROCK_SIZE); };
  const average = channel => { let sum = 0; for (let i = channel; i < rock.length; i += 4) sum += rock[i]; return sum / (ROCK_SIZE * ROCK_SIZE); };
  // Mottling and grain are centred, so a stone keeps its own colour on average.
  assert.ok(Math.abs(average(0) - 127) < 14 && Math.abs(average(1) - 127) < 10);
  // Grain is fine: neighbouring pixels differ. Mottling is broad: they hardly do.
  let grain = 0, mottle = 0;
  for (let y = 0; y < ROCK_SIZE; y += 3) for (let x = 0; x < ROCK_SIZE; x += 3) { grain += Math.abs(at(x, y, 1) - at(x + 2, y, 1)); mottle += Math.abs(at(x, y, 0) - at(x + 2, y, 0)); }
  assert.ok(grain > mottle * 3);
  // Veins and flecks are occasional.
  assert.ok(share(2, 64) > .003 && share(2, 64) < .08, `veins over ${(share(2, 64) * 100).toFixed(1)}%`);
  assert.ok(share(3, 128) > .002 && share(3, 128) < .05, `flecks over ${(share(3, 128) * 100).toFixed(1)}%`);
  // No picture is loaded and nothing is fetched anywhere in the sphere.
  for (const name of ['sphere-rock.mjs', 'sphere-renderer.mjs', 'sphere-field.mjs', 'sphere-mesh.mjs', 'sphere-motion.mjs', 'SphereCanvas.jsx']) {
    const source = readFileSync(new URL(`../src/sphere/${name}`, import.meta.url), 'utf8');
    assert.equal(/new Image|fetch\(|createImageBitmap|\.png|\.jpe?g|\.webp|XMLHttpRequest|<img/.test(source), false, name);
  }
});
