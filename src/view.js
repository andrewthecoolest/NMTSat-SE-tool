// SVG rendering of one sheet. Pure: returns markup for the current state.
import { DEFAULT_OBJECT_COLOR, byId, insideBundle } from './model.js';
import { pathLength, pointAt } from './bundles.js';
import { isOpenVia, sheetName, viaDestinations } from './derive.js';
import { richToHtml } from './richtext.js';

export const G = 20; // pixels per grid unit
const VIA_R = 8;
const PORT_R = 5;
const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const TAP_R = 4;
const PEEK_INSET = 6; // a box's hover-preview zone keeps this far from its edges, where wires and ports attach

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pxRect = (p) => ({ x: p.x * G, y: p.y * G, w: p.w * G, h: p.h * G });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function portPoint(placement, via) {
  const r = pxRect(placement);
  const t = via.portOffset;
  if (via.portSide === 'top') return { x: r.x + t * r.w, y: r.y };
  if (via.portSide === 'bottom') return { x: r.x + t * r.w, y: r.y + r.h };
  if (via.portSide === 'left') return { x: r.x, y: r.y + t * r.h };
  return { x: r.x + r.w, y: r.y + t * r.h };
}

// The box edge nearest to a point, and how far along it (0..1).
export function nearestSide(placement, pt) {
  const r = pxRect(placement);
  const options = [
    { side: 'top', d: Math.abs(pt.y - r.y), offset: (pt.x - r.x) / r.w },
    { side: 'bottom', d: Math.abs(pt.y - r.y - r.h), offset: (pt.x - r.x) / r.w },
    { side: 'left', d: Math.abs(pt.x - r.x), offset: (pt.y - r.y) / r.h },
    { side: 'right', d: Math.abs(pt.x - r.x - r.w), offset: (pt.y - r.y) / r.h },
  ];
  const best = options.sort((a, b) => a.d - b.d)[0];
  return { side: best.side, offset: clamp(best.offset, 0, 1) };
}

function arrow(tip, dx, dy, color, size = 8) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const pts = [[tip.x, tip.y], [bx - uy * size * 0.5, by + ux * size * 0.5], [bx + uy * size * 0.5, by - ux * size * 0.5]];
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${esc(color)}"/>`;
}

// ---- wire geometry ----------------------------------------------------------

function endShape(doc, ep) {
  if (ep.kind === 'module') {
    const p = byId(doc.placements, ep.placementId);
    // A wire end moved by hand stays on the side and spot it was put.
    if (ep.side) return { point: portPoint(p, { portSide: ep.side, portOffset: ep.offset }), side: ep.side, radius: 0 };
    return { rect: pxRect(p) };
  }
  if (ep.kind === 'unknown') {
    const u = byId(doc.unknownLoads, ep.unknownId);
    return { rect: { x: u.x * G, y: u.y * G, w: G, h: G } };
  }
  if (ep.kind === 'port') {
    const via = byId(doc.vias, ep.viaId);
    return { point: portPoint(byId(doc.placements, ep.placementId), via), side: via.portSide, radius: PORT_R };
  }
  if (ep.kind === 'tap') {
    const tap = byId(doc.taps, ep.tapId);
    return bundleSpot(byId(doc.bundles, tap.bundleId), tap.at);
  }
  if (ep.kind === 'junction') {
    const j = byId(doc.junctions, ep.junctionId);
    return { point: { x: j.x * G, y: j.y * G }, radius: 0 };
  }
  const via = byId(doc.vias, ep.viaId);
  return { point: { x: via.x * G, y: via.y * G }, radius: VIA_R };
}

// Where a wire meets a bundle `at` units along it. Wires leave a leg from its
// side facing them, and leave an end straight out of that end.
function bundleSpot(bundle, at) {
  const p = pointAt(bundle.points, at);
  const pts = bundle.points;
  const length = pathLength(pts);
  let endSide = null;
  if (at <= 0 || at >= length) {
    const [a, b] = at <= 0 ? [pts[1], pts[0]] : [pts[pts.length - 2], pts[pts.length - 1]];
    endSide = b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'bottom' : 'top';
  }
  return { point: { x: p.x * G, y: p.y * G }, radius: TAP_R, leg: p.dir, endSide };
}

const centerOf = (s) => s.point || { x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 };

