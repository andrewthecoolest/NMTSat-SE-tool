// Document model. Every change goes through apply(doc, command), which works on
// a copy and only returns the new document if it still satisfies every invariant.

export const SCHEMA_VERSION = 1;
const DEFAULT_OBJECT_COLOR = '#334155';
const DEFAULT_WIRE_COLOR = '#2563eb';
const SIDES = ['top', 'right', 'bottom', 'left'];
const PORT_SPREAD = [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6];

export function emptyDoc() {
  return { schemaVersion: SCHEMA_VERSION, objects: [], placements: [], unknownLoads: [], wires: [], segments: [], vias: [] };
}

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
// Wire graphs. Nodes are module entities ("m:id"), unknown loads ("u:id") and
// vias ("v:id"); a via and its ports are one node.

export function endpointNode(doc, ep) {
  if (ep.kind === 'module') {
    const p = byId(doc.placements, ep.placementId);
    return p ? 'm:' + p.objectId : null;
  }
  if (ep.kind === 'unknown') return 'u:' + ep.unknownId;
  if (ep.kind === 'port' || ep.kind === 'via') return 'v:' + ep.viaId;
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
  const lists = ['objects', 'placements', 'unknownLoads', 'wires', 'segments', 'vias'];
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
  if (errors.length) return errors;

  const wireNames = new Set();
  for (const w of doc.wires) {
    if (typeof w.name !== 'string' || !w.name.trim()) { errors.push('A wire has no name.'); continue; }
    if (wireNames.has(nameKey(w.name))) errors.push(`Two wires are named ${w.name}.`);
    wireNames.add(nameKey(w.name));
    if (w.direction !== 'directed' && w.direction !== 'bidirectional') errors.push(`${w.name} has an unknown direction.`);
  }
  const viaKeys = new Set();
  for (const v of doc.vias) {
    const w = byId(doc.wires, v.wireId);
    if (!w) { errors.push('A via refers to a missing wire.'); continue; }
    if (!isSubsystem(v.subsystemId)) { errors.push(`A ${w.name} via is in a missing subsystem.`); continue; }
    const directionOk = w.direction === 'bidirectional' ? v.direction === 'bi' : v.direction === 'in' || v.direction === 'out';
    if (!directionOk) errors.push(`${w.name} has a via with the wrong direction.`);
    const key = `${v.wireId}/${v.subsystemId}/${v.direction}`;
    if (viaKeys.has(key)) errors.push(`${w.name} has two ${v.direction} vias in ${byId(doc.objects, v.subsystemId).name}.`);
    viaKeys.add(key);
    if (!finite(v.x, v.y) || !SIDES.includes(v.portSide) || !(v.portOffset >= 0 && v.portOffset <= 1)) {
      errors.push(`${w.name} has a via with an invalid position.`);
    }
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
  for (const w of doc.wires) errors.push(...treeProblems(doc, w));
  return errors;
}

function endpointProblem(doc, seg, ep) {
  if (!ep) return 'a segment is missing an end';
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
  if (comps.length > 1) return [`${w.name} would be split into ${comps.length} disconnected pieces.`];
  if (comps[0].nodes.size !== edges.length + 1) return [`${w.name} would form a loop.`];
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

// Vias for a (wire, subsystem) pair. `side` is where the segment is drawn:
// 'parent' (at a port on the subsystem box) or 'inside' (at the sheet boundary).
function findOrCreateVia(doc, wire, subsystemId, side, role, pos) {
  const mine = doc.vias.filter((v) => v.wireId === wire.id && v.subsystemId === subsystemId);
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
    portOffset: side === 'parent' ? clamp01(pos.offset) : PORT_SPREAD[n % PORT_SPREAD.length],
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
      const via = findOrCreateVia(doc, wire, p.objectId, 'parent', role, t);
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
  }
  return fail('Draw between modules, subsystems, unknown loads or the sheet boundary.');
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
    doc.vias = doc.vias.filter((v) => objectIds.has(v.subsystemId));
    const exists = (ep) => {
      if (ep.kind === 'module') return !!byId(doc.placements, ep.placementId);
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
    const keep = w.direction === 'directed'
      ? comps.find((c) => c.nodes.has(roots.get(w.id)))
      : comps.sort((a, b) => b.edges.size - a.edges.size)[0];
    const kept = new Set([...(keep?.edges ?? [])].map((e) => e.seg));
    doc.segments = doc.segments.filter((s) => s.wireId !== w.id || kept.has(s));
  }
  doc.vias = doc.vias.filter((v) => doc.segments.some((s) => touchesVia(s, v.id)));
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
        direction: spec.direction === 'bidirectional' ? 'bidirectional' : 'directed',
      };
      doc.wires.push(wire);
    }
    const reached = new Set(wireEdges(doc, wire.id).flatMap((e) => [e.a, e.b]));
    const a = resolveTarget(doc, sheetId, from, 'from', wire);
    const b = resolveTarget(doc, sheetId, to, 'to', wire);
    const na = endpointNode(doc, a);
    const nb = endpointNode(doc, b);
    if (na === nb) fail(`A wire can't connect ${nodeName(doc, na)} to itself.`);
    for (const ep of [a, b]) {
      if (ep.kind === 'unknown' && doc.segments.some((s) => touchesUnknown(s, ep.unknownId))) {
        fail('An unknown load can only end one wire. Promote it to a module to continue from it.');
      }
    }
    if (!isNew) {
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
    if (description !== undefined) o.description = description;
  },

  editWire(doc, { id, name, color, description }) {
    const w = get(doc.wires, id);
    if (name !== undefined) rename(doc, w, name, wireByName);
    if (color !== undefined) w.color = color;
    if (description !== undefined) w.description = description;
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
    for (const v of doc.vias.filter((v) => v.wireId === a.id)) {
      const twin = doc.vias.find((o) => o.wireId === b.id && o.subsystemId === v.subsystemId && o.direction === v.direction);
      if (twin) remapVia(doc, v.id, twin.id);
      else v.wireId = b.id;
    }
    for (const s of doc.segments) if (s.wireId === a.id) s.wireId = b.id;
    doc.wires = doc.wires.filter((w) => w !== a);
  },

  setDirection(doc, { wireId, direction, origin }) {
    const w = get(doc.wires, wireId);
    if (w.direction === direction) return;
    if (direction === 'bidirectional') {
      w.direction = 'bidirectional';
      for (const v of doc.vias.filter((v) => v.wireId === w.id)) {
        if (!byId(doc.vias, v.id)) continue;
        const twin = doc.vias.find((o) => o !== v && o.wireId === w.id && o.subsystemId === v.subsystemId);
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
          const via = findOrCreateVia(doc, wire, obj.id, 'parent', end, { side: end === 'to' ? 'left' : 'right', offset: 0.5 });
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

  deleteUnknown(doc, { id }) {
    const roots = directedRoots(doc);
    get(doc.unknownLoads, id);
    doc.unknownLoads = doc.unknownLoads.filter((u) => u.id !== id);
    sweep(doc);
    prune(doc, roots);
  },
};
