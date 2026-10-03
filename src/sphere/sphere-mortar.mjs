// The mortar the stones are set in, as a relief map made at start-up from the
// layout itself: every place has a socket pressed into it by its stone, the
// mortar stands up where it was squeezed between stones, a fine groove parts
// one ring from the next, and the rest is rough, sandy and uneven. No picture
// is loaded. The map wraps the sphere: across is the bearing round the pole
// facing the viewer, down is distance from that pole.

export const MORTAR_WIDTH = 1536;
export const MORTAR_HEIGHT = 768;
// How deep a stone's imprint is, and how far mortar stands up against a stone, in pixels.
const SOCKET = 1.7;
const SQUEEZE = .5;
const GROOVE = .55;

function hash(x, y, salt) {
  let value = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) | 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
// Smooth noise, `across` cells round the sphere and `down` cells from pole to pole.
function cloud(u, v, across, down, salt) {
  const fx = u * across, fy = v * down, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), at = (i, j) => hash((x0 + i) % across, y0 + j, salt);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * sx, bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * sx;
  return top + (bottom - top) * sy;
}
// A box blur that wraps round the sphere and stops at the poles.
function blur(source, width, height, reach) {
  const across = new Float32Array(source.length), out = new Float32Array(source.length), span = reach * 2 + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -reach; x <= reach; x++) sum += source[y * width + (x + width) % width];
    for (let x = 0; x < width; x++) {
      across[y * width + x] = sum / span;
      sum += source[y * width + (x + reach + 1) % width] - source[y * width + (x - reach + width) % width];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -reach; y <= reach; y++) sum += across[Math.max(0, Math.min(height - 1, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum += across[Math.min(height - 1, y + reach + 1) * width + x] - across[Math.max(0, y - reach) * width + x];
    }
  }
  return out;
}

/**
 * The mortar's relief for one field of stones. Red and green hold the slope
 * (east and south; 128 is level), blue how high the spot lies (190 is the
 * mortar's own level; a socket's floor is far below it, and shade gathers
 * there), alpha its tone (stains and patches). The returned map also carries
 * `level`, the heights in pixels, for tests.
 */