function dominantSide(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

// Where a wire leaves a shape when heading toward `toward`, and which side it leaves from.
function legSide(s, toward) {
  if (s.endSide) return s.endSide;
  if (s.leg === 'h') return toward.y < s.point.y ? 'top' : 'bottom';
  return toward.x < s.point.x ? 'left' : 'right';
}

// `shift` slides an end along a box side (to keep it off other wires); ends at
// points (ports, vias, taps, ends placed by hand) don't move.
function anchor(s, toward, shift = 0) {
  if (s.point) {
    const side = s.side || (s.leg ? legSide(s, toward) : dominantSide(s.point, toward));
    const [nx, ny] = NORMAL[side];
    return { x: s.point.x + nx * s.radius, y: s.point.y + ny * s.radius, side };
  }
  const r = s.rect;
  const c = centerOf(s);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (Math.abs(dx) * r.h >= Math.abs(dy) * r.w) {
    const inset = Math.min(G / 2, r.h / 2);
    const [lo, hi] = [r.y + inset, r.y + r.h - inset];
    return { x: dx >= 0 ? r.x + r.w : r.x, y: clamp(clamp(toward.y, lo, hi) + shift, lo, hi), side: dx >= 0 ? 'right' : 'left' };
  }
  const inset = Math.min(G / 2, r.w / 2);
  const [lo, hi] = [r.x + inset, r.x + r.w - inset];
  return { x: clamp(clamp(toward.x, lo, hi) + shift, lo, hi), y: dy >= 0 ? r.y + r.h : r.y, side: dy >= 0 ? 'bottom' : 'top' };
}

// Orthogonal routes between two anchors: step out from each side, then connect.
// Returns the possible right-angle joins, preferring ones that don't double back
// toward either end's box (which happens when an end faces away from the other).
// Each join is { free, make(shift) }: a free join has a middle leg that can slide
// sideways by `shift` (to keep it off other wires).
function routeOptions(a, b) {
  const horizontal = (s) => s === 'left' || s === 'right';
  const stub = (p) => ({ x: p.x + NORMAL[p.side][0] * G, y: p.y + NORMAL[p.side][1] * G });
  const a1 = stub(a);
  const b1 = stub(b);
  const mx = (a1.x + b1.x) / 2;
  const my = (a1.y + b1.y) / 2;
  const viaX = { free: true, make: (d) => [{ x: mx + d, y: a1.y }, { x: mx + d, y: b1.y }] };
  const viaY = { free: true, make: (d) => [{ x: a1.x, y: my + d }, { x: b1.x, y: my + d }] };
  const corner1 = { free: false, make: () => [{ x: b1.x, y: a1.y }] };
  const corner2 = { free: false, make: () => [{ x: a1.x, y: b1.y }] };
  let options;
  if (horizontal(a.side) && horizontal(b.side)) options = [viaX, viaY];
  else if (!horizontal(a.side) && !horizontal(b.side)) options = [viaY, viaX];
  else options = horizontal(a.side) ? [corner1, corner2] : [corner2, corner1];
  const backtracks = (middle) => {
    const pts = [a1, ...middle, b1].filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
    if (pts.length < 2) return 0;
    const [na, nb] = [NORMAL[a.side], NORMAL[b.side]];
    const first = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
    const last = { x: pts[pts.length - 1].x - pts[pts.length - 2].x, y: pts[pts.length - 1].y - pts[pts.length - 2].y };
    return (first.x * na[0] + first.y * na[1] < 0 ? 1 : 0) + (last.x * nb[0] + last.y * nb[1] > 0 ? 1 : 0);
  };
  const scored = options.map((o) => ({ ...o, back: backtracks(o.make(0)), a, b, a1, b1 }));
  const fewest = Math.min(...scored.map((o) => o.back));
  return scored.filter((o) => o.back === fewest);
}

const buildRoute = (o, d) => [o.a, o.a1, ...o.make(d), o.b1, o.b];

// ---- keeping wires apart ----------------------------------------------------
// Wires are laid out in the order they were made. Each new one tries small
// shifts (of where it meets an auto-placed box edge, and of its middle leg)
// until none of its legs runs along another wire's or a bundle's within
// SPACING. Crossing is fine; so is touching a segment of the same wire.

const SPACING = 8;
const SHIFTS = [0, SPACING, -SPACING, 2 * SPACING, -2 * SPACING];
const LEG_SHIFTS = [...SHIFTS, 3 * SPACING, -3 * SPACING];

function legsOf(pts, wireId) {
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]];
    if (p.x === q.x && p.y !== q.y) legs.push({ v: true, c: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y), wireId });
    else if (p.y === q.y && p.x !== q.x) legs.push({ v: false, c: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x), wireId });
  }
  return legs;
}

