// App wiring: state, history, pointer/keyboard handling, toolbar.
import { apply, byId, emptyDoc, upgrade, validate, wireByName } from './model.js';
import { bundleSummary, sheetName, sheetPath, status } from './derive.js';
import { G, itemsInRect, nearestSide, renderSheet, segmentEnds, segmentRoute, wireGhost } from './view.js';
import { flushEdits, h, renderPanel } from './panel.js';
import { localStore } from './storage.js';
import { createPreview } from './preview.js';
import { boxPort, project } from './bundles.js';
import { plainText, richEditor, richToHtml } from './richtext.js';

const NOTE_BOX = { w: 8, h: 2 }; // default text box size, in grid units
const WIRE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#4b5563'];

const svg = document.getElementById('canvas');
const panelEl = document.getElementById('panel');
const crumbsEl = document.getElementById('crumbs');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const objectDialog = document.getElementById('objectDialog');
const wireDialog = document.getElementById('wireDialog');
const pullDialog = document.getElementById('pullDialog');
const lineDialog = document.getElementById('lineDialog');
const noteDialog = document.getElementById('noteDialog');
const noteEditorEl = document.getElementById('noteEditor');

let doc = emptyDoc();
let past = [];
let future = [];
let path = ['root'];       // sheet ids from root to the current sheet
let tool = 'select';
let selection = null;      // { kind: 'placement' | 'unknown' | 'segment' | 'via' | 'note', id }, or { kind: 'many', items: [...] }
let subject = null;        // what the info view shows
let preview = null;        // document shown instead of `doc` while dragging
let drag = null;
let wiring = null;         // a wire started by a click, following the pointer until the next click
let bundling = null;       // a bundle being laid out: { points (grid), cursor (grid) }
let spaceDown = false;     // Space held: dragging pans
let lastClick = {};        // for double-click detection
const views = {};          // sheet id -> { x, y, k }

const hoverPreview = createPreview({
  host: document.querySelector('main'),
  getDoc: () => doc,
  boxRect: (key) => {
    const [kind, id] = key.split(':');
    const el = kind === 'b' ? svg.querySelector(`[data-kind="bundle"][data-id="${id}"] > .peek`) : svg.querySelector(`[data-kind="placement"][data-id="${id}"] > .body`);
    return el?.getBoundingClientRect() ?? null;
  },
  parentName: () => sheetName(doc, currentSheet()),
  // Clicking a preview enters the subsystem (or, on its details, opens its info),
  // or opens the module's or bundle's info view.
  onOpen: (key, part) => {
    const [kind, placementId] = key.split(':');
    if (kind === 'b') {
      selection = { kind: 'bundle', id: placementId };
      subject = { kind: 'bundle', id: placementId };
      return render();
    }
    const p = byId(doc.placements, placementId);
    const obj = p && byId(doc.objects, p.objectId);
    if (!obj) return;
    if (obj.type === 'subsystem' && part !== 'details') return goTo([...path, obj.id]);
    selection = { kind: 'placement', id: p.id };
    subject = { kind: 'object', id: obj.id, placementId: p.id };
    render();
  },
});

const currentSheet = () => path[path.length - 1];
const view = () => (views[currentSheet()] ||= { x: 60, y: 60, k: 1 });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- history ----------------------------------------------------------------

// keepPanel: leave the info view as it is (used when saving one of its fields).
function setDoc(next, keepPanel = false) {
  past.push(doc);
  if (past.length > 200) past.shift();
  future = [];
  doc = next;
  localStore.save(doc);
  render(keepPanel);
}

function commit(cmd, prefix = '', keepPanel = false) {
  const r = apply(doc, cmd);
  if (r.error) {
    toast(prefix + r.error);
    render();
    return null;
  }
  setDoc(r.doc, keepPanel);
  return r;
}

// Deletions happen at once and say what went; Undo brings it back. (No confirm():
// browsers let people switch those off, after which every delete silently failed.)
function commitDeletion(cmd, describe) {
  const r = apply(doc, cmd);
  if (r.error) return toast(r.error);
  const lost = doc.segments.length - r.doc.segments.length;
  setDoc(r.doc);
  toast(`${describe(lost)} Undo brings it back.`);
}

function undo() {
  if (!past.length) return;
  future.push(doc);
  doc = past.pop();
  localStore.save(doc);
  render();
}

function redo() {
  if (!future.length) return;
  past.push(doc);
  doc = future.pop();
  localStore.save(doc);
  render();
}

function replaceDoc(next, message) {
  path = ['root'];
  selection = null;
  subject = null;
  preview = null;
  drag = null;
  setDoc(next);
  toast(message);
}

// ---- rendering --------------------------------------------------------------

const LISTS = { placement: 'placements', unknown: 'unknownLoads', segment: 'segments', via: 'vias', note: 'notes', bundle: 'bundles', tap: 'taps', line: 'lines' };

function render(keepPanel = false) {
  // Leave sheets that no longer exist (e.g. after undo or delete).
  const gone = path.findIndex((id, i) => i > 0 && byId(doc.objects, id)?.type !== 'subsystem');
  if (gone > 0) path = path.slice(0, gone);
  if (selection?.items) {
    const items = selection.items.filter((x) => byId(doc[LISTS[x.kind]], x.id));
    selection = items.length > 1 ? { kind: 'many', items } : items[0] ?? null;
  } else if (selection && !byId(doc[LISTS[selection.kind]], selection.id)) selection = null;

  renderCanvas();
  if (!keepPanel) renderPanel(panelEl, panelApp());
  if (!panelEl.open) subject = null;

  crumbsEl.replaceChildren(...path.flatMap((id, i) => {
    const item = i === path.length - 1
      ? h('span', {}, sheetName(doc, id))
      : h('button', { onclick: () => goTo(path.slice(0, i + 1)) }, sheetName(doc, id));
    return i ? [h('span', { class: 'sep' }, '›'), item] : [item];
  }));

  const s = status(doc);
  statusEl.textContent = `${plural(s.unknownLoads, 'unknown load')} · ${plural(s.openVias, 'open via')}${s.openTaps ? ` · ${plural(s.openTaps, 'open bundle tap')}` : ''}`;

  document.getElementById('objectNames').replaceChildren(...doc.objects.map((o) => h('option', { value: o.name })));
  document.getElementById('wireNames').replaceChildren(...doc.wires.map((w) => h('option', { value: w.name })));
  document.getElementById('undo').disabled = !past.length;
  document.getElementById('redo').disabled = !future.length;
}

