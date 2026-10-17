// Hover preview of a box: after the pointer rests on it for half a second, a
// read-only window expands from the box. A subsystem shows its sheet (60% of the
// canvas) with its description, contents and boundary wires beside it; a module
// shows a card with its description and connections. Moving the pointer out of
// the preview shrinks it straight back; clicking it opens the subsystem or info.
import { byId } from './model.js';
import { appearsOn, connections, sheetName, subsystemSummary } from './derive.js';
import { renderSheet, sheetBounds } from './view.js';
import { h } from './panel.js';
import { plainText, richToHtml } from './richtext.js';

const HOVER_MS = 500;
const CLOSE_MS = 200;   // matches #preview.closing in style.css
const SIZE = 0.6;       // expanded subsystem preview, as a fraction of the canvas
const SIDE = 0.35;      // share of a subsystem preview's width given to its details
const CARD_WIDTH = [340, 560]; // module card width range (px); it aims for 40% of the canvas
const KEEP_IN = 20;     // the pointer stays at least this far inside the preview
const HEADER = 32;      // height of the preview's title bar
const MAX_ZOOM = 2;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---- read-only details ------------------------------------------------------

const section = (title, ...body) => h('section', {}, h('h3', {}, title), ...body);
const list = (items, empty = 'None.') => (items.length ? h('ul', {}, items) : h('p', { class: 'muted' }, empty));
const swatch = (color) => h('span', { class: 'swatch', style: `background:${color}` });

function description(rich) {
  if (!plainText(rich).trim()) return h('p', { class: 'muted' }, 'No description.');
  const view = h('div', { class: 'rich-view' });
  view.innerHTML = richToHtml(rich);
  return view;
}

const connectionList = (entries, arrow) => list(entries.map((c) => h('li', { class: c.unresolved ? 'unresolved' : '' },
  swatch(c.wire.color), `${c.wire.name} ${arrow} ${c.name}`, c.unresolved ? ' (unresolved)' : '')));

function subsystemDetails(doc, obj) {
  const s = subsystemSummary(doc, obj.id);
  return h('aside', { class: 'details scroll' },
    section('DESCRIPTION', description(obj.description)),
    section('CONTENTS', h('p', {}, [plural(s.modules, 'module'), plural(s.subsystems, 'subsystem'), plural(s.unknownLoads, 'unknown load')].join(' · '))),
    section('BOUNDARY WIRES', list(s.vias.map((v) => h('li', { class: v.open ? 'unresolved' : '' },
      swatch(v.wire.color), `${v.wire.name} (${v.via.direction})`, v.open ? ' (open via)' : '')))));
}

function moduleDetails(doc, obj) {
  const conns = connections(doc, obj.id);
  return h('div', { class: 'details card-body scroll' },
    section('DESCRIPTION', description(obj.description)),
    section('CONN-IN', connectionList(conns.in, '←')),
    section('CONN-OUT', connectionList(conns.out, '→')),
    section('APPEARS ON', list(appearsOn(doc, obj.id).map((id) => h('li', {}, sheetName(doc, id))))));
}

function title(obj) {
  const hint = obj.type === 'subsystem' ? 'Click to open · move away to close' : 'Click for info · move away to close';
  return h('header', {}, swatch(obj.color), h('span', { class: 'name' }, obj.name), h('span', { class: 'hint' }, hint));
}

// The subsystem's sheet, fitted to `w` × `h`; the viewBox scales it while the preview grows.
function sheetView(doc, obj, w, h, parentName) {
  const b = sheetBounds(doc, obj.id);
  if (!b) return Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing inside yet.' });
  const k = Math.min(w / b.w, h / b.h, MAX_ZOOM);
  const vw = w / k;
  const vh = h / k;
  const vx = b.x + b.w / 2 - vw / 2;
  const vy = b.y + b.h / 2 - vh / 2;
  const markup = renderSheet(doc, {
    sheetId: obj.id, parentName, selection: null,
    view: { x: -vx, y: -vy, k: 1 }, width: vw, height: vh, boundary: false, patternId: 'previewDots',
  });
  const holder = document.createElement('div');
  holder.innerHTML = `<svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${markup}</svg>`;
  return holder.firstElementChild;
}

// ---- the preview window -----------------------------------------------------