function overlapCount(legs, placed, wireId) {
  let n = 0;
  for (const l of legs) {
    for (const m of placed) {
      if (m.wireId === wireId || m.v !== l.v || Math.abs(m.c - l.c) > SPACING - 0.5) continue;
      if (Math.min(m.hi, l.hi) - Math.max(m.lo, l.lo) > 1) n++;
    }
  }
  return n;
}

// The nearest route between two shapes that doesn't run along `placed` legs.
function routeAvoiding(sa, sb, placed, wireId) {
  const shiftsA = sa.rect ? SHIFTS : [0];
  const shiftsB = sb.rect ? SHIFTS : [0];
  const tries = [];
  for (const da of shiftsA) {
    for (const db of shiftsB) {
      const options = routeOptions(anchor(sa, centerOf(sb), da), anchor(sb, centerOf(sa), db));
      options.forEach((o, i) => {
        for (const d of o.free ? LEG_SHIFTS : [0]) tries.push({ o, d, cost: Math.abs(da) + Math.abs(db) + Math.abs(d) + i * SPACING * 0.5 });
      });
    }
  }
  tries.sort((x, y) => x.cost - y.cost);
  let best = null;
  for (const t of tries) {
    const pts = buildRoute(t.o, t.d);
    const n = overlapCount(legsOf(pts, wireId), placed, wireId);
    if (!n) return pts;
    if (!best || n < best.n) best = { pts, n };
  }
  return best.pts;
}

// Routes for every segment drawn on a sheet, cached per document (documents
// are never changed in place, so each new state gets a fresh layout).
const layouts = new WeakMap();

function wireLayout(doc, sheetId) {
  let bySheet = layouts.get(doc);
  if (!bySheet) layouts.set(doc, (bySheet = new Map()));
  if (bySheet.has(sheetId)) return bySheet.get(sheetId);
  const placed = [];
  for (const b of doc.bundles) {
    if (b.sheetId === sheetId) placed.push(...legsOf(b.points.map((q) => ({ x: q.x * G, y: q.y * G })), null));
  }
  const routes = new Map();
  for (const seg of doc.segments) {
    if (seg.sheetId !== sheetId || insideBundle(doc, seg)) continue;
    const pts = routeAvoiding(endShape(doc, seg.from), endShape(doc, seg.to), placed, seg.wireId);
    routes.set(seg.id, pts);
    placed.push(...legsOf(pts, seg.wireId));
  }
  const layout = { routes, placed };
  bySheet.set(sheetId, layout);
  return layout;
}

// The points a segment is drawn through (px), as laid out on its sheet.
export function segmentRoute(doc, seg) {
  return wireLayout(doc, seg.sheetId).routes.get(seg.id) ?? null;
}

// Where a segment's two ends are drawn (for dragging an end around its module).
export function segmentEnds(doc, seg) {
  const pts = wireLayout(doc, seg.sheetId).routes.get(seg.id);
  if (pts) return { from: pts[0], to: pts[pts.length - 1] };
  const sa = endShape(doc, seg.from);
  const sb = endShape(doc, seg.to);
  return { from: anchor(sa, centerOf(sb)), to: anchor(sb, centerOf(sa)) };
}

function segmentMarkup(doc, seg, selected) {
  const wire = byId(doc.wires, seg.wireId);
  const pts = wireLayout(doc, seg.sheetId).routes.get(seg.id);
  const b = pts[pts.length - 1];
  const d = 'M' + pts.map((p) => `${p.x},${p.y}`).join(' L');

  let head = '';
  if (wire.direction === 'directed') {
    let i = pts.length - 2;
    while (i > 0 && pts[i].x === b.x && pts[i].y === b.y) i--;
    head = arrow(b, b.x - pts[i].x, b.y - pts[i].y, wire.color);
  }
  // Label the longest leg.
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const len = (j) => Math.abs(pts[j + 1].x - pts[j].x) + Math.abs(pts[j + 1].y - pts[j].y);
    if (len(i) > len(best)) best = i;
  }
  const lx = (pts[best].x + pts[best + 1].x) / 2;
  const ly = (pts[best].y + pts[best + 1].y) / 2;

  return `<g class="wire${wire.universal ? ' universal' : ''}${selected ? ' selected' : ''}" data-kind="segment" data-id="${seg.id}">
    <title>${esc(wire.name)}${wire.universal ? ' (universal)' : ''}</title>
    <path class="hit" d="${d}"/>
    <path class="line" d="${d}" stroke="${esc(wire.color)}"/>
    ${head}
    <text class="wire-label" x="${lx}" y="${ly - 4}" fill="${esc(wire.color)}">${esc(wire.name)}</text>
  </g>`;
}

