// Rigid-motion arithmetic for the tile sphere. A quaternion is [x, y, z, w] and
// is always kept at unit length, so it can turn a tile but never stretch it.

export const TAU = Math.PI * 2;
export const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
export const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
export const follow = (value, target, dt, duration) => value + (target - value) * (1 - Math.exp(-dt / duration));
// The same per-stone hash the flat medallion uses, so a seed means the same thing in both.
export const hash = (seed, index) => { const value = Math.sin(seed * 197.17 + index * 89.71) * 43758.5453; return value - Math.floor(value); };

export function quatAxis(x, y, z, angle, out = new Float64Array(4)) {
  const length = Math.hypot(x, y, z) || 1, half = angle / 2, s = Math.sin(half) / length;
  out[0] = x * s; out[1] = y * s; out[2] = z * s; out[3] = Math.cos(half);
  return out;
}

// The turn `b` followed by the turn `a`.
export function quatMul(a, b, out = new Float64Array(4)) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatNormalize(q, out = q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  out[0] = q[0] / length; out[1] = q[1] / length; out[2] = q[2] / length; out[3] = q[3] / length;
  return out;
}

// Exactly what the vertex shader does to a point of a tile.
export function quatRotate(q, v, out = new Float64Array(3)) {
  const x = q[0], y = q[1], z = q[2], w = q[3], vx = v[0], vy = v[1], vz = v[2];
  const cx = y * vz - z * vy + w * vx, cy = z * vx - x * vz + w * vy, cz = x * vy - y * vx + w * vz;
  out[0] = vx + 2 * (y * cz - z * cy);
  out[1] = vy + 2 * (z * cx - x * cz);
  out[2] = vz + 2 * (x * cy - y * cx);
  return out;
}

// The turn that carries the x, y and z axes onto three perpendicular unit vectors.
export function quatFromFrame(xAxis, yAxis, zAxis, out = new Float64Array(4)) {
  const m00 = xAxis[0], m10 = xAxis[1], m20 = xAxis[2];
  const m01 = yAxis[0], m11 = yAxis[1], m21 = yAxis[2];
  const m02 = zAxis[0], m12 = zAxis[1], m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out[3] = s / 4; out[0] = (m21 - m12) / s; out[1] = (m02 - m20) / s; out[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out[3] = (m21 - m12) / s; out[0] = s / 4; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = s / 4; out[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = s / 4;
  }
  return quatNormalize(out);
}

// Column-major 3x3 for a uniform. Built from a unit quaternion, it is a pure rotation.
export function quatToMat3(q, out = new Float32Array(9)) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w);
  out[3] = 2 * (x * y - z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z + x * w);
  out[6] = 2 * (x * z + y * w); out[7] = 2 * (y * z - x * w); out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

/**
 * One fixed camera on the axis through the sphere's centre, `distance` away.
 * `radius` is the sphere's own radius and `apparent` the radius of its outline
 * on screen, both in CSS pixels; `half` is half the side of the square canvas.
 * Returned as the four numbers the vertex shader needs.
 */
export function createLens({ radius, distance, apparent, half, reach = 24 }) {
  // A sphere's outline is where the line of sight grazes it, not its widest slice.
  const focal = apparent * Math.sqrt(distance * distance - radius * radius) / radius;
  const near = distance - radius - reach, far = distance + radius + reach;
  return {
    focal, near, far, distance,
    zoom: focal / half,
    depthScale: -(far + near) / (far - near),
    depthOffset: -2 * far * near / (far - near),
    // Where a point lands on screen, in CSS pixels from the sphere's centre.
    project(x, y, z) { const w = distance - z; return [focal * x / w, focal * y / w]; },
  };
}
