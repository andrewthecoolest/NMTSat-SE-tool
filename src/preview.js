// Hover preview of a subsystem's sheet: after the pointer rests on a subsystem
// box for a second, its contents expand from the box to fill the canvas. Moving
// the pointer out of the preview shrinks it straight back; clicking opens the sheet.
import { byId } from './model.js';
import { renderSheet, sheetBounds } from './view.js';

const HOVER_MS = 1000;
const CLOSE_MS = 200;   // matches #preview.closing in style.css
const MARGIN = 24;      // gap between the expanded preview and the canvas edge
const HEADER = 32;      // height of the preview's title bar
const MAX_ZOOM = 2;

// host: the element the preview covers. getDoc(): the current document.
// boxRect(placementId): screen rect of that box, or null. parentName(): name of
// the sheet being viewed. onOpen(subsystemId): enter that subsystem's sheet.
export function createPreview({ host, getDoc, boxRect, parentName, onOpen }) {
  const el = document.createElement('div');
  el.id = 'preview';
  el.hidden = true;
  host.append(el);

  let timer = null;
  let waitingFor = null;   // placement id the hover timer is running for
  let open = null;         // { placementId, subsystemId, from } while expanded
  let closeTimer = null;

  const local = (r) => {
    const h = host.getBoundingClientRect();
    return { left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height };
  };
  const place = (r) => Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

  function cancel() {
    clearTimeout(timer);
    timer = null;
    waitingFor = null;
  }

  // Call on every pointer move over the canvas with the hovered subsystem
  // placement's id, or null when not over one.
  function hover(placementId) {
    if (open || placementId === waitingFor) return;
    cancel();
    if (!placementId) return;
    waitingFor = placementId;
    timer = setTimeout(() => expand(placementId), HOVER_MS);
  }

  function content(doc, subsystem, size) {
    const title = document.createElement('header');
    const name = document.createElement('span');
    name.textContent = subsystem.name;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Click to open · move away to close';
    title.append(name, hint);

    const b = sheetBounds(doc, subsystem.id);
    if (!b) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing inside yet.';
      return [title, empty];
    }
    // Fit the contents to the final size; the viewBox scales them while it grows.
    const w = size.width;
    const h = size.height - HEADER;
    const k = Math.min(w / b.w, h / b.h, MAX_ZOOM);
    const vw = w / k;
    const vh = h / k;
    const vx = b.x + b.w / 2 - vw / 2;
    const vy = b.y + b.h / 2 - vh / 2;
    const markup = renderSheet(doc, {
      sheetId: subsystem.id, parentName: parentName(), selection: null,
      view: { x: -vx, y: -vy, k: 1 }, width: vw, height: vh, boundary: false, patternId: 'previewDots',
    });
    const holder = document.createElement('div');
    holder.innerHTML = `<svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${markup}</svg>`;
    return [title, holder.firstElementChild];
  }

  function expand(placementId) {
    cancel();
    const doc = getDoc();
    const p = byId(doc.placements, placementId);
    const subsystem = p && byId(doc.objects, p.objectId);
    const rect = boxRect(placementId);
    if (subsystem?.type !== 'subsystem' || !rect) return;

    const h = host.getBoundingClientRect();
    const final = { left: MARGIN, top: MARGIN, width: Math.max(0, h.width - 2 * MARGIN), height: Math.max(0, h.height - 2 * MARGIN) };
    const from = local(rect);
    clearTimeout(closeTimer);
    el.classList.remove('closing');
    el.replaceChildren(...content(doc, subsystem, final));
    el.hidden = false;
    place(from);
    el.getBoundingClientRect(); // start the transition from the box
    place(final);
    open = { placementId, subsystemId: subsystem.id, from };
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
    if (!open) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) hide();
  });
  document.documentElement.addEventListener('pointerleave', () => hide());
  window.addEventListener('blur', () => hide());
  el.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('click', () => {
    const id = open?.subsystemId;
    hide(false);
    if (id) onOpen(id);
  });

  return { hover, cancel, hide };
}
