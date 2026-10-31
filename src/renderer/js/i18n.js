// Dogfile in Spanish, German, French, Portuguese and Chinese. The interface is written in English; this layer
// swaps the words on screen for the chosen language as they appear (menus, buttons, dialogs, settings, tooltips),
// leaving file and folder names, document text and anything you typed alone.
// Dictionaries: assets/i18n/<lang>.json, { "English text": "translation" }; "{0}" marks a part that varies.
export const LANGS = [['auto', 'Automatic (Windows language)'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['fr', 'Français'], ['pt', 'Português'], ['zh', '中文 (简体)']];
const SUPPORTED = new Set(['es', 'de', 'fr', 'pt', 'zh']);

let dict = null;          // exact matches
let byPrefix = new Map(); // patterns with parts that vary, grouped by their first characters
let loose = [];           // patterns that start with a varying part
let current = 'en';
const SKIP = '.nm, .cm-editor, .cm-content, [translate="no"], .notranslate, input, textarea, select option[data-raw], .tab-title, .crumb, .crumbs, .pv-name, .pv-text, .pv-code, .pv-meta .v, .si-label.user, .as-msg.me, .as-write, code, pre, kbd, .xterm, .hi-main b, .ws-name, .mitem .nm, .lsize, .cell .nm, .drow .c-name, .vw-name, .q-name, .pl-title, .track-name, .md-body, .note-text';

export function langFor(setting) {
  const want = !setting || setting === 'auto' ? (navigator.language || 'en').slice(0, 2).toLowerCase() : setting;
  return SUPPORTED.has(want) ? want : 'en';
}
export const language = () => current;

function compile(d) {
  const exact = Object.create(null);
  const pre = new Map();
  const lo = [];
  for (let [k, v] of Object.entries(d)) {
    if (!v) continue;
    k = k.trim(); v = String(v).trim();
    if (!k) continue;
    if (!/\{\d\}/.test(k)) { exact[k] = v; continue; }
    // spaces next to a varying part may be missing once the text is trimmed ("…shortcuts. {0}" with nothing in {0})
    const parts = k.split(/(\{\d\})/);
    const src = '^' + parts.map((p, i) => {
      if (/^\{\d\}$/.test(p)) return '([\\s\\S]*?)';
      let e = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (i > 0) e = e.replace(/^ +/, '\\s*');
      if (i < parts.length - 1) e = e.replace(/ +$/, '\\s*');
      return e;
    }).join('') + '$';
    let re; try { re = new RegExp(src); } catch { continue; }
    const order = [...k.matchAll(/\{(\d)\}/g)].map((m) => +m[1]);
    const pat = { re, v, order };
    const lit = k.split(/\{\d\}/)[0];
    if (lit.length >= 3) { const key = lit.slice(0, 3); if (!pre.has(key)) pre.set(key, []); pre.get(key).push(pat); } else lo.push(pat);
  }
  dict = exact; byPrefix = pre; loose = lo;
}
function viaPattern(t) {
  const tryList = (list) => {
    for (const p of list) {
      const m = p.re.exec(t);
      if (!m) continue;
      const vals = {}; p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
      return p.v.replace(/\{(\d)\}/g, (_, n) => (vals[n] != null ? tr(vals[n]) : ''));
    }
    return null;
  };
  return (t.length >= 3 && byPrefix.has(t.slice(0, 3)) && tryList(byPrefix.get(t.slice(0, 3)))) || tryList(loose);
}
/** the translation of one piece of interface text (unchanged when there's none) */
export function tr(s) {
  if (!dict || typeof s !== 'string') return s;
  const t = s.trim();
  if (!t || t.length > 600) return s;
  let v = dict[t];
  if (v === undefined) {
    // "Save…" / "Save:" / trailing punctuation the dictionary doesn't have
    const m = /^(.*?)([…:.!?]+)$/.exec(t);
    if (m && dict[m[1]] !== undefined) v = dict[m[1]] + m[2];
    else v = viaPattern(t);
  }
  if (v == null) return s;
  return t === s ? v : s.replace(t, v);
}
const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
const done = new WeakMap(); // text node -> the translation it got (so we don't translate twice)
function skip(el) { return !el || (el.closest && el.closest(SKIP)); }
function doText(n) {
  const val = n.nodeValue;
  if (!val || !/[A-Za-z]/.test(val) || done.get(n) === val) return;
  if (skip(n.parentElement)) return;
  const out = tr(val);
  if (out !== val) { n.nodeValue = out; }
  done.set(n, n.nodeValue);
}
const FIELD = 'input, textarea';
function doEl(el) {
  if (el.nodeType !== 1) return;
  // text boxes keep what's typed in them, but their hint text and tooltip are interface text
  if (el.matches(FIELD)) { if (el.parentElement && skip(el.parentElement)) return; for (const a of ATTRS) { const v = el.getAttribute(a); if (v && /[A-Za-z]/.test(v)) { const o = tr(v); if (o !== v) el.setAttribute(a, o); } }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) el.value = tr(el.value);
    return;
  }
  if (skip(el)) return;
  for (const a of ATTRS) { const v = el.getAttribute(a); if (v && /[A-Za-z]/.test(v)) { const o = tr(v); if (o !== v) el.setAttribute(a, o); } }
  if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) el.value = tr(el.value);
  if (el.tagName === 'OPTION' && el.textContent) { const o = tr(el.textContent); if (o !== el.textContent) el.textContent = o; return; }
}
export function translateTree(root) {
  if (!dict || !root) return;
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) { if (skip(root) && !root.matches(FIELD)) return; doEl(root); }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) && !n.matches(FIELD) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let n;
  while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doEl(n); }
}
let observer = null;
export async function initI18n(setting) {
  const lang = langFor(setting);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  if (lang === current && (lang === 'en' || dict)) return lang;
  current = lang;
  if (lang === 'en') { dict = null; observer?.disconnect(); observer = null; return lang; }
  try { compile(await (await fetch(new URL(`../assets/i18n/${lang}.json`, import.meta.url))).json()); } catch { dict = null; current = 'en'; return 'en'; }
  translateTree(document.body);
  document.title = tr(document.title);
  observer?.disconnect();
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') { if (ATTRS.includes(m.attributeName)) doEl(m.target); }
      else for (const n of m.addedNodes) translateTree(n);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  return lang;
}
