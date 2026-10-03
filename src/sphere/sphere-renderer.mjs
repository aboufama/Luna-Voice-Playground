import { RADIUS, COURSES } from './sphere-field.mjs';
import { PROFILE, MORTAR, SIDES, createTileTemplate, createBedMesh } from './sphere-mesh.mjs';
import { ROCK_SIZE, ROCK_DENSITY, createRock, createRelief } from './sphere-rock.mjs';
import { MORTAR_WIDTH, MORTAR_HEIGHT, createMortarMap } from './sphere-mortar.mjs';
import { STRIDE, TURN, PLACE, FACES } from './sphere-motion.mjs';

const number = value => value.toFixed(4);
// The mortar's surface: a little above the middle of the stones, well below their faces.
export const BED_RADIUS = RADIUS + MORTAR;
// The light's own view of the sphere, for its depth pass: this many pixels across, at this many texels.
const LIGHT_REACH = RADIUS + 14;
export const SHADOW_SIZE = 1024;

// Where a point lands: through the one fixed lens, or, in the light's depth pass, straight along the light.
const SHARED = `
uniform mat3 uSway;
uniform vec4 uLens;
uniform vec2 uNudge;
uniform mat3 uLight;
uniform float uPass;
vec4 project(vec3 seen) {
  if (uPass > 0.5) { vec3 from = uLight * seen; return vec4(from.xy, -from.z, 1.0); }
  float depth = uLens.y - seen.z;
  return vec4(seen.xy * uLens.x + uNudge * depth, uLens.w - uLens.z * depth, depth);
}`;
// One light for stones and mortar alike, from above and to the left of the viewer: soft sky, a
// directional key, and the key cut off wherever something stands between the surface and the light.
const LIGHT = `
uniform vec3 uKey;
uniform mat3 uLight;
uniform float uPass;
uniform highp sampler2DShadow uShadow;
float sunlit(vec3 seen, vec3 surface) {
  vec3 from = uLight * (seen + surface * 0.7);
  return texture(uShadow, vec3(from.xy * 0.5 + 0.5, 0.5 - from.z * 0.5 - 0.0022));
}
vec3 lit(vec3 colour, vec3 normal, float shade, float sun) {
  float key = max(dot(normal, uKey), 0.0) * sun;
  vec3 sky = mix(vec3(0.21, 0.21, 0.24), vec3(0.42, 0.43, 0.46), normal.y * 0.5 + 0.5) * shade;
  return pow(pow(colour, vec3(2.2)) * (sky + vec3(0.94, 0.90, 0.82) * key), vec3(1.0 / 2.2));
}`;

// Every stone is the same hand-cut piece (sphere-mesh.mjs) built from its own
// twelve outline points. The only things that change from frame to frame are
// aTurn, aPlace and aFaces: a unit quaternion, a position, and which stone is
// on each of its two sides.
export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aVertex;
layout(location = 1) in vec4 aOutlineA;
layout(location = 2) in vec4 aOutlineB;
layout(location = 3) in vec4 aOutlineC;
layout(location = 4) in vec4 aOutlineD;
layout(location = 5) in vec4 aOutlineE;
layout(location = 6) in vec4 aOutlineF;
layout(location = 7) in float aThickness;
layout(location = 8) in vec4 aMineral;
layout(location = 9) in vec4 aCool;
layout(location = 10) in vec4 aBright;
layout(location = 11) in vec4 aWarm;
layout(location = 12) in vec4 aTurn;
layout(location = 13) in vec4 aPlace;
layout(location = 14) in vec4 aFaces;
layout(location = 15) in vec4 aRock;
${SHARED}
centroid out vec3 vNormal;
centroid out vec2 vRock;
centroid out vec3 vWear;
centroid out vec2 vAcross;
out vec3 vSeen;
flat out vec3 vFace;
flat out vec3 vEast;
flat out vec3 vSouth;
flat out vec4 vUpper;
flat out vec4 vLower;
flat out vec4 vCut;
flat out float vClear;

