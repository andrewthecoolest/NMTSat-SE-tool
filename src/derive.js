// Derived data. Never stored; always computed from the document.
import { byId, wireEdges, wireOrigin } from './model.js';

// Walk from `node` (arriving from `prev`) through vias until reaching modules,
// unknown loads, or a via with nothing beyond it (an open via).
// dir: 'down' follows segment direction, 'up' goes against it, 'any' ignores it.
function terminals(edges, node, prev, dir) {
  if (!node.startsWith('v:')) return [node];
  const next = edges
    .filter((e) => (dir === 'down' ? e.a === node : dir === 'up' ? e.b === node : e.a === node || e.b === node))
    .map((e) => (e.a === node ? e.b : e.a))
    .filter((n) => n !== prev);
  if (!next.length) return [node];
  return next.flatMap((n) => terminals(edges, n, node, dir));
}

export function describeNode(doc, node) {
  const id = node.slice(2);
  if (node.startsWith('m:')) return { name: byId(doc.objects, id)?.name ?? '?', objectId: id, unresolved: false };
  if (node.startsWith('u:')) return { name: 'Unknown load', unresolved: true };
  const via = byId(doc.vias, id);
  return { name: `${byId(doc.objects, via?.subsystemId)?.name ?? '?'} (open via)`, unresolved: true };
}

// conn-in and conn-out for a module, aggregated over all its placements.
export function connections(doc, objectId) {
  const me = 'm:' + objectId;
  const result = { in: [], out: [] };
  for (const wire of doc.wires) {
    const edges = wireEdges(doc, wire.id);
    const directed = wire.direction === 'directed';
    for (const e of edges) {
      if (e.a !== me && e.b !== me) continue;
      const downstream = e.a === me;
      const dir = !directed ? 'any' : downstream ? 'down' : 'up';
      for (const node of terminals(edges, downstream ? e.b : e.a, me, dir)) {
        const entry = { wire, ...describeNode(doc, node) };
        if (!directed || !downstream) result.in.push(entry);
        if (!directed || downstream) result.out.push(entry);
      }
    }
  }
  return result;
}

// A via is open when nothing continues on one of its sides.
export function isOpenVia(doc, via) {
  const ends = doc.segments.flatMap((s) => [s.from, s.to]).filter((ep) => ep.viaId === via.id);
  return !ends.some((ep) => ep.kind === 'via') || !ends.some((ep) => ep.kind === 'port');
}

export function status(doc) {
  return { unknownLoads: doc.unknownLoads.length, openVias: doc.vias.filter((v) => isOpenVia(doc, v)).length };
}

export function sheetName(doc, sheetId) {
  return sheetId === 'root' ? 'Root' : byId(doc.objects, sheetId)?.name ?? '?';
}

export function appearsOn(doc, objectId) {
  const sheets = doc.placements.filter((p) => p.objectId === objectId).map((p) => p.sheetId);
  return [...new Set(sheets)];
}

// A chain of sheet ids from root down to sheetId, or null if unreachable.
export function sheetPath(doc, sheetId) {
  const queue = [['root']];
  const seen = new Set();
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    if (last === sheetId) return path;
    if (seen.has(last)) continue;
    seen.add(last);
    for (const p of doc.placements) {
      if (p.sheetId === last && byId(doc.objects, p.objectId)?.type === 'subsystem') queue.push([...path, p.objectId]);
    }
  }
  return null;
}

export function subsystemSummary(doc, id) {
  const onSheet = doc.placements.filter((p) => p.sheetId === id).map((p) => byId(doc.objects, p.objectId));
  return {
    modules: onSheet.filter((o) => o.type === 'module').length,
    subsystems: onSheet.filter((o) => o.type === 'subsystem').length,
    unknownLoads: doc.unknownLoads.filter((u) => u.sheetId === id).length,
    vias: doc.vias.filter((v) => v.subsystemId === id).map((v) => ({ via: v, wire: byId(doc.wires, v.wireId), open: isOpenVia(doc, v) })),
  };
}

export function wireSummary(doc, wireId) {
  const wire = byId(doc.wires, wireId);
  const edges = wireEdges(doc, wireId);
  const nodes = [...new Set(edges.flatMap((e) => [e.a, e.b]))];
  const origin = wire.direction === 'directed' ? wireOrigin(doc, wireId) : null;
  return {
    origin: origin && (origin.startsWith('v:') ? { name: `${byId(doc.objects, byId(doc.vias, origin.slice(2)).subsystemId).name} (via)` } : describeNode(doc, origin)),
    endpoints: nodes
      .filter((n) => !n.startsWith('v:') || isOpenVia(doc, byId(doc.vias, n.slice(2))))
      .map((n) => describeNode(doc, n)),
    nodes,
    sheets: [...new Set(edges.map((e) => e.seg.sheetId))],
  };
}

// Names of what an out-via leads to on the outside (for its label).
export function viaDestinations(doc, via) {
  const edges = wireEdges(doc, via.wireId);
  return terminals(edges, 'v:' + via.id, null, 'down')
    .filter((n) => n !== 'v:' + via.id)
    .map((n) => describeNode(doc, n).name);
}
