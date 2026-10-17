// Document model. Every change goes through apply(doc, command), which works on
// a copy and only returns the new document if it still satisfies every invariant.
import { isRich, normalize, plainText, runsOf } from './richtext.js';
import { boxPort, cleanPoints, isOrthogonal, movePoint, nearestBoxSide, pathLength, plugInto, pointAt } from './bundles.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_OBJECT_COLOR = '#334155';
const DEFAULT_WIRE_COLOR = '#2563eb';
const SIDES = ['top', 'right', 'bottom', 'left'];
const PORT_SPREAD = [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6];

export function emptyDoc() {
  return { schemaVersion: SCHEMA_VERSION, objects: [], placements: [], unknownLoads: [], wires: [], segments: [], vias: [], notes: [], bundles: [], taps: [], crossings: [], junctions: [] };
}

// Older documents: no notes, bundles or taps lists, or notes without a size (they
// used to size themselves to their text: about 8px per character and 18px per line).
export function upgrade(data) {
  if (!data || typeof data !== 'object') return data;
  for (const k of ['notes', 'bundles', 'taps', 'crossings', 'junctions']) if (!(k in data)) data[k] = [];
  if (!Array.isArray(data.notes)) return data;
  for (const n of data.notes) {
    if (!n || typeof n !== 'object' || ('w' in n && 'h' in n)) continue;
    const lines = plainText(n.text).split('\n');
    n.w = Math.max(1, Math.ceil((Math.max(...lines.map((l) => l.length)) * 8 + 12) / 20));
    n.h = Math.max(1, Math.ceil((lines.length * 19 + 8) / 20));
  }
  return data;
}

// Rich text from the UI, stored in its simplest form.
const cleanRich = (v) => (isRich(v) ? normalize(runsOf(v)) : fail('That text could not be read.'));

export const nameKey = (name) => String(name).trim().toLowerCase();
export const newId = () => Math.random().toString(36).slice(2, 10);
export const byId = (list, id) => list.find((x) => x.id === id);
export const objectByName = (doc, name) => doc.objects.find((o) => nameKey(o.name) === nameKey(name));
export const wireByName = (doc, name) => doc.wires.find((w) => nameKey(w.name) === nameKey(name));

class ModelError extends Error {}
const fail = (message) => { throw new ModelError(message); };
const get = (list, id) => byId(list, id) || fail('That item no longer exists.');
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

// ---------------------------------------------------------------------------
// Wire graphs. Nodes are module entities ("m:id"), unknown loads ("u:id"), vias
// ("v:id"; a via and its ports are one node) and bundle taps ("t:id": where a
// wire enters or leaves a bundle). A segment between two taps of the same
// bundle runs inside it.

export function endpointNode(doc, ep) {
  if (ep.kind === 'module') {
    const p = byId(doc.placements, ep.placementId);
    return p ? 'm:' + p.objectId : null;
  }
  if (ep.kind === 'unknown') return 'u:' + ep.unknownId;
  if (ep.kind === 'port' || ep.kind === 'via') return 'v:' + ep.viaId;
  if (ep.kind === 'tap') return 't:' + ep.tapId;
  if (ep.kind === 'junction') return 'j:' + ep.junctionId;
  return null;
}

export function wireEdges(doc, wireId) {
  return doc.segments
    .filter((s) => s.wireId === wireId)
    .map((s) => ({ seg: s, a: endpointNode(doc, s.from), b: endpointNode(doc, s.to) }));
}

export function nodeName(doc, node) {
  const id = node.slice(2);
  if (node.startsWith('m:')) return byId(doc.objects, id)?.name ?? '?';
  if (node.startsWith('u:')) return 'an unknown load';
  if (node.startsWith('t:')) return `${byId(doc.bundles, byId(doc.taps, id)?.bundleId)?.name ?? '?'} (bundle)`;
  if (node.startsWith('j:')) return 'a branch point';
  const via = byId(doc.vias, id);
  return `${byId(doc.objects, via?.subsystemId)?.name ?? '?'} (via)`;
}

// The root of a directed wire: the only node no segment points to.
export function wireOrigin(doc, wireId) {
  const edges = wireEdges(doc, wireId);
  const targets = new Set(edges.map((e) => e.b));
  return edges.find((e) => !targets.has(e.a))?.a ?? null;
}

function components(edges) {
  const adjacent = new Map();
  for (const e of edges) {
    for (const n of [e.a, e.b]) {
      if (!adjacent.has(n)) adjacent.set(n, []);
      adjacent.get(n).push(e);
    }
  }
  const seen = new Set();
  const result = [];
  for (const start of adjacent.keys()) {
    if (seen.has(start)) continue;
    const comp = { nodes: new Set(), edges: new Set() };
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      comp.nodes.add(n);
      for (const e of adjacent.get(n)) {
        comp.edges.add(e);
        stack.push(e.a === n ? e.b : e.a);
      }
    }
    result.push(comp);
  }
  return result;
}

const touchesVia = (s, viaId) => [s.from, s.to].some((ep) => (ep.kind === 'via' || ep.kind === 'port') && ep.viaId === viaId);
const touchesJunction = (s, junctionId) => [s.from, s.to].some((ep) => ep.kind === 'junction' && ep.junctionId === junctionId);
const touchesTap = (s, tapId) => [s.from, s.to].some((ep) => ep.kind === 'tap' && ep.tapId === tapId);
const tapBundle = (doc, ep) => (ep?.kind === 'tap' ? byId(doc.taps, ep.tapId)?.bundleId : undefined);
const crossingVia = (doc, ep) => ((ep?.kind === 'via' || ep?.kind === 'port') && byId(doc.vias, ep.viaId)?.crossingId) || undefined;
// A segment that runs inside a bundle: between two of its taps, or between a
// tap and the via that carries the wire across a subsystem edge with the bundle.
export const insideBundle = (doc, s) =>
  (!!tapBundle(doc, s.from) && tapBundle(doc, s.from) === tapBundle(doc, s.to))
  || (!!tapBundle(doc, s.from) && !!crossingVia(doc, s.to))
  || (!!tapBundle(doc, s.to) && !!crossingVia(doc, s.from));

// ---------------------------------------------------------------------------
// Bundles across subsystems. A crossing joins an end (0 = A, 1 = B) of a bundle
// on a parent sheet (`outer`, plugged into a subsystem box there) to an end of a
// bundle inside that subsystem (`inner`). Joined bundles form one chain that the
// user sees as a single bundle.

const crossingAt = (doc, bundleId, end) =>
  doc.crossings.find((c) => (c.outerId === bundleId && c.outerEnd === end) || (c.innerId === bundleId && c.innerEnd === end));
const otherSide = (c, bundleId, end) => (c.outerId === bundleId && c.outerEnd === end ? { id: c.innerId, end: c.innerEnd } : { id: c.outerId, end: c.outerEnd });

// The bundles joined to `bundleId`, in order from one free end to the other:
// items { bundle, reversed, offset, length } (offset = distance along the whole
// chain to the item's start) and joints { crossing, at } between them.
export function bundleChain(doc, bundleId) {
  let piece = bundleId;
  let leaving = 0;
  const seen = new Set();
  for (;;) {
    const c = crossingAt(doc, piece, leaving);
    if (!c || seen.has(c.id)) break;
    seen.add(c.id);
    const o = otherSide(c, piece, leaving);
    piece = o.id;
    leaving = 1 - o.end;
  }
  const items = [];
  const joints = [];
  let entry = leaving;
  let offset = 0;
  const visited = new Set();
  while (piece && !visited.has(piece)) {
    visited.add(piece);
    const bundle = byId(doc.bundles, piece);
    if (!bundle) break;
    const length = pathLength(bundle.points);
    items.push({ bundle, reversed: entry === 1, offset, length });
    offset += length;
    const c = crossingAt(doc, piece, 1 - entry);
    if (!c) break;
    joints.push({ crossing: c, at: offset });
    const o = otherSide(c, piece, 1 - entry);
    piece = o.id;
    entry = o.end;
  }
  return { items, joints, length: offset };
}