// The wire being drawn: routed and colored like a real segment, from a drop
// target (see targetAt in main.js) to another target or { kind: 'point', x, y }.
function targetShape(doc, t) {
  if (t.kind === 'module' || t.kind === 'unknown') return endShape(doc, t);
  if (t.kind === 'port' || t.kind === 'via') return byId(doc.vias, t.viaId) ? endShape(doc, t) : null;
  if (t.kind === 'subsystem') {
    const p = byId(doc.placements, t.placementId);
    return { point: portPoint(p, { portSide: t.side, portOffset: t.offset }), side: t.side, radius: PORT_R };
  }
  if (t.kind === 'tap') return byId(doc.taps, t.tapId) ? endShape(doc, t) : null;
  if (t.kind === 'junction') return byId(doc.junctions, t.junctionId) ? endShape(doc, t) : null;
  if (t.kind === 'branch') return { point: { x: t.x * G, y: t.y * G }, radius: 0 };
  if (t.kind === 'bundle') {
    const b = byId(doc.bundles, t.bundleId);
    return b ? bundleSpot(b, t.at) : null;
  }
  if (t.kind === 'newUnknown') return { rect: { x: t.x * G, y: t.y * G, w: G, h: G } };
  if (t.kind === 'boundary') return { point: { x: t.x * G, y: t.y * G }, radius: 0 };
  return { point: { x: t.x, y: t.y }, radius: 0 };
}

function ghostMark(doc, t, shape, color) {
  if (t.kind === 'newUnknown') {
    const { x, y } = shape.rect;
    const m = 4;
    return `<path class="ghost-x" d="M${x + m},${y + m} L${x + G - m},${y + G - m} M${x + G - m},${y + m} L${x + m},${y + G - m}"/>`;
  }
  if (t.kind === 'subsystem') return `<circle class="ghost-port" cx="${shape.point.x}" cy="${shape.point.y}" r="${PORT_R}" stroke="${esc(color)}"/>`;
  if (t.kind === 'bundle') return `<circle class="ghost-port" cx="${shape.point.x}" cy="${shape.point.y}" r="${TAP_R + 1}" stroke="${esc(color)}"/>`;
  if (t.kind === 'branch') return `<circle class="ghost-junction" cx="${shape.point.x}" cy="${shape.point.y}" r="4" fill="${esc(color)}"/>`;
  if (shape.rect && t.kind !== 'point') {
    const r = shape.rect;
    return `<rect class="ghost-target" x="${r.x - 3}" y="${r.y - 3}" width="${r.w + 6}" height="${r.h + 6}" stroke="${esc(color)}"/>`;
  }
  return '';
}

export function wireGhost(doc, from, to, { color, directed, sheetId, wireId = null }) {
  const sa = targetShape(doc, from);
  const sb = targetShape(doc, to);
  if (!sa || !sb) return '';
  // The wire being drawn keeps clear of the wires already on the sheet, like a new one will.
  const pts = routeAvoiding(sa, sb, wireLayout(doc, sheetId).placed, wireId);
  const b = pts[pts.length - 1];
  let head = '';
  if (directed) {
    let i = pts.length - 2;
    while (i > 0 && pts[i].x === b.x && pts[i].y === b.y) i--;
    head = arrow(b, b.x - pts[i].x, b.y - pts[i].y, color);
  }
  return `<g class="wire-ghost">
    ${ghostMark(doc, from, sa, color)}${ghostMark(doc, to, sb, color)}
    <path class="line" d="M${pts.map((p) => `${p.x},${p.y}`).join(' L')}" stroke="${esc(color)}"/>${head}
  </g>`;
}

// Everything on a sheet that lies entirely inside a world rectangle (px), for
// box selection. A segment counts when both of its ends do.
export function itemsInRect(doc, sheetId, r) {
  const inside = (b) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
  const shapeInside = (s) => inside(s.rect || { x: s.point.x, y: s.point.y, w: 0, h: 0 });
  const items = [];
  for (const p of doc.placements) if (p.sheetId === sheetId && inside(pxRect(p))) items.push({ kind: 'placement', id: p.id });
  for (const n of doc.notes) if (n.sheetId === sheetId && inside(pxRect(n))) items.push({ kind: 'note', id: n.id });
  for (const u of doc.unknownLoads) {
    if (u.sheetId === sheetId && inside({ x: u.x * G, y: u.y * G, w: G, h: G })) items.push({ kind: 'unknown', id: u.id });
  }
  for (const b of doc.bundles) {
    if (b.sheetId === sheetId && b.points.every((q) => inside({ x: q.x * G, y: q.y * G, w: 0, h: 0 }))) items.push({ kind: 'bundle', id: b.id });
  }
  for (const seg of doc.segments) {
    if (seg.sheetId !== sheetId || insideBundle(doc, seg)) continue;
    if (shapeInside(endShape(doc, seg.from)) && shapeInside(endShape(doc, seg.to))) items.push({ kind: 'segment', id: seg.id });
  }
  return items;
}

