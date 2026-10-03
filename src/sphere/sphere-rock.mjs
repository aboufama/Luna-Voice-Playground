// The rock every stone is cut from: one small square of grain, made from
// numbers when the page starts. No picture is loaded and nothing is fetched.
// It repeats seamlessly, and each tile reads its own patch of it, at its own
// place and turn, so that no two stones carry the same piece.

// Pixels of the square to one CSS pixel of stone.
export const ROCK_DENSITY = 4;
export const ROCK_SIZE = 256;

// Integer hashing: the same rock on every visit and every machine.
function hash(x, y, salt) {
  let value = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) | 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

// Smooth noise with `period` cells across the square, so it wraps without a seam.
function cloud(x, y, size, period, salt) {
  const fx = x / size * period, fy = y / size * period;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const at = (i, j) => hash(((x0 + i) % period + period) % period, ((y0 + j) % period + period) % period, salt);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * sx, bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * Four layers of rock in the four channels of one RGBA square:
 *   red    mottling: broad clouds, the size of a stone and smaller
 *   green  grain: fine speckle, a pixel or two across
 *   blue   veins: thin wandering lines
 *   alpha  flecks: sparse small spots, for inclusions and pits
 * Every layer is centred on mid-grey, so a stone's own colour is unchanged on average.
 */
export function createRock(size = ROCK_SIZE) {
  const rock = new Uint8Array(size * size * 4);
  // One fleck in most cells of a coarse grid, anywhere inside its cell.
  const cells = size / 8;
  const fleck = (x, y) => {
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8);
    let strongest = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = ((cx + i) % cells + cells) % cells, gy = ((cy + j) % cells + cells) % cells;
      if (hash(gx, gy, 71) > .15) continue;
      const px = (cx + i + hash(gx, gy, 72)) * 8, py = (cy + j + hash(gx, gy, 73)) * 8, radius = .9 + hash(gx, gy, 74) ** 2 * 2.6;
      const reach = 1 - Math.hypot(x + .5 - px, y + .5 - py) / radius;
      if (reach > strongest) strongest = reach;
    }
    return Math.min(1, strongest * 1.6);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (y * size + x) * 4;
    const mottle = .5 * cloud(x, y, size, 5, 11) + .32 * cloud(x, y, size, 11, 12) + .18 * cloud(x, y, size, 23, 13);
    const grain = .45 * cloud(x, y, size, 64, 21) + .35 * cloud(x, y, size, 128, 22) + .2 * hash(x, y, 23);
    // A vein runs where a slow field crosses its middle; a second field bends it,
    // and a third decides which parts of the rock are veined at all: most are not.
    const bend = cloud(x, y, size, 9, 31) * .18;
    const ridge = 1 - Math.abs(2 * (cloud(x, y, size, 4, 32) * .82 + bend) - 1);
    const veined = Math.min(1, Math.max(0, (cloud(x, y, size, 3, 33) - .56) / .14));
    const vein = Math.pow(Math.max(0, ridge), 16) * veined;
    rock[at] = Math.round(255 * Math.min(1, Math.max(0, .5 + (mottle - .5) * 1.9)));
    rock[at + 1] = Math.round(255 * Math.min(1, Math.max(0, .5 + (grain - .5) * 2.1)));
    rock[at + 2] = Math.round(255 * vein);
    rock[at + 3] = Math.round(255 * fleck(x, y));
  }
  return rock;
}

/**
 * The same rock as a surface: for every pixel of the square, which way it
 * slopes and how deep it lies. Mottling is broad swell, grain is roughness,
 * flecks are pits and veins are fine grooves. Red and green hold the slope
 * (128 is level), blue the height, alpha how far the spot is sunk below its
 * surroundings, which is where shade gathers.
 */
export function createRelief(rock, size = ROCK_SIZE) {
  const height = new Float32Array(size * size), relief = new Uint8Array(size * size * 4);
  for (let at = 0; at < size * size; at++) {
    height[at] = .34 * (rock[at * 4] / 255 - .5) + .2 * (rock[at * 4 + 1] / 255 - .5) - .3 * rock[at * 4 + 3] / 255 - .16 * rock[at * 4 + 2] / 255;
  }
  const wrap = value => (value + size) % size, at = (x, y) => height[wrap(y) * size + wrap(x)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Slopes in height per stone pixel: two texels apart is half a pixel.
    const sx = (at(x + 1, y) - at(x - 1, y)) * ROCK_DENSITY / 2, sy = (at(x, y + 1) - at(x, y - 1)) * ROCK_DENSITY / 2;
    const around = (at(x - 3, y) + at(x + 3, y) + at(x, y - 3) + at(x, y + 3) + at(x - 2, y - 2) + at(x + 2, y + 2) + at(x - 2, y + 2) + at(x + 2, y - 2)) / 8;
    const to = (y * size + x) * 4, byte = value => Math.max(0, Math.min(255, Math.round(value)));
    relief[to] = byte(128 - sx * 127); relief[to + 1] = byte(128 - sy * 127);
    relief[to + 2] = byte(128 + at(x, y) * 200);
    relief[to + 3] = byte(128 + (at(x, y) - around) * 620);
  }
  return relief;
}
