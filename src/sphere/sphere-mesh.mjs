// One tessera: a hand-cut stone, twelve-sided, with a face on each side and a
// rounded shoulder falling from each face to the stone's widest outline. Every
// stone on the sphere is this same piece drawn from its own twelve points, so
// the shape below is the only shape there is. The mortar is a shell of rigid
// cells, one to a place, which together make a hollow sphere.

export const SIDES = 12;
export const PROFILE = {
  top: 1.6,    // from the middle of the stone up to its face, in pixels, before the stone's own thickness is applied
  face: .85,   // the face is the outline drawn in by this much; the shoulder is the rest
  rim: .42,    // how far the edge of the face has worn round (radians of slope)
};
// The mortar stands this far below a stone's face: the stones stand clearly proud of it.
export const RECESS = 1.3;
// Height of the mortar above the middle of a stone of ordinary thickness.
export const MORTAR = PROFILE.top - RECESS;

// Rings of the stone from the top down: centre of the face, edge of the face,
// widest outline, edge of the underside, centre of the underside.
export const RING = { centre: 0, face: 1, waist: 2, under: 3, base: 4 };
const HEIGHT = [1, 1, 0, -1, -1];
const DRAWN_IN = [0, PROFILE.face, 1, PROFILE.face, 0];

/**
 * The template: 38 vertices, each [which point of the outline, which ring], and
 * the triangles between them: a fan for each face and two rings of shoulder.
 */
export function createTileTemplate() {
  const vertices = [0, RING.centre], indices = [];
  for (const ring of [RING.face, RING.waist, RING.under]) for (let side = 0; side < SIDES; side++) vertices.push(side, ring);
  vertices.push(0, RING.base);
  const face = side => 1 + side % SIDES, waist = side => 1 + SIDES + side % SIDES, under = side => 1 + 2 * SIDES + side % SIDES, base = 1 + 3 * SIDES;
  for (let side = 0; side < SIDES; side++) {
    indices.push(0, face(side), face(side + 1));
    indices.push(waist(side), waist(side + 1), face(side + 1), waist(side), face(side + 1), face(side));
    indices.push(under(side), under(side + 1), waist(side + 1), under(side), waist(side + 1), waist(side));
    indices.push(base, under(side + 1), under(side));
  }
  return { vertices: new Float32Array(vertices), indices: new Uint8Array(indices), vertexCount: vertices.length / 2, indexCount: indices.length };
}

/**
 * A point of one stone in the stone's own space, before it is turned or placed:
 * exactly what the vertex shader computes as `local`. `outline` holds the
 * stone's twelve outline points (x, y pairs) and `thickness` its own thickness.
 */
export function tilePoint(outline, thickness, side, ring, out = new Float64Array(3)) {
  out[0] = outline[side * 2] * DRAWN_IN[ring];
  out[1] = outline[side * 2 + 1] * DRAWN_IN[ring];
  out[2] = HEIGHT[ring] * PROFILE.top * thickness;
  return out;
}

// The mortar is a shell this thick under its surface, cut into cells: one to a
// place, each a curved slab with a top, an underside and four cut sides. A ring is
// the cells of one course, and turns as one. A cell can also be carried off as a
// rigid piece, with the stone set in it, when the shell cracks open.
export const SHELL = 4.6;
export const CELL_SEGMENTS = 4;
// Which way a face of a cell looks: out, in, towards the pole facing the viewer, away from it, and back and on round its ring.
export const CELL_FACE = { top: 0, under: 1, north: 2, south: 3, west: 4, east: 5 };

/**
 * The one piece every cell is drawn from. A corner is [how far round its
 * stretch of the ring (0 to 1), how far across the ring (0 to 1), how deep (0 at
 * the surface, 1 at the underside), which face it belongs to].
 */