export function createMortarMap(field, width = MORTAR_WIDTH, height = MORTAR_HEIGHT) {
  const { radius, sockets, courseEdge } = field, size = width * height;
  const pressed = new Float32Array(size), TAU = Math.PI * 2;
  const sinRow = new Float32Array(height), cosRow = new Float32Array(height), sinColumn = new Float32Array(width), cosColumn = new Float32Array(width);
  for (let y = 0; y < height; y++) { const polar = (y + .5) / height * Math.PI; sinRow[y] = Math.sin(polar); cosRow[y] = Math.cos(polar); }
  for (let x = 0; x < width; x++) { const bearing = (x + .5) / width * TAU; sinColumn[x] = Math.sin(bearing); cosColumn[x] = Math.cos(bearing); }

  // Every place presses its own outline into the mortar.
  for (let place = 0; place < sockets.count; place++) {
    const n = place * 3, nx = sockets.normal[n], ny = sockets.normal[n + 1], nz = sockets.normal[n + 2];
    const sx = sockets.south[n], sy = sockets.south[n + 1], sz = sockets.south[n + 2];
    const ex = sy * nz - sz * ny, ey = sz * nx - sx * nz, ez = sx * ny - sy * nx;
    const outline = sockets.outline.subarray(place * 24, place * 24 + 24);
    let reach = 0;
    for (let k = 0; k < 12; k++) reach = Math.max(reach, Math.hypot(outline[k * 2], outline[k * 2 + 1]));
    const polar = Math.acos(Math.max(-1, Math.min(1, nz))), bearing = Math.atan2(-ny, nx), angle = (reach + .6) / radius;
    const rowFrom = Math.max(0, Math.floor((polar - angle) / Math.PI * height)), rowTo = Math.min(height - 1, Math.ceil((polar + angle) / Math.PI * height));
    const wide = Math.min(Math.PI, angle / Math.max(.02, Math.sin(polar) - angle)), columns = Math.min(width, Math.ceil(wide / TAU * width) * 2 + 2);
    const first = Math.floor((bearing - wide) / TAU * width);
    for (let y = rowFrom; y <= rowTo; y++) for (let step = 0; step < columns; step++) {
      const x = ((first + step) % width + width) % width;
      // The point of the sphere under this texel, in the place's own plane.
      const px = sinRow[y] * cosColumn[x] - nx, py = -sinRow[y] * sinColumn[x] - ny, pz = cosRow[y] - nz;
      const u = (px * ex + py * ey + pz * ez) * radius, v = (px * sx + py * sy + pz * sz) * radius;
      let inside = false;
      for (let a = 0, b = 11; a < 12; b = a++) {
        const ax = outline[a * 2], ay = outline[a * 2 + 1], bx = outline[b * 2], by = outline[b * 2 + 1];
        if ((ay > v) !== (by > v) && u < (bx - ax) * (v - ay) / (by - ay) + ax) inside = !inside;
      }
      if (inside) pressed[y * width + x] = 1;
    }
  }

  // Mortar squeezed up against the stones, most where two stones stand close.
  const crowded = blur(blur(pressed, width, height, 2), width, height, 1);
  const level = new Float32Array(size);
  for (let y = 0; y < height; y++) {
    const arc = (y + .5) / height * Math.PI * radius, v = y / height;
    // The parting line between this ring and the next.
    let parting = 0;
    for (let edge = 1; edge < courseEdge.length - 1; edge++) { const away = (arc - courseEdge[edge]) / .34; if (Math.abs(away) < 3) parting = Math.max(parting, Math.exp(-away * away)); }
    for (let x = 0; x < width; x++) {
      const at = y * width + x, u = x / width;
      // Rough and sandy, with slow unevenness, the drag of a trowel, and the odd pit.
      const rough = (hash(x, y, 5) - .5) * .3 + (cloud(u, v, 220, 110, 6) - .5) * .34 + (cloud(u, v, 40, 20, 7) - .5) * .5 + (cloud(u, v, 26, 160, 8) - .5) * .26;
      const pit = hash(x >> 1, y >> 1, 9) < .012 ? -.7 * hash(x >> 1, y >> 1, 10) : 0;
      level[at] = pressed[at] ? -SOCKET + (hash(x, y, 11) - .5) * .16 : SQUEEZE * Math.min(1, crowded[at] * 1.9) + rough + pit - GROOVE * parting;
    }
  }

  // Slope and shade from the heights.
  const around = blur(level, width, height, 5), map = new Uint8Array(size * 4), byte = value => Math.max(0, Math.min(255, Math.round(value)));
  const down = Math.PI * radius / height;
  for (let y = 0; y < height; y++) {
    const across = Math.max(.25, TAU * radius * sinRow[y] / width), v = y / height;
    for (let x = 0; x < width; x++) {
      const at = y * width + x, east = level[y * width + (x + 1) % width] - level[y * width + (x + width - 1) % width];
      const south = level[Math.min(height - 1, y + 1) * width + x] - level[Math.max(0, y - 1) * width + x];
      map[at * 4] = byte(128 - east / (2 * across) * 100);
      map[at * 4 + 1] = byte(128 - south / (2 * down) * 100);
      // How deep the spot lies: its own level, and a little more where it is lower than what is round it.
      map[at * 4 + 2] = byte(190 + level[at] * 55 + (level[at] - around[at]) * 40);
      // Tone: patches that set paler or darker, and stains.
      map[at * 4 + 3] = byte(128 + (cloud(x / width, v, 14, 9, 21) - .5) * 150 + (cloud(x / width, v, 48, 30, 22) - .5) * 70);
    }
  }
  map.level = level;
  return map;
}
