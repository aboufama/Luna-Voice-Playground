// One tessera: a hand-cut stone, twelve-sided, with a face on each side and a
// rounded shoulder falling from each face to the stone's widest outline. Every
// stone on the sphere is this same piece drawn from its own twelve points, so
// the shape below is the only shape there is. The mortar is a stack of rigid
// rings, one to a course, which together make a sphere.

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

/**
 * The mortar: one band of the unit sphere for every ring, each with its own
 * points so that a ring can turn without its neighbours. `edges` are the
 * polar angles where the rings begin and end, from the pole facing the viewer
 * to the far one. A point is [x, y, z, which ring].
 */
export function createBedMesh(edges, segments = 120) {
  const points = [], indices = [];
  for (let ring = 0; ring + 1 < edges.length; ring++) {
    const first = points.length / 4;
    for (const polar of [edges[ring], edges[ring + 1]]) for (let segment = 0; segment <= segments; segment++) {
      const around = segment / segments * Math.PI * 2;
      points.push(Math.sin(polar) * Math.cos(around), Math.sin(polar) * Math.sin(around), Math.cos(polar), ring);
    }
    for (let segment = 0; segment < segments; segment++) {
      const a = first + segment, b = a + segments + 1;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return { points: new Float32Array(points), indices: new Uint16Array(indices) };
}
