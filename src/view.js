// SVG rendering of one sheet. Pure: returns markup for the current state.
import { byId } from './model.js';
import { isOpenVia, viaDestinations } from './derive.js';
import { richToHtml } from './richtext.js';

export const G = 20; // pixels per grid unit
const VIA_R = 8;
const PORT_R = 5;
const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

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
  if (ep.kind === 'module') return { rect: pxRect(byId(doc.placements, ep.placementId)) };
  if (ep.kind === 'unknown') {
    const u = byId(doc.unknownLoads, ep.unknownId);
    return { rect: { x: u.x * G, y: u.y * G, w: G, h: G } };
  }
  if (ep.kind === 'port') {
    const via = byId(doc.vias, ep.viaId);
    return { point: portPoint(byId(doc.placements, ep.placementId), via), side: via.portSide, radius: PORT_R };
  }
  const via = byId(doc.vias, ep.viaId);
  return { point: { x: via.x * G, y: via.y * G }, radius: VIA_R };
}

const centerOf = (s) => s.point || { x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 };

function dominantSide(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

// Where a wire leaves a shape when heading toward `toward`, and which side it leaves from.
function anchor(s, toward) {
  if (s.point) {
    const side = s.side || dominantSide(s.point, toward);
    const [nx, ny] = NORMAL[side];
    return { x: s.point.x + nx * s.radius, y: s.point.y + ny * s.radius, side };
  }
  const r = s.rect;
  const c = centerOf(s);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (Math.abs(dx) * r.h >= Math.abs(dy) * r.w) {
    const inset = Math.min(G / 2, r.h / 2);
    return { x: dx >= 0 ? r.x + r.w : r.x, y: clamp(toward.y, r.y + inset, r.y + r.h - inset), side: dx >= 0 ? 'right' : 'left' };
  }
  const inset = Math.min(G / 2, r.w / 2);
  return { x: clamp(toward.x, r.x + inset, r.x + r.w - inset), y: dy >= 0 ? r.y + r.h : r.y, side: dy >= 0 ? 'bottom' : 'top' };
}

// Orthogonal route between two anchors: step out from each side, then connect.
function route(a, b) {
  const horizontal = (s) => s === 'left' || s === 'right';
  const stub = (p) => ({ x: p.x + NORMAL[p.side][0] * G, y: p.y + NORMAL[p.side][1] * G });
  const a1 = stub(a);
  const b1 = stub(b);
  let middle;
  if (horizontal(a.side) && horizontal(b.side)) {
    const mx = (a1.x + b1.x) / 2;
    middle = [{ x: mx, y: a1.y }, { x: mx, y: b1.y }];
  } else if (!horizontal(a.side) && !horizontal(b.side)) {
    const my = (a1.y + b1.y) / 2;
    middle = [{ x: a1.x, y: my }, { x: b1.x, y: my }];
  } else {
    middle = [horizontal(a.side) ? { x: b1.x, y: a1.y } : { x: a1.x, y: b1.y }];
  }
  return [a, a1, ...middle, b1, b];
}

function segmentMarkup(doc, seg, selected) {
  const wire = byId(doc.wires, seg.wireId);
  const sa = endShape(doc, seg.from);
  const sb = endShape(doc, seg.to);
  const a = anchor(sa, centerOf(sb));
  const b = anchor(sb, centerOf(sa));
  const pts = route(a, b);
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

  return `<g class="wire${selected ? ' selected' : ''}" data-kind="segment" data-id="${seg.id}">
    <title>${esc(wire.name)}</title>
    <path class="hit" d="${d}"/>
    <path class="line" d="${d}" stroke="${esc(wire.color)}"/>
    ${head}
    <text class="wire-label" x="${lx}" y="${ly - 4}" fill="${esc(wire.color)}">${esc(wire.name)}</text>
  </g>`;
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

function placementMarkup(doc, p, selected) {
  const o = byId(doc.objects, p.objectId);
  const r = pxRect(p);
  const ports = o.type === 'subsystem' ? doc.vias.filter((v) => v.subsystemId === o.id).map((v) => portMarkup(doc, p, v)).join('') : '';
  const handle = selected ? `<rect class="handle" data-kind="resize" data-id="${p.id}" x="${r.x + r.w - 5}" y="${r.y + r.h - 5}" width="10" height="10"/>` : '';
  return `<g class="box ${o.type}${selected ? ' selected' : ''}" data-kind="placement" data-id="${p.id}">
    <rect class="body" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" stroke="${esc(o.color)}"/>
    <text class="label" x="${r.x + r.w / 2}" y="${r.y + r.h / 2}">${esc(o.name)}</text>
    <g class="info" data-kind="info" data-id="${p.id}">
      <title>Info</title>
      <circle cx="${r.x + r.w - 9}" cy="${r.y + 9}" r="6"/>
      <text x="${r.x + r.w - 9}" y="${r.y + 9}">i</text>
    </g>
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
  const sel = (kind, id) => selection?.kind === kind && selection.id === id;
  const left = -view.x / view.k;
  const top = -view.y / view.k;

  const parts = [];
  parts.push(`<rect fill="url(#${patternId})" x="${left - G}" y="${top - G}" width="${width / view.k + 2 * G}" height="${height / view.k + 2 * G}"/>`);
  for (const p of doc.placements) if (p.sheetId === sheetId) parts.push(placementMarkup(doc, p, sel('placement', p.id)));
  for (const s of doc.segments) if (s.sheetId === sheetId) parts.push(segmentMarkup(doc, s, sel('segment', s.id)));
  for (const u of doc.unknownLoads) if (u.sheetId === sheetId) parts.push(unknownMarkup(u, sel('unknown', u.id)));
  for (const v of doc.vias) if (v.subsystemId === sheetId) parts.push(viaMarkup(doc, v, parentName, sel('via', v.id)));
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
