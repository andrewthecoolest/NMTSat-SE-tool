// The info view: a large centered dialog laid out like a man page.
import { byId, nodeName, objectByName, wireByName } from './model.js';
import { appearsOn, connections, sheetName, subsystemSummary, wireSummary } from './derive.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const section = (title, ...body) => h('section', {}, h('h3', {}, title), h('div', { class: 'body' }, ...body));
const list = (items, empty = 'None.') => (items.length ? h('ul', {}, items) : h('p', { class: 'muted' }, empty));
const swatch = (color) => h('span', { class: 'swatch', style: `background:${color}` });

// Editable fields use defaultValue so unsaved edits can be detected on close.
const textInput = (value, onchange, props = {}) => h('input', { defaultValue: value, onchange, autocomplete: 'off', ...props });
const colorInput = (value, onchange) => h('input', { type: 'color', defaultValue: value, onchange, title: 'Color' });
const descriptionInput = (value, onchange) =>
  h('textarea', { class: 'description', defaultValue: value, onchange, placeholder: 'No description yet.', spellcheck: true });

// Save a field without rebuilding the page, so a click that blurred the field
// (say, on Delete) still lands on its button.
function save(app, e, cmd) {
  const ok = !!app.edit(cmd);
  if (ok) e.target.defaultValue = e.target.value;
  return ok;
}

// Commit any field whose edit hasn't fired a change event yet (e.g. closed with Esc).
export function flushEdits(el) {
  for (const field of el.querySelectorAll('input, textarea')) {
    if (field.value !== field.defaultValue) field.dispatchEvent(new Event('change'));
  }
}

// app: { doc, subject, sheetId, commit, preview, open, close, refresh, toast, goToSheet,
//        edit, removePlacement, deleteEverywhere, deleteSegment, deleteUnknown }
export function renderPanel(el, app) {
  const { doc, subject } = app;
  let content = null;
  if (subject?.kind === 'object' && byId(doc.objects, subject.id)) content = objectPage(app);
  if (subject?.kind === 'wire' && byId(doc.wires, subject.id)) content = wirePage(app);
  if (subject?.kind === 'unknown' && byId(doc.unknownLoads, subject.id)) content = unknownPage(app);
  if (!content) {
    el.replaceChildren();
    if (el.open) el.close();
    return;
  }
  el.replaceChildren(h('div', { class: 'page' }, content));
  if (!el.open) el.showModal();
}

function header(app, title) {
  return h('header', {}, h('span', { class: 'title' }, title), h('button', { class: 'close', title: 'Close (Esc)', onclick: app.close }, '×'));
}

function sheetLinks(app, sheetIds) {
  return list(sheetIds.map((id) => h('li', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.goToSheet(id); } }, sheetName(app.doc, id)))));
}

function connectionList(entries, arrowSymbol) {
  return list(entries.map((c) => h('li', { class: c.unresolved ? 'unresolved' : '' },
    swatch(c.wire.color), `${c.wire.name} ${arrowSymbol} ${c.name}`, c.unresolved ? ' (unresolved)' : '')));
}

function objectPage(app) {
  const { doc, subject } = app;
  const obj = byId(doc.objects, subject.id);
  const placement = byId(doc.placements, subject.placementId);

  // Renaming to another object's name merges the two (Undo separates them again).
  const rename = (e) => {
    const name = e.target.value.trim();
    const other = objectByName(doc, name);
    if (!other || other === obj) {
      if (save(app, e, { type: 'editObject', id: obj.id, name })) e.target.closest('.page').querySelector('.title').textContent = `${name}(${obj.type})`;
      return;
    }
    if (other.type !== obj.type) {
      app.toast(`${other.name} already exists as a ${other.type}.`);
      return app.refresh();
    }
    if (!app.commit({ type: 'mergeObjects', fromId: obj.id, intoId: other.id }, `Can't merge: `)) return;
    app.toast(`Merged ${obj.name} into ${other.name}. Undo separates them.`);
    app.open({ kind: 'object', id: other.id });
  };

  const parts = [
    header(app, `${obj.name}(${obj.type})`),
    section('NAME', h('div', { class: 'row' },
      textInput(obj.name, rename, { class: 'name' }),
      colorInput(obj.color, (e) => save(app, e, { type: 'editObject', id: obj.id, color: e.target.value })))),
    section('DESCRIPTION', descriptionInput(obj.description, (e) => save(app, e, { type: 'editObject', id: obj.id, description: e.target.value }))),
  ];

  if (obj.type === 'module') {
    const conns = connections(doc, obj.id);
    parts.push(section('CONN-IN', connectionList(conns.in, '←')), section('CONN-OUT', connectionList(conns.out, '→')));
  } else {
    const s = subsystemSummary(doc, obj.id);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    parts.push(
      section('CONTENTS', h('p', {}, [plural(s.modules, 'module'), plural(s.subsystems, 'subsystem'), plural(s.unknownLoads, 'unknown load')].join(' · '))),
      section('BOUNDARY WIRES', list(s.vias.map((v) => h('li', { class: v.open ? 'unresolved' : '' },
        swatch(v.wire.color), `${v.wire.name} (${v.via.direction})`, v.open ? ' (open via)' : '')))),
    );
  }

  parts.push(
    section('APPEARS ON', sheetLinks(app, appearsOn(doc, obj.id))),
    h('footer', {},
      placement && placement.sheetId === app.sheetId && h('button', { onclick: () => app.removePlacement(placement.id) }, 'Remove from this sheet'),
      h('button', { class: 'danger', onclick: () => app.deleteEverywhere(obj.id) }, 'Delete everywhere')),
  );
  return parts;
}