const endIndex = (b, end) => (end ? b.points.length - 1 : 0);

// Keep every bundle that plugs into a box attached to its edge (boxes move and
// resize), and keep the vias that carry wires across in step with it.
function attachCrossings(doc) {
  for (const c of doc.crossings) {
    const outer = byId(doc.bundles, c.outerId);
    const inner = byId(doc.bundles, c.innerId);
    const p = byId(doc.placements, c.placementId);
    if (!outer || !inner || !p) continue;
    const target = boxPort(p, c.side, c.offset);
    // Work on the path as if the plugged end were last, so it meets the edge square-on.
    const ordered = c.outerEnd ? outer.points : [...outer.points].reverse();
    const plugged = plugInto(ordered, target, c.side);
    if (plugged !== ordered) {
      const before = pathLength(outer.points);
      outer.points = c.outerEnd ? plugged : [...plugged].reverse();
      const grew = pathLength(outer.points) - before;
      // Positions count from end A, so a change at end A shifts them.
      if (c.outerEnd === 0) for (const t of doc.taps) if (t.bundleId === outer.id) t.at = Math.max(0, t.at + grew);
      const length = pathLength(outer.points);
      for (const t of doc.taps) if (t.bundleId === outer.id) t.at = Math.min(t.at, length);
    }
    const inside = inner.points[endIndex(inner, c.innerEnd)];
    for (const v of doc.vias) {
      if (v.crossingId === c.id) Object.assign(v, { x: inside.x, y: inside.y, portSide: c.side, portOffset: c.offset });
    }
  }
}

// Branch points only exist where a wire actually branches. One left joining
// two segments is merged away (into one segment); one left at a dead end goes,
// with its segment; an unused one goes.
function tidyJunctions(doc) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const j of doc.junctions) {
      const segs = doc.segments.filter((s) => touchesJunction(s, j.id));
      if (segs.length >= 3) continue;
      if (segs.length === 2) {
        const [s1, s2] = segs;
        const far = (s) => (s.from.kind === 'junction' && s.from.junctionId === j.id ? s.to : s.from);
        Object.assign(s1, { from: far(s1), to: far(s2) });
        doc.segments = doc.segments.filter((s) => s !== s2);
      } else if (segs.length === 1) {
        doc.segments = doc.segments.filter((s) => s !== segs[0]);
      }
      doc.junctions = doc.junctions.filter((x) => x !== j);
      changed = true;
      break;
    }
  }
}

// A tap where a wire crosses a subsystem edge with its bundle (it follows the bundle).
const isCrossingTap = (doc, tapId) =>
  doc.segments.some((s) => touchesTap(s, tapId) && (crossingVia(doc, s.from) || crossingVia(doc, s.to)));
const touchesUnknown = (s, unknownId) => [s.from, s.to].some((ep) => ep.kind === 'unknown' && ep.unknownId === unknownId);

