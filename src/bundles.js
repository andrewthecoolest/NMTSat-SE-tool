// Bundle geometry. A bundle's path is a list of grid points joined by
// horizontal or vertical legs; positions along it ("at") are grid units of
// distance from its first point (end A) to its last (end B).

const legLength = (a, b) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

export const isOrthogonal = (points) => points.every((p, i) => i === 0 || p.x === points[i - 1].x || p.y === points[i - 1].y);

export const pathLength = (points) => points.reduce((n, p, i) => (i ? n + legLength(points[i - 1], p) : 0), 0);

// Drop repeated points and corners that don't turn (so every inner point is a real corner).
export function cleanPoints(points) {
  const out = [];
  for (const p of points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }))) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

// The grid point `at` units along the path, and the direction of the leg it is on.
export function pointAt(points, at) {
  let left = Math.max(0, at);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = legLength(a, b);
    if (left <= len || i === points.length - 1) {
      const t = len ? Math.min(left, len) / len : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dir: a.y === b.y ? 'h' : 'v' };
    }
    left -= len;
  }
  return { ...points[0], dir: 'h' };
}

// The position along the path nearest a grid point, in whole units; within one
// unit of an end it snaps to that end.
export function project(points, gx, gy) {
  let best = { d: Infinity, at: 0 };
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = legLength(a, b);
    const t = len ? Math.min(1, Math.max(0, ((gx - a.x) * (b.x - a.x) + (gy - a.y) * (b.y - a.y)) / (len * len))) : 0;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const d = Math.hypot(gx - x, gy - y);
    if (d < best.d) best = { d, at: start + t * len };
    start += len;
  }
  const total = pathLength(points);
  const at = Math.round(best.at);
  if (at <= 1) return 0;
  if (at >= total - 1) return total;
  return at;
}

// Move one point. An end gets a new corner so its leg bends; an inner corner
// slides its neighbours along so both of its legs stay straight.
export function movePoint(points, index, x, y) {
  const next = points.map((p) => ({ ...p }));
  const old = points[index];
  const last = points.length - 1;
  if (index === 0 || index === last) {
    const n = points[index === 0 ? 1 : last - 1];
    const corner = n.y === old.y ? { x, y: n.y } : { x: n.x, y };
    next[index] = { x, y };
    next.splice(index === 0 ? 1 : last, 0, corner);
    return cleanPoints(next);
  }
  for (const j of [index - 1, index + 1]) {
    const n = next[j];
    if (!n) continue;
    if (n.y === old.y && n.x !== old.x) n.y = y;
    else if (n.x === old.x && n.y !== old.y) n.x = x;
  }
  next[index] = { x, y };
  return cleanPoints(next);
}