function renderCanvas() {
  let overlay = '';
  if (drag?.type === 'box') {
    const r = boxFrom(drag.start, drag.end, tool === 'text' ? NOTE_BOX : undefined);
    overlay = `<rect class="ghost" x="${r.x * G}" y="${r.y * G}" width="${r.w * G}" height="${r.h * G}"/>`;
  }
  const w = drag?.type === 'wire' ? drag : wiring;
  if (w) overlay = wireGhost(doc, w.from, ghostEnd(w), { ...wireStyle(w), sheetId: currentSheet() });
  if (drag?.type === 'lineDraw') {
    const [a, b] = [gridPoint(drag.start), gridPoint(drag.end)];
    overlay = `<line class="ghost" x1="${a.x * G}" y1="${a.y * G}" x2="${b.x * G}" y2="${b.y * G}"/>`;
  }
  if (bundling) {
    const pts = [...bundling.points, orthoFrom(bundling.points[bundling.points.length - 1], bundling.cursor)];
    overlay = `<path class="bundle-draft" d="M${pts.map((q) => `${q.x * G},${q.y * G}`).join(' L')}"/>`;
  }
  if (drag?.type === 'marquee') {
    const r = rectFrom(drag.start, drag.end);
    overlay = `<rect class="marquee" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
  }
  svg.innerHTML = renderSheet(preview || doc, {
    sheetId: currentSheet(),
    parentName: sheetName(doc, path[path.length - 2] ?? 'root'),
    selection,
    view: view(),
    width: svg.clientWidth,
    height: svg.clientHeight,
    overlay,
  });
}

function panelApp() {
  return {
    doc, subject, sheetId: currentSheet(), commit, toast,
    edit: (cmd) => commit(cmd, '', true),
    preview: (cmd) => {
      preview = cmd ? apply(doc, cmd).doc ?? null : null;
      renderCanvas();
    },
    open: (s) => { subject = s; render(); },
    close: () => panelEl.close(),
    refresh: () => render(),
    goToSheet: (id) => {
      panelEl.close();
      goTo(sheetPath(doc, id) ?? ['root']);
    },
    removePlacement, deleteEverywhere, deleteSegment, deleteUnknown, deleteBundle,
  };
}

// Closing the info view (×, Esc, or clicking outside it) keeps any unsaved edits.
panelEl.addEventListener('close', () => {
  subject = null;
  preview = null;
  flushEdits(panelEl);
  render();
});
panelEl.addEventListener('pointerdown', (e) => {
  if (e.target === panelEl) panelEl.close();
});

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 5000);
}

// ---- navigation & deletion --------------------------------------------------

function goTo(newPath) {
  path = newPath;
  selection = null;
  render();
}

const andSegments = (lost) => (lost ? `, plus ${plural(lost, 'wire segment')}` : '');

function removePlacement(id) {
  const p = byId(doc.placements, id);
  const obj = byId(doc.objects, p.objectId);
  if (doc.placements.filter((x) => x.objectId === obj.id).length === 1) return deleteEverywhere(obj.id);
  commitDeletion({ type: 'removePlacement', id }, (lost) => `Removed ${obj.name} from this sheet${andSegments(lost)}.`);
}

function deleteEverywhere(objectId) {
  const obj = byId(doc.objects, objectId);
  const inside = obj.type === 'subsystem' ? ' and everything on its sheet' : '';
  commitDeletion({ type: 'deleteObject', id: objectId }, (lost) => `Deleted ${obj.name}${inside}${andSegments(lost)}.`);
}

function deleteSegment(id) {
  const wire = byId(doc.wires, byId(doc.segments, id).wireId);
  commitDeletion({ type: 'deleteSegment', id }, (lost) => `Deleted ${plural(lost, 'segment')} of ${wire.name}.`);
}

function deleteUnknown(id) {
  commitDeletion({ type: 'deleteUnknown', id }, (lost) => `Deleted the unknown load${andSegments(lost)}.`);
}

// Delete everything in a box selection as one undo step. Items already removed
// along with an earlier one (e.g. a segment on a deleted module) are skipped.
function deleteMany(items) {
  const order = ['note', 'line', 'segment', 'tap', 'unknown', 'bundle', 'placement'];
  const sorted = items.filter((x) => order.includes(x.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  let next = doc;
  for (const { kind, id } of sorted) {
    if (!byId(next[LISTS[kind]], id)) continue;
    let cmd = { type: { note: 'deleteNote', line: 'deleteLine', segment: 'deleteSegment', tap: 'deleteTap', unknown: 'deleteUnknown', bundle: 'deleteBundle' }[kind], id };
    if (kind === 'placement') {
      const p = byId(next.placements, id);
      const last = next.placements.filter((x) => x.objectId === p.objectId).length === 1;
      cmd = last ? { type: 'deleteObject', id: p.objectId } : { type: 'removePlacement', id };
    }
    const r = apply(next, cmd);
    if (r.error) return toast(r.error);
    next = r.doc;
  }
  const chosen = sorted.filter((x) => x.kind === 'segment').length;
  const lost = Math.max(0, doc.segments.length - next.segments.length - chosen);
  setDoc(next);
  toast(`Deleted ${plural(sorted.length, 'item')}${andSegments(lost)}. Undo brings it back.`);
}

function deleteBundle(id) {
  const b = byId(doc.bundles, id);
  commitDeletion({ type: 'deleteBundle', id }, () => `Removed ${b.name}; its wires now run directly.`);
}

function deleteTap(id) {
  const wire = byId(doc.wires, byId(doc.taps, id).wireId);
  commitDeletion({ type: 'deleteTap', id }, (lost) => `Removed where ${wire.name} meets the bundle${andSegments(lost)}.`);
}

function deleteSelection() {
  if (!selection) return;
  if (selection.kind === 'many') return deleteMany(selection.items);
  const { kind, id } = selection;
  if (kind === 'placement') removePlacement(id);
  if (kind === 'unknown') deleteUnknown(id);
  if (kind === 'segment') deleteSegment(id);
  if (kind === 'note') commit({ type: 'deleteNote', id });
  if (kind === 'line') commit({ type: 'deleteLine', id });
  if (kind === 'bundle') deleteBundle(id);
  if (kind === 'tap') deleteTap(id);
  if (kind === 'via') toast('Vias follow their segments. Delete a segment instead.');
}

// ---- dialogs ----------------------------------------------------------------

function ask(dialog, values) {
  const form = dialog.querySelector('form');
  form.reset();
  for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? Object.fromEntries(new FormData(form)) : null), { once: true });
  });
}

function syncWireDialog() {
  const form = wireDialog.querySelector('form');
  const existing = wireByName(doc, form.elements.name.value);
  form.elements.color.disabled = form.elements.universal.disabled = !!existing;
  if (existing) {
    form.elements.color.value = existing.color;
    form.elements.direction.value = existing.direction;
    form.elements.universal.checked = !!existing.universal;
  }
  // A universal wire is always bidirectional.
  if (!existing && form.elements.universal.checked) form.elements.direction.value = 'bidirectional';
  form.elements.direction.disabled = !!existing || form.elements.universal.checked;
  document.getElementById('wireHint').textContent = existing
    ? existing.universal
      ? `Adds to the universal wire ${existing.name}: it is connected everywhere it appears.`
      : `Extends the existing ${existing.direction} wire ${existing.name}.`
    : form.elements.universal.checked
      ? 'Creates a universal wire (like ground): draw it anywhere; all its pieces count as connected.'
      : 'Creates a new wire.';
}
wireDialog.querySelector('[name=name]').addEventListener('input', syncWireDialog);
wireDialog.querySelector('[name=universal]').addEventListener('change', syncWireDialog);

async function askWire(name) {
  const pending = ask(wireDialog, { name, color: WIRE_COLORS[doc.wires.length % WIRE_COLORS.length], direction: 'directed' });
  syncWireDialog();
  return pending;
}

// Grid rows a text box `w` units wide needs to show all of `text`.
function noteRows(text, w) {
  const probe = h('div', { class: 'note-body' });
  probe.innerHTML = richToHtml(text);
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', left: '-10000px', top: '0', width: `${w * G}px` });
  document.body.append(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.ceil(px / G);
}

// Ask for a legend line's color and caption; an existing line is edited.
async function askLine(line, ends) {
  const answer = await ask(lineDialog, { color: line?.color ?? '#dc2626', label: line?.label ?? '' });
  if (!answer) return renderCanvas();
  if (line) return commit({ type: 'editLine', id: line.id, color: answer.color, label: answer.label });
  const r = commit({ type: 'addLine', sheetId: currentSheet(), ...ends, color: answer.color, label: answer.label });
  if (r) {
    selection = { kind: 'line', id: r.id };
    render();
  }
}

// Ask for a text box's text; an existing box is edited (and deleted if cleared).
// The box grows taller if the text doesn't fit; it never shrinks on its own.
async function askNote(note, box) {
  const editor = richEditor({ value: note?.text ?? '' });
  noteEditorEl.replaceChildren(editor);
  const pending = ask(noteDialog, {});
  editor.focusEditor();
  if (!(await pending)) return;
  const text = editor.value;
  const { w, h: rows } = note ?? box;
  const fit = Math.max(rows, noteRows(text, w));
  if (note) commit({ type: 'editNote', id: note.id, text, h: fit });
  else if (plainText(text).trim()) {
    const r = commit({ type: 'addNote', sheetId: currentSheet(), ...box, h: fit, text });
    if (r) {
      selection = { kind: 'note', id: r.id };
      render();
    }
  }
}

// ---- pointer interaction ----------------------------------------------------

function toWorld(e) {
  const r = svg.getBoundingClientRect();
  const v = view();
  return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
}

function elementAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-kind]');
  return el && svg.contains(el) ? el : null;
}

// What a dragged wire end would attach to if dropped here, looking past the
// thing being dragged (its own segment, its unknown load, or anything new in
// the live preview). Empty space leaves the end floating at a new unknown load.
function dropTarget(e, pt, segmentId, unknownId) {
  for (const node of document.elementsFromPoint(e.clientX, e.clientY)) {
    const el = node.closest?.('[data-kind]');
    if (!el || !svg.contains(el)) continue;
    const { kind, id } = el.dataset;
    if (kind === 'segment' && id === segmentId) continue;
    if (kind === 'unknown' && (id === unknownId || !byId(doc.unknownLoads, id))) continue;
    if (kind === 'boundary' || kind === 'note' || kind === 'label') continue;
    return targetAt(el, pt);
  }
  return { kind: 'newUnknown', x: Math.floor(pt.x / G), y: Math.floor(pt.y / G) };
}

// Where a dragged unknown load would attach its wire, if dropped on something.
function unknownDropTarget(d, e, pt) {
  const seg = doc.segments.find((s) => [s.from, s.to].some((ep) => ep.kind === 'unknown' && ep.unknownId === d.id));
  if (!seg) return null;
  const t = dropTarget(e, pt, seg.id, d.id);
  return t.kind === 'newUnknown' ? null : t;
}

// Is pt on (or within reach of) placement p's box?
function nearBox(p, pt, reach = 12) {
  const [x, y, w, h] = [p.x * G, p.y * G, p.w * G, p.h * G];
  return pt.x >= x - reach && pt.x <= x + w + reach && pt.y >= y - reach && pt.y <= y + h + reach;
}

// The leg of a segment's drawn route nearest pt: 'x' for a vertical leg (it
// moves sideways), 'y' for a horizontal one.
function legAxis(seg, pt) {
  const pts = segmentRoute(doc, seg) ?? [];
  let best = { d: Infinity, axis: 'x' };
  for (let i = 1; i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]];
    if (p.x === q.x && p.y === q.y) continue;
    const c = nearestOnRoute([p, q], pt);
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < best.d) best = { d, axis: p.x === q.x ? 'x' : 'y' };
  }
  return best.axis;
}

// Grid rectangle spanned by a drag; a plain click gives a default-sized box.
function boxFrom(a, b, fallback = { w: 6, h: 3 }) {
  const x = Math.round(Math.min(a.x, b.x) / G);
  const y = Math.round(Math.min(a.y, b.y) / G);
  const w = Math.round(Math.max(a.x, b.x) / G) - x;
  const h = Math.round(Math.max(a.y, b.y) / G) - y;
  return w >= 1 && h >= 1 ? { x, y, w, h } : { x, y, ...fallback };
}

// What a wire end dropped on `el` at world point `pt` refers to.
function targetAt(el, pt) {
  // A label stands for what it labels (a wire's line or a bundle).
  if (el?.dataset.kind === 'label') return targetAt(el.parentElement?.closest('[data-kind]'), pt);
  const kind = el?.dataset.kind;
  const id = el?.dataset.id;
  if (kind === 'placement' || kind === 'resize') {
    const p = byId(doc.placements, id);
    if (byId(doc.objects, p.objectId).type === 'module') return { kind: 'module', placementId: id };
    return { kind: 'subsystem', placementId: id, ...nearestSide(p, pt) };
  }
  if (kind === 'port') return { kind: 'port', placementId: el.dataset.placement, viaId: id };
  if (kind === 'unknown') return { kind: 'unknown', unknownId: id };
  if (kind === 'via') return { kind: 'via', viaId: id };
  if (kind === 'boundary') return { kind: 'boundary', x: Math.round(pt.x / G), y: Math.round(pt.y / G) };
  if (kind === 'tap') {
    // A wire's dot on a bundle: more wires can go in or come out at that same point.
    const t = byId(doc.taps, id);
    return { kind: 'bundle', bundleId: t.bundleId, at: t.at, prefer: t.wireId };
  }
  if (kind === 'junction') return { kind: 'junction', junctionId: id };
  if (kind === 'segment') {
    // On a wire's line: branch from (or join) it at the nearest point on it.
    const at = nearestOnRoute(segmentRoute(doc, byId(doc.segments, id)) ?? [pt], pt);
    return { kind: 'branch', segmentId: id, x: at.x / G, y: at.y / G };
  }
  if (kind === 'bundle' || kind === 'bundlePoint') {
    const b = byId(doc.bundles, id);
    return { kind: 'bundle', bundleId: id, at: project(b.points, pt.x / G, pt.y / G) };
  }
  return { kind: 'newUnknown', x: Math.floor(pt.x / G), y: Math.floor(pt.y / G) };
}

const targetKey = (t) => t.placementId || t.unknownId || t.viaId || t.tapId || t.bundleId || t.segmentId || t.junctionId || t.kind;

// The point on a drawn route (px) nearest pt.
function nearestOnRoute(pts, pt) {
  let best = pts[0];
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]];
    const len2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((pt.x - p.x) * (q.x - p.x) + (pt.y - p.y) * (q.y - p.y)) / len2)) : 0;
    const c = { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

// The wire already tied to a drop target (via, port, bundle tap, branch point
// or a wire's line), if any.
function targetWire(t) {
  if (!t) return undefined;
  if (t.kind === 'branch') return byId(doc.wires, byId(doc.segments, t.segmentId)?.wireId);
  if (t.kind === 'junction') {
    const seg = doc.segments.find((s) => [s.from, s.to].some((ep) => ep.kind === 'junction' && ep.junctionId === t.junctionId));
    return seg && byId(doc.wires, seg.wireId);
  }
  return byId(doc.wires, byId(doc.vias, t.viaId)?.wireId || byId(doc.taps, t.tapId)?.wireId);
}
const onWire = (t) => t?.kind === 'branch' || t?.kind === 'junction';

// Where the wire being drawn ends: the thing under the pointer, or the pointer
// itself while it is still over the starting point.
function ghostEnd(w) {
  const t = w.hover;
  const pointer = { kind: 'point', x: w.end.x, y: w.end.y };
  if (!t) return pointer;
  if (t.kind === 'newUnknown') return w.from.kind === 'newUnknown' && w.from.x === t.x && w.from.y === t.y ? pointer : t;
  return targetKey(t) === targetKey(w.from) ? pointer : t;
}

// Color and direction of the wire being drawn: an existing wire's when it starts
// (or ends) at one of its vias, else the new wire's defaults.
function wireStyle(w) {
  const wire = (w.from.pull && wireByName(doc, w.from.pull)) || targetWire(w.from) || targetWire(w.hover);
  if (wire) return { color: wire.color, directed: wire.direction === 'directed', wireId: wire.id };
  return { color: WIRE_COLORS[doc.wires.length % WIRE_COLORS.length], directed: true };
}

// A wire pulled out of a bundle already has its name (from.pull); otherwise ask.
async function finishWire(from, to) {
  renderCanvas();
  const known = targetWire(from) || targetWire(to);
  // Branching from (or joining) a wire's line can only continue that wire.
  const branchOf = (onWire(from) && targetWire(from)) || (onWire(to) && targetWire(to));
  const answer = from.pull ? { name: from.pull } : branchOf ? { name: branchOf.name } : await askWire(known ? known.name : '');
  if (!answer) return;
  const r = commit({ type: 'drawSegment', sheetId: currentSheet(), from, to, wire: { ...answer, universal: answer.universal === 'on' } });
  if (r) {
    selection = { kind: 'segment', id: r.id };
    render();
  }
}

function openWire(segmentId) {
  const seg = byId(doc.segments, segmentId);
  if (!seg) return renderCanvas();
  selection = { kind: 'segment', id: segmentId };
  subject = { kind: 'wire', id: seg.wireId, segmentId };
  render();
}

// Ask which wire to pull out of a bundle (null if cancelled, or if it carries none).
async function askPull(bundleId, preferWireId) {
  const b = byId(doc.bundles, bundleId);
  // Any wire in the bundle, including parts of it across subsystem edges.
  const inside = bundleSummary(doc, b.id).lanes.map((l) => l.wire);
  if (!inside.length) {
    toast(`No wires are in ${b.name} yet. Draw a wire onto it to put it in.`);
    return null;
  }
  document.getElementById('pullTitle').textContent = `Pull a wire out of ${b.name}`;
  document.getElementById('bundleWires').replaceChildren(...inside.map((w) => h('option', { value: w.name })));
  const prefer = inside.find((w) => w.id === preferWireId);
  const answer = await ask(pullDialog, { name: prefer?.name ?? (inside.length === 1 ? inside[0].name : '') });
  return answer?.name.trim() || null;
}

// Bundle legs are horizontal or vertical: the next point lines up with the last.
const orthoFrom = (last, g) => (Math.abs(g.x - last.x) >= Math.abs(g.y - last.y) ? { x: g.x, y: last.y } : { x: last.x, y: g.y });
const gridPoint = (pt) => ({ x: Math.round(pt.x / G), y: Math.round(pt.y / G) });

function finishBundle() {
  const points = bundling?.points ?? [];
  const cross = bundling?.cross ?? [];
  bundling = null;
  if (points.length < 2) return renderCanvas();
  const r = commit({ type: 'addBundle', sheetId: currentSheet(), points, cross });
  if (r) {
    selection = { kind: 'bundle', id: r.id };
    render();
  }
}

// World rectangle (px) spanned by two points.
const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

// A wire end attached to placement p within reach of pt, as a drag to move it
// around the box (a module end) or move its port (a subsystem end).
function wireEndNear(p, pt) {
  for (const seg of doc.segments) {
    if (seg.sheetId !== currentSheet()) continue;
    const ends = segmentEnds(doc, seg);
    for (const end of ['from', 'to']) {
      const ep = seg[end];
      if (ep.placementId !== p.id || Math.hypot(ends[end].x - pt.x, ends[end].y - pt.y) > 10) continue;
      if (ep.kind === 'module') return { type: 'segEnd', id: seg.id, end, placementId: p.id };
      if (ep.kind === 'port' && !byId(doc.vias, ep.viaId)?.crossingId) return { type: 'movePort', id: ep.viaId, placementId: p.id, segmentId: seg.id };
    }
  }
  return null;
}

function startSelect(el, pt) {
  const { kind, id } = el.dataset;
  const gx = pt.x / G;
  const gy = pt.y / G;
  // Double-click detected by hand: re-rendering on the first click replaces
  // the element, so the browser's dblclick event is unreliable here.
  const now = Date.now();
  const double = lastClick.id === id && now - lastClick.time < 400;
  lastClick = double ? {} : { id, time: now };

  if (kind === 'resize') {
    drag = { type: 'resize', id };
  } else if (kind === 'noteResize') {
    drag = { type: 'resizeNote', id };
  } else if (kind === 'placement') {
    const p = byId(doc.placements, id);
    const type = byId(doc.objects, p.objectId).type;
    // A wire end at the box's edge can be grabbed from just inside the box too.
    const end = !double && wireEndNear(p, pt);
    if (end) {
      selection = { kind: 'segment', id: end.segmentId };
      drag = end;
      return render();
    }
    if (double && type === 'subsystem') return goTo([...path, p.objectId]);
    if (double) {
      selection = { kind, id };
      subject = { kind: 'object', id: p.objectId, placementId: id };
      return render();
    }
    selection = { kind, id };
    drag = { type: 'move', id, dx: gx - p.x, dy: gy - p.y };
    render();
  } else if (kind === 'unknown') {
    const u = byId(doc.unknownLoads, id);
    selection = { kind, id };
    if (double) subject = { kind: 'unknown', id };
    else drag = { type: 'moveUnknown', id, dx: gx - u.x, dy: gy - u.y };
    render();
  } else if (kind === 'via' || kind === 'port') {
    const via = byId(doc.vias, id);
    selection = kind === 'via' ? { kind, id } : null;
    if (double) subject = { kind: 'wire', id: via.wireId };
    else if (kind === 'via') drag = { type: 'moveVia', id };
    else drag = { type: 'movePort', id, placementId: el.dataset.placement };
    render();
  } else if (kind === 'note') {
    const n = byId(doc.notes, id);
    selection = { kind, id };
    if (!double) drag = { type: 'moveNote', id, dx: gx - n.x, dy: gy - n.y };
    render();
    if (double) askNote(n);
  } else if (kind === 'label') {
    // Drag a wire's or bundle's label somewhere easier to read; a click on a
    // wire's label opens its info.
    const { of } = el.dataset;
    const item = of === 'bundle' ? byId(doc.bundles, id) : byId(doc.segments, id);
    selection = { kind: of === 'bundle' ? 'bundle' : 'segment', id };
    drag = { type: 'moveLabel', of, id, sx: gx, sy: gy, dx0: item?.label?.dx ?? 0, dy0: item?.label?.dy ?? 0, start: pt };
    render();
  } else if (kind === 'line') {
    const l = byId(doc.lines, id);
    selection = { kind, id };
    if (double) askLine(l);
    else drag = { type: 'moveLine', id, sx: gx, sy: gy };
    render();
  } else if (kind === 'lineEnd') {
    drag = { type: 'moveLineEnd', id, end: Number(el.dataset.index) };
  } else if (kind === 'junction') {
    selection = null;
    if (double) {
      const seg = doc.segments.find((s) => [s.from, s.to].some((ep) => ep.kind === 'junction' && ep.junctionId === id));
      if (seg) subject = { kind: 'wire', id: seg.wireId };
    } else drag = { type: 'moveJunction', id };
    render();
  } else if (kind === 'segment') {
    // Pressing near an end on a module or subsystem drags that end around the box;
    // otherwise a click opens the wire's info when released.
    const seg = byId(doc.segments, id);
    const ends = segmentEnds(doc, seg);
    const near = ['from', 'to'].find((end) => Math.hypot(ends[end].x - pt.x, ends[end].y - pt.y) < 14 && ['module', 'port'].includes(seg[end].kind));
    selection = { kind, id };
    if (near && seg[near].kind === 'module') drag = { type: 'segEnd', id, end: near, placementId: seg[near].placementId };
    else if (near) drag = { type: 'movePort', id: seg[near].viaId, placementId: seg[near].placementId, segmentId: id, end: near };
    // Dragging elsewhere on the line moves that leg; a click opens the wire's info.
    else drag = { type: 'segClick', id, axis: legAxis(seg, pt), start: pt };
    render();
  } else if (kind === 'bundle') {
    // Click selects (and drags) a bundle; double-click opens its info.
    selection = { kind, id };
    if (double) subject = { kind: 'bundle', id };
    else drag = { type: 'moveBundle', id, sx: gx, sy: gy };
    render();
  } else if (kind === 'bundlePoint') {
    drag = { type: 'moveBundlePoint', id, index: Number(el.dataset.index) };
  } else if (kind === 'tap') {
    // Click selects a tap and drags it along its bundle; double-click opens its wire's info.
    selection = { kind, id };
    if (double) subject = { kind: 'wire', id: byId(doc.taps, id).wireId };
    else drag = { type: 'moveTap', id };
    render();
  }
}

function dragCommand(d, pt, e) {
  const gx = pt.x / G;
  const gy = pt.y / G;
  if (d.type === 'move') return { type: 'movePlacement', id: d.id, x: gx - d.dx, y: gy - d.dy };
  if (d.type === 'resize') {
    const p = byId(doc.placements, d.id);
    return { type: 'movePlacement', id: d.id, w: gx - p.x, h: gy - p.y };
  }
  if (d.type === 'moveUnknown') return { type: 'moveUnknown', id: d.id, x: gx - d.dx, y: gy - d.dy };
  if (d.type === 'moveNote') return { type: 'moveNote', id: d.id, x: gx - d.dx, y: gy - d.dy };
  if (d.type === 'resizeNote') {
    const n = byId(doc.notes, d.id);
    return { type: 'moveNote', id: d.id, w: gx - n.x, h: gy - n.y };
  }
  if (d.type === 'moveVia') return { type: 'moveVia', id: d.id, x: gx, y: gy };
  // A wire end slides around its box while near it; dragged away, it floats and
  // reattaches to whatever it's dropped on.
  if (d.type === 'segEnd' || (d.type === 'movePort' && d.segmentId)) {
    const p = byId(doc.placements, d.placementId);
    const segId = d.segmentId || d.id;
    if (nearBox(p, pt)) {
      return d.type === 'segEnd'
        ? { type: 'setSegmentEnd', id: d.id, end: d.end, ...nearestSide(p, pt) }
        : { type: 'movePort', id: d.id, ...nearestSide(p, pt) };
    }
    return e && { type: 'reconnectEnd', id: segId, end: d.end, target: dropTarget(e, pt, segId) };
  }
  if (d.type === 'segClick') {
    if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 5) return null;
    return { type: 'setSegmentBend', id: d.id, axis: d.axis, at: d.axis === 'x' ? gx : gy };
  }
  if (d.type === 'moveLabel') {
    if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 3) return null;
    return { type: 'moveLabel', of: d.of, id: d.id, dx: d.dx0 + gx - d.sx, dy: d.dy0 + gy - d.sy };
  }
  if (d.type === 'moveLine') return { type: 'moveLine', id: d.id, dx: Math.round(gx - d.sx), dy: Math.round(gy - d.sy) };
  if (d.type === 'moveLineEnd') return { type: 'moveLineEnd', id: d.id, end: d.end, x: Math.round(gx), y: Math.round(gy) };
  if (d.type === 'moveJunction') return { type: 'moveJunction', id: d.id, x: gx, y: gy };
  if (d.type === 'moveTap') {
    const t = byId(doc.taps, d.id);
    return { type: 'moveTap', id: d.id, at: project(byId(doc.bundles, t.bundleId).points, gx, gy) };
  }
  if (d.type === 'moveBundle') return { type: 'moveBundle', id: d.id, dx: Math.round(gx - d.sx), dy: Math.round(gy - d.sy) };
  if (d.type === 'moveBundlePoint') return { type: 'moveBundlePoint', id: d.id, index: d.index, x: Math.round(gx), y: Math.round(gy) };
  if (d.type === 'movePort') return { type: 'movePort', id: d.id, ...nearestSide(byId(doc.placements, d.placementId), pt) };
  return null;
}

// What the hover preview would show for the thing under the pointer: a box
// ("p:<placement id>") or a bundle ("b:<bundle id>"). Only each one's preview
// zone counts (a box's inner area, a bundle's label), so wiring near edges,
// the i button and taps never opens a preview.
function hoveredBox(e) {
  if (!e.target.closest?.('.peek')) return null;
  const box = e.target.closest('[data-kind="placement"]');
  if (box && byId(doc.placements, box.dataset.id)) return 'p:' + box.dataset.id;
  const bundle = e.target.closest('[data-kind="bundle"]');
  return bundle && byId(doc.bundles, bundle.dataset.id) ? 'b:' + bundle.dataset.id : null;
}

svg.addEventListener('pointerdown', (e) => {
  hoverPreview.cancel();
  if (e.button !== 0 && e.button !== 1) return;
  const el = e.target.closest('[data-kind]');
  const pt = toWorld(e);
  svg.setPointerCapture(e.pointerId);

  const empty = !el || el.dataset.kind === 'boundary';
  if (e.button === 1 || spaceDown) {
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: { ...view() } };
  } else if (wiring) {
    // Second click of a click-started wire: finish it here, or cancel on its start.
    const w = wiring;
    wiring = null;
    const to = targetAt(el, pt);
    if (ghostEnd({ ...w, hover: to }).kind === 'point') renderCanvas();
    else finishWire(w.from, to);
  } else if (tool === 'select' && empty) {
    selection = null;
    render();
    drag = { type: 'marquee', start: pt, end: pt };
  } else if (tool === 'select') {
    startSelect(el, pt);
  } else if (tool === 'line') {
    drag = { type: 'lineDraw', start: pt, end: pt };
  } else if (tool === 'module' || tool === 'subsystem' || tool === 'text') {
    drag = { type: 'box', start: pt, end: pt };
  } else if (tool === 'unknown') {
    commit({ type: 'addUnknown', sheetId: currentSheet(), x: Math.floor(pt.x / G), y: Math.floor(pt.y / G) });
  } else if (tool === 'wire') {
    drag = { type: 'wire', from: targetAt(el, pt), start: pt, end: pt, hover: null };
  } else if (tool === 'bundle') {
    // Each click adds a corner; clicking the last point again (a double-click)
    // finishes. Clicking a subsystem box plugs that end into it.
    const box = el?.dataset.kind === 'placement' || el?.dataset.kind === 'resize' ? byId(doc.placements, el.dataset.id) : null;
    if (box && byId(doc.objects, box.objectId).type === 'subsystem') {
      const { side, offset } = nearestSide(box, pt);
      const g = boxPort(box, side, offset);
      const plug = { placementId: box.id, side, offset };
      if (!bundling) {
        bundling = { points: [g], cursor: g, cross: [{ end: 0, ...plug }] };
        return renderCanvas();
      }
      // Turn so the last leg goes straight into the box's edge.
      const last = bundling.points[bundling.points.length - 1];
      const corner = side === 'top' || side === 'bottom' ? { x: g.x, y: last.y } : { x: last.x, y: g.y };
      for (const q of [corner, g]) {
        const prev = bundling.points[bundling.points.length - 1];
        if (q.x !== prev.x || q.y !== prev.y) bundling.points.push(q);
      }
      (bundling.cross ||= []).push({ end: 1, ...plug });
      return finishBundle();
    }
    const g = gridPoint(pt);
    if (!bundling) bundling = { points: [g], cursor: g };
    else {
      const last = bundling.points[bundling.points.length - 1];
      const next = orthoFrom(last, g);
      if (next.x === last.x && next.y === last.y) return finishBundle();
      bundling.points.push(next);
    }
    renderCanvas();
  }
});

svg.addEventListener('pointermove', (e) => {
  const pt = toWorld(e);
  if (!drag) {
    // No previews while something is selected (they'd cover what you're working on).
    hoverPreview.hover(tool === 'select' && !e.buttons && !spaceDown && !selection ? hoveredBox(e) : null);
    if (wiring) {
      wiring.end = pt;
      wiring.hover = targetAt(elementAt(e), pt);
      renderCanvas();
    }
    if (bundling) {
      bundling.cursor = gridPoint(pt);
      renderCanvas();
    }
    return;
  }
  if (drag.type === 'pan') {
    Object.assign(view(), { x: drag.view.x + e.clientX - drag.sx, y: drag.view.y + e.clientY - drag.sy });
  } else if (drag.type === 'box' || drag.type === 'marquee' || drag.type === 'lineDraw') {
    drag.end = pt;
  } else if (drag.type === 'wire') {
    drag.end = pt;
    drag.hover = targetAt(elementAt(e), pt);
  } else {
    drag.cmd = dragCommand(drag, pt, e) ?? drag.cmd;
    preview = (drag.cmd && apply(doc, drag.cmd).doc) || null;
  }
  renderCanvas();
});

svg.addEventListener('pointerup', async (e) => {
  const d = drag;
  drag = null;
  if (!d) return;
  const pt = toWorld(e);

  if (d.type === 'box' && tool === 'text') {
    const box = boxFrom(d.start, pt, NOTE_BOX);
    renderCanvas();
    askNote(null, box);
  } else if (d.type === 'moveUnknown' && d.cmd && unknownDropTarget(d, e, pt)) {
    // An unknown load (a floating wire end) dropped onto something attaches its wire there.
    preview = null;
    const seg = doc.segments.find((s) => [s.from, s.to].some((ep) => ep.kind === 'unknown' && ep.unknownId === d.id));
    const end = seg.from.kind === 'unknown' && seg.from.unknownId === d.id ? 'from' : 'to';
    lastClick = {};
    commit({ type: 'reconnectEnd', id: seg.id, end, target: unknownDropTarget(d, e, pt) });
  } else if (d.cmd) {
    const moved = preview && JSON.stringify(preview) !== JSON.stringify(doc);
    preview = null;
    if (moved) {
      lastClick = {}; // a press that became a drag doesn't count toward a double-click
      commit(d.cmd);
    } else if (d.type === 'segEnd' || d.type === 'segClick' || d.segmentId || (d.type === 'moveLabel' && d.of === 'segment')) {
      openWire(d.segmentId || d.id);
    } else renderCanvas();
  } else if (d.type === 'segClick' || d.type === 'segEnd' || d.segmentId || (d.type === 'moveLabel' && d.of === 'segment')) {
    openWire(d.segmentId || d.id);
  } else if (d.type === 'moveLabel') {
    render();
  } else if (d.type === 'lineDraw') {
    const [a, b] = [gridPoint(d.start), gridPoint(pt)];
    askLine(null, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  } else if (d.type === 'box') {
    const box = boxFrom(d.start, pt);
    const objectType = tool;
    renderCanvas();
    document.getElementById('objectTitle').textContent = `New ${objectType}`;
    const answer = await ask(objectDialog, { name: '' });
    if (!answer) return;
    const r = commit({ type: 'addObject', sheetId: currentSheet(), name: answer.name, objectType, ...box });
    if (r) {
      selection = { kind: 'placement', id: r.id };
      render();
    }
  } else if (d.type === 'marquee') {
    const items = itemsInRect(doc, currentSheet(), rectFrom(d.start, pt));
    selection = items.length > 1 ? { kind: 'many', items } : items[0] ?? null;
    render();
  } else if (d.type === 'wire') {
    const to = targetAt(elementAt(e), pt);
    const click = Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < G / 2;
    if (d.from.kind === 'branch' && targetWire(d.from)?.direction === 'directed') {
      renderCanvas();
      return toast(`${targetWire(d.from).name} is directed, so it can't branch partway along. Start from a module or via instead.`);
    }
    // Starting on a bundle pulls a wire out of it: ask which one first.
    if (d.from.kind === 'bundle') {
      renderCanvas();
      if (!click && ghostEnd({ ...d, hover: to }).kind === 'point') return;
      const pull = await askPull(d.from.bundleId, d.from.prefer);
      if (!pull) return;
      d.from = { ...d.from, pull };
    }
    // A click (no real drag) starts a wire that follows the pointer until the next click.
    if (click) {
      wiring = { ...d, end: pt, hover: to };
      renderCanvas();
    } else if (ghostEnd({ ...d, hover: to }).kind === 'point') {
      renderCanvas();
    } else {
      finishWire(d.from, to);
    }
  }
});