// True if sheetId is outerId's sheet or lies (transitively) inside it.
export function contains(doc, outerId, sheetId) {
  const seen = new Set();
  const stack = [outerId];
  while (stack.length) {
    const s = stack.pop();
    if (s === sheetId) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    for (const p of doc.placements) {
      if (p.sheetId === s && byId(doc.objects, p.objectId)?.type === 'subsystem') stack.push(p.objectId);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation: returns a list of problems (empty when the document is legal).

export function validate(doc) {
  try {
    return check(doc);
  } catch {
    return ['Not a valid document.'];
  }
}

function check(doc) {
  if (!doc || doc.schemaVersion !== SCHEMA_VERSION) return [`Unsupported schemaVersion (expected ${SCHEMA_VERSION}).`];
  const lists = ['objects', 'placements', 'unknownLoads', 'wires', 'segments', 'vias', 'notes', 'bundles', 'taps', 'crossings', 'junctions'];
  for (const k of lists) if (!Array.isArray(doc[k])) return [`Missing "${k}" list.`];

  const errors = [];
  const ids = new Set();
  for (const k of lists) {
    for (const x of doc[k]) {
      if (typeof x?.id !== 'string' || x.id === 'root' || ids.has(x.id)) errors.push(`Duplicate or missing id in ${k}.`);
      ids.add(x?.id);
    }
  }
  if (errors.length) return errors;

  const isSubsystem = (id) => byId(doc.objects, id)?.type === 'subsystem';
  const sheetOk = (id) => id === 'root' || isSubsystem(id);
  const finite = (...ns) => ns.every(Number.isFinite);

  const objectNames = new Set();
  for (const o of doc.objects) {
    if (typeof o.name !== 'string' || !o.name.trim()) { errors.push('An object has no name.'); continue; }
    if (objectNames.has(nameKey(o.name))) errors.push(`Two objects are named ${o.name}.`);
    objectNames.add(nameKey(o.name));
    if (o.type !== 'module' && o.type !== 'subsystem') errors.push(`${o.name} has an unknown type.`);
    if (!isRich(o.description)) errors.push(`${o.name} has an invalid description.`);
    if (!doc.placements.some((p) => p.objectId === o.id)) errors.push(`${o.name} is not placed on any sheet.`);
  }
  for (const p of doc.placements) {
    const o = byId(doc.objects, p.objectId);
    if (!o) { errors.push('A placement refers to a missing object.'); continue; }
    if (!sheetOk(p.sheetId)) errors.push(`${o.name} is on a missing sheet.`);
    if (!finite(p.x, p.y, p.w, p.h) || p.w < 1 || p.h < 1) errors.push(`${o.name} has an invalid position or size.`);
    if (o.type === 'subsystem' && contains(doc, o.id, p.sheetId)) errors.push(`${o.name} would be inside itself.`);
  }
  for (const u of doc.unknownLoads) {
    if (!sheetOk(u.sheetId) || !finite(u.x, u.y)) errors.push('An unknown load is on a missing sheet.');
  }
  for (const n of doc.notes) {
    if (!sheetOk(n.sheetId) || !finite(n.x, n.y, n.w, n.h) || n.w < 1 || n.h < 1 || !isRich(n.text) || !plainText(n.text).trim()) {
      errors.push('A text note is invalid.');
    }
  }
  for (const j of doc.junctions) {
    if (!sheetOk(j.sheetId) || !finite(j.x, j.y)) errors.push('A wire branch point is on a missing sheet.');
  }
  for (const b of doc.bundles) {
    const pointsOk = Array.isArray(b.points) && b.points.length >= 2 && b.points.every((q) => Number.isInteger(q?.x) && Number.isInteger(q?.y));
    if (typeof b.name !== 'string' || !b.name.trim() || !isRich(b.description)) errors.push('A bundle has no name or an invalid description.');
    else if (!sheetOk(b.sheetId)) errors.push(`${b.name} is on a missing sheet.`);
    else if (!pointsOk || !isOrthogonal(b.points) || !pathLength(b.points)) errors.push(`${b.name} needs a path of straight horizontal and vertical legs.`);
  }
  const usedEnds = new Set();
  for (const c of doc.crossings) {
    const outer = byId(doc.bundles, c.outerId);
    const inner = byId(doc.bundles, c.innerId);
    const p = byId(doc.placements, c.placementId);
    if (!outer || !inner || outer === inner || !p || !isSubsystem(p.objectId)) { errors.push('A bundle crossing refers to a missing bundle or subsystem.'); continue; }
    if (outer.sheetId !== p.sheetId || inner.sheetId !== p.objectId) errors.push(`${outer.name} crosses into a subsystem from the wrong sheet.`);
    if (![0, 1].includes(c.outerEnd) || ![0, 1].includes(c.innerEnd) || !SIDES.includes(c.side) || !(c.offset >= 0 && c.offset <= 1)) errors.push(`${outer.name} has an invalid subsystem crossing.`);
    for (const key of [`${c.outerId}/${c.outerEnd}`, `${c.innerId}/${c.innerEnd}`]) {
      if (usedEnds.has(key)) errors.push(`${outer.name} has two crossings at one end.`);
      usedEnds.add(key);
    }
  }
  if (errors.length) return errors;

  const wireNames = new Set();
  for (const w of doc.wires) {
    if (typeof w.name !== 'string' || !w.name.trim()) { errors.push('A wire has no name.'); continue; }
    if (wireNames.has(nameKey(w.name))) errors.push(`Two wires are named ${w.name}.`);
    wireNames.add(nameKey(w.name));
    if (w.direction !== 'directed' && w.direction !== 'bidirectional') errors.push(`${w.name} has an unknown direction.`);
    if (!isRich(w.description)) errors.push(`${w.name} has an invalid description.`);
    if (w.universal !== undefined && w.universal !== true) errors.push(`${w.name} has an invalid universal setting.`);
    if (w.universal && w.direction !== 'bidirectional') errors.push(`${w.name} is universal, so it must be bidirectional.`);
  }
  const viaKeys = new Set();
  for (const v of doc.vias) {
    const w = byId(doc.wires, v.wireId);
    if (!w) { errors.push('A via refers to a missing wire.'); continue; }
    if (!isSubsystem(v.subsystemId)) { errors.push(`A ${w.name} via is in a missing subsystem.`); continue; }
    const directionOk = w.direction === 'bidirectional' ? v.direction === 'bi' : v.direction === 'in' || v.direction === 'out';
    if (!directionOk) errors.push(`${w.name} has a via with the wrong direction.`);
    if (v.crossingId) {
      const c = byId(doc.crossings, v.crossingId);
      if (!c || byId(doc.placements, c.placementId)?.objectId !== v.subsystemId) errors.push(`${w.name} crosses into a subsystem with a bundle that isn't there.`);
    }
    const key = `${v.wireId}/${v.subsystemId}/${v.direction}/${v.crossingId ?? ''}`;
    if (viaKeys.has(key)) errors.push(`${w.name} has two ${v.direction} vias in ${byId(doc.objects, v.subsystemId).name}.`);
    viaKeys.add(key);
    if (!finite(v.x, v.y) || !SIDES.includes(v.portSide) || !(v.portOffset >= 0 && v.portOffset <= 1)) {
      errors.push(`${w.name} has a via with an invalid position.`);
    }
  }
  for (const t of doc.taps) {
    const b = byId(doc.bundles, t.bundleId);
    const w = byId(doc.wires, t.wireId);
    if (!b || !w) { errors.push('A bundle tap refers to a missing bundle or wire.'); continue; }
    if (!(t.at >= 0 && t.at <= pathLength(b.points))) errors.push(`${w.name} enters or leaves ${b.name} past its end.`);
  }
  for (const s of doc.segments) {
    const w = byId(doc.wires, s.wireId);
    if (!w) { errors.push('A segment refers to a missing wire.'); continue; }
    if (!sheetOk(s.sheetId)) { errors.push(`A ${w.name} segment is on a missing sheet.`); continue; }
    for (const ep of [s.from, s.to]) {
      const problem = endpointProblem(doc, s, ep);
      if (problem) errors.push(`${w.name}: ${problem}.`);
    }
  }
  if (errors.length) return errors;

  for (const u of doc.unknownLoads) {
    if (doc.segments.filter((s) => touchesUnknown(s, u.id)).length > 1) errors.push('An unknown load has more than one segment.');
  }
  for (const v of doc.vias) {
    if (!doc.segments.some((s) => touchesVia(s, v.id))) errors.push(`${byId(doc.wires, v.wireId).name} has a via with no segments.`);
  }
  for (const t of doc.taps) {
    if (!doc.segments.some((s) => touchesTap(s, t.id))) errors.push(`${byId(doc.wires, t.wireId).name} has a bundle tap with no segments.`);
  }
  for (const j of doc.junctions) {
    const segs = doc.segments.filter((s) => touchesJunction(s, j.id));
    const wires = new Set(segs.map((s) => s.wireId));
    if (segs.length < 2 || wires.size !== 1) { errors.push('A wire branch point must join segments of one wire.'); continue; }
    const w = byId(doc.wires, segs[0].wireId);
    if (w.direction === 'directed') errors.push(`${w.name} is directed, so it can't branch partway along a wire.`);
  }
  for (const w of doc.wires) errors.push(...treeProblems(doc, w));
  return errors;
}

function endpointProblem(doc, seg, ep) {
  if (!ep) return 'a segment is missing an end';
  if (ep.kind === 'module' && (ep.side !== undefined || ep.offset !== undefined) && (!SIDES.includes(ep.side) || !(ep.offset >= 0 && ep.offset <= 1))) {
    return 'a segment is attached to an invalid spot on a module';
  }
  if (ep.kind === 'module' || ep.kind === 'port') {
    const p = byId(doc.placements, ep.placementId);
    if (!p) return 'a segment ends at a missing placement';
    if (p.sheetId !== seg.sheetId) return 'a segment ends on a different sheet';
    const o = byId(doc.objects, p.objectId);
    if (ep.kind === 'module') return o.type === 'module' ? null : `${o.name} is not a module`;
    const v = byId(doc.vias, ep.viaId);
    if (o.type !== 'subsystem' || !v || v.subsystemId !== o.id || v.wireId !== seg.wireId) return `a port on ${o.name} has no matching via`;
    return null;
  }
  if (ep.kind === 'unknown') {
    const u = byId(doc.unknownLoads, ep.unknownId);
    if (!u) return 'a segment ends at a missing unknown load';
    return u.sheetId === seg.sheetId ? null : 'a segment ends on a different sheet';
  }
  if (ep.kind === 'junction') {
    const j = byId(doc.junctions, ep.junctionId);
    if (!j) return 'a segment ends at a missing branch point';
    return j.sheetId === seg.sheetId ? null : 'a segment ends at a branch point on a different sheet';
  }
  if (ep.kind === 'tap') {
    const t = byId(doc.taps, ep.tapId);
    if (!t || t.wireId !== seg.wireId) return 'a segment ends at a missing bundle tap';
    return byId(doc.bundles, t.bundleId)?.sheetId === seg.sheetId ? null : 'a segment ends at a bundle on a different sheet';
  }
  if (ep.kind === 'via') {
    const v = byId(doc.vias, ep.viaId);
    if (!v || v.wireId !== seg.wireId) return 'a segment ends at a missing via';
    return v.subsystemId === seg.sheetId ? null : 'a segment ends at a via on a different sheet';
  }
  return 'a segment has an unknown kind of end';
}

function treeProblems(doc, w) {
  const edges = wireEdges(doc, w.id);
  if (!edges.length) return [`${w.name} has no segments.`];
  for (const e of edges) if (e.a === e.b) return [`${w.name} would connect ${nodeName(doc, e.a)} to itself.`];
  const comps = components(edges);
  // A universal wire (like ground) is connected everywhere, so its pieces needn't
  // touch; each piece is still a tree.
  if (comps.length > 1 && !w.universal) return [`${w.name} would be split into ${comps.length} disconnected pieces.`];
  const nodes = comps.reduce((n, c) => n + c.nodes.size, 0);
  if (nodes !== edges.length + comps.length) return [`${w.name} would form a loop.`];
  if (w.direction === 'directed') {
    const incoming = new Map();
    for (const e of edges) {
      if (incoming.has(e.b)) return [`${w.name} would have two segments arriving at ${nodeName(doc, e.b)}.`];
      incoming.set(e.b, e);
    }
    // An in-via is fed from the parent sheet, an out-via from inside its subsystem.
    for (const v of doc.vias.filter((v) => v.wireId === w.id)) {
      const e = incoming.get('v:' + v.id);
      if (e && (v.direction === 'in') !== (e.seg.to.kind === 'port')) {
        return [`${w.name} arrives at its ${v.direction} via in ${byId(doc.objects, v.subsystemId).name} from the wrong side.`];
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Commands

export function apply(doc, command) {
  const next = structuredClone(doc);
  try {
    const handler = commands[command.type] || fail(`Unknown command ${command.type}.`);
    const result = handler(next, command) || {};
    tidyJunctions(next);
    attachCrossings(next);
    const problems = validate(next);
    if (problems.length) return { error: problems[0] };
    return { doc: next, ...result };
  } catch (e) {
    if (e instanceof ModelError) return { error: e.message };
    throw e;
  }
}

const snapRect = (x, y, w, h) => ({
  x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)),
});

function checkSheet(doc, sheetId) {
  if (sheetId !== 'root' && byId(doc.objects, sheetId)?.type !== 'subsystem') fail('That sheet no longer exists.');
}

// Find the entity a new placement refers to, creating it if the name is new.
function placeObject(doc, sheetId, name, type) {
  const clean = String(name ?? '').trim();
  if (!clean) fail('Give it a name.');
  checkSheet(doc, sheetId);
  let obj = objectByName(doc, clean);
  if (obj && obj.type !== type) fail(`${obj.name} already exists as a ${obj.type}.`);
  if (!obj) {
    obj = { id: newId(), name: clean, type, color: DEFAULT_OBJECT_COLOR, description: '' };
    doc.objects.push(obj);
  }
  if (type === 'subsystem' && contains(doc, obj.id, sheetId)) fail(`Can't place ${obj.name} inside itself.`);
  return obj;
}

function placementOn(doc, sheetId, placementId) {
  const p = byId(doc.placements, placementId);
  if (!p || p.sheetId !== sheetId) fail('That box is not on this sheet.');
  return p;
}

// The nearest offset to `offset` on a subsystem's side that keeps a new port
// about 0.8 grid units (16 px) from the ports already there, so wires don't
// arrive on top of each other. `length` is the side's length in grid units.
function freePortOffset(doc, subsystemId, side, offset, length) {
  const taken = doc.vias.filter((v) => v.subsystemId === subsystemId && v.portSide === side && !v.crossingId).map((v) => v.portOffset);
  const step = Math.min(0.5, 0.8 / Math.max(1, Number(length) || 1));
  for (let k = 0; k <= 12; k++) {
    for (const o of k ? [offset + k * step, offset - k * step] : [offset]) {
      if (o < 0.05 || o > 0.95) continue;
      if (taken.every((t) => Math.abs(t - o) >= step * 0.99)) return o;
    }
  }
  return offset;
}

// Vias for a (wire, subsystem) pair. `side` is where the segment is drawn:
// 'parent' (at a port on the subsystem box) or 'inside' (at the sheet boundary).
function findOrCreateVia(doc, wire, subsystemId, side, role, pos) {
  const mine = doc.vias.filter((v) => v.wireId === wire.id && v.subsystemId === subsystemId && !v.crossingId);
  const find = (d) => mine.find((v) => v.direction === d);
  let via;
  if (wire.direction === 'bidirectional') via = find('bi');
  else if (side === 'parent') via = role === 'to' ? find('in') : find('out') || find('in');
  else via = role === 'to' ? find('out') : find('in') || find('out');
  if (via) return via;

  let direction = 'bi';
  if (wire.direction === 'directed') direction = (side === 'parent') === (role === 'to') ? 'in' : 'out';
  const n = doc.vias.filter((v) => v.subsystemId === subsystemId).length;
  via = {
    id: newId(), wireId: wire.id, subsystemId, direction,
    x: side === 'inside' ? Math.round(pos.x) : direction === 'out' ? 30 : 2,
    y: side === 'inside' ? Math.round(pos.y) : 2 + 3 * n,
    portSide: side === 'parent' && SIDES.includes(pos.side) ? pos.side : direction === 'out' ? 'right' : 'left',
    portOffset: side === 'parent' ? freePortOffset(doc, subsystemId, pos.side, clamp01(pos.offset), pos.length) : PORT_SPREAD[n % PORT_SPREAD.length],
  };
  doc.vias.push(via);
  return via;
}

// Turn a UI drop target into a segment endpoint, creating vias/unknowns as needed.
function resolveTarget(doc, sheetId, t, role, wire) {
  switch (t?.kind) {
    case 'module': {
      const p = placementOn(doc, sheetId, t.placementId);
      if (byId(doc.objects, p.objectId).type !== 'module') fail('That box is not a module.');
      return { kind: 'module', placementId: p.id };
    }
    case 'subsystem': {
      const p = placementOn(doc, sheetId, t.placementId);
      if (byId(doc.objects, p.objectId).type !== 'subsystem') fail('That box is not a subsystem.');
      const length = t.side === 'top' || t.side === 'bottom' ? p.w : p.h;
      const via = findOrCreateVia(doc, wire, p.objectId, 'parent', role, { ...t, length });
      return { kind: 'port', placementId: p.id, viaId: via.id };
    }
    case 'port': {
      const v = byId(doc.vias, t.viaId);
      const p = placementOn(doc, sheetId, t.placementId);
      if (v && v.wireId === wire.id && v.subsystemId === p.objectId) return { kind: 'port', placementId: p.id, viaId: v.id };
      return resolveTarget(doc, sheetId, { kind: 'subsystem', placementId: p.id, side: v?.portSide, offset: v?.portOffset }, role, wire);
    }
    case 'unknown': {
      const u = byId(doc.unknownLoads, t.unknownId);
      if (!u || u.sheetId !== sheetId) fail('That unknown load is not on this sheet.');
      return { kind: 'unknown', unknownId: u.id };
    }
    case 'newUnknown': {
      checkSheet(doc, sheetId);
      const u = { id: newId(), sheetId, x: Math.round(t.x), y: Math.round(t.y) };
      doc.unknownLoads.push(u);
      return { kind: 'unknown', unknownId: u.id };
    }
    case 'via': {
      const v = byId(doc.vias, t.viaId);
      if (v && v.wireId === wire.id && v.subsystemId === sheetId) return { kind: 'via', viaId: v.id };
      return resolveTarget(doc, sheetId, { kind: 'boundary', x: v?.x ?? 0, y: v?.y ?? 0 }, role, wire);
    }
    case 'boundary': {
      if (sheetId === 'root') fail('The root sheet has no boundary.');
      checkSheet(doc, sheetId);
      const via = findOrCreateVia(doc, wire, sheetId, 'inside', role, t);
      return { kind: 'via', viaId: via.id };
    }
    case 'bundle': {
      // Ending on a bundle puts the wire in there. Starting on one pulls a wire
      // that is already inside out there: it runs inside from its nearest tap.
      const b = byId(doc.bundles, t.bundleId);
      if (!b || b.sheetId !== sheetId) fail('That bundle is not on this sheet.');
      const at = Math.min(Math.max(0, Math.round(Number(t.at) || 0)), pathLength(b.points));
      const tap = { id: newId(), bundleId: b.id, wireId: wire.id, at };
      if (role === 'to') {
        doc.taps.push(tap);
        return { kind: 'tap', tapId: tap.id };
      }
      // The wire's nearest tap anywhere along the chain (across subsystem edges).
      const chain = bundleChain(doc, b.id);
      const itemOf = (bundleId) => chain.items.findIndex((i) => i.bundle.id === bundleId);
      const along = (bundleId, pos) => {
        const it = chain.items[itemOf(bundleId)];
        return it.offset + (it.reversed ? it.length - pos : pos);
      };
      const mine = doc.taps.filter((x) => itemOf(x.bundleId) >= 0 && x.wireId === wire.id);
      if (!mine.length) fail(`${wire.name} isn't in ${b.name}. Draw it onto the bundle to put it in first.`);
      const here = along(b.id, at);
      const near = mine.reduce((best, x) => (Math.abs(along(x.bundleId, x.at) - here) < Math.abs(along(best.bundleId, best.at) - here) ? x : best));
      const run = (sheet, from, to) => doc.segments.push({ id: newId(), wireId: wire.id, sheetId: sheet, from, to });
      const tapEp = (x) => ({ kind: 'tap', tapId: x.id });
      // Walk from the nearest tap's bundle to this one, crossing each subsystem edge between.
      let last = near;
      const i1 = itemOf(b.id);
      for (let i = itemOf(near.bundleId); i !== i1; i += Math.sign(i1 - i)) {
        const step = Math.sign(i1 - i);
        const P = chain.items[i];
        const Q = chain.items[i + step];
        const exitEnd = (step > 0) !== P.reversed ? 1 : 0;
        const entryEnd = (step > 0) !== Q.reversed ? 0 : 1;
        const out = { id: newId(), bundleId: P.bundle.id, wireId: wire.id, at: exitEnd ? P.length : 0 };
        const into = { id: newId(), bundleId: Q.bundle.id, wireId: wire.id, at: entryEnd ? Q.length : 0 };
        doc.taps.push(out, into);
        run(P.bundle.sheetId, tapEp(last), tapEp(out));
        const c = chain.joints[Math.min(i, i + step)].crossing;
        const inward = c.outerId === P.bundle.id;
        const placement = byId(doc.placements, c.placementId);
        const via = {
          id: newId(), wireId: wire.id, subsystemId: placement.objectId, crossingId: c.id,
          direction: wire.direction === 'bidirectional' ? 'bi' : inward ? 'in' : 'out',
          x: 0, y: 0, portSide: c.side, portOffset: c.offset,
        };
        doc.vias.push(via);
        const port = { kind: 'port', placementId: placement.id, viaId: via.id };
        const inside = { kind: 'via', viaId: via.id };
        if (inward) {
          run(placement.sheetId, tapEp(out), port);
          run(placement.objectId, inside, tapEp(into));
        } else {
          run(placement.objectId, tapEp(out), inside);
          run(placement.sheetId, port, tapEp(into));
        }
        last = into;
      }
      doc.taps.push(tap);
      run(sheetId, tapEp(last), tapEp(tap));
      return { kind: 'tap', tapId: tap.id, pulledOut: true };
    }
    case 'branch': {
      // Branching partway along a wire: split the segment at a new branch point.
      const seg = byId(doc.segments, t.segmentId);
      if (!seg || seg.sheetId !== sheetId) fail('That wire is not on this sheet.');
      const other = byId(doc.wires, seg.wireId);
      if (other.id !== wire.id) fail(`That line is ${other.name}; a branch from it has to be ${other.name} too.`);
      if (wire.direction === 'directed') fail(`${wire.name} is directed, so it can't branch partway along. Branch it from a module or via instead.`);
      const j = { id: newId(), sheetId, x: Number(t.x) || 0, y: Number(t.y) || 0 };
      doc.junctions.push(j);
      const point = { kind: 'junction', junctionId: j.id };
      doc.segments.push({ id: newId(), wireId: wire.id, sheetId, from: point, to: seg.to });
      seg.to = point;
      return { ...point, branched: true };
    }
    case 'junction': {
      const j = byId(doc.junctions, t.junctionId);
      if (!j || j.sheetId !== sheetId) fail('That branch point is not on this sheet.');
      const on = doc.segments.find((s) => touchesJunction(s, j.id));
      if (on && on.wireId !== wire.id) fail(`That branch point is on ${byId(doc.wires, on.wireId).name}, not ${wire.name}.`);
      return { kind: 'junction', junctionId: j.id };
    }
    case 'tap': {
      const tp = byId(doc.taps, t.tapId);
      const b = tp && byId(doc.bundles, tp.bundleId);
      if (!b || b.sheetId !== sheetId) fail('That bundle is not on this sheet.');
      if (tp.wireId !== wire.id) fail(`That point on ${b.name} is where ${byId(doc.wires, tp.wireId).name} goes in or out, not ${wire.name}.`);
      return { kind: 'tap', tapId: tp.id };
    }
  }
  return fail('Draw between modules, subsystems, unknown loads, bundles or the sheet boundary.');
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}

// Remove anything that refers to something that no longer exists.
function sweep(doc) {
  const size = () => Object.values(doc).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  let before;
  do {
    before = size();
    const objectIds = new Set(doc.objects.map((o) => o.id));
    const sheetOk = (id) => id === 'root' || objectIds.has(id);
    doc.placements = doc.placements.filter((p) => objectIds.has(p.objectId) && sheetOk(p.sheetId));
    const placed = new Set(doc.placements.map((p) => p.objectId));
    doc.objects = doc.objects.filter((o) => placed.has(o.id));
    doc.unknownLoads = doc.unknownLoads.filter((u) => sheetOk(u.sheetId));
    doc.notes = doc.notes.filter((n) => sheetOk(n.sheetId));
    doc.vias = doc.vias.filter((v) => objectIds.has(v.subsystemId));
    doc.bundles = doc.bundles.filter((b) => sheetOk(b.sheetId));
    doc.crossings = doc.crossings.filter((c) => byId(doc.bundles, c.outerId) && byId(doc.bundles, c.innerId) && byId(doc.placements, c.placementId));
    doc.vias = doc.vias.filter((v) => !v.crossingId || byId(doc.crossings, v.crossingId));
    doc.taps = doc.taps.filter((t) => byId(doc.bundles, t.bundleId));
    doc.junctions = doc.junctions.filter((j) => sheetOk(j.sheetId));
    const exists = (ep) => {
      if (ep.kind === 'junction') return !!byId(doc.junctions, ep.junctionId);
      if (ep.kind === 'module') return !!byId(doc.placements, ep.placementId);
      if (ep.kind === 'tap') return !!byId(doc.taps, ep.tapId);
      if (ep.kind === 'unknown') return !!byId(doc.unknownLoads, ep.unknownId);
      if (ep.kind === 'via') return !!byId(doc.vias, ep.viaId);
      return !!byId(doc.placements, ep.placementId) && !!byId(doc.vias, ep.viaId);
    };
    doc.segments = doc.segments.filter((s) => sheetOk(s.sheetId) && exists(s.from) && exists(s.to));
  } while (size() !== before);
}

const directedRoots = (doc) =>
  new Map(doc.wires.filter((w) => w.direction === 'directed').map((w) => [w.id, wireOrigin(doc, w.id)]));

// After segments are removed, keep only the part of each wire that is still
// attached: the origin's side for directed wires, the largest piece otherwise.
function prune(doc, roots) {
  for (const w of doc.wires) {
    const comps = components(wireEdges(doc, w.id));
    if (w.universal) continue; // every piece of a universal wire stays
    const keep = w.direction === 'directed'
      ? comps.find((c) => c.nodes.has(roots.get(w.id)))
      : comps.sort((a, b) => b.edges.size - a.edges.size)[0];
    const kept = new Set([...(keep?.edges ?? [])].map((e) => e.seg));
    doc.segments = doc.segments.filter((s) => s.wireId !== w.id || kept.has(s));
  }
  doc.vias = doc.vias.filter((v) => doc.segments.some((s) => touchesVia(s, v.id)));
  doc.taps = doc.taps.filter((t) => doc.segments.some((s) => touchesTap(s, t.id)));
  doc.wires = doc.wires.filter((w) => doc.segments.some((s) => s.wireId === w.id));
}

function remapVia(doc, fromViaId, toViaId) {
  for (const s of doc.segments) {
    for (const ep of [s.from, s.to]) if ((ep.kind === 'via' || ep.kind === 'port') && ep.viaId === fromViaId) ep.viaId = toViaId;
  }
  doc.vias = doc.vias.filter((v) => v.id !== fromViaId);
}

function rename(doc, item, name, findExisting) {
  const clean = String(name).trim();
  if (!clean) fail('Names cannot be empty.');
  const other = findExisting(doc, clean);
  if (other && other !== item) fail(`${other.name} already exists.`);
  item.name = clean;
}

// Replace one bundle's taps with direct connections (see deleteBundle).
function dissolveBundle(doc, bundle) {
  const id = bundle.id;
  for (const w of doc.wires) {
    const taps = new Set(doc.taps.filter((t) => t.bundleId === id && t.wireId === w.id).map((t) => 't:' + t.id));
    if (!taps.size) continue;
    const edges = wireEdges(doc, w.id);
    const inner = edges.filter((e) => taps.has(e.a) && taps.has(e.b));
    const outer = edges.filter((e) => taps.has(e.a) !== taps.has(e.b));
    // Group the taps joined by runs inside the bundle.
    const group = new Map([...taps].map((t) => [t, t]));
    const find = (t) => (group.get(t) === t ? t : find(group.get(t)));
    for (const e of inner) group.set(find(e.a), find(e.b));
    const added = [];
    for (const root of new Set([...taps].map(find))) {
      const ends = outer
        .filter((e) => find(taps.has(e.a) ? e.a : e.b) === root)
        .map((e) => ({ ep: taps.has(e.a) ? e.seg.to : e.seg.from, entering: taps.has(e.b), tap: taps.has(e.a) ? e.a : e.b }));
      if (ends.length === 1) {
        const [only] = ends;
        const pos = pointAt(bundle.points, byId(doc.taps, only.tap.slice(2)).at);
        const u = { id: newId(), sheetId: bundle.sheetId, x: Math.floor(pos.x), y: Math.floor(pos.y) };
        doc.unknownLoads.push(u);
        const end = { kind: 'unknown', unknownId: u.id };
        added.push({ id: newId(), wireId: w.id, sheetId: bundle.sheetId, from: only.entering ? only.ep : end, to: only.entering ? end : only.ep });
        continue;
      }
      if (ends.length < 2) continue;
      // Directed: from where it entered to each place it left. Otherwise: from one end to the rest.
      let hub = w.direction === 'directed' ? ends.find((x) => x.entering) : null;
      hub ||= ends.find((x) => x.ep.kind !== 'unknown') || ends[0];
      const rest = ends.filter((x) => x !== hub);
      if (hub.ep.kind === 'unknown' && rest.length > 1) {
        fail(`Can't remove ${bundle.name}: an unknown load feeds ${w.name} to several places through it. Promote the unknown load first.`);
      }
      for (const x of rest) added.push({ id: newId(), wireId: w.id, sheetId: bundle.sheetId, from: hub.ep, to: x.ep });
    }
    const gone = new Set([...inner, ...outer].map((e) => e.seg));
    doc.segments = doc.segments.filter((s) => !gone.has(s)).concat(added);
  }
  doc.taps = doc.taps.filter((t) => t.bundleId !== id);
}

const commands = {
  addObject(doc, { sheetId, name, objectType, x, y, w = 6, h = 3 }) {
    if (objectType !== 'module' && objectType !== 'subsystem') fail('Unknown object type.');
    const obj = placeObject(doc, sheetId, name, objectType);
    const p = { id: newId(), objectId: obj.id, sheetId, ...snapRect(x, y, w, h) };
    doc.placements.push(p);
    return { id: p.id };
  },

  movePlacement(doc, { id, x, y, w, h }) {
    const p = get(doc.placements, id);
    Object.assign(p, snapRect(x ?? p.x, y ?? p.y, w ?? p.w, h ?? p.h));
  },

  addUnknown(doc, { sheetId, x, y }) {
    checkSheet(doc, sheetId);
    const u = { id: newId(), sheetId, x: Math.round(x), y: Math.round(y) };
    doc.unknownLoads.push(u);
    return { id: u.id };
  },

  moveUnknown(doc, { id, x, y }) {
    Object.assign(get(doc.unknownLoads, id), { x: Math.round(x), y: Math.round(y) });
  },

  moveVia(doc, { id, x, y }) {
    Object.assign(get(doc.vias, id), { x: Math.round(x), y: Math.round(y) });
  },

  movePort(doc, { id, side, offset }) {
    if (!SIDES.includes(side)) fail('Unknown side.');
    Object.assign(get(doc.vias, id), { portSide: side, portOffset: clamp01(offset) });
  },

  drawSegment(doc, { sheetId, from, to, wire: spec }) {
    const name = String(spec?.name ?? '').trim();
    if (!name) fail('Give the wire a name.');
    let wire = wireByName(doc, name);
    const isNew = !wire;
    if (isNew) {
      wire = {
        id: newId(), name, color: spec.color || DEFAULT_WIRE_COLOR, description: '',
        direction: spec.direction === 'bidirectional' || spec.universal ? 'bidirectional' : 'directed',
      };
      if (spec.universal) wire.universal = true;
      doc.wires.push(wire);
    }
    const reached = new Set(wireEdges(doc, wire.id).flatMap((e) => [e.a, e.b]));
    const a = resolveTarget(doc, sheetId, from, 'from', wire);
    // Pulling a wire out of a bundle, or branching from partway along it, starts
    // (or ends) where the wire already is.
    for (const ep of [a]) {
      if (ep.pulledOut || ep.branched) reached.add(endpointNode(doc, ep));
      delete ep.pulledOut;
      delete ep.branched;
    }
    const b = resolveTarget(doc, sheetId, to, 'to', wire);
    if (b.branched) reached.add(endpointNode(doc, b));
    delete b.branched;
    if (tapBundle(doc, a) && tapBundle(doc, a) === tapBundle(doc, b)) fail('Pull the wire out somewhere off the bundle.');
    const na = endpointNode(doc, a);
    const nb = endpointNode(doc, b);
    if (na === nb) fail(`A wire can't connect ${nodeName(doc, na)} to itself.`);
    for (const ep of [a, b]) {
      if (ep.kind === 'unknown' && doc.segments.some((s) => touchesUnknown(s, ep.unknownId))) {
        fail('An unknown load can only end one wire. Promote it to a module to continue from it.');
      }
    }
    // A universal wire can be drawn anywhere; it is assumed connected everywhere.
    if (!isNew && !wire.universal) {
      const ra = reached.has(na);
      const rb = reached.has(nb);
      const extendable = listNames([...reached].filter((n) => !n.startsWith('u:')).map((n) => nodeName(doc, n)).slice(0, 4));
      if (ra && rb) fail(`${wire.name} already reaches both ${nodeName(doc, na)} and ${nodeName(doc, nb)}; another segment would form a loop.`);
      if (!ra && !rb) fail(`${wire.name} doesn't reach ${nodeName(doc, na)} or ${nodeName(doc, nb)}. Extend it from ${extendable || 'its existing ends'}, or use a new wire name.`);
      if (wire.direction === 'directed' && !ra) fail(`${wire.name} is directed: start the segment where it already is (${extendable}) and draw toward the new end.`);
    }
    const seg = { id: newId(), wireId: wire.id, sheetId, from: a, to: b };
    doc.segments.push(seg);
    return { id: seg.id, wireId: wire.id };
  },

  editObject(doc, { id, name, color, description }) {
    const o = get(doc.objects, id);
    if (name !== undefined) rename(doc, o, name, objectByName);
    if (color !== undefined) o.color = color;
    if (description !== undefined) o.description = cleanRich(description);
  },

  // universal: true makes a wire universal (and bidirectional); false makes it
  // ordinary again, which needs all its pieces joined into one.
  editWire(doc, { id, name, color, description, universal }) {
    const w = get(doc.wires, id);
    if (name !== undefined) rename(doc, w, name, wireByName);
    if (color !== undefined) w.color = color;
    if (description !== undefined) w.description = cleanRich(description);
    if (universal === true && !w.universal) {
      if (w.direction === 'directed') commands.setDirection(doc, { wireId: w.id, direction: 'bidirectional' });
      w.universal = true;
    }
    if (universal === false && w.universal) {
      const pieces = components(wireEdges(doc, w.id)).length;
      if (pieces > 1) fail(`${w.name} is in ${pieces} separate pieces, so it has to stay universal until they're joined.`);
      delete w.universal;
    }
  },

  mergeObjects(doc, { fromId, intoId }) {
    const a = get(doc.objects, fromId);
    const b = get(doc.objects, intoId);
    if (a === b) fail('Nothing to merge.');
    if (a.type !== b.type) fail(`Can't merge a ${a.type} into a ${b.type}.`);
    if (a.type === 'subsystem') {
      const busy = doc.placements.some((p) => p.sheetId === a.id) || doc.unknownLoads.some((u) => u.sheetId === a.id) || doc.vias.some((v) => v.subsystemId === a.id);
      if (busy) fail(`Only an empty subsystem can be merged away, and ${a.name}'s sheet has content.`);
    }
    for (const p of doc.placements) if (p.objectId === a.id) p.objectId = b.id;
    doc.objects = doc.objects.filter((o) => o !== a);
  },

  mergeWires(doc, { fromId, intoId }) {
    const a = get(doc.wires, fromId);
    const b = get(doc.wires, intoId);
    if (a === b) fail('Nothing to merge.');
    if (a.direction !== b.direction) fail(`Make ${a.name} and ${b.name} the same direction before merging.`);
    if (a.universal) b.universal = true;
    for (const v of doc.vias.filter((v) => v.wireId === a.id)) {
      const twin = doc.vias.find((o) => o.wireId === b.id && o.subsystemId === v.subsystemId && o.direction === v.direction && o.crossingId === v.crossingId);
      if (twin) remapVia(doc, v.id, twin.id);
      else v.wireId = b.id;
    }
    for (const s of doc.segments) if (s.wireId === a.id) s.wireId = b.id;
    for (const t of doc.taps) if (t.wireId === a.id) t.wireId = b.id;
    doc.wires = doc.wires.filter((w) => w !== a);
  },

  setDirection(doc, { wireId, direction, origin }) {
    const w = get(doc.wires, wireId);
    if (w.direction === direction) return;
    if (direction === 'directed' && w.universal) fail(`${w.name} is universal, so it is always bidirectional.`);
    if (direction === 'directed' && doc.segments.some((s) => s.wireId === w.id && (s.from.kind === 'junction' || s.to.kind === 'junction'))) {
      fail(`${w.name} branches partway along, which directed wires can't. Remove those branches first.`);
    }
    if (direction === 'bidirectional') {
      w.direction = 'bidirectional';
      for (const v of doc.vias.filter((v) => v.wireId === w.id)) {
        if (!byId(doc.vias, v.id)) continue;
        const twin = doc.vias.find((o) => o !== v && o.wireId === w.id && o.subsystemId === v.subsystemId && o.crossingId === v.crossingId);
        if (twin) {
          // A segment straight from the in-via to the out-via would become a self-loop; drop it.
          doc.segments = doc.segments.filter((s) => !(touchesVia(s, v.id) && touchesVia(s, twin.id)));
          remapVia(doc, twin.id, v.id);
        }
        v.direction = 'bi';
      }
      const problem = treeProblems(doc, w)[0];
      if (problem) fail(`Can't make ${w.name} bidirectional: it enters and leaves the same subsystem along different paths (${problem})`);
      return;
    }
    if (direction !== 'directed') fail('Unknown direction.');
    const edges = wireEdges(doc, w.id);
    if (!edges.some((e) => e.a === origin || e.b === origin)) fail(`Pick an origin on ${w.name}.`);
    // Orient every segment away from the origin.
    const done = new Set();
    const queue = [origin];
    while (queue.length) {
      const n = queue.shift();
      for (const e of edges) {
        if (done.has(e) || (e.a !== n && e.b !== n)) continue;
        done.add(e);
        if (e.b === n) [e.seg.from, e.seg.to] = [e.seg.to, e.seg.from];
        queue.push(e.a === n ? e.b : e.a);
      }
    }
    w.direction = 'directed';
    for (const v of doc.vias.filter((v) => v.wireId === w.id)) {
      const incoming = doc.segments.find((s) => (s.to.kind === 'via' || s.to.kind === 'port') && s.to.viaId === v.id);
      if (incoming) v.direction = incoming.to.kind === 'port' ? 'in' : 'out';
      else v.direction = doc.segments.some((s) => s.from.kind === 'port' && s.from.viaId === v.id) ? 'out' : 'in';
    }
  },

  promoteUnknown(doc, { id, name, objectType, w = 6, h = 3 }) {
    if (objectType !== 'module' && objectType !== 'subsystem') fail('Unknown object type.');
    const u = get(doc.unknownLoads, id);
    const obj = placeObject(doc, u.sheetId, name, objectType);
    const p = { id: newId(), objectId: obj.id, sheetId: u.sheetId, ...snapRect(u.x, u.y, w, h) };
    doc.placements.push(p);
    for (const s of doc.segments) {
      for (const end of ['from', 'to']) {
        if (s[end].kind !== 'unknown' || s[end].unknownId !== id) continue;
        if (objectType === 'module') {
          s[end] = { kind: 'module', placementId: p.id };
        } else {
          const wire = byId(doc.wires, s.wireId);
          const via = findOrCreateVia(doc, wire, obj.id, 'parent', end, { side: end === 'to' ? 'left' : 'right', offset: 0.5, length: p.h });
          s[end] = { kind: 'port', placementId: p.id, viaId: via.id };
        }
      }
    }
    doc.unknownLoads = doc.unknownLoads.filter((x) => x !== u);
    return { id: p.id };
  },

  deleteSegment(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.segments, id);
    doc.segments = doc.segments.filter((s) => s.id !== id);
    prune(doc, roots);
  },

  removePlacement(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.placements, id);
    doc.placements = doc.placements.filter((p) => p.id !== id);
    sweep(doc);
    prune(doc, roots);
  },

  deleteObject(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.objects, id);
    doc.objects = doc.objects.filter((o) => o.id !== id);
    sweep(doc);
    prune(doc, roots);
  },

  addNote(doc, { sheetId, x, y, w = 8, h = 2, text }) {
    checkSheet(doc, sheetId);
    const clean = cleanRich(text ?? '');
    if (!plainText(clean).trim()) fail('Type some text.');
    const n = { id: newId(), sheetId, ...snapRect(x, y, w, h), text: clean };
    doc.notes.push(n);
    return { id: n.id };
  },

  moveNote(doc, { id, x, y, w, h }) {
    const n = get(doc.notes, id);
    Object.assign(n, snapRect(x ?? n.x, y ?? n.y, w ?? n.w, h ?? n.h));
  },

  // Clearing a note's text deletes it. `h` optionally resizes it to fit.
  editNote(doc, { id, text, h }) {
    const n = get(doc.notes, id);
    const clean = cleanRich(text ?? '');
    if (!plainText(clean).trim()) {
      doc.notes = doc.notes.filter((x) => x !== n);
      return;
    }
    n.text = clean;
    if (h !== undefined) n.h = Math.max(1, Math.round(h));
  },

  // cross: optional [{ end (0 = A, 1 = B), placementId, side, offset }]: that end
  // plugs into a subsystem box on this sheet, and the bundle carries on inside it
  // from a bundle via near the subsystem sheet's left edge.
  addBundle(doc, { sheetId, points, cross = [] }) {
    checkSheet(doc, sheetId);
    const clean = cleanPoints(points ?? []);
    if (clean.length < 2) fail('A bundle needs at least two points.');
    if (!isOrthogonal(clean)) fail('Bundle legs must be horizontal or vertical.');
    let n = doc.bundles.length + 1;
    while (doc.bundles.some((b) => nameKey(b.name) === nameKey(`Bundle ${n}`))) n++;
    const b = { id: newId(), sheetId, name: `Bundle ${n}`, description: '', points: clean };
    doc.bundles.push(b);
    for (const x of cross) {
      const p = placementOn(doc, sheetId, x.placementId);
      if (byId(doc.objects, p.objectId).type !== 'subsystem') fail('A bundle can only go into a subsystem.');
      const k = doc.crossings.filter((c) => byId(doc.placements, c.placementId)?.objectId === p.objectId).length;
      const y = 2 + 3 * k;
      const inner = { id: newId(), sheetId: p.objectId, name: b.name, description: '', points: [{ x: 2, y }, { x: 10, y }] };
      doc.bundles.push(inner);
      doc.crossings.push({ id: newId(), outerId: b.id, outerEnd: x.end ? 1 : 0, innerId: inner.id, innerEnd: 0, placementId: p.id, side: SIDES.includes(x.side) ? x.side : 'left', offset: clamp01(x.offset) });
    }
    return { id: b.id };
  },

  moveBundle(doc, { id, dx, dy }) {
    const b = get(doc.bundles, id);
    b.points = b.points.map((q) => ({ x: q.x + Math.round(dx), y: q.y + Math.round(dy) }));
  },

  // Move one corner or end; taps keep their distance from end A (clamped to the new length).
  // An end plugged into a subsystem box slides around the box's edge instead.
  moveBundlePoint(doc, { id, index, x, y }) {
    const b = get(doc.bundles, id);
    if (!b.points[index]) fail('That bundle point no longer exists.');
    const plugged = doc.crossings.find((c) => c.outerId === b.id && endIndex(b, c.outerEnd) === index);
    if (plugged) {
      Object.assign(plugged, nearestBoxSide(get(doc.placements, plugged.placementId), x, y));
      return;
    }
    b.points = movePoint(b.points, index, Math.round(x), Math.round(y));
    if (b.points.length < 2) fail('A bundle needs at least two points.');
    const length = pathLength(b.points);
    for (const t of doc.taps) if (t.bundleId === b.id) t.at = Math.min(t.at, length);
  },

  // Name and description belong to the whole bundle, across subsystem edges.
  editBundle(doc, { id, name, description }) {
    get(doc.bundles, id);
    if (name !== undefined && !String(name).trim()) fail('Names cannot be empty.');
    const clean = description === undefined ? undefined : cleanRich(description);
    for (const { bundle } of bundleChain(doc, id).items) {
      if (name !== undefined) bundle.name = String(name).trim();
      if (clean !== undefined) bundle.description = clean;
    }
  },

  // Deleting a bundle dissolves it: each wire that went through is reconnected
  // directly from where it went in to where it came out. A wire put in but never
  // pulled out ends at a new unknown load where it went in.
  // Across subsystem edges, the whole bundle goes, and the vias that carried
  // its wires across become ordinary vias.
  deleteBundle(doc, { id }) {
    get(doc.bundles, id);
    const chain = bundleChain(doc, id);
    for (const { bundle } of chain.items) dissolveBundle(doc, bundle);
    const crossed = new Set(chain.joints.map((j) => j.crossing.id));
    for (const v of doc.vias.filter((x) => crossed.has(x.crossingId))) {
      delete v.crossingId;
      const twin = doc.vias.find((o) => o !== v && !o.crossingId && o.wireId === v.wireId && o.subsystemId === v.subsystemId && o.direction === v.direction);
      if (twin) remapVia(doc, v.id, twin.id);
    }
    doc.crossings = doc.crossings.filter((c) => !crossed.has(c.id));
    const pieces = new Set(chain.items.map((i) => i.bundle.id));
    doc.bundles = doc.bundles.filter((b) => !pieces.has(b.id));
    sweep(doc);
    prune(doc, directedRoots(doc));
  },

  // Slide a tap along its bundle (whole grid units, within its ends).
  moveTap(doc, { id, at }) {
    const t = get(doc.taps, id);
    if (isCrossingTap(doc, id)) fail('That is where the wire crosses into a subsystem; it follows the bundle.');
    const length = pathLength(get(doc.bundles, t.bundleId).points);
    t.at = Math.min(Math.max(0, Math.round(Number(at) || 0)), length);
  },

  // Remove one place where a wire goes into or out of a bundle, with its segments.
  deleteTap(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.taps, id);
    if (isCrossingTap(doc, id)) fail('That is where the wire crosses into a subsystem; delete where it goes in or comes out instead.');
    doc.segments = doc.segments.filter((s) => !touchesTap(s, id));
    doc.taps = doc.taps.filter((t) => t.id !== id);
    prune(doc, roots);
  },

  // Move where a segment meets a module: a side and how far along it (0..1).
  // Without one, the end picks the side facing the segment's other end.
  setSegmentEnd(doc, { id, end, side, offset }) {
    const seg = get(doc.segments, id);
    const ep = seg[end === 'to' ? 'to' : 'from'];
    if (ep.kind !== 'module') fail('Only wire ends on modules can be moved this way.');
    if (side === undefined) {
      delete ep.side;
      delete ep.offset;
    } else {
      if (!SIDES.includes(side)) fail('Unknown side.');
      Object.assign(ep, { side, offset: clamp01(offset) });
    }
  },

  deleteNote(doc, { id }) {
    get(doc.notes, id);
    doc.notes = doc.notes.filter((n) => n.id !== id);
  },

  deleteUnknown(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.unknownLoads, id);
    doc.unknownLoads = doc.unknownLoads.filter((u) => u.id !== id);
    sweep(doc);
    prune(doc, roots);
  },
};
