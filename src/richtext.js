// Rich text for descriptions and notes. Stored as a plain string when it has no
// formatting, otherwise as a list of runs: { text, b?: true, size?: px, color?: '#rrggbb' }.

export const DEFAULT_SIZE = 14;
export const SIZES = [10, 12, 14, 18, 24, 32];
const SIZE_NAMES = { 10: 'Tiny', 12: 'Small', 14: 'Normal', 18: 'Large', 24: 'Huge', 32: 'Title' };
const HEX = /^#[0-9a-f]{6}$/i;
const RUN_KEYS = new Set(['text', 'b', 'size', 'color']);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function isRich(v) {
  if (typeof v === 'string') return true;
  return Array.isArray(v) && v.every((r) => r && typeof r.text === 'string'
    && Object.keys(r).every((k) => RUN_KEYS.has(k))
    && (r.b === undefined || r.b === true)
    && (r.size === undefined || SIZES.includes(r.size))
    && (r.color === undefined || HEX.test(r.color)));
}

export const runsOf = (rich) => (Array.isArray(rich) ? rich : [{ text: String(rich ?? '') }]);
export const plainText = (rich) => runsOf(rich).map((r) => r.text).join('');

// Merge neighbouring runs with the same style; plain text if nothing is styled.
export function normalize(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const run = { text: r.text };
    if (r.b) run.b = true;
    if (r.size && r.size !== DEFAULT_SIZE) run.size = r.size;
    if (r.color) run.color = r.color.toLowerCase();
    const last = out[out.length - 1];
    if (last && last.b === run.b && last.size === run.size && last.color === run.color) last.text += run.text;
    else out.push(run);
  }
  return out.some((r) => r.b || r.size || r.color) ? out : out.map((r) => r.text).join('');
}

// HTML for display; whitespace and newlines need `white-space: pre-wrap`.
export function richToHtml(rich) {
  return runsOf(rich).map((r) => {
    const style = [r.b && 'font-weight:bold', r.size && `font-size:${r.size}px`, r.color && `color:${r.color}`].filter(Boolean).join(';');
    return style ? `<span style="${style}">${esc(r.text)}</span>` : esc(r.text);
  }).join('');
}

// ---------------------------------------------------------------------------
// Editor (browser only)

const BLOCKS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

function toHex(color) {
  if (HEX.test(color)) return color;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : undefined;
}

const nearestSize = (px) => SIZES.reduce((best, s) => (Math.abs(s - px) < Math.abs(best - px) ? s : best));

// Read the editor's DOM back into runs.
function readRuns(root) {
  const runs = [];
  const text = () => runs.map((r) => r.text).join('');
  const walk = (node, style) => {
    if (node.nodeType === Node.TEXT_NODE) return runs.push({ ...style, text: node.data });
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') return runs.push({ ...style, text: '\n' });
    const s = { ...style };
    if (node.tagName === 'B' || node.tagName === 'STRONG') s.b = true;
    if (node.tagName === 'FONT' && node.getAttribute('color')) s.color = toHex(node.getAttribute('color')) ?? s.color;
    const weight = node.style?.fontWeight;
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) s.b = true;
    if (weight === 'normal' || Number(weight) === 400) s.b = false;
    if (node.style?.color) s.color = toHex(node.style.color) ?? s.color;
    const px = parseFloat(node.style?.fontSize);
    if (px > 0) s.size = nearestSize(px);
    if (BLOCKS.has(node.tagName) && text() && !text().endsWith('\n')) runs.push({ text: '\n' });
    for (const child of node.childNodes) walk(child, s);
  };
  for (const child of root.childNodes) walk(child, {});
  // Browsers keep a placeholder line break at the end of editable text.
  while (runs.length && runs[runs.length - 1].text.endsWith('\n')) {
    const last = runs[runs.length - 1];
    last.text = last.text.replace(/\n+$/, '');
    if (!last.text) runs.pop();
    else break;
  }
  return normalize(runs);
}