// The browser can abandon a drag (e.g. a system gesture); drop it and its preview.
svg.addEventListener('pointercancel', () => {
  drag = null;
  preview = null;
  renderCanvas();
});

svg.addEventListener('pointerleave', () => hoverPreview.hover(null));

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  hoverPreview.cancel();
  const v = view();
  const r = svg.getBoundingClientRect();
  const k = Math.min(4, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  Object.assign(v, { x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k, k });
  renderCanvas();
}, { passive: false });

window.addEventListener('resize', renderCanvas);

// ---- keyboard & toolbar -----------------------------------------------------

function setTool(name) {
  tool = name;
  if (wiring || bundling) {
    wiring = null;
    bundling = null;
    renderCanvas();
  }
  svg.dataset.tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
}

const TOOL_KEYS = { v: 'select', m: 'module', s: 'subsystem', u: 'unknown', w: 'wire', b: 'bundle', t: 'text', l: 'line' };

document.addEventListener('keydown', (e) => {
  hoverPreview.hide();
  if (e.target.closest?.('input, textarea, select, dialog')) return;
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if ((e.metaKey || e.ctrlKey) && key === 'y') {
    e.preventDefault();
    redo();
  } else if (e.metaKey || e.ctrlKey || e.altKey) {
    // leave other shortcuts to the browser
  } else if (e.key === ' ') {
    e.preventDefault();
    spaceDown = true;
    svg.classList.add('panning');
  } else if (TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  } else if (e.key === 'Escape' && wiring) {
    wiring = null; // cancel the wire being drawn, but stay in the Wire tool
    renderCanvas();
  } else if (e.key === 'Escape' && bundling) {
    bundling = null; // cancel the bundle being laid out, but stay in the Bundle tool
    renderCanvas();
  } else if (e.key === 'Enter' && bundling) {
    finishBundle();
  } else if (e.key === 'Escape') {
    setTool('select');
    selection = null;
    subject = null;
    preview = null;
    render();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  }
});