// host: the element the preview covers. getDoc(): the current document.
// boxRect(placementId): screen rect of that box, or null. parentName(): name of
// the sheet being viewed. onOpen(placementId): open what the preview shows.
export function createPreview({ host, getDoc, boxRect, parentName, onOpen }) {
  const el = document.createElement('div');
  el.id = 'preview';
  el.hidden = true;
  host.append(el);

  let timer = null;
  let waitingFor = null;   // placement id the hover timer is running for
  let open = null;         // { placementId, from } while expanded
  let closeTimer = null;
  let pointer = { x: 0, y: 0 }; // last pointer position, relative to host

  const local = (r) => {
    const hr = host.getBoundingClientRect();
    return { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height };
  };

  // Where the expanded preview goes along one axis: centered, but moved just
  // enough to keep the hovered box (when it fits) and the pointer inside it.
  function axis(size, total, boxStart, boxEnd, at) {
    let pos = (total - size) / 2;
    if (boxEnd - boxStart <= size) pos = clamp(pos, boxEnd - size, boxStart);
    pos = clamp(pos, at + KEEP_IN - size, at - KEEP_IN);
    return clamp(pos, 0, Math.max(0, total - size));
  }

  const place = (r) => Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

  function cancel() {
    clearTimeout(timer);
    timer = null;
    waitingFor = null;
  }

  // Call on every pointer move over the canvas with the hovered box's
  // placement id, or null when not over one.
  function hover(placementId) {
    if (open || placementId === waitingFor) return;
    cancel();
    if (!placementId) return;
    waitingFor = placementId;
    timer = setTimeout(() => expand(placementId), HOVER_MS);
  }

  // The module card's natural height at a given width, capped at maxHeight.
  function cardHeight(width, maxHeight) {
    Object.assign(el.style, { left: '0px', top: '0px', width: `${width}px`, height: 'auto', visibility: 'hidden', transition: 'none' });
    el.hidden = false;
    const natural = el.offsetHeight;
    Object.assign(el.style, { visibility: '', transition: '' });
    return Math.min(natural, maxHeight);
  }

  function expand(placementId) {
    cancel();
    const doc = getDoc();
    const p = byId(doc.placements, placementId);
    const obj = p && byId(doc.objects, p.objectId);
    const rect = boxRect(placementId);
    if (!obj || !rect) return;

    const hr = host.getBoundingClientRect();
    const from = local(rect);
    clearTimeout(closeTimer);
    el.classList.remove('closing');
    el.dataset.type = obj.type;

    let width;
    let height;
    if (obj.type === 'subsystem') {
      width = hr.width * SIZE;
      height = hr.height * SIZE;
      const sheetWidth = width * (1 - SIDE);
      el.replaceChildren(title(obj), h('div', { class: 'split' },
        sheetView(doc, obj, sheetWidth, height - HEADER, parentName()), subsystemDetails(doc, obj)));
    } else {
      width = Math.min(clamp(hr.width * 0.4, ...CARD_WIDTH), hr.width);
      el.replaceChildren(title(obj), moduleDetails(doc, obj));
      height = cardHeight(width, hr.height * SIZE);
    }
    const final = {
      left: axis(width, hr.width, from.left, from.left + from.width, pointer.x),
      top: axis(height, hr.height, from.top, from.top + from.height, pointer.y),
      width,
      height,
    };
    el.hidden = false;
    place(from);
    el.getBoundingClientRect(); // start the transition from the box
    place(final);
    open = { placementId, from };
  }

  function hide(animate = true) {
    cancel();
    if (!open) return;
    const { from, placementId } = open;
    open = null;
    waitingFor = placementId; // don't reopen until the pointer has left that box
    const finish = () => {
      el.hidden = true;
      el.classList.remove('closing');
      el.replaceChildren();
    };
    if (!animate) return finish();
    el.classList.add('closing');
    place(from);
    closeTimer = setTimeout(finish, CLOSE_MS);
  }

  // Shrink as soon as the pointer is outside the preview (checked by position,
  // since the preview appears under a pointer that never "entered" it).
  document.addEventListener('pointermove', (e) => {
    const hr = host.getBoundingClientRect();
    pointer = { x: e.clientX - hr.left, y: e.clientY - hr.top };
    if (!open) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) hide();
  });
  document.documentElement.addEventListener('pointerleave', () => hide());
  window.addEventListener('blur', () => hide());
  // Scrolling works in the details; elsewhere it must not zoom the canvas behind.
  el.addEventListener('wheel', (e) => {
    if (!e.target.closest('.scroll')) e.preventDefault();
  }, { passive: false });
  el.addEventListener('click', () => {
    const id = open?.placementId;
    hide(false);
    if (id) onOpen(id);
  });

  return { hover, cancel, hide };
}