// ---- objects ----------------------------------------------------------------

function portMarkup(doc, placement, via) {
  const wire = byId(doc.wires, via.wireId);
  const pt = portPoint(placement, via);
  const [nx, ny] = NORMAL[via.portSide];
  // Arrow drawn just inside the box: pointing inward for "in", outward for "out".
  let head = '';
  if (via.direction === 'in') head = arrow({ x: pt.x - nx * 13, y: pt.y - ny * 13 }, -nx, -ny, wire.color, 6);
  if (via.direction === 'out') head = arrow({ x: pt.x - nx * (PORT_R + 1), y: pt.y - ny * (PORT_R + 1) }, nx, ny, wire.color, 6);
  return `<g class="port" data-kind="port" data-id="${via.id}" data-placement="${placement.id}">
    <title>${esc(wire.name)} (${via.direction})</title>
    <circle cx="${pt.x}" cy="${pt.y}" r="${PORT_R}" stroke="${esc(wire.color)}"/>${head}
  </g>`;
}

// The inner area of a box that opens its hover preview, clear of everything
// near the edges. Boxes too small to have one have no preview.
function peekZone(r) {
  const w = r.w - 2 * PEEK_INSET;
  const h = r.h - 2 * PEEK_INSET;
  if (w < 12 || h < 8) return '';
  return `<rect class="peek" x="${r.x + PEEK_INSET}" y="${r.y + PEEK_INSET}" width="${w}" height="${h}" rx="4"/>`;
}

function placementMarkup(doc, p, selected) {
  const o = byId(doc.objects, p.objectId);
  const r = pxRect(p);
  // Ports of vias that carry wires inside a bundle are part of the bundle, not drawn.
  const ports = o.type === 'subsystem' ? doc.vias.filter((v) => v.subsystemId === o.id && !v.crossingId).map((v) => portMarkup(doc, p, v)).join('') : '';
  const handle = selected ? `<rect class="handle" data-kind="resize" data-id="${p.id}" x="${r.x + r.w - 5}" y="${r.y + r.h - 5}" width="10" height="10"/>` : '';
  // A colored box gets a very light tint of its color; the default color stays white.
  const tint = o.color.toLowerCase() === DEFAULT_OBJECT_COLOR ? '' : ` style="fill:color-mix(in srgb, ${esc(o.color)} 9%, #fff)"`;
  return `<g class="box ${o.type}${selected ? ' selected' : ''}" data-kind="placement" data-id="${p.id}">
    <rect class="body" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" stroke="${esc(o.color)}"${tint}/>
    ${peekZone(r)}
    <text class="label" x="${r.x + r.w / 2}" y="${r.y + r.h / 2}">${esc(o.name)}</text>
    ${ports}${handle}
  </g>`;
}

function unknownMarkup(u, selected) {
  const x = u.x * G;
  const y = u.y * G;
  const m = 4;
  return `<g class="unknown${selected ? ' selected' : ''}" data-kind="unknown" data-id="${u.id}">
    <title>Unknown load</title>
    <rect x="${x}" y="${y}" width="${G}" height="${G}"/>
    <path d="M${x + m},${y + m} L${x + G - m},${y + G - m} M${x + G - m},${y + m} L${x + m},${y + G - m}"/>
  </g>`;
}