vec2 outline(int side) {
  vec4 pair = side < 2 ? aOutlineA : side < 4 ? aOutlineB : side < 6 ? aOutlineC : side < 8 ? aOutlineD : side < 10 ? aOutlineE : aOutlineF;
  return (side & 1) == 0 ? pair.xy : pair.zw;
}
vec3 turn(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec4 side(float which) { return which < 0.5 ? aMineral : which < 1.5 ? aCool : which < 2.5 ? aBright : aWarm; }

void main() {
  int at = int(aVertex.x), ring = int(aVertex.y);
  vec2 here = outline(at), before = outline((at + ${SIDES - 1}) % ${SIDES}), after = outline((at + 1) % ${SIDES});
  float up = ring < 2 ? 1.0 : ring == 2 ? 0.0 : -1.0;
  float drawn = ring == 2 ? 1.0 : ring == 1 || ring == 3 ? ${number(PROFILE.face)} : 0.0;
  // This stone's own fixed shape.
  vec3 local = vec3(here * drawn, up * ${number(PROFILE.top)} * aThickness);

  // Faces look straight out, a little rounded at their worn edge; the shoulder turns from there to the side.
  vec2 outward = normalize(vec2(after.y - before.y, before.x - after.x));
  vec3 normal = ring == 0 || ring == 4 ? vec3(0.0, 0.0, up) : ring == 2 ? vec3(outward, 0.0) : vec3(outward * ${number(Math.sin(PROFILE.rim))}, up * ${number(Math.cos(PROFILE.rim))});

  // Rigid: turn the stone, carry it to its place, then turn the whole sphere.
  vec3 placed = turn(aTurn, local) + aPlace.xyz;
  vec3 seen = uSway * placed;
  vSeen = seen;
  vNormal = uSway * turn(aTurn, normal);
  vFace = uSway * turn(aTurn, vec3(0.0, 0.0, 1.0));
  vEast = uSway * turn(aTurn, vec3(1.0, 0.0, 0.0));
  vSouth = uSway * turn(aTurn, vec3(0.0, 1.0, 0.0));
  gl_Position = project(seen);

  // The stone's own piece of rock: its own coordinates, at its own place and turn in the grain.
  vec2 across = local.xy + local.z * vec2(0.55, 0.35);
  vAcross = local.xy;
  vRock = (vec2(across.x * aRock.z - across.y * aRock.w, across.x * aRock.w + across.y * aRock.z)) * ${number(ROCK_DENSITY / ROCK_SIZE)} + aRock.xy;
  // Where on the stone this is: from the middle of a face (0) to its edge (1) and down the shoulder (2);
  // which side of the stone (0 upper, 1 lower); and how far down towards the mortar line.
  vWear = vec3(ring == 0 || ring == 4 ? 0.0 : ring == 2 ? 2.0 : 1.0, ring < 2 ? 0.0 : ring == 2 ? 0.5 : 1.0, ring == 2 ? 1.0 : 0.0);
  // Which stone is on each side: one of this block's four, chosen whole.
  vUpper = side(aFaces.x); vLower = side(aFaces.y);
  vCut = aRock;
  vClear = aPlace.w;
}`;

// A stone is its rock, in colour and in relief: a hand-split face that is domed,
// dished or ridged; grain, pits and veins that catch the light; a worn edge;
// matt; and in the shade of whatever stands between it and the light.
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
centroid in vec3 vNormal;
centroid in vec2 vRock;
centroid in vec3 vWear;
centroid in vec2 vAcross;
in vec3 vSeen;
flat in vec3 vFace;
flat in vec3 vEast;
flat in vec3 vSouth;
flat in vec4 vUpper;
flat in vec4 vLower;
flat in vec4 vCut;
flat in float vClear;
uniform sampler2D uRock;
uniform sampler2D uRelief;
${LIGHT}
out vec4 colour;

// What each kind of stone is made of. The kinds, in order: limestone or basalt, lapis, marble, green stone, terracotta.
// How far its clouds lighten and darken it, and how coarse its grain is;
const float CLOUDED[5] = float[5](0.24, 0.42, 0.20, 0.50, 0.14);
const float GRAINED[5] = float[5](0.30, 0.26, 0.18, 0.24, 0.34);
// how rough its split surface is;
const float ROUGH[5] = float[5](1.25, 0.95, 0.75, 0.95, 1.45);
// what its paler patches are (calcite in lapis, cream in marble) and how much of them there is;
const vec4 PATCH[5] = vec4[5](vec4(0.74, 0.72, 0.68, 0.22), vec4(0.70, 0.74, 0.80, 0.36), vec4(0.93, 0.87, 0.72, 0.30), vec4(0.74, 0.84, 0.76, 0.30), vec4(0.86, 0.66, 0.50, 0.20));
// its veins;
const vec4 VEIN[5] = vec4[5](vec4(0.82, 0.80, 0.76, 0.34), vec4(0.86, 0.88, 0.90, 0.50), vec4(0.60, 0.36, 0.22, 0.40), vec4(0.84, 0.90, 0.86, 0.36), vec4(0.90, 0.80, 0.66, 0.12));
// and its flecks: pits in limestone, pyrite in lapis, dark crystals in green stone, pale grit in terracotta.
const vec4 FLECK[5] = vec4[5](vec4(0.26, 0.25, 0.23, 0.24), vec4(0.76, 0.64, 0.36, 0.62), vec4(0.66, 0.42, 0.24, 0.26), vec4(0.12, 0.26, 0.24, 0.40), vec4(0.92, 0.86, 0.74, 0.50));

void main() {
  if (uPass > 0.5) { colour = vec4(0.0); return; }
  // Whichever side of the block this is, it is one whole stone: nothing is mixed.
  bool upper = vWear.y < 0.5;
  vec4 material = upper ? vUpper : vLower;
  int kind = int(material.a * 255.0 + 0.5);
  vec4 rock = texture(uRock, vRock), relief = texture(uRelief, vRock);
  vec3 body = material.rgb * (1.0 + (rock.r - 0.5) * CLOUDED[kind] + (rock.g - 0.5) * GRAINED[kind]);
  body = mix(body, PATCH[kind].rgb, smoothstep(0.58, 0.9, rock.r) * PATCH[kind].a);
  body = mix(body, VEIN[kind].rgb, smoothstep(0.25, 0.9, rock.b) * VEIN[kind].a);
  body = mix(body, FLECK[kind].rgb, smoothstep(0.4, 0.8, rock.a) * FLECK[kind].a);
  // Wear: the edge of a face is rubbed paler and chalkier than its middle.
  body = mix(body, body * 1.06 + 0.04, smoothstep(0.82, 1.25, vWear.x) * 0.5);

  // The split face. It is domed or dished, and often two facets meet along a ridge;
  vec2 shape = vAcross * (vCut.x - 0.36) * 0.085;
  float ridge = dot(vAcross, vCut.zw) - (vCut.y - 0.5) * 3.4;
  shape += vCut.zw * (fract(vCut.x * 7.31 + vCut.y * 3.17) - 0.42) * 0.36 * clamp(ridge * 2.2, -1.0, 1.0);
  // and its grain, pits and veins stand in relief: the slope of the rock, turned back from the rock's axes to the stone's.
  vec2 slope = (relief.xy - 0.5) * 2.0 * ROUGH[kind];
  shape += vec2(slope.x * vCut.z + slope.y * vCut.w, slope.y * vCut.z - slope.x * vCut.w);
  vec3 face = normalize((upper ? vFace : -vFace) + vEast * shape.x + vSouth * shape.y);
  // Only towards its worn edge does a face round over into the shoulder.
  vec3 normal = normalize(mix(face, normalize(vNormal), smoothstep(0.6, 1.05, vWear.x)));

  // Shade gathers in pits, and down the shoulder towards the mortar unless the stone stands clear of it.
  float shade = (0.72 + 0.56 * relief.a) * (1.0 - 0.5 * pow(clamp(vWear.z, 0.0, 1.0), 1.3) * (1.0 - 0.8 * vClear));
  colour = vec4(lit(body, normal, shade, sunlit(vSeen, normalize(vNormal))), 1.0);
}`;

// The mortar is a stack of rings, one to a course, each turning only with its own
// course and with the sphere. Its relief is its own: the sockets, squeezed joints
// and parting lines made from the layout, and sand read in the mortar's own coordinates.
export const BED_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPoint;
uniform float uDial[${COURSES}];
${SHARED}
out vec3 vPoint;
out vec3 vSeen;
flat out vec2 vDial;
void main() {
  // The ring's own turn about the axis through the poles, then the sphere's.
  float dial = uDial[int(aPoint.w)];
  vDial = vec2(cos(dial), sin(dial));
  vec3 turned = vec3(aPoint.x * vDial.x - aPoint.y * vDial.y, aPoint.x * vDial.y + aPoint.y * vDial.x, aPoint.z);
  vPoint = aPoint.xyz;
  vSeen = uSway * (turned * ${number(BED_RADIUS)});
  gl_Position = project(vSeen);
}`;
export const BED_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vPoint;
in vec3 vSeen;
flat in vec2 vDial;
uniform mat3 uSway;
uniform sampler2D uRock;
uniform sampler2D uRelief;
uniform sampler2D uMortar;
${LIGHT}
out vec4 colour;
void main() {
  if (uPass > 0.5) { colour = vec4(0.0); return; }
  vec3 point = normalize(vPoint);
  float girth = max(length(point.xy), 0.0001), bearing = atan(-point.y, point.x);
  // The layout's relief: where on this ring's own band of mortar this is.
  vec4 laid = texture(uMortar, vec2(bearing / 6.2831853 + (bearing < 0.0 ? 1.0 : 0.0), acos(clamp(point.z, -1.0, 1.0)) / 3.14159265));
  // Sand: read on three sides and averaged, so the grain never stretches.
  vec3 weight = pow(abs(point), vec3(4.0));
  vec3 at = point * ${number(BED_RADIUS * ROCK_DENSITY / ROCK_SIZE)};
  vec4 rock = (texture(uRock, at.yz) * weight.x + texture(uRock, at.zx) * weight.y + texture(uRock, at.xy) * weight.z) / (weight.x + weight.y + weight.z);
  vec4 sand = (texture(uRelief, at.yz) * weight.x + texture(uRelief, at.zx) * weight.y + texture(uRelief, at.xy) * weight.z) / (weight.x + weight.y + weight.z);
  // The map is pinched to a point at each pole, so its slopes count for nothing there.
  float mapped = smoothstep(0.012, 0.05, girth);
  float sunk = clamp((0.6 - laid.b) * 3.6, 0.0, 1.0) * mapped;
  vec3 mortar = vec3(0.80, 0.77, 0.70) * (0.86 + 0.28 * laid.a) * (1.0 + (rock.r - 0.5) * 0.18 + (rock.g - 0.5) * 0.34);
  mortar = mix(mortar, vec3(0.40, 0.38, 0.35), smoothstep(0.45, 0.85, rock.a) * 0.45);
  // The floor of a socket is the darker, finer mortar the stone was bedded in.
  mortar = mix(mortar, mortar * vec3(0.90, 0.88, 0.85), sunk);
  // Its surface slopes as the layout's relief and the sand say, in the ring's own directions: east and south.
  vec3 east = vec3(point.y, -point.x, 0.0) / girth, south = vec3(point.z * point.x / girth, point.z * point.y / girth, -girth);
  vec2 slope = (laid.xy - 0.5) * 2.55 * mapped + (sand.xy - 0.5) * 1.5 * (1.0 - 0.6 * sunk);
  vec3 ringNormal = normalize(point + east * slope.x + south * slope.y);
  vec3 normal = uSway * vec3(ringNormal.x * vDial.x - ringNormal.y * vDial.y, ringNormal.x * vDial.y + ringNormal.y * vDial.x, ringNormal.z);
  vec3 surface = uSway * vec3(point.x * vDial.x - point.y * vDial.y, point.x * vDial.y + point.y * vDial.x, point.z);
  // Shade gathers in the joints and the sockets.
  float shade = mix(1.0, mix(0.66, 1.06, smoothstep(0.3, 0.8, laid.b)), mapped) * (0.8 + 0.4 * sand.a);
  colour = vec4(lit(mortar, normal, shade, sunlit(vSeen, surface)), 1.0);
}`;

// The one light: above and to the left of the viewer, as in the flat medallion's stone atlas.
const KEY_LIGHT = [-.5, .58, .64];

/**
 * Draws the sphere into `canvas`. Each frame has two passes over the same two
 * real objects, the mortar rings and the stones: first the light's own depth
 * view of them, into a depth map, then the picture, in which that map says
 * what the light reaches. Nothing is drawn after the picture. Throws if WebGL2
 * is unavailable, so the caller can fall back to the flat medallion.
 */
export function createSphereRenderer(canvas, field) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL2 is unavailable');
  const template = createTileTemplate(), bed = createBedMesh(Array.from(field.courseEdge, edge => edge / RADIUS));
  const buffers = [], programs = [], arrays = [], textures = [];
  const length = Math.hypot(...KEY_LIGHT), key = KEY_LIGHT.map(part => part / length);
  // The light's own axes: across, up and towards it, each scaled so the sphere fills its view.
  const across = [key[2], 0, -key[0]].map(part => part / Math.hypot(key[2], key[0]));
  const upward = [key[1] * across[2] - key[2] * across[1], key[2] * across[0] - key[0] * across[2], key[0] * across[1] - key[1] * across[0]];
  const lightView = new Float32Array([across[0], upward[0], key[0], across[1], upward[1], key[1], across[2], upward[2], key[2]].map(part => part / LIGHT_REACH));

  function program(vertex, fragment) {
    const made = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'A shader did not compile');
      gl.attachShader(made, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(made);
    if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made) || 'A shader did not link');
    gl.useProgram(made);
    const at = name => gl.getUniformLocation(made, name);
    gl.uniform3f(at('uKey'), key[0], key[1], key[2]);
    gl.uniformMatrix3fv(at('uLight'), false, lightView);
    ['uRock', 'uRelief', 'uMortar', 'uShadow'].forEach((name, unit) => gl.uniform1i(at(name), unit));
    programs.push(made);
    return { made, sway: at('uSway'), lens: at('uLens'), nudge: at('uNudge'), pass: at('uPass'), dial: at('uDial') };
  }
  function array() { const made = gl.createVertexArray(); gl.bindVertexArray(made); arrays.push(made); return made; }
  function buffer(target, data, usage) {
    const made = gl.createBuffer();
    gl.bindBuffer(target, made); gl.bufferData(target, data, usage);
    buffers.push(made);
    return made;
  }
  function attribute(location, size, type, normalized, stride, offset, perTile) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
    gl.vertexAttribDivisor(location, perTile ? 1 : 0);
  }
  // A map made from numbers at start-up: no picture goes into any of them.
  function map(unit, width, height, data, repeats) {
    const made = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, made);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (repeats) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
    textures.push(made);
    return made;
  }
  // The rock's colours, the rock's relief, and the mortar's relief as the layout presses it.
  const rock = createRock(ROCK_SIZE);
  map(0, ROCK_SIZE, ROCK_SIZE, rock, true);
  map(1, ROCK_SIZE, ROCK_SIZE, createRelief(rock, ROCK_SIZE), true);
  map(2, MORTAR_WIDTH, MORTAR_HEIGHT, createMortarMap(field, MORTAR_WIDTH, MORTAR_HEIGHT), false);

  // The light's depth map: what the light can see of the stones and the mortar. Depth only; nothing is ever drawn from it.
  const shadow = gl.createTexture();
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, shadow);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  textures.push(shadow);
  const lightDepth = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, lightDepth);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadow, 0);
  gl.drawBuffers([gl.NONE]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // The mortar rings. Written once, never touched again.
  const mortar = program(BED_VERTEX_SHADER, BED_FRAGMENT_SHADER), bedArray = array();
  buffer(gl.ARRAY_BUFFER, bed.points, gl.STATIC_DRAW);
  attribute(0, 4, gl.FLOAT, false, 0, 0, false);
  buffer(gl.ELEMENT_ARRAY_BUFFER, bed.indices, gl.STATIC_DRAW);

  // The one piece every stone is drawn from.
  const stones = program(VERTEX_SHADER, FRAGMENT_SHADER), stoneArray = array();
  buffer(gl.ARRAY_BUFFER, template.vertices, gl.STATIC_DRAW);
  attribute(0, 2, gl.FLOAT, false, 0, 0, false);
  buffer(gl.ELEMENT_ARRAY_BUFFER, template.indices, gl.STATIC_DRAW);

  // Each stone's cut, thickness and piece of rock: written once, never touched again.
  const CUT = SIDES * 2 + 5, cuts = new Float32Array(field.count * CUT);
  for (let index = 0; index < field.count; index++) {
    const at = index * CUT, turned = field.rock[index * 3 + 2];
    cuts.set(field.outline.subarray(index * SIDES * 2, (index + 1) * SIDES * 2), at);
    cuts[at + SIDES * 2] = field.height[index];
    cuts.set([field.rock[index * 3], field.rock[index * 3 + 1], Math.cos(turned), Math.sin(turned)], at + SIDES * 2 + 1);
  }
  buffer(gl.ARRAY_BUFFER, cuts, gl.STATIC_DRAW);
  for (let pair = 0; pair < SIDES / 2; pair++) attribute(1 + pair, 4, gl.FLOAT, false, CUT * 4, pair * 16, true);
  attribute(7, 1, gl.FLOAT, false, CUT * 4, SIDES * 8, true);
  attribute(15, 4, gl.FLOAT, false, CUT * 4, SIDES * 8 + 4, true);

  // The four stones a block can show, each a colour and a kind of stone, likewise fixed.
  const pigments = new Uint8Array(field.count * 16);
  for (let index = 0; index < field.count; index++) {
    [field.mineral, field.cool, field.bright, field.warm].forEach((material, layer) => pigments.set(material.subarray(index * 4, index * 4 + 4), index * 16 + layer * 4));
  }
  buffer(gl.ARRAY_BUFFER, pigments, gl.STATIC_DRAW);
  for (let layer = 0; layer < 4; layer++) attribute(8 + layer, 4, gl.UNSIGNED_BYTE, true, 16, layer * 4, true);

  // Where every stone is this frame: the only buffer written again.
  const motion = buffer(gl.ARRAY_BUFFER, field.count * STRIDE * 4, gl.DYNAMIC_DRAW);
  attribute(12, 4, gl.FLOAT, false, STRIDE * 4, TURN * 4, true);
  attribute(13, 4, gl.FLOAT, false, STRIDE * 4, PLACE * 4, true);
  attribute(14, 4, gl.FLOAT, false, STRIDE * 4, FACES * 4, true);

  // Solid things, the nearest in front. Depth and facing are the only tests there are.
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  let pixels = canvas.width;

  // The two real objects, as seen through the lens or along the light.
  function scene(pass, turned, dial, lens, nudgeX, nudgeY) {
    for (const [target, vertices] of [[mortar, bedArray], [stones, stoneArray]]) {
      gl.useProgram(target.made);
      gl.uniform1f(target.pass, pass);
      gl.uniformMatrix3fv(target.sway, false, turned);
      gl.uniform4f(target.lens, lens.zoom, lens.distance, lens.depthScale, lens.depthOffset);
      gl.uniform2f(target.nudge, nudgeX, nudgeY);
      gl.bindVertexArray(vertices);
      if (target === mortar) { gl.uniform1fv(target.dial, dial); gl.drawElements(gl.TRIANGLES, bed.indices.length, gl.UNSIGNED_SHORT, 0); }
      else gl.drawElementsInstanced(gl.TRIANGLES, template.indexCount, gl.UNSIGNED_BYTE, 0, field.count);
    }
  }
  return {
    lost: () => gl.isContextLost(),
    resize(size) {
      if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
      pixels = size;
    },
    // `tiles`, `turned` and `dial` come straight from the motion; `lens` and the nudge place the fixed camera.
    draw(tiles, turned, dial, lens, nudgeX = 0, nudgeY = 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, motion);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, tiles);
      // First what the light sees: depth only, into its own map, which must not be read while it is written.
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, lightDepth);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      scene(1, turned, dial, lens, nudgeX, nudgeY);
      // Then the picture, straight to the page. Nothing is drawn after it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, shadow);
      gl.viewport(0, 0, pixels, pixels);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      scene(0, turned, dial, lens, nudgeX, nudgeY);
    },
    dispose() {
      for (const made of buffers) gl.deleteBuffer(made);
      for (const made of arrays) gl.deleteVertexArray(made);
      for (const made of programs) gl.deleteProgram(made);
      for (const made of textures) gl.deleteTexture(made);
      gl.deleteFramebuffer(lightDepth);
    },
  };
}
