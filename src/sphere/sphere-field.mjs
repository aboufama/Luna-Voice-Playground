import { stonePigments } from '../mosaic-pigment.mjs';
import { TAU, clamp, smooth, hash, quatFromFrame, quatMul, quatAxis } from './sphere-math.mjs';

// The flat medallion's own measures (a course 6.8 deep, a stone about 7.3 wide,
// one small stone at the centre), each a little larger: the sphere's tesserae
// are cut bigger than the medallion's.
export const SCALE = 1.22;
export const PITCH = 6.8 * SCALE;
const STONE = 7.3 * SCALE;
export const CENTRE = 2.9 * SCALE;
// Rings of latitude between the stone at the front pole and the one at the back.
export const RINGS = 56;
export const COURSES = RINGS + 2;
// Chosen so a whole number of courses runs from pole to pole.
export const RADIUS = (2 * CENTRE + RINGS * PITCH) / Math.PI;
// The medallion is the face of the sphere, a cap around the pole facing the viewer.
// Its construction grows with the stones. Its meander would then fall at the
// outline, so the band is drawn in to end here, and given fewer repeats so that
// each key keeps as many stones as it has on the flat medallion.
export const FACE_ARC = 150;
const MEANDER_REPEATS = 14;
const MEANDER_INSET = 144 * SCALE - FACE_ARC;
// A line one stone wide breaks up sooner when the stones are larger, so the construction is drawn a little more firmly.
const FIRMER = 1.18;
// Mortar between two neighbouring stones, in pixels, before the hand that cut them made it uneven.
const JOINT = .7;
// One stone in fifteen or so has been lost, in patches as wear goes, and seldom from the gilded lines.
const LOST = .078;
const LOST_GILDED = .12;
// A document handed to the sphere arrives as a small sheet of this many stones, this many to a row,
// each this far across, cut from one pale stone. They are not part of the sphere until it swallows them.
export const SHEET = 9, SHEET_ROW = 3, SHEET_STONE = 7.4;
// The mineral a tile is cut from, as in the flat medallion's stone atlas.
const MINERALS = { warm: [72, 65, 55], pale: [92, 88, 79], dark: [48, 47, 43] };
// The flat stones are drawn as ink over a white page; a solid tile carries that lightening in its body.
const MINERAL_BODY = .66;
// Each colour of the palette is a real stone. What kind decides its grain, veins and flecks.
export const KIND = { limestone: 0, lapis: 1, marble: 2, greenstone: 3, terracotta: 4 };
// How far each kind sits from the palette's pure colour: natural stone is greyer and chalkier than enamel.
const GREYER = [0, .26, .24, .34, .24];
const CHALKIER = [0, .1, .14, .16, .12];
const CHALK = [224, 218, 205];

