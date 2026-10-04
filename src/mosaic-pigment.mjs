const clamp = value => Math.max(0, Math.min(1, value));
const hash = (seed, index) => { const value = Math.sin(seed * 197.17 + index * 89.71) * 43758.5453; return value - Math.floor(value); };
const blend = (a, b, t) => a.map((channel, index) => channel + (b[index] - channel) * t);
function ramp(stops, position) {
  const scaled = clamp(position) * (stops.length - 1), index = Math.min(stops.length - 2, Math.floor(scaled));
  return blend(stops[index], stops[index + 1], scaled - index);
}

// Ink and highlighter: the page's own study colours, cut into glass.
const INK = [[104, 160, 226], [44, 98, 190], [34, 52, 134]];
const GILT = [[242, 204, 108], [228, 168, 50], [206, 136, 44]];
const EMBER = [[246, 198, 98], [230, 138, 46], [198, 86, 54]];
const CREAM = [[255, 245, 216], [251, 228, 164], [245, 208, 122]];
const JADE = [[112, 228, 210], [40, 192, 186], [18, 150, 168]];
const GLINT = [[255, 242, 156], [255, 226, 112], [250, 206, 86]];
const TEAL = [34, 142, 154], MINT = [176, 246, 226], GARNET = [178, 66, 62];

/**
 * Three fixed glazes for one stone; nothing here animates. `cool` is the mosaic
 * while it listens: ink blues that deepen toward the rim, with the compass
 * construction and the meander gilded. `bright` is that stone under the tide of
 * a person's voice, and `warm` is the stone lit by Plato's own voice.
 * The page is white, so light is drawn as stronger colour, never as paleness.
 */
export function stonePigments(tile) {
  const seed = Number.isFinite(tile.seed) ? tile.seed : .5;
  const radius = Number.isFinite(tile.r) ? tile.r : .5;
  const depth = clamp(.06 + radius * .78 + (hash(seed, 3) - .5) * .44);
  const gilded = (tile.motifStrength || 0) > .2 + hash(seed, 5) * .14;
  const shade = hash(seed, 11);
  if (gilded) return { gilded, cool: ramp(GILT, shade), bright: ramp(GLINT, shade), warm: ramp(CREAM, shade) };
  // A scattering of off-colour glass keeps the field hand-laid, not printed.
  const accent = hash(seed, 9) < .075;
  return { gilded, cool: accent ? TEAL : ramp(INK, depth), bright: accent ? MINT : ramp(JADE, depth), warm: accent ? GARNET : ramp(EMBER, depth) };
}