// A bundle: a thick two-tone line along its path, capped at both ends, labeled
// with its name and how many wires it carries. Corner handles when selected.
function bundleMarkup(doc, b, selected) {
  const pts = b.points.map((q) => ({ x: q.x * G, y: q.y * G }));
  const d = 'M' + pts.map((q) => `${q.x},${q.y}`).join(' L');
  const cap = (q, from) => {
    const vertical = from.x === q.x;
    return vertical
      ? `<line class="cap" x1="${q.x - 7}" y1="${q.y}" x2="${q.x + 7}" y2="${q.y}"/>`
      : `<line class="cap" x1="${q.x}" y1="${q.y - 7}" x2="${q.x}" y2="${q.y + 7}"/>`;
  };
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const len = (j) => Math.abs(pts[j + 1].x - pts[j].x) + Math.abs(pts[j + 1].y - pts[j].y);
    if (len(i) > len(best)) best = i;
  }
  const lx = (pts[best].x + pts[best + 1].x) / 2;
  const ly = (pts[best].y + pts[best + 1].y) / 2;
  const wires = new Set(doc.taps.filter((t) => t.bundleId === b.id).map((t) => t.wireId)).size;
  // An end plugged into a subsystem box has no cap; an end that carries on from
  // a parent sheet is a bundle via, labeled with where it comes from.
  const endMark = (end, q, from) => {
    const c = doc.crossings.find((x) => (x.outerId === b.id && x.outerEnd === end) || (x.innerId === b.id && x.innerEnd === end));
    if (!c) return cap(q, from);
    if (c.outerId === b.id) return '';
    const parent = sheetName(doc, byId(doc.placements, c.placementId)?.sheetId);
    return `<rect class="bundle-via" x="${q.x - 9}" y="${q.y - 9}" width="18" height="18" rx="4"/>
    <text class="bundle-via-label" x="${q.x}" y="${q.y + 24}">${esc(b.name)} from ${esc(parent)}</text>`;
  };
  const handles = selected
    ? pts.map((q, i) => `<rect class="handle" data-kind="bundlePoint" data-id="${b.id}" data-index="${i}" x="${q.x - 5}" y="${q.y - 5}" width="10" height="10"/>`).join('')
    : '';
  return `<g class="bundle${selected ? ' selected' : ''}" data-kind="bundle" data-id="${b.id}">
    <title>${esc(b.name)}</title>
    <path class="hit" d="${d}"/>
    <path class="outer" d="${d}"/>
    <path class="inner" d="${d}"/>
    ${endMark(0, pts[0], pts[1])}${endMark(1, pts[pts.length - 1], pts[pts.length - 2])}
    ${(() => {
      // The label sits on a small pill, which is the bundle's hover-preview zone.
      const text = `${b.name} · ${wires} wire${wires === 1 ? '' : 's'}`;
      const w = text.length * 6.2 + 14;
      return `<rect class="peek bundle-pill" x="${lx - w / 2}" y="${ly - 22}" width="${w}" height="16" rx="8"/>
    <text class="bundle-label" x="${lx}" y="${ly - 10}">${esc(text)}</text>`;
    })()}
    ${handles}
  </g>`;
}

// Where a wire goes into or out of a bundle; hollow when nothing continues there.
function tapMarkup(doc, t, open, selected) {
  const wire = byId(doc.wires, t.wireId);
  const { point } = bundleSpot(byId(doc.bundles, t.bundleId), t.at);
  return `<g class="tap${open ? ' open' : ''}${selected ? ' selected' : ''}" data-kind="tap" data-id="${t.id}">
    <title>${esc(wire.name)}</title>
    <circle cx="${point.x}" cy="${point.y}" r="${TAP_R}" stroke="${esc(wire.color)}" fill="${open ? '#fff' : esc(wire.color)}"/>
  </g>`;
}

