// Derived data. Never stored; always computed from the document.
import { bundleChain, byId, insideBundle, wireEdges, wireOrigin } from './model.js';

// Walk from `node` (arriving from `prev`) through vias and bundle taps until
// reaching modules, unknown loads, or a via or tap with nothing beyond it.
// dir: 'down' follows segment direction, 'up' goes against it, 'any' ignores it.
function terminals(edges, node, prev, dir) {
  if (!node.startsWith('v:') && !node.startsWith('t:') && !node.startsWith('j:')) return [node];
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
  if (node.startsWith('t:')) return { name: `${byId(doc.bundles, byId(doc.taps, id)?.bundleId)?.name ?? '?'} (in bundle)`, unresolved: true };
  if (node.startsWith('j:')) return { name: 'Branch point', unresolved: true };
  const via = byId(doc.vias, id);
  return { name: `${byId(doc.objects, via?.subsystemId)?.name ?? '?'} (open via)`, unresolved: true };
}

// conn-in and conn-out for a module, aggregated over all its placements.
export function connections(doc, objectId) {
  const me = 'm:' + objectId;
  const result = { in: [], out: [] };
  for (const wire of doc.wires) {
    const edges = wireEdges(doc, wire.id);
    // A universal wire (like ground) connects everything on it, in any piece:
    // every other module and unknown load on it is a peer.
    if (wire.universal) {
      const nodes = new Set(edges.flatMap((e) => [e.a, e.b]));
      if (!nodes.has(me)) continue;
      for (const node of nodes) {
        if (node === me || !(node.startsWith('m:') || node.startsWith('u:'))) continue;
        const entry = { wire, ...describeNode(doc, node), universal: true };
        result.in.push(entry);
        result.out.push(entry);
      }
      continue;
    }
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

// A bundle tap is open when it is a dead end: a wire put in but not pulled out
// anywhere, or pulled out with nothing attached.
export const isOpenTap = (doc, tap) =>
  doc.segments.filter((s) => [s.from, s.to].some((ep) => ep.kind === 'tap' && ep.tapId === tap.id)).length < 2;

export function status(doc) {
  return {
    unknownLoads: doc.unknownLoads.length,
    openVias: doc.vias.filter((v) => isOpenVia(doc, v)).length,
    openTaps: doc.taps.filter((t) => isOpenTap(doc, t)).length,
  };
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
    origin: origin && (origin.startsWith('v:') ? { name: `${byId(doc.objects, byId(doc.vias, origin.slice(2)).subsystemId).name} (via)` }
      : origin.startsWith('t:') ? { name: `${byId(doc.bundles, byId(doc.taps, origin.slice(2)).bundleId).name} (bundle)` }
      : describeNode(doc, origin)),
    endpoints: nodes
      .filter((n) => !n.startsWith('j:'))
      .filter((n) => (!n.startsWith('v:') || isOpenVia(doc, byId(doc.vias, n.slice(2)))) && (!n.startsWith('t:') || isOpenTap(doc, byId(doc.taps, n.slice(2)))))
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

// What a bundle carries, along its whole length (across subsystem edges, see
// bundleChain). Each wire has a lane spanning the stretch it runs through; its
// taps say where it goes in or out and what is beyond. Positions here run from
// end A of the whole chain. The cuts (ends, taps, subsystem edges) split it
// into sections, each listing the wires inside it.
export function bundleSummary(doc, bundleId) {
  const chain = bundleChain(doc, bundleId);
  const bundle = byId(doc.bundles, bundleId);
  const length = chain.length;
  const itemOf = new Map(chain.items.map((it) => [it.bundle.id, it]));
  const along = (t) => {
    const it = itemOf.get(t.bundleId);
    return it.offset + (it.reversed ? it.length - t.at : t.at);
  };
  const mine = doc.taps.filter((t) => itemOf.has(t.bundleId));
  const isMine = (ep) => ep.kind === 'tap' && mine.some((t) => t.id === ep.tapId);
  const lanes = [];
  for (const wire of doc.wires) {
    const taps = mine.filter((t) => t.wireId === wire.id).sort((a, b) => along(a) - along(b));
    if (!taps.length) continue;
    const edges = wireEdges(doc, wire.id);
    const directed = wire.direction === 'directed';
    // Runs inside (tap to tap), plus the hops across subsystem edges.
    const insideRun = (e) => insideBundle(doc, e.seg) && (isMine(e.seg.from) || isMine(e.seg.to));
    const inner = edges.filter((e) => isMine(e.seg.from) && isMine(e.seg.to))
      .map((e) => ({ from: along(byId(doc.taps, e.seg.from.tapId)), to: along(byId(doc.taps, e.seg.to.tapId)) }));
    const crossing = (t) => edges.some((e) => insideRun(e) && !(isMine(e.seg.from) && isMine(e.seg.to)) && (e.seg.from.tapId === t.id || e.seg.to.tapId === t.id));
    const waiting = !inner.length && !taps.some(crossing);
    const points = taps.filter((t) => !crossing(t)).map((t) => {
      const node = 't:' + t.id;
      const outside = edges.filter((e) => (e.a === node || e.b === node) && !insideRun(e)).map((e) => {
        const entering = e.b === node;
        const dir = !directed ? 'any' : entering ? 'up' : 'down';
        const names = terminals(edges, entering ? e.a : e.b, node, dir).map((n) => describeNode(doc, n));
        return { entering, names };
      });
      // Directed wires go 'in' or 'out'; a bidirectional wire just meets the bundle there.
      const role = waiting ? 'in, not pulled out' : !directed ? '' : outside.some((o) => o.entering) ? 'in' : outside.length ? 'out' : '';
      return { tap: t, at: along(t), outside, role, open: isOpenTap(doc, t) };
    });
    const ats = taps.map(along);
    lanes.push({ wire, points, inner, min: Math.min(...ats), max: Math.max(...ats), waiting });
  }
  const edgesAt = chain.joints.map((j) => ({ at: j.at, name: byId(doc.objects, byId(doc.placements, j.crossing.placementId)?.objectId)?.name ?? '?' }));
  const cuts = [...new Set([0, length, ...edgesAt.map((x) => x.at), ...lanes.flatMap((l) => l.points.map((p) => p.at))])].sort((a, b) => a - b);
  const cutLabel = (at) => {
    if (at === 0) return 'End A';
    if (at === length) return 'End B';
    const names = lanes.flatMap((l) => l.points.filter((p) => p.at === at).map((p) => (p.role ? `${l.wire.name} ${p.role}` : l.wire.name)));
    for (const x of edgesAt) if (x.at === at) names.push(`${x.name} edge`);
    return names.join(', ');
  };
  const sections = [];
  for (let i = 1; i < cuts.length; i++) {
    const [a, b] = [cuts[i - 1], cuts[i]];
    sections.push({ from: a, to: b, wires: lanes.filter((l) => !l.waiting && l.min <= a && l.max >= b).map((l) => l.wire) });
  }
  const sheets = [...new Set(chain.items.map((it) => it.bundle.sheetId))];
  return { bundle, length, lanes, cuts, sections, cutLabel, edges: edgesAt, sheets };
}