// font size="7" is a marker left by execCommand('fontSize'); swap it for real
// pixel sizes, keeping the selection (or caret) where it was.
function applyPendingSize(content) {
  const fonts = content.querySelectorAll('font[size="7"]');
  if (!fonts.length) return;
  const sel = document.getSelection();
  const keep = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
  for (const font of fonts) {
    const span = document.createElement('span');
    span.style.fontSize = `${content.pendingSize}px`;
    for (const inner of font.querySelectorAll('[style]')) inner.style.fontSize = '';
    for (const inner of font.querySelectorAll('font[size]')) inner.removeAttribute('size');
    span.append(...font.childNodes);
    font.replaceWith(span);
  }
  if (keep && content.contains(keep[0]) && content.contains(keep[2])) sel.setBaseAndExtent(...keep);
}

// A toolbar plus an editable area. onchange(value) runs when focus leaves the
// editor with changes (or on flush()); return true to mark the value saved.
export function richEditor({ value = '', onchange, placeholder = '', className = '' }) {
  const wrapper = el('div', { className: 'rich' });
  const content = el('div', { className: `rich-content ${className}`.trim(), contentEditable: 'true', spellcheck: true });
  content.dataset.placeholder = placeholder;
  content.innerHTML = richToHtml(value);
  let saved = JSON.stringify(normalize(runsOf(value)));

  // Remember the selection when focus leaves, so toolbar controls that take
  // focus (size menu, color picker) still format the text that was selected.
  let range = null;
  content.addEventListener('blur', () => {
    const sel = document.getSelection();
    range = sel.rangeCount && content.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  });

  const run = (fn) => {
    if (document.activeElement !== content) {
      content.focus();
      if (range && content.contains(range.startContainer) && content.contains(range.endContainer)) {
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    document.execCommand('styleWithCSS', false, false);
    fn();
    applyPendingSize(content);
  };

  const bold = el('button', { type: 'button', className: 'rich-bold', title: 'Bold (Ctrl/Cmd+B)', textContent: 'B' });
  bold.addEventListener('mousedown', (e) => e.preventDefault());
  bold.addEventListener('click', () => run(() => document.execCommand('bold')));

  const size = el('select', { title: 'Text size' });
  size.append(el('option', { value: '', textContent: 'Size' }), ...SIZES.map((s) => el('option', { value: s, textContent: `${SIZE_NAMES[s]} (${s})` })));
  size.addEventListener('change', () => {
    const px = Number(size.value);
    size.value = '';
    if (!px) return;
    content.pendingSize = px;
    run(() => document.execCommand('fontSize', false, '7'));
  });

  const color = el('input', { type: 'color', value: '#dc2626', title: 'Pick a text color' });
  const paint = el('button', { type: 'button', className: 'rich-paint', title: 'Color the selected text' });
  paint.append(el('span', { textContent: 'A' }));
  const showColor = () => paint.style.setProperty('--paint', color.value);
  showColor();
  color.addEventListener('input', showColor);
  color.addEventListener('change', () => run(() => document.execCommand('foreColor', false, color.value)));
  paint.addEventListener('mousedown', (e) => e.preventDefault());
  paint.addEventListener('click', () => run(() => document.execCommand('foreColor', false, color.value)));

  const clear = el('button', { type: 'button', title: 'Remove formatting from the selected text', textContent: 'Clear' });
  clear.addEventListener('mousedown', (e) => e.preventDefault());
  clear.addEventListener('click', () => run(() => document.execCommand('removeFormat')));

  content.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && (key === 'i' || key === 'u')) e.preventDefault(); // only bold is kept
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!document.execCommand('insertLineBreak')) document.execCommand('insertHTML', false, '<br>');
    }
  });
  content.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  content.addEventListener('input', () => {
    if (content.pendingSize) applyPendingSize(content);
    if (!content.textContent) content.replaceChildren(); // show the placeholder again
  });

  wrapper.flush = () => {
    const v = readRuns(content);
    if (JSON.stringify(v) === saved) return;
    if (onchange?.(v)) saved = JSON.stringify(v);
  };
  Object.defineProperty(wrapper, 'value', { get: () => readRuns(content) });
  wrapper.focusEditor = () => content.focus();
  wrapper.addEventListener('focusout', (e) => {
    if (!wrapper.contains(e.relatedTarget)) wrapper.flush();
  });

  wrapper.append(el('div', { className: 'rich-toolbar' }, bold, size, paint, color, clear), content);
  return wrapper;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