// Exploded view of a bundle (for its hover preview): one lane per wire it
// carries, drawn along a straightened track from end A to end B.
export function bundleDiagram(summary) {
  const { lanes, length, cuts } = summary;
  const left = 44;
  const trackW = 400;
  const top = 50;
  const laneH = 48;
  const n = Math.max(1, lanes.length);
  const x = (at) => left + (length ? at / length : 0) * trackW;
  const bottom = top + (n - 1) * laneH;
  const parts = [`<rect class="track" x="${left - 10}" y="${top - 24}" width="${trackW + 20}" height="${bottom - top + 52}" rx="8"/>`];
  parts.push(`<text class="track-end" x="${left - 16}" y="${(top + bottom) / 2 + 4}" text-anchor="end">A</text>`);
  parts.push(`<text class="track-end" x="${left + trackW + 16}" y="${(top + bottom) / 2 + 4}">B</text>`);
  for (const at of cuts) if (at > 0 && at < length) parts.push(`<line class="cut" x1="${x(at)}" y1="${top - 24}" x2="${x(at)}" y2="${bottom + 28}"/>`);
  for (const edge of summary.edges ?? []) parts.push(`<text class="lane-note" x="${x(edge.at)}" y="${top - 30}" text-anchor="middle">${esc(edge.name)} edge</text>`);
  if (!lanes.length) parts.push(`<text class="lane-note" x="${left + trackW / 2}" y="${top + 4}" text-anchor="middle">No wires in this bundle yet.</text>`);
  lanes.forEach((lane, i) => {
    const y = top + i * laneH;
    const color = esc(lane.wire.color);
    parts.push(`<text class="lane-name" x="${x(lane.min) + 2}" y="${y - 8}" fill="${color}">${esc(lane.wire.name)}</text>`);
    if (!lane.waiting) parts.push(`<line class="lane" x1="${x(lane.min)}" y1="${y}" x2="${x(lane.max)}" y2="${y}" stroke="${color}"/>`);
    if (lane.wire.direction === 'directed') {
      for (const run of lane.inner) {
        if (run.from === run.to) continue;
        const mx = (x(run.from) + x(run.to)) / 2;
        parts.push(arrow({ x: mx + (run.to > run.from ? 5 : -5), y }, run.to > run.from ? 1 : -1, 0, lane.wire.color, 8));
      }
    }
    for (const p of lane.points) {
      const anchorText = p.at <= 0 ? 'start' : p.at >= length ? 'end' : 'middle';
      const words = p.outside.map((o) => {
        const names = o.names.map((m) => m.name).join(', ');
        if (lane.wire.direction !== 'directed') return `↔ ${names}`;
        return o.entering ? `from ${names}` : `to ${names}`;
      });
      const label = lane.waiting ? `${words.join('; ')} · not pulled out` : words.join('; ');
      const unresolved = p.open || p.outside.some((o) => o.names.some((m) => m.unresolved));
      parts.push(`<circle class="lane-tap" cx="${x(p.at)}" cy="${y}" r="5" stroke="${color}" fill="${p.open ? '#fff' : color}"/>`);
      if (label) parts.push(`<text class="lane-note${unresolved ? ' unresolved' : ''}" x="${x(p.at)}" y="${y + 18}" text-anchor="${anchorText}">${esc(label)}</text>`);
    }
  });
  return { markup: parts.join(''), width: left + trackW + 44, height: bottom + 44 };
}

// A text box: rich text wrapped inside a resizable box (text beyond it is clipped).
function noteMarkup(n, selected) {
  const r = pxRect(n);
  const handle = selected ? `<rect class="handle" data-kind="noteResize" data-id="${n.id}" x="${r.x + r.w - 5}" y="${r.y + r.h - 5}" width="10" height="10"/>` : '';
  return `<g class="note${selected ? ' selected' : ''}" data-kind="note" data-id="${n.id}">
    <rect class="frame" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>
    <foreignObject x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"><div class="note-body">${richToHtml(n.text)}</div></foreignObject>
    ${handle}
  </g>`;
}

function viaMarkup(doc, via, parentName, selected) {
  const wire = byId(doc.wires, via.wireId);
  const x = via.x * G;
  const y = via.y * G;
  let head = '';
  let label = wire.name;
  if (via.direction === 'in') {
    head = arrow({ x: x + VIA_R + 8, y }, 1, 0, wire.color, 7);
    label += ` from ${parentName}`;
  }
  if (via.direction === 'out') {
    head = arrow({ x: x - VIA_R, y }, 1, 0, wire.color, 7);
    const dest = viaDestinations(doc, via);
    if (dest.length) label += ` → ${dest.join(', ')}`;
  }
  const open = isOpenVia(doc, via) ? ' open' : '';
  return `<g class="via${open}${selected ? ' selected' : ''}" data-kind="via" data-id="${via.id}">
    <circle cx="${x}" cy="${y}" r="${VIA_R}" stroke="${esc(wire.color)}"/>${head}
    <text class="via-label" x="${x}" y="${y + VIA_R + 14}">${esc(label)}</text>
  </g>`;
}

// ---- sheet ------------------------------------------------------------------