export function createCellTemplate(segments = CELL_SEGMENTS) {
  const corners = [], indices = [];
  const corner = (round, across, deep, face) => corners.push(round, across, deep, face) / 4 - 1;
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d);
  for (let step = 0; step < segments; step++) {
    const from = step / segments, to = (step + 1) / segments;
    // Seen from outside, round a face: on round the ring, then across it.
    quad(corner(from, 0, 0, CELL_FACE.top), corner(to, 0, 0, CELL_FACE.top), corner(to, 1, 0, CELL_FACE.top), corner(from, 1, 0, CELL_FACE.top));
    quad(corner(from, 0, 1, CELL_FACE.under), corner(from, 1, 1, CELL_FACE.under), corner(to, 1, 1, CELL_FACE.under), corner(to, 0, 1, CELL_FACE.under));
    quad(corner(from, 0, 0, CELL_FACE.north), corner(from, 0, 1, CELL_FACE.north), corner(to, 0, 1, CELL_FACE.north), corner(to, 0, 0, CELL_FACE.north));
    quad(corner(from, 1, 0, CELL_FACE.south), corner(to, 1, 0, CELL_FACE.south), corner(to, 1, 1, CELL_FACE.south), corner(from, 1, 1, CELL_FACE.south));
  }
  quad(corner(0, 0, 0, CELL_FACE.west), corner(0, 1, 0, CELL_FACE.west), corner(0, 1, 1, CELL_FACE.west), corner(0, 0, 1, CELL_FACE.west));
  quad(corner(1, 0, 0, CELL_FACE.east), corner(1, 0, 1, CELL_FACE.east), corner(1, 1, 1, CELL_FACE.east), corner(1, 1, 0, CELL_FACE.east));
  return { corners: new Float32Array(corners), indices: new Uint8Array(indices), cornerCount: corners.length / 4, indexCount: indices.length };
}

/**
 * A corner of one cell on the sphere of radius 1, before its ring turns or
 * anything carries it: exactly what the mortar's vertex shader computes.
 * `span` is the cell's [polar from, polar to, round from, round to]. Returns
 * the point (scaled to its depth by `radius` and `shell`) and the way its face looks.
 */
export function cellPoint(span, corner, radius, shell = SHELL) {
  const polar = span[0] + (span[1] - span[0]) * corner[1], round = span[2] + (span[3] - span[2]) * corner[0];
  const out = [Math.sin(polar) * Math.cos(round), -Math.sin(polar) * Math.sin(round), Math.cos(polar)];
  const east = [-Math.sin(round), -Math.cos(round), 0], south = [Math.cos(polar) * Math.cos(round), -Math.cos(polar) * Math.sin(round), -Math.sin(polar)];
  const face = [out, out.map(part => -part), south.map(part => -part), south, east.map(part => -part), east][corner[3]];
  const reach = radius - shell * corner[2];
  return { point: out.map(part => part * reach), face };
}

/**
 * The cells the mortar is cut into: one to every socket, and the cap round each
 * pole cut again along its neighbouring ring's places, so that its edge meets
 * theirs. `edges` are the polar angles where the rings begin and end. Each
 * cell is [polar from, polar to, round from, round to]; `socket` says which
 * socket each belongs to, and `ring` which ring turns it.
 */
export function createCells(field, edges) {
  const spans = [], socket = [], ring = [], { sockets, courses } = field;
  const neighbours = course => { const found = []; for (let index = 0; index < sockets.count; index++) if (sockets.course[index] === course) found.push(index); return found; };
  for (let index = 0; index < sockets.count; index++) {
    const course = sockets.course[index];
    const cuts = course === 0 ? neighbours(1) : course === courses - 1 ? neighbours(courses - 2) : [index];
    for (const cut of cuts) {
      spans.push(edges[course], edges[course + 1], sockets.round[cut * 2], sockets.round[cut * 2 + 1]);
      socket.push(index); ring.push(course);
    }
  }
  return { count: socket.length, spans: new Float32Array(spans), socket: new Uint16Array(socket), ring: new Float32Array(ring) };
}