const releaseSpace = () => {
  spaceDown = false;
  svg.classList.remove('panning');
};
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') releaseSpace();
});
window.addEventListener('blur', releaseSpace);

for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);

document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'default.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const importFile = document.getElementById('importFile');
document.getElementById('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  let data;
  try {
    data = upgrade(JSON.parse(await file.text()));
  } catch {
    return toast(`${file.name} is not valid JSON.`);
  }
  const problems = validate(data);
  if (problems.length) return toast(`Can't import ${file.name}: ${problems[0]}`);
  replaceDoc(data, `Imported ${file.name}. Undo goes back.`);
});

async function loadDefault() {
  try {
    const r = await fetch('default.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    const data = upgrade(await r.json());
    return validate(data).length ? null : data;
  } catch {
    return null;
  }
}

document.getElementById('reset').addEventListener('click', async () => {
  const data = await loadDefault();
  if (data) replaceDoc(data, 'Loaded default.json. Undo goes back.');
  else toast('No valid default.json was found.');
});

document.getElementById('new').addEventListener('click', () => replaceDoc(emptyDoc(), 'Started an empty diagram. Undo goes back.'));

// ---- start ------------------------------------------------------------------

const saved = upgrade(localStore.load());
doc = saved && !validate(saved).length ? saved : (await loadDefault()) ?? emptyDoc();
setTool('select');
render();