function wirePage(app) {
  const { doc, subject } = app;
  const wire = byId(doc.wires, subject.id);
  const summary = wireSummary(doc, wire.id);

  const rename = (e) => {
    const name = e.target.value.trim();
    const other = wireByName(doc, name);
    if (!other || other === wire) {
      if (save(app, e, { type: 'editWire', id: wire.id, name })) e.target.closest('.page').querySelector('.title').textContent = `${name}(wire)`;
      return;
    }
    if (!app.commit({ type: 'mergeWires', fromId: wire.id, intoId: other.id }, `Can't merge: `)) return;
    app.toast(`Merged ${wire.name} into ${other.name}. Undo separates them.`);
    app.open({ kind: 'wire', id: other.id });
  };

  const setDirection = (e) => {
    if (e.target.value === 'bidirectional') {
      app.commit({ type: 'setDirection', wireId: wire.id, direction: 'bidirectional' });
    } else {
      subject.orienting = true;
      app.refresh();
    }
  };

  // Choosing an origin when making a bidirectional wire directed: preview, then apply.
  let orient = null;
  if (subject.orienting) {
    let unknownCount = 0;
    const label = (n) => (n.startsWith('u:') ? `Unknown load ${++unknownCount}` : nodeName(doc, n));
    const command = (origin) => ({ type: 'setDirection', wireId: wire.id, direction: 'directed', origin });
    const select = h('select', { onchange: (e) => app.preview(command(e.target.value)) },
      summary.nodes.map((n) => h('option', { value: n }, label(n))));
    const stop = () => { subject.orienting = false; app.preview(null); app.refresh(); };
    orient = h('div', { class: 'orient' },
      h('p', {}, 'Pick the origin. Every segment will point away from it.'),
      select,
      h('button', { onclick: () => { if (app.commit(command(select.value))) stop(); } }, 'Apply'),
      h('button', { onclick: stop }, 'Cancel'));
    queueMicrotask(() => app.preview(command(select.value)));
  }

  return [
    header(app, `${wire.name}(wire)`),
    section('NAME', h('div', { class: 'row' },
      textInput(wire.name, rename, { class: 'name' }),
      colorInput(wire.color, (e) => save(app, e, { type: 'editWire', id: wire.id, color: e.target.value })))),
    section('DESCRIPTION', descriptionInput(wire.description, (e) => save(app, e, { type: 'editWire', id: wire.id, description: e.target.value }))),
    section('DIRECTION',
      h('select', { onchange: setDirection },
        h('option', { value: 'directed', selected: wire.direction === 'directed' || subject.orienting }, 'Directed'),
        h('option', { value: 'bidirectional', selected: wire.direction === 'bidirectional' && !subject.orienting }, 'Bidirectional')),
      orient),
    summary.origin && section('ORIGIN', h('p', {}, summary.origin.name)),
    section('ENDPOINTS', list(summary.endpoints.map((n) => h('li', { class: n.unresolved ? 'unresolved' : '' }, n.name, n.unresolved ? ' (unresolved)' : '')))),
    section('APPEARS ON', sheetLinks(app, summary.sheets)),
    subject.segmentId && byId(doc.segments, subject.segmentId) &&
      h('footer', {}, h('button', { class: 'danger', onclick: () => app.deleteSegment(subject.segmentId) }, 'Delete segment')),
  ];
}

function unknownPage(app) {
  const { subject } = app;
  const name = h('input', { list: 'objectNames', placeholder: 'e.g. Solar Array', autocomplete: 'off' });
  const type = h('select', {}, h('option', { value: 'module' }, 'Module'), h('option', { value: 'subsystem' }, 'Subsystem'));
  const promote = (e) => {
    e.preventDefault();
    const r = app.commit({ type: 'promoteUnknown', id: subject.id, name: name.value, objectType: type.value });
    if (r) app.open({ kind: 'object', id: byId(r.doc.placements, r.id).objectId, placementId: r.id });
  };
  return [
    header(app, 'unknown(load)'),
    section('DESCRIPTION', h('p', { class: 'unresolved' }, 'An unresolved placeholder at the end of a wire.')),
    section('PROMOTE',
      h('p', {}, 'Name it to turn it into a module or subsystem. Its wire stays attached.'),
      h('form', { class: 'row', onsubmit: promote }, name, type, h('button', {}, 'Promote'))),
    h('footer', {}, h('button', { class: 'danger', onclick: () => app.deleteUnknown(subject.id) }, 'Delete')),
  ];
}
