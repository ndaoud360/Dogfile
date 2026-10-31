// Small, dependency-free Markdown renderer (used by the preview pane and Dogfile Notepad).
import { esc } from './core.js';

export function markdown(src) {
  const lines = esc(src).split(/\r?\n/);
  let html = '', inCode = false, inList = null;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[$1]').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
  for (const l of lines) {
    if (l.startsWith('```')) { if (inCode) { html += '</pre>'; inCode = false; } else { html += '<pre>'; inCode = true; } continue; }
    if (inCode) { html += l + '\n'; continue; }
    const m = l.match(/^(#{1,6})\s+(.*)/);
    const li = l.match(/^\s*([-*+]|\d+\.)\s+(.*)/);
    if (inList && !li) { html += `</${inList}>`; inList = null; }
    if (m) html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    else if (li) { const tag = /\d/.test(li[1]) ? 'ol' : 'ul'; if (!inList) { html += `<${tag}>`; inList = tag; } html += `<li>${inline(li[2])}</li>`; }
    else if (/^&gt;/.test(l)) html += `<blockquote>${inline(l.replace(/^&gt;\s?/, ''))}</blockquote>`;
    else if (/^(-{3,}|\*{3,})$/.test(l.trim())) html += '<hr>';
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += `</${inList}>`;
  if (inCode) html += '</pre>';
  return html;
}