// World-space rectangle (px) around everything on a sheet, with room for wire
// stubs and labels; null for an empty sheet.
export function sheetBounds(doc, sheetId) {
  const rects = [];
  for (const p of doc.placements) if (p.sheetId === sheetId) rects.push(pxRect(p));
  for (const n of doc.notes) if (n.sheetId === sheetId) rects.push(pxRect(n));
  for (const b of doc.bundles) {
    if (b.sheetId === sheetId) for (const q of b.points) rects.push({ x: q.x * G - 10, y: q.y * G - 24, w: 20, h: 34 });
  }
  for (const u of doc.unknownLoads) if (u.sheetId === sheetId) rects.push({ x: u.x * G, y: u.y * G, w: G, h: G });
  for (const v of doc.vias) {
    if (v.subsystemId !== sheetId) continue;
    const half = Math.max(VIA_R + 16, (byId(doc.wires, v.wireId).name.length + 12) * 3.5);
    rects.push({ x: v.x * G - half, y: v.y * G - VIA_R, w: 2 * half, h: 2 * VIA_R + 20 });
  }
  if (!rects.length) return null;
  const pad = 2 * G;
  const x = Math.min(...rects.map((r) => r.x)) - pad;
  const y = Math.min(...rects.map((r) => r.y)) - pad;
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) + pad - x, h: Math.max(...rects.map((r) => r.y + r.h)) + pad - y };
}

// boundary: draw the sheet-boundary strip on subsystem sheets. patternId must be
// unique per page (the hover preview renders a second sheet alongside the canvas).
export function renderSheet(doc, { sheetId, parentName, selection, view, width, height, overlay = '', boundary: withBoundary = true, patternId = 'dots' }) {
  const sel = (kind, id) => (selection?.kind === kind && selection.id === id) || !!selection?.items?.some((x) => x.kind === kind && x.id === id);
  const left = -view.x / view.k;
  const top = -view.y / view.k;

  const parts = [];
  parts.push(`<rect fill="url(#${patternId})" x="${left - G}" y="${top - G}" width="${width / view.k + 2 * G}" height="${height / view.k + 2 * G}"/>`);
  for (const p of doc.placements) if (p.sheetId === sheetId) parts.push(placementMarkup(doc, p, sel('placement', p.id)));
  for (const b of doc.bundles) if (b.sheetId === sheetId) parts.push(bundleMarkup(doc, b, sel('bundle', b.id)));
  for (const s of doc.segments) if (s.sheetId === sheetId && !insideBundle(doc, s)) parts.push(segmentMarkup(doc, s, sel('segment', s.id)));
  // Branch points: a dot where a wire splits partway along.
  for (const j of doc.junctions) {
    if (j.sheetId !== sheetId) continue;
    const seg = doc.segments.find((x) => [x.from, x.to].some((ep) => ep.kind === 'junction' && ep.junctionId === j.id));
    const wire = seg && byId(doc.wires, seg.wireId);
    if (wire) parts.push(`<g class="junction" data-kind="junction" data-id="${j.id}"><title>${esc(wire.name)}</title><circle cx="${j.x * G}" cy="${j.y * G}" r="4" fill="${esc(wire.color)}"/></g>`);
  }
  for (const t of doc.taps) {
    const b = byId(doc.bundles, t.bundleId);
    if (b.sheetId !== sheetId) continue;
    const touching = doc.segments.filter((s) => [s.from, s.to].some((ep) => ep.kind === 'tap' && ep.tapId === t.id));
    // Where a wire crosses a subsystem edge with its bundle, it's part of the bundle.
    if (touching.some((s) => insideBundle(doc, s) && [s.from, s.to].some((ep) => ep.kind === 'via' || ep.kind === 'port'))) continue;
    parts.push(tapMarkup(doc, t, touching.length < 2, sel('tap', t.id)));
  }
  for (const u of doc.unknownLoads) if (u.sheetId === sheetId) parts.push(unknownMarkup(u, sel('unknown', u.id)));
  for (const v of doc.vias) if (v.subsystemId === sheetId && !v.crossingId) parts.push(viaMarkup(doc, v, parentName, sel('via', v.id)));
  for (const n of doc.notes) if (n.sheetId === sheetId) parts.push(noteMarkup(n, sel('note', n.id)));
  parts.push(overlay);

  const boundary = sheetId === 'root' || !withBoundary ? '' : `
    <rect class="boundary" data-kind="boundary" x="7" y="7" width="${Math.max(0, width - 14)}" height="${Math.max(0, height - 14)}"/>
    <text class="boundary-label" x="${width / 2}" y="11">sheet boundary · drop a wire here to leave this subsystem</text>`;

  return `<defs>
      <pattern id="${patternId}" width="${G}" height="${G}" x="${-G / 2}" y="${-G / 2}" patternUnits="userSpaceOnUse">
        <circle cx="${G / 2}" cy="${G / 2}" r="1.1" fill="#9ca3af" fill-opacity="0.55"/>
      </pattern>
    </defs>
    <g transform="translate(${view.x},${view.y}) scale(${view.k})">${parts.join('')}</g>${boundary}`;
}