// Integer hashing keeps the cuts identical across visits and machines.
function noise(index) {
  let value = (index + 0x6d2b79f5) | 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

const trace = (distance, width = 1.7) => Math.exp(-0.5 * (distance / width) ** 2);

const KEY = [[0, .82], [.23, .82], [.23, .18], [.73, .18], [.73, .63], [.48, .63], [.48, .42]];
/**
 * The medallion's motifs: the meander key in the outer band, the two compass
 * sweeps and the construction triangle. `x` and `y` are medallion coordinates
 * (y down), measured from its centre. This is the flat field's own function,
 * repeated here because that module does not export it;
 * tests/sphere-field.test.mjs fails if the two ever disagree.
 */
export function motifStrength(x, y) {
  const radius = Math.hypot(x, y), theta = Math.atan2(y, x);
  let key = 0;
  if (radius > 116 && radius < 144) {
    const phase = ((theta / TAU + 1.018) % 1) * 20;
    const repeat = Math.floor(phase), u = phase - repeat;
    const length = TAU * 130 / 20;
    let distance = Infinity;
    for (let index = 1; index < KEY.length; index++) {
      const a = KEY[index - 1], b = KEY[index];
      distance = Math.min(distance, segmentDistance(u * length, radius - 119, a[0] * length, a[1] * 21, b[0] * length, b[1] * 21));
    }
    const fragment = noise(repeat + 880) < .27 ? .05 : .52 + noise(repeat + 900) * .4;
    key = trace(distance, 2.75) * fragment * smooth((radius - 116) / 4) * smooth((144 - radius) / 4);
  }
  const sweepA = trace(Math.abs(Math.hypot(x + 17, y - 3) - 46), 3.1);
  const sweepB = trace(Math.abs(Math.hypot(x - 23, y - 3) - 46), 3.0);
  const triangle = Math.min(
    segmentDistance(x, y, -51, 32, 47, 32),
    segmentDistance(x, y, 47, 32, -2, -53),
    segmentDistance(x, y, -2, -53, -51, 32),
  );
  const worn = .66 + .17 * Math.sin(x * .067 + y * .042) + .12 * Math.cos(y * .091 - x * .029);
  const geometry = Math.max(sweepA * .48, sweepB * .37, trace(triangle, 2.8) * .43) * worn;
  return clamp(Math.max(key, geometry));
}

/**
 * The same motifs laid on the sphere for its larger stones. `arc` is distance
 * along the surface from the pole facing the viewer and `theta` the medallion's
 * bearing. The construction is the medallion's, enlarged with the stones and
 * drawn a little more firmly; the meander is the medallion's band, enlarged
 * too, then moved in and turned through fewer repeats. Both are read from the
 * one function above.
 */
export function faceMotif(arc, theta) {
  const inner = arc / SCALE;
  const construction = inner < 112 ? Math.min(1, FIRMER * motifStrength(inner * Math.cos(theta), inner * Math.sin(theta))) : 0;
  const band = (arc + MEANDER_INSET) / SCALE, along = theta * MEANDER_REPEATS / 20;
  const key = band > 116 && band < 144 ? motifStrength(band * Math.cos(along), band * Math.sin(along)) : 0;
  return Math.max(construction, key);
}

/**
 * Where a point of the medallion sits on the sphere. The medallion's centre is
 * the pole facing the viewer and distance from that centre becomes distance
 * along the surface, so a course stays as deep as it was. `arc` is that
 * distance and `theta` the medallion's own bearing (clockwise on screen).
 * The result is in sphere space: x right, y up, z towards the viewer.
 */
export function onSphere(arc, theta, out = new Float64Array(3)) {
  const polar = arc / RADIUS, ring = Math.sin(polar) * RADIUS;
  out[0] = ring * Math.cos(theta); out[1] = -ring * Math.sin(theta); out[2] = Math.cos(polar) * RADIUS;
  return out;
}

// The sphere is built as a stack of rigid rings, one to a course, each free to
// turn about the axis through the poles. The edge between two rings is a true
// circle: a ring's stones and its mortar all lie inside it, clear of the next ring.
const boundary = course => CENTRE + course * PITCH;
// A stone keeps this far inside its own ring, and inside its own place round the ring.
const KEEP = .2;

/**
 * A stone cut by hand from a four-cornered blank: twelve points round its
 * outline. No corner is left sharp (the hammer takes a little off towards each
 * neighbour, and now and then a real chip), and no edge is straight (somewhere
 * along it the cut bows, more often in than out).
 */
function handCut(blank, id, low, high) {
  const outline = [];
  for (let c = 0; c < 4; c++) {
    const here = blank[c], before = blank[(c + 3) % 4], after = blank[(c + 1) % 4], chipped = noise(id * 9 + c + 5101) < .17;
    const back = (chipped ? .15 : .055) + noise(id * 9 + c + 5201) * (chipped ? .15 : .1);
    const on = (chipped ? .15 : .055) + noise(id * 9 + c + 5301) * (chipped ? .15 : .1);
    outline.push([here[0] + (before[0] - here[0]) * back, here[1] + (before[1] - here[1]) * back]);
    outline.push([here[0] + (after[0] - here[0]) * on, here[1] + (after[1] - here[1]) * on]);
    const along = .34 + noise(id * 9 + c + 5401) * .32, bow = (noise(id * 9 + c + 5501) - .64) * .1;
    const ex = after[0] - here[0], ey = after[1] - here[1];
    outline.push([here[0] + ex * along + ey * bow, here[1] + ey * along - ex * bow]);
  }
  // A stone must be able to turn over in its place and seat again: at every depth no wider one
  // side than the other, and nowhere outside its ring.
  const byDepth = [...blank].sort((a, b) => a[1] - b[1]);
  const inner = Math.min(Math.abs(byDepth[0][0]), Math.abs(byDepth[1][0])), outer = Math.min(Math.abs(byDepth[2][0]), Math.abs(byDepth[3][0]));
  const from = (byDepth[0][1] + byDepth[1][1]) / 2, to = (byDepth[2][1] + byDepth[3][1]) / 2;
  return outline.map(([u, v]) => {
    const reach = inner + (outer - inner) * clamp((v - from) / (to - from));
    return [Math.max(-reach, Math.min(reach, u)), Math.max(low, Math.min(high, v))];
  });
}

// Which real stone a palette colour is, judged by its hue.
function kindOf([r, g, b]) {
  const high = Math.max(r, g, b), low = Math.min(r, g, b);
  if (high - low < 30) return KIND.limestone;
  const hue = (high === r ? ((g - b) / (high - low) + 6) % 6 : high === g ? (b - r) / (high - low) + 2 : (r - g) / (high - low) + 4) * 60;
  if (hue >= 200 && hue < 290) return KIND.lapis;
  if (hue >= 70 && hue < 200) return KIND.greenstone;
  return hue >= 32 && hue < 70 ? KIND.marble : KIND.terracotta;
}

// A palette colour as the stone a mosaicist would reach for: a little greyer and
// chalkier than the pure colour, and never the same twice. `piece` picks this
// stone's own share of that variation.
function asStone(colour, piece) {
  const kind = kindOf(colour), grey = colour[0] * .3 + colour[1] * .59 + colour[2] * .11;
  const value = 1 + (hash(piece, 81) - .5) * .2, drift = hash(piece, 83) - .5;
  return [...colour.map((channel, index) => {
    const stone = channel + (grey - channel) * GREYER[kind];
    const chalked = stone + (CHALK[index] - stone) * CHALKIER[kind];
    // Lighter or darker by a tenth, and a shade warmer or cooler.
    return Math.max(0, Math.min(255, Math.round(chalked * value + drift * (index === 0 ? 12 : index === 2 ? -12 : 0))));
  }), kind];
}

/**
 * Every stone of the sphere, as flat arrays the renderer and the motion share.
 *
 * A stone is a rigid piece: `outline` holds the twelve points of its own
 * hand-cut outline in its own plane (east, south), counter-clockwise seen from
 * outside; `frame` turns that plane onto the sphere, with the slight tilt of a
 * stone set by hand; `normal` is where its centre sits and `seat` how far in or
 * out of true it was pressed. Nothing here changes after it is built.
 */
export function createSphereField() {
  const tiles = [], lost = [], sockets = [], places = new Uint16Array(COURSES);
  const point = new Float64Array(3);
  let slot = 0;

  function tile(course, polar, tilt, round) {
    const id = slot++;
    // The centre is the middle of the four corners, pushed back onto the sphere.
    const centre = [0, 0, 0], placed = polar.map(([arc, theta]) => [...onSphere(arc, theta, point)]);
    for (const p of placed) { centre[0] += p[0]; centre[1] += p[1]; centre[2] += p[2]; }
    const length = Math.hypot(...centre), normal = centre.map(value => value / length);
    const bearing = Math.hypot(normal[0], normal[1]) > 1e-9 ? Math.atan2(-normal[1], normal[0]) : 0;
    const dip = Math.acos(clamp(normal[2], -1, 1)), arc = dip * RADIUS;
    const south = [Math.cos(dip) * Math.cos(bearing), -Math.cos(dip) * Math.sin(bearing), -Math.sin(dip)];
    const east = [-Math.sin(bearing), -Math.cos(bearing), 0];
    const seed = noise(id + 1901), motif = faceMotif(arc, bearing);
    const pigments = stonePigments({ seed, r: arc / 150, motifStrength: motif });
    // Lost stones: wear comes in patches, and spares the lines that carry the drawing.
    const polarStone = course === 0 || course === COURSES - 1;
    const wear = .5 + .5 * Math.sin(normal[0] * 3.1 + normal[1] * 1.7 + 1.3) * Math.cos(normal[1] * 2.3 - normal[2] * 2.9 + .4);
    const gone = !polarStone && noise(id + 17003) < LOST * (.55 + .9 * wear) * (pigments.gilded ? LOST_GILDED : 1);
    const place = places[course]++;
    // Lay the blank flat in the tile's own plane, turn it in place as a hand would set it, then cut it.
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    let blank = placed.map(p => {
      const dx = p[0] - normal[0] * RADIUS, dy = p[1] - normal[1] * RADIUS, dz = p[2] - normal[2] * RADIUS;
      const u = dx * east[0] + dy * east[1] + dz * east[2], v = dx * south[0] + dy * south[1] + dz * south[2];
      return [u * cos - v * sin, u * sin + v * cos];
    });
    let area = 0;
    for (let i = 0; i < 4; i++) { const a = blank[i], b = blank[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area < 0) blank = blank.reverse();
    const outline = polarStone ? handCut(blank, id, -9, 9) : handCut(blank, id, boundary(course - 1) - arc + KEEP, boundary(course) - arc - KEEP);
    // Every place has its socket in the mortar, whether or not its stone is still there.
    // `round` is the stretch of its ring the place takes up: the mortar is cut along the same lines.
    sockets.push({ normal, south, outline, course, round, stone: gone ? -1 : tiles.length });
    if (gone) { lost.push(arc, bearing); return; }
    // No stone sits true: each leans a few degrees and stands a hair proud or shy, which is why they catch the light one by one.
    const lean = quatMul(quatAxis(1, 0, 0, (hash(seed, 61) - .5) * .13), quatAxis(0, 1, 0, (hash(seed, 63) - .5) * .13));
    const variant = hash(seed, 18), mineral = variant < .14 ? MINERALS.warm : variant > .84 ? MINERALS.pale : MINERALS.dark;
    tiles.push({
      course, place, socket: sockets.length - 1, arc, theta: bearing, seed, normal, south, outline, motif, gilded: pigments.gilded,
      frame: quatMul(quatFromFrame(east, south, normal), lean),
      seat: polarStone ? 0 : (hash(seed, 65) - .5) * .5,
      height: 1 + (hash(seed, 67) - .5) * .24,
      // How far the stone reaches along the meridian from its centre.
      span: (Math.max(...outline.map(c => c[1])) - Math.min(...outline.map(c => c[1]))) / 2,
      // And across it: the radius it sweeps when it turns over about its meridian.
      reach: Math.max(...outline.map(c => Math.abs(c[0]))),
      // Its own patch of rock: where in the grain it was cut, and which way round.
      rock: [hash(seed, 71), hash(seed, 73), hash(seed, 75) * TAU],
      mineral: asStone(mineral.map(channel => 255 + (channel - 255) * MINERAL_BODY), seed + 1),
      cool: asStone(pigments.cool, seed + 2), bright: asStone(pigments.bright, seed + 3), warm: asStone(pigments.warm, seed + 4),
    });
  }

  // The medallion's own centre stone, and its twin at the far pole.
  const centreStone = [[-1.8, -1.7], [1.75, -1.9], [1.9, 1.75], [-1.7, 1.9]].map(([x, y]) => [Math.hypot(x, y) * SCALE, Math.atan2(y, x)]);
  tile(0, centreStone, 0, [0, TAU]);
  for (let ring = 0; ring < RINGS; ring++) {
    const centreArc = CENTRE + (ring + .5) * PITCH;
    // The sphere narrows away from its widest ring, so a course holds fewer stones than it would lying flat.
    const girth = RADIUS * Math.sin(centreArc / RADIUS);
    const count = Math.max(7, Math.round(TAU * girth / STONE));
    const weights = Array.from({ length: count }, (_, index) => .88 + noise(ring * 401 + index + 53) * .24);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let theta = ring * 2.399963229728653 + noise(ring + 100) * .15;
    for (let index = 0; index < count; index++) {
      const width = weights[index] / total * TAU, inset = JOINT / 2 / girth;
      const left = theta + inset, right = theta + width - inset;
      const skew = (noise(ring * 409 + index + 103) - .5) * .12 * SCALE / girth;
      const turned = (noise(slot + 4301) * 2 - 1) * (1.5 + noise(slot + 1901) * 2) * Math.PI / 180;
      tile(ring + 1, [
        [boundary(ring) + JOINT / 2, left - skew],
        [boundary(ring) + JOINT / 2, right - skew],
        [boundary(ring + 1) - JOINT / 2, right + skew],
        [boundary(ring + 1) - JOINT / 2, left + skew],
      ], turned, [theta % TAU, theta % TAU + width]);
      theta += width;
    }
  }
  tile(RINGS + 1, centreStone.map(([arc, theta]) => [Math.PI * RADIUS - arc, theta]), 0, [0, TAU]);

  // The sheet a document arrives as: square stones cut by the same hand.
  const half = SHEET_STONE / 2, sheet = Array.from({ length: SHEET }, (_, index) => {
    const seed = noise(index + 90001);
    return {
      outline: handCut([[-half, -half], [half, -half], [half, half], [-half, half]], 70000 + index, -half, half),
      height: 1 + (hash(seed, 67) - .5) * .2, rock: [hash(seed, 71), hash(seed, 73), hash(seed, 75) * TAU],
    };
  });

  const count = tiles.length;
  const field = {
    count, radius: RADIUS, courses: COURSES,
    // Where the lost stones were: distance from the front pole and bearing, in pairs. Only their sockets are there now.
    lost: new Float32Array(lost),
    // How many places each ring has round it: one step of that ring is one place.
    places,
    // Where each ring begins and ends, as distance from the front pole: COURSES + 1 edges.
    courseEdge: Float32Array.from({ length: COURSES + 1 }, (_, edge) => edge === 0 ? 0 : edge === COURSES ? Math.PI * RADIUS : boundary(edge - 1)),
    // Every place's socket, taken or empty: where it is, which way is south there, and the outline pressed into the mortar;
    // which ring it is on, the stretch of that ring it takes up (from, to), and which stone sits in it (-1 if it is lost).
    sockets: {
      count: sockets.length, normal: Float32Array.from(sockets.flatMap(socket => socket.normal)), south: Float32Array.from(sockets.flatMap(socket => socket.south)), outline: Float32Array.from(sockets.flatMap(socket => socket.outline.flat())),
      course: Uint8Array.from(sockets, socket => socket.course), round: Float32Array.from(sockets.flatMap(socket => socket.round)), stone: Int16Array.from(sockets, socket => socket.stone),
    },
    // The stones of a document's sheet: their outlines, thicknesses and pieces of rock, like any other stone's.
    sheet: { count: SHEET, outline: Float32Array.from(sheet.flatMap(stone => stone.outline.flat())), height: Float32Array.from(sheet, stone => stone.height), rock: Float32Array.from(sheet.flatMap(stone => stone.rock)) },
    // How far along the surface each course lies from the pole facing the viewer.
    courseArc: Float32Array.from({ length: COURSES }, (_, course) => course === 0 ? 0 : course === COURSES - 1 ? Math.PI * RADIUS : CENTRE + (course - .5) * PITCH),
    // Which ring each stone is in, which place round that ring is its own, and which socket that is.
    course: new Uint8Array(count), place: new Uint16Array(count), socket: Uint16Array.from(tiles, stone => stone.socket), arc: new Float32Array(count), theta: new Float32Array(count),
    seed: new Float64Array(count), motif: new Float32Array(count), gilded: new Uint8Array(count),
    span: new Float32Array(count), reach: new Float32Array(count), height: new Float32Array(count), seat: new Float32Array(count), rock: new Float32Array(count * 3),
    normal: new Float32Array(count * 3), south: new Float32Array(count * 3), frame: new Float32Array(count * 4),
    outline: new Float32Array(count * 24),
    // Each stone's four materials: red, green, blue and which kind of stone it is.
    mineral: new Uint8Array(count * 4), cool: new Uint8Array(count * 4), bright: new Uint8Array(count * 4), warm: new Uint8Array(count * 4),
  };
  tiles.forEach((stone, index) => {
    field.course[index] = stone.course; field.place[index] = stone.place; field.arc[index] = stone.arc; field.theta[index] = stone.theta;
    field.seed[index] = stone.seed; field.motif[index] = stone.motif; field.gilded[index] = Number(stone.gilded);
    field.span[index] = stone.span; field.reach[index] = stone.reach; field.height[index] = stone.height; field.seat[index] = stone.seat; field.rock.set(stone.rock, index * 3);
    field.normal.set(stone.normal, index * 3); field.south.set(stone.south, index * 3); field.frame.set(stone.frame, index * 4);
    stone.outline.forEach((corner, at) => field.outline.set(corner, index * 24 + at * 2));
    for (const material of ['mineral', 'cool', 'bright', 'warm']) field[material].set(stone[material], index * 4);
  });
  return field;
}
