// Understanding requests for the app in the current tab: Notepad ("sort the lines and remove duplicates",
// "replace cat with dog", "make it uppercase"), Photos ("erase everything and apply a sepia filter", "change the
// size to 1920 wide", "crop to square") and the Player ("louder", "play at 1.5x", "skip 30 seconds").
// A request is split into steps; each step becomes { op, arg, label } that the app carries out.
// Pure functions, no DOM: tested by build/test-assistant-apps.mjs.

const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100, a: 1, an: 1 };
const num = (s) => { if (s == null) return null; s = String(s).trim().toLowerCase().replace(/,/g, ''); if (s in NUMW) return NUMW[s]; const n = parseFloat(s); return isFinite(n) ? n : null; };
const N = String.raw`(-?\d+(?:[.,]\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)`;

// quoted pieces are kept whole ("replace "a, b and c" with x")
function protect(text) {
  const q = [];
  const t = text.replace(/"([^"]*)"|“([^”]*)”|'([^']+)'(?=\s|$|[,.;!?])|‘([^’]*)’/g, (m, a, b, c, d) => { q.push(a ?? b ?? c ?? d); return `\u0001${q.length - 1}\u0002`; });
  return { t, q };
}
const restore = (s, q) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => q[+i]);
const unquote = (s, q) => restore(String(s || '').trim(), q).replace(/^["“'‘]|["”'’]$/g, '');
const SPLIT = /\s*(?:;|,?\s*\band then\b|,?\s*\bthen\b|,?\s*\balso\b|,?\s*\band\b|,|\.\s+|\.$)\s*/i;

// split into steps; a piece that isn't understood alone is joined with the next one ("replace cats and dogs with birds")
export function parseAppRequest(app, text) {
  const P = PARSERS[app];
  if (!P) return { steps: [], rest: [text] };
  const { t, q } = protect(String(text || '').trim());
  const whole = P(clean(t), q);
  const parts = t.split(SPLIT).map((x) => x.trim()).filter(Boolean);
  const steps = [], rest = [];
  if (parts.length <= 1) { if (whole) steps.push(...[].concat(whole)); else rest.push(restore(t, q)); return { steps, rest }; }
  for (let i = 0; i < parts.length; i++) {
    let cur = parts[i], got = P(clean(cur), q);
    let j = i;
    while (!got && j + 1 < parts.length) { j++; cur = `${cur} and ${parts[j]}`; got = P(clean(cur), q); }
    if (got) { steps.push(...[].concat(got)); i = j; } else rest.push(restore(parts[i], q));
  }
  // nothing split cleanly but the whole thing reads as one step
  if (!steps.length && whole) return { steps: [].concat(whole), rest: [] };
  return { steps, rest };
}
const clean = (s) => s.replace(/^(?:(?:please|can you|could you|would you|kindly|i want (?:you )?to|i'?d like (?:you )?to|let'?s|go ahead and|now|just|ok(?:ay)?|hey|also|and)\b[\s,]*)+/i, '').replace(/[\s!?.]+$/, '').replace(/\s+please$/i, '').trim();

// ---------------- Notepad ----------------
const IT = String.raw`(?:it|this|that|everything|all|the (?:whole )?(?:text|document|doc|file|note|page|content|contents|selection|selected text|lines?))`;
function notepad(s, q) {
  const S = s.toLowerCase();
  const U = (x) => unquote(x, q);
  const scope = /\b(selection|selected)\b/.test(S) ? 'sel' : /\b(whole|entire|all of the|everything)\b/.test(S) ? 'all' : undefined;
  const st = (op, arg, label) => ({ op, arg: { ...(arg || {}), ...(scope && !(arg && arg.scope) ? { scope } : {}) }, label });
  let m;
  // replace / swap / delete words
  if ((m = s.match(/^(?:replace|change|switch|swap|substitute|turn)\s+(?:all\s+|every\s+|each\s+)?(?:(?:the\s+)?(?:words?|text|occurrences?|instances?)\s+(?:of\s+)?)?(.+?)\s+(?:with|to|into|by|for)\s+(.+?)(?:\s+(?:everywhere|throughout|in (?:the )?(?:whole )?(?:document|text|file)))?$/i)) && !/\b(case|upper|lower)\b/i.test(m[2])) {
    const find = U(m[1]), wth = U(m[2]);
    if (find && !/^(it|this|that|everything)$/i.test(find)) return st('replace', { find, with: /^(nothing|blank|empty)$/i.test(wth) ? '' : wth, wholeWord: /\bwords?\b/i.test(s) || undefined, caseSensitive: /\b(case[- ]sensitive|exact case|match case)\b/i.test(s) || undefined }, `Replace “${find}” with “${wth}”`);
  }
  if ((m = s.match(/^(?:delete|remove|erase|strip|get rid of|take out|drop)\s+(?:all\s+|every\s+|each\s+)?(?:(?:the\s+)?lines?\s+(?:that\s+)?(?:contain(?:ing|s)?|with|that have|having|matching|mentioning)|lines?\s+with)\s+(.+)$/i))) return st('filterLines', { find: U(m[1]) }, `Delete lines containing “${U(m[1])}”`);
  if ((m = s.match(/^(?:keep|show|leave)\s+only\s+(?:the\s+)?lines?\s+(?:that\s+)?(?:contain(?:ing|s)?|with|that have|having|matching|mentioning)\s+(.+)$/i)) || (m = s.match(/^(?:only keep|filter (?:to|for))\s+(?:the\s+)?lines?\s+(?:with|containing)\s+(.+)$/i))) return st('filterLines', { find: U(m[1]), keep: true }, `Keep only lines containing “${U(m[1])}”`);
  if ((m = s.match(/^(?:delete|remove|erase|clear|wipe|empty)\s+(?:out\s+)?(?:everything|all(?: the)? text|all of it|the (?:whole |entire )?(?:document|text|file|page|note|contents?)|it all)$/i)) || /^(?:clear|empty|wipe)(?: it| out)?$/i.test(s) || /^start (?:over|fresh|from scratch)$/i.test(s)) return { op: 'clear', arg: {}, label: 'Clear the document' };
  if ((m = s.match(new RegExp(`^(?:delete|remove)\\s+line\\s+(?:number\\s+)?${N}$`, 'i')))) return st('deleteLine', { line: num(m[1]) }, `Delete line ${num(m[1])}`);
  if (/^(?:delete|remove)\s+(?:this|the current)\s+line$/i.test(s)) return st('deleteLine', {}, 'Delete this line');
  if (/^duplicate\s+(?:this\s+|the\s+)?line$/i.test(s)) return st('duplicateLine', {}, 'Duplicate the line');
  // lines
  if (/\b(remove|delete|get rid of|strip|drop|eliminate|dedupe|deduplicate)\b.*\b(duplicates?|duplicated|repeated|repeat)\b|\bdedup(e|licate)?\b|\bunique lines\b|\bremove (?:the )?dupes\b/i.test(S)) return st('lines', { fn: /ignor\w* case|case[- ]insensitive/.test(S) ? 'uniqueCI' : 'unique' }, 'Remove duplicate lines');
  if (/\b(remove|delete|get rid of|strip|drop|eliminate)\b.*\b(empty|blank)\s+lines?\b|\bno (?:empty|blank) lines\b/i.test(S)) return st('lines', { fn: 'removeEmpty' }, 'Remove empty lines');
  if (/\b(collapse|squash|reduce)\b.*\b(empty|blank)\s+lines\b/i.test(S)) return st('lines', { fn: 'collapseEmpty' }, 'Collapse empty lines');
  if (/\bsort\b|\balphabeti[sz]e\b|\b(in|into) (alphabetical|numerical|reverse alphabetical) order\b|\border (the )?lines\b/i.test(S)) {
    const fn = /\b(length|longest|shortest)\b/.test(S) ? (/\blongest first|longest to shortest|descending|desc\b/.test(S) ? 'sortLenDesc' : 'sortLen') : /\bnumer/.test(S) ? 'sortNum' : /\b(desc|descending|reverse|z\s*(to|-|→)\s*a|backwards)\b/.test(S) ? 'sortDesc' : 'sortAsc';
    return st('lines', { fn }, { sortAsc: 'Sort the lines A → Z', sortDesc: 'Sort the lines Z → A', sortLen: 'Sort lines by length', sortLenDesc: 'Sort lines longest first', sortNum: 'Sort lines by number' }[fn]);
  }
  if (/\b(reverse|flip|invert)\b.*\b(lines?|order)\b/i.test(S)) return st('lines', { fn: 'reverse' }, 'Reverse the line order');
  if (/\b(shuffle|randomi[sz]e|scramble)\b/i.test(S)) return st('lines', { fn: 'shuffle' }, 'Shuffle the lines');
  if (/\b(remove|strip|delete|get rid of)\b.*\b(numbers?|numbering|bullets?|bullet points?)\b.*\b(lines?|start|front|beginning|list)\b|\bunnumber\b/i.test(S)) return st('lines', { fn: 'unnumber' }, 'Remove numbering');
  if (/\b(number|enumerate)\b.*\b(the )?(lines|each line|every line)\b|\badd (line )?numbers\b|\bnumbered list\b/i.test(S)) return st('lines', { fn: 'number' }, 'Number the lines');
  if (/\b(bullet(ed)?|bullet points?)\b/i.test(S) && /\b(make|turn|convert|add|into|as)\b/i.test(S)) return st('lines', { fn: 'bullets' }, 'Make a bulleted list');
  if (/\btrim\b|\b(remove|strip|delete)\b.*\b(trailing|leading|extra)\s+(white\s*space|spaces)\b/i.test(S)) {
    if (/\bextra spaces?\b|\bdouble spaces?\b|\bmultiple spaces\b/.test(S)) return st('spaces', {}, 'Collapse extra spaces');
    const fn = /\btrailing\b|\bend\b/.test(S) ? 'trimTrailing' : /\bleading\b|\bstart\b|\bbeginning\b/.test(S) ? 'trimLeading' : 'trim';
    return st('lines', { fn }, { trimTrailing: 'Trim trailing spaces', trimLeading: 'Trim leading spaces', trim: 'Trim spaces' }[fn]);
  }
  if (/\b(double|extra|multiple|repeated) spaces\b/i.test(S)) return st('spaces', {}, 'Collapse extra spaces');
  if (/\btabs?\b.*\b(to|into)\b.*\bspaces\b/i.test(S)) return st('lines', { fn: 'tabsToSpaces' }, 'Tabs to spaces');
  if (/\bspaces\b.*\b(to|into)\b.*\btabs\b/i.test(S)) return st('lines', { fn: 'spacesToTabs' }, 'Spaces to tabs');
  if (/^(?:un-?indent|outdent|dedent)\b/i.test(S)) return st('lines', { fn: 'outdent' }, 'Outdent');
  if (/^indent\b/i.test(S)) return st('lines', { fn: 'indent' }, 'Indent');
  if ((m = s.match(/^(?:join|merge|combine)\s+(?:all\s+)?(?:the\s+)?lines(?:\s+(?:with|using|by)\s+(.+))?(?:\s+into one(?: line)?)?$/i)) || /^(?:put|make)\s+(?:it|everything|all)\s+(?:on|into)\s+one\s+line$/i.test(s)) { const sep = m && m[1] ? U(m[1]).replace(/^(?:a\s+)?comma$/i, ', ').replace(/^(?:a\s+)?space$/i, ' ') : ' '; return st('joinLines', { sep }, 'Join the lines'); }
  if ((m = s.match(/^(?:split|break)\s+(?:it|the text|the lines?|this)?\s*(?:up\s+)?(?:at|on|by)\s+(?:every\s+|each\s+)?(.+?)(?:\s+into (?:separate |new )?lines)?$/i))) { const raw = U(m[1]); const sep = /^(?:commas?|,)$/i.test(raw) ? ',' : /^(?:semicolons?)$/i.test(raw) ? ';' : /^(?:spaces?)$/i.test(raw) ? ' ' : /^(?:tabs?)$/i.test(raw) ? '\t' : /^(?:periods?|full stops?|sentences?)$/i.test(raw) ? '. ' : /^(?:pipes?)$/i.test(raw) ? '|' : raw; return st('splitLines', { sep }, `Split at “${raw}”`); }
  if ((m = s.match(/^(?:add|put|insert|prepend|start)\s+(.+?)\s+(?:to|at|in front of|before)\s+(?:the\s+)?(?:start|beginning|front)\s+of\s+(?:each|every|all(?: the)?)\s+lines?$/i)) || (m = s.match(/^(?:start|begin)\s+(?:each|every)\s+line\s+with\s+(.+)$/i)) || (m = s.match(/^prefix\s+(?:each|every|all)\s+lines?\s+with\s+(.+)$/i))) return st('affix', { before: U(m[1]) }, `Add “${U(m[1])}” at the start of every line`);
  if ((m = s.match(/^(?:add|put|insert|append)\s+(.+?)\s+(?:to|at)\s+(?:the\s+)?end\s+of\s+(?:each|every|all(?: the)?)\s+lines?$/i)) || (m = s.match(/^(?:end)\s+(?:each|every)\s+line\s+with\s+(.+)$/i)) || (m = s.match(/^suffix\s+(?:each|every|all)\s+lines?\s+with\s+(.+)$/i))) return st('affix', { after: U(m[1]) }, `Add “${U(m[1])}” at the end of every line`);
  if ((m = s.match(/^(?:wrap|surround|enclose|put)\s+(?:each|every|all(?: the)?)\s+lines?\s+(?:in|with)\s+(.+)$/i)) || (m = s.match(/^(?:put|wrap)\s+(.+?)\s+around\s+(?:each|every)\s+line$/i))) { const w = U(m[1]).replace(/^(?:double )?quotes?$/i, '"').replace(/^single quotes?$/i, "'").replace(/^(?:brackets|square brackets)$/i, '[]').replace(/^(?:parentheses|parens)$/i, '()').replace(/^(?:curly braces|braces)$/i, '{}').replace(/^(?:angle brackets)$/i, '<>'); const pair = { '[]': ['[', ']'], '()': ['(', ')'], '{}': ['{', '}'], '<>': ['<', '>'] }[w] || [w, w]; return st('affix', { before: pair[0], after: pair[1] }, `Wrap every line in ${pair[0]}…${pair[1]}`); }
  // case
  if (/\b(upper ?case|all caps|capital letters|caps lock|uppercase)\b/i.test(S) || /^(?:capitali[sz]e|caps)\s+(?:everything|it all|all)$/i.test(s)) return st('case', { to: 'upper' }, 'UPPERCASE');
  if (/\b(lower ?case|small letters|lowercase)\b/i.test(S) || /^(?:decapitali[sz]e|uncapitali[sz]e)\b/i.test(S)) return st('case', { to: 'lower' }, 'lowercase');
  if (/\btitle ?case\b|\bcapitali[sz]e (?:each|every|the first letter of (?:each|every)) word\b|\bcapitali[sz]e (?:all )?(?:the )?words\b/i.test(S)) return st('case', { to: 'title' }, 'Title Case');
  if (/\bsentence ?case\b|\bcapitali[sz]e (?:the )?(?:first letter of )?(?:each |every )?sentences?\b|\bfix (?:the )?capitali[sz]ation\b/i.test(S)) return st('case', { to: 'sentence' }, 'Sentence case');
  if (/\b(invert|toggle|swap|flip) (?:the )?case\b/i.test(S)) return st('case', { to: 'invert' }, 'Invert case');
  if (/\bcamel ?case\b/i.test(S)) return st('case', { to: 'camel' }, 'camelCase');
  if (/\bsnake ?case\b/i.test(S)) return st('case', { to: 'snake' }, 'snake_case');
  if (/\b(kebab|dash) ?case\b/i.test(S)) return st('case', { to: 'kebab' }, 'kebab-case');
  // JSON / encodings
  if (/\b(minify|compact|compress)\b.*\bjson\b|\bjson\b.*\b(minif|one line|compact)/i.test(S)) return st('json', { min: true }, 'Minify the JSON');
  if (/\b(format|pretty|prettify|beautify|indent|tidy|clean up)\b.*\bjson\b|\bjson\b.*\b(pretty|format|readable)\b/i.test(S)) return st('json', {}, 'Format the JSON');
  if (/\bbase ?64\b/i.test(S)) return st('encode', { kind: /\b(decode|from)\b/.test(S) ? 'base64d' : 'base64' }, /\b(decode|from)\b/.test(S) ? 'Decode Base64' : 'Encode as Base64');
  if (/\burl\b.*\b(encode|decode|escape|unescape)\b|\b(encode|decode)\b.*\burl\b/i.test(S)) return st('encode', { kind: /\b(decode|unescape)\b/.test(S) ? 'urld' : 'url' }, /\bdecode|unescape/.test(S) ? 'URL-decode' : 'URL-encode');
  if (/\b(strip|remove|delete|get rid of)\b.*\b(html|tags|markup)\b|\bplain text\b.*\bhtml\b|\bhtml to (?:plain )?text\b/i.test(S)) return st('encode', { kind: 'stripHtml' }, 'Remove HTML tags');
  if (/\bescape\b.*\bhtml\b/i.test(S)) return st('encode', { kind: 'escapeHtml' }, 'Escape HTML');
  if (/\b(curly|smart|typographic) quotes\b/i.test(S)) return st('encode', { kind: 'smartQuotes' }, 'Curly quotes');
  if (/\b(straight|plain|dumb) quotes\b/i.test(S)) return st('encode', { kind: 'plainQuotes' }, 'Straight quotes');
  if (/\breverse (?:the )?(?:text|characters|letters|string)\b|\bspell (?:it )?backwards\b/i.test(S)) return st('encode', { kind: 'reverseText' }, 'Reverse the text');
  if ((m = S.match(/\b(?:extract|pull out|get|list|find all|grab|collect)\b.*\b(emails?|e-mail addresses|email addresses|urls?|links|web addresses|numbers|phone numbers|hashtags)\b/i))) { const k = /mail/.test(m[1]) ? 'emails' : /url|link|web/.test(m[1]) ? 'urls' : /phone/.test(m[1]) ? 'phones' : /hashtag/.test(m[1]) ? 'hashtags' : 'numbers'; return st('extract', { kind: k }, `Collect the ${k}`); }
  if ((m = s.match(/^(?:sha-?(1|256|512)|md5)\b|\bhash\b/i))) { const algo = /512/.test(S) ? 'SHA-512' : /sha-?1\b/.test(S) ? 'SHA-1' : 'SHA-256'; return st('hash', { algo }, `Copy the ${algo} hash`); }
  // counting & statistics
  if ((m = s.match(/^(?:how many times (?:does|do|is|are)\s+(.+?)\s+(?:appear|occur|show up|used|come up|there)|count (?:the )?(?:occurrences|instances|times) of\s+(.+)|how many\s+(.+?)\s+(?:are there|is there|do i have)(?: in (?:it|the (?:text|document)))?)$/i))) { const f = U(m[1] || m[2] || m[3]); if (!/^(words?|lines?|characters?|letters?|sentences?|paragraphs?)$/i.test(f)) return st('count', { find: f.replace(/s$/i, (x) => (f.length > 3 ? '' : x)) }, `Count “${f}”`); }
  if (/\b(word ?count|count (?:the )?words|how many (words|characters|letters|lines|sentences|paragraphs)|how long is (?:it|this|the (?:text|document))|reading time|character count|statistics|stats)\b/i.test(S)) return st('count', {}, 'Count words and lines');
  // find / navigate
  if ((m = s.match(/^(?:find|search(?: for)?|look for|where(?:'s| is| are)|locate|highlight|select)\s+(?:all\s+(?:the\s+)?(?:occurrences of\s+|instances of\s+)?|every\s+)?(.+?)(?:\s+in (?:the )?(?:text|document|file))?$/i)) && !/^(?:all|everything|the whole (?:thing|document)|line\b|duplicates?|lines?\b.*)$/i.test(m[1])) { const all = /\b(all|every|highlight|select)\b/i.test(s.split(/\s+/).slice(0, 3).join(' ')); return st('find', { find: U(m[1]), all }, `Find “${U(m[1])}”`); }
  if ((m = s.match(new RegExp(`^(?:go|jump|move|scroll|take me|skip)\\s+(?:to\\s+)?(?:line\\s+)(?:number\\s+)?${N}$`, 'i'))) || (m = s.match(new RegExp(`^line\\s+${N}$`, 'i')))) return { op: 'goto', arg: { line: num(m[1]) }, label: `Go to line ${num(m[1])}` };
  if (/^(?:go|jump|move|scroll|take me)\s+(?:to\s+)?(?:the\s+)?(?:last line|bottom|end)(?: of (?:the )?(?:document|file|text))?$/i.test(s)) return { op: 'bottom', arg: {}, label: 'Go to the end' };
  if (/^(?:go|jump|move|scroll|take me)\s+(?:to\s+)?(?:the\s+)?(?:first line|top|start|beginning)(?: of (?:the )?(?:document|file|text))?$/i.test(s)) return { op: 'top', arg: {}, label: 'Go to the top' };
  if (/^select (?:all|everything)$/i.test(s)) return { op: 'selectAll', arg: {}, label: 'Select everything' };
  if (/^copy\b(?:\s+(?:it|everything|all|the (?:whole )?(?:text|document)|this))?(?:\s+to (?:the )?clipboard)?$/i.test(s)) return st('copy', { scope: /\b(all|everything|whole|document)\b/i.test(s) ? 'all' : undefined }, 'Copy to the clipboard');
  // insert
  if (/\b(insert|add|put|type|write)\b.*\b(today'?s date|the date|date and time|the time|timestamp|current date)\b/i.test(S)) return { op: 'date', arg: { iso: /\biso\b/.test(S) }, label: 'Insert the date' };
  if ((m = s.match(/^(?:add|insert|type|write|put|append|prepend)\s+(?:the\s+(?:text|words?|line)\s+)?(\u0001\d+\u0002)(?:\s+(?:at|to)\s+(?:the\s+)?(top|start|beginning|end|bottom)(?:\s+of (?:the )?(?:document|file|text))?)?$/i))) { const w = m[2] ? (/top|start|beginning/i.test(m[2]) ? 'start' : 'end') : /^append/i.test(s) ? 'end' : /^prepend/i.test(s) ? 'start' : 'cursor'; return { op: 'insert', arg: { text: U(m[1]), where: w }, label: `Insert “${U(m[1])}”` }; }
  if ((m = s.match(/^(?:add|insert)\s+(?:a\s+)?(?:heading|title)\s+(?:called\s+|saying\s+)?(.+)$/i))) return { op: 'insert', arg: { text: `# ${U(m[1])}`, where: 'start' }, label: `Add the heading “${U(m[1])}”` };
  // file & view
  if (/^(?:save|save it|save (?:the )?(?:file|document|changes|my work))$/i.test(s)) return { op: 'save', arg: {}, label: 'Save' };
  if (/^save (?:it )?as\b|^save a copy\b/i.test(s)) return { op: 'saveAs', arg: {}, label: 'Save as' };
  if (/^(?:new|create|open|start) (?:a )?(?:new |blank |empty )?(?:document|file|note|tab|page)$/i.test(s)) return { op: 'new', arg: {}, label: 'New document' };
  if (/^open (?:a )?file$|^open\b.*\bfrom (?:my )?(?:computer|disk|pc)$/i.test(s)) return { op: 'open', arg: {}, label: 'Open a file' };
  if (/^undo(?: that| it| the last (?:change|edit|step))?$/i.test(s)) return { op: 'undo', arg: {}, label: 'Undo' };
  if (/^redo(?: that| it)?$/i.test(s)) return { op: 'redo', arg: {}, label: 'Redo' };
  if (/\b(word ?wrap|wrap (?:the )?(?:long )?lines|line wrap(?:ping)?|wrap text)\b/i.test(S)) return { op: 'wrap', arg: { on: !/\b(off|disable|stop|don'?t|no|unwrap|turn off)\b/i.test(S) }, label: 'Word wrap' };
  if (/\b(show|hide|display|turn (?:on|off))\b.*\b(white ?space|invisible characters|spaces and tabs)\b/i.test(S)) return { op: 'whitespace', arg: { on: !/\b(hide|off)\b/i.test(S) }, label: 'Whitespace' };
  if (/\b(show|hide|turn (?:on|off))\b.*\bline numbers\b/i.test(S)) return { op: 'lineNumbers', arg: { on: !/\b(hide|off)\b/i.test(S) }, label: 'Line numbers' };
  if (/\b(preview|render)\b.*\b(markdown|html|it)\b|\b(markdown|html) preview\b|^preview$/i.test(S)) return { op: 'preview', arg: { on: !/\b(close|hide|off|stop)\b/i.test(S) }, label: 'Preview' };
  if ((m = S.match(new RegExp(`\\b(?:font|text) size\\s+(?:to\\s+)?${N}\\b`)))) return { op: 'fontSize', arg: { size: num(m[1]) }, label: `Font size ${num(m[1])}` };
  if (/\b(bigger|larger|zoom in|increase (?:the )?(?:font|text) size|make (?:the )?(?:text|font) bigger)\b/i.test(S)) return { op: 'zoom', arg: { dir: 1 }, label: 'Zoom in' };
  if (/\b(smaller|zoom out|decrease (?:the )?(?:font|text) size|make (?:the )?(?:text|font) smaller)\b/i.test(S)) return { op: 'zoom', arg: { dir: -1 }, label: 'Zoom out' };
  if (/\b(reset|normal|default) (?:the )?(?:zoom|font size|text size)\b/i.test(S)) return { op: 'zoom', arg: { dir: 0 }, label: 'Reset zoom' };
  if ((m = S.match(new RegExp(`\\btab (?:size|width)\\s+(?:to\\s+)?${N}\\b|\\b${N}[- ]space (?:tabs|indent)`)))) return { op: 'tabSize', arg: { size: num(m[1] || m[2]) }, label: 'Tab size' };
  if ((m = S.match(/\b(?:set|change|switch|make)\b.*\b(?:language|syntax|highlighting|mode)\b\s+(?:to\s+|as\s+)?([a-z+#.]+)$/i)) || (m = S.match(/^(?:this is|treat (?:it|this) as|it'?s)\s+(?:a\s+)?([a-z+#.]+)(?:\s+(?:file|code|document))?$/i)) || (m = S.match(/^highlight (?:it|this )?as\s+([a-z+#.]+)$/i))) return { op: 'lang', arg: { name: m[1] }, label: `Language: ${m[1]}` };
  if ((m = S.match(/\b(windows|crlf|unix|linux|lf|mac|cr)\b\s*(?:line endings|eol|newlines)\b|\b(?:line endings|eol|newlines)\b.*\b(windows|crlf|unix|linux|lf|mac|cr)\b/i))) return { op: 'eol', arg: { kind: (m[1] || m[2]).toLowerCase() }, label: 'Line endings' };
  if ((m = S.match(/\b(?:encoding|save (?:it )?(?:as|in))\b.*\b(utf-?8(?: with bom)?|utf-?16(?: ?[lb]e)?|ansi|windows-1252)\b/i))) return { op: 'encoding', arg: { enc: m[1].replace(/utf-?8 with bom/i, 'utf8bom').replace(/utf-?8/i, 'utf8').replace(/utf-?16 ?be/i, 'utf16be').replace(/utf-?16(?: ?le)?/i, 'utf16le').replace(/windows-1252/i, 'ansi') }, label: 'Encoding' };
  if (/\b(read[- ]only|lock (?:the )?(?:file|document|it))\b/i.test(S)) return { op: 'readonly', arg: { on: !/\b(off|unlock|remove|clear|make (?:it )?editable|turn off)\b/i.test(S) }, label: 'Read-only' };
  if (/\b(unlock|make (?:it )?editable)\b/i.test(S)) return { op: 'readonly', arg: { on: false }, label: 'Editable' };
  if (/^(?:fold|collapse) (?:all|everything)$/i.test(s)) return { op: 'fold', arg: { on: true }, label: 'Fold all' };
  if (/^(?:unfold|expand) (?:all|everything)$/i.test(s)) return { op: 'fold', arg: { on: false }, label: 'Unfold all' };
  if (/^(?:toggle )?(?:comment|uncomment)(?: (?:out )?(?:this|these|the) (?:line|lines|selection|code))?$/i.test(s)) return { op: 'comment', arg: {}, label: 'Toggle comment' };
  if (/^(?:bookmark|mark) (?:this )?line$/i.test(s)) return { op: 'bookmark', arg: {}, label: 'Bookmark this line' };
  if (/^close(?: (?:it|this|the (?:file|document|tab)))?$/i.test(s)) return { op: 'close', arg: {}, label: 'Close' };
  return null;
}

// ---------------- Photos ----------------
const FX = ['original', 'vivid', 'mono', 'noir', 'vintage', 'warm', 'cool', 'fade', 'dramatic', 'punch'];
function photos(s, q) {
  const S = s.toLowerCase();
  let m;
  // start over / clear the drawing
  if (/\b(erase|remove|clear|delete|undo|reset|revert|wipe|discard|scrap|get rid of)\b.*\b(drawings?|scribbles?|pen|marks?|annotations?|doodles?|lines i drew|what i drew|ink|text i added|highlights?)\b/i.test(S)) return { op: 'clearDrawing', label: 'Remove the drawing' };
  if (/\b(erase|remove|clear|undo|reset|revert|wipe|discard|scrap)\b.*\b(everything|all(?: (?:the|my))? (?:edits|changes)|all of it|it all|every (?:edit|change))\b|^(?:start (?:over|fresh|again)|reset(?: (?:it|the (?:photo|picture|image)))?|revert(?: to (?:the )?original)?|back to (?:the )?original|undo all|go back to the original)$/i.test(S)) return { op: 'resetAll', label: 'Start from the original' };
  // filters & adjustments
  if (/\bsepia\b/.test(S)) return { op: 'adjust', arg: { sepia: pct(S, 100) }, label: 'Sepia', apply: true };
  if (/\b(black and white|black & white|b&w|b\/w|gr[ae]y ?scale|monochrome|desaturate(?: completely)?|no colou?rs?|remove (?:the )?colou?rs?)\b/.test(S) && !/\bfilter (?:called|named)\b/.test(S)) return { op: 'adjust', arg: { grayscale: 100 }, label: 'Black & white', apply: true };
  if (/\b(invert|negative)\b/.test(S) && !/\bcase\b/.test(S)) return { op: 'adjust', arg: { invert: 100 }, label: 'Invert colours', apply: true };
  if ((m = S.match(/\b(vivid|mono|noir|vintage|warm(?:er)?|cool(?:er)?|fade(?:d)?|dramatic|punch(?:y)?)\b/)) && /\b(filter|look|effect|style|preset|apply|make|add|give|use|it)\b/.test(S) && !/\b(brightness|contrast|saturation)\b/.test(S)) { const name = FX.find((f) => m[1].startsWith(f)) || m[1]; return { op: 'filter', arg: name, label: `${name[0].toUpperCase() + name.slice(1)} filter`, apply: true }; }
  if (/\b(remove|no|clear|undo)\b.*\bfilters?\b|\bfilter off\b/.test(S)) return { op: 'filter', arg: 'original', label: 'No filter' };
  if (/\bblur\b/.test(S)) { if (/\b(remove|no|undo|unblur|sharpen)\b/.test(S)) return { op: 'adjust', arg: { blur: 0 }, label: 'No blur' }; return { op: 'adjust', arg: { blur: Math.min(20, numIn(S) ?? (/\b(slight|little|bit|soft)\b/.test(S) ? 2 : 4)) }, label: 'Blur', apply: true }; }
  if (/\bvignette\b/.test(S)) return { op: 'adjust', arg: { vignette: /\b(remove|no)\b/.test(S) ? 0 : Math.min(100, numIn(S) ?? 45) }, label: 'Vignette', apply: true };
  for (const [k, words, up, down] of [['brightness', /\b(bright(?:ness|er|en)?|light(?:er|en)?|dark(?:er|en)?|dim(?:mer)?|exposure)\b/, /\b(bright(?:er|en)|light(?:er|en)|more (?:light|exposure))\b/, /\b(dark(?:er|en)|dim(?:mer)?|less (?:light|exposure))\b/],
    ['contrast', /\bcontrast\b/, /\b(more|increase|boost|raise|higher|add)\b/, /\b(less|decrease|reduce|lower|soften)\b/],
    ['saturate', /\b(saturat\w*|colou?rful|vibran\w*|colou?rs? (?:pop|stronger|weaker)|muted|duller)\b/, /\b(more|increase|boost|raise|higher|colou?rful|pop|stronger|vibrant)\b/, /\b(less|decrease|reduce|lower|muted|duller|weaker|desaturate)\b/],
    ['hue', /\bhue\b/, /\b(more|increase|shift|rotate|raise)\b/, /\b(less|decrease|lower)\b/]]) {
    if (!words.test(S)) continue;
    const base = k === 'hue' ? 0 : 100;
    const n = numIn(S);
    if (n != null && /\b(to|at|=|set)\b/.test(S)) return { op: 'adjust', arg: { [k]: k === 'hue' ? n : n }, label: `${label(k)} ${n}${k === 'hue' ? '°' : '%'}`, apply: true };
    const amt = n != null ? n : /\b(little|slightly|bit|touch|tad)\b/.test(S) ? 12 : /\b(lot|much|very|way|really)\b/.test(S) ? 45 : 25;
    const dir = down.test(S) ? -1 : up.test(S) || /\b(more|increase|boost|raise|higher|up)\b/.test(S) ? 1 : /\b(less|decrease|reduce|lower|down)\b/.test(S) ? -1 : 1;
    return { op: 'adjust', arg: { [k]: base + dir * amt, relative: true }, label: `${label(k)} ${dir > 0 ? '+' : '−'}${amt}${k === 'hue' ? '°' : '%'}`, apply: true };
  }
  // size
  if (/\b(resize|size|scale|shrink|enlarge|smaller|bigger|larger|dimensions?|width|height|wide|tall|pixels?|px|half|double|downsize|upscale|megapixels?)\b/.test(S) && !/\b(font|text|zoom)\b/.test(S)) {
    if ((m = S.match(/(\d{2,5})\s*(?:x|×|by|\*)\s*(\d{2,5})/))) return { op: 'resize', arg: { w: +m[1], h: +m[2] }, label: `Resize to ${m[1]} × ${m[2]}` };
    if ((m = S.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/))) { let p = +m[1]; if (/\b(smaller|shrink|reduce|by)\b/.test(S) && /\b(smaller|shrink|reduce)\b/.test(S)) p = 100 - p; return { op: 'resize', arg: { percent: p }, label: `Resize to ${p}%` }; }
    if (/\bhalf\b/.test(S)) return { op: 'resize', arg: { percent: 50 }, label: 'Half the size' };
    if (/\b(quarter)\b/.test(S)) return { op: 'resize', arg: { percent: 25 }, label: 'A quarter of the size' };
    if (/\b(double|twice)\b/.test(S)) return { op: 'resize', arg: { percent: 200 }, label: 'Double the size' };
    if ((m = S.match(/(\d{2,5})\s*(?:px|pixels?)?\s*(wide|width|across|horizontal)/)) || (m = S.match(/\bwidth\s*(?:of|to|=|:)?\s*(\d{2,5})/))) return { op: 'resize', arg: { w: +m[1] }, label: `Resize to ${m[1]} wide` };
    if ((m = S.match(/(\d{2,5})\s*(?:px|pixels?)?\s*(tall|high|height|vertical)/)) || (m = S.match(/\bheight\s*(?:of|to|=|:)?\s*(\d{2,5})/))) return { op: 'resize', arg: { h: +m[1] }, label: `Resize to ${m[1]} tall` };
    if ((m = S.match(/\b(4k|uhd|1080p?|full ?hd|720p?|hd|instagram|thumbnail|icon|avatar|email|web)\b/))) { const P = { '4k': 3840, uhd: 3840, 1080: 1920, '1080p': 1920, 'full hd': 1920, fullhd: 1920, '720': 1280, '720p': 1280, hd: 1280, instagram: 1080, thumbnail: 320, icon: 256, avatar: 512, email: 1024, web: 1600 }; const w = P[m[1].replace(/\s+/g, ' ')] || 1920; return { op: 'resize', arg: { w, longest: true }, label: `Resize to ${w}px (${m[1]})` }; }
    if ((m = S.match(/\b(?:to|at|of|max(?:imum)?|longest side|long edge)\s*(\d{2,5})\s*(?:px|pixels?)?\b/)) || (m = S.match(/\b(\d{2,5})\s*(?:px|pixels?)\b/))) return { op: 'resize', arg: { w: +m[1], longest: true }, label: `Resize to ${m[1]}px on the long side` };
    if (/\b(smaller|shrink|reduce)\b/.test(S)) return { op: 'resize', arg: { percent: 50 }, label: 'Half the size' };
    if (/\b(bigger|larger|enlarge)\b/.test(S)) return { op: 'resize', arg: { percent: 150 }, label: '150% of the size' };
  }
  // rotate / flip / crop
  if (/\b(rotate|turn|spin)\b/.test(S)) {
    if (/\b180\b|\bupside down\b|\baround\b/.test(S)) return { op: 'rotate180', label: 'Rotate 180°' };
    if (/\b(left|counter ?clockwise|anti ?clockwise|ccw|-90)\b/.test(S)) return { op: 'rotateL', label: 'Rotate left' };
    return { op: 'rotateR', label: 'Rotate right' };
  }
  if (/\b(flip|mirror)\b/.test(S)) return /\b(vertical(?:ly)?|upside|top to bottom)\b/.test(S) ? { op: 'flipV', label: 'Flip vertically' } : { op: 'flip', label: 'Flip horizontally' };
  if (/\bcrop\b|\btrim (?:the )?edges\b|\bsquare\b|\bportrait\b|\blandscape\b|\b\d+\s*:\s*\d+\b/.test(S) && !/\bsave\b/.test(S)) {
    let a = 'free';
    if ((m = S.match(/\b(\d+)\s*(?::|by|x)\s*(\d+)\b/)) && +m[1] < 40 && +m[2] < 40) a = `${m[1]}:${m[2]}`;
    else if (/\bsquare\b|\binstagram\b/.test(S)) a = '1:1';
    else if (/\b(widescreen|youtube|wallpaper|desktop|16 ?by ?9)\b/.test(S)) a = '16:9';
    else if (/\b(story|stories|phone|tiktok|reel|vertical)\b/.test(S)) a = '9:16';
    else if (/\bportrait\b/.test(S)) a = '4:5';
    else if (/\blandscape\b/.test(S)) a = '3:2';
    else if (/\boriginal\b/.test(S)) a = 'original';
    if (a === '4:5' || a === '9:16' || a === '16:9' || a === '1:1' || a === '3:2' || a === '4:3' || a === 'original' || /\d+:\d+/.test(a)) return [{ op: 'cropAspect', arg: a, label: `Crop to ${a === '1:1' ? 'a square' : a}` }, { op: 'applyCrop', label: 'Apply the crop', quiet: true }];
    return { op: 'crop', label: 'Crop (drag the box)' };
  }
  // drawing
  if (/\b(highlighter|highlight)\b/.test(S)) return { op: 'drawMode', arg: 'marker', label: 'Highlighter' };
  if (/\beraser\b/.test(S)) return { op: 'drawMode', arg: 'eraser', label: 'Eraser' };
  if (/\b(draw|pen|annotate|sketch|scribble)\b/.test(S)) { const c = colourIn(S); return c ? [{ op: 'drawMode', arg: 'pen', label: 'Draw' }, { op: 'drawColor', arg: c, label: `Colour ${c}` }] : { op: 'drawMode', arg: 'pen', label: 'Draw' }; }
  if (/\b(add|write|put)\b.*\btext\b/.test(S)) return { op: 'drawMode', arg: 'text', label: 'Text (click where it goes)' };
  // saving
  if ((m = S.match(/\b(?:save|export|convert)\b.*\b(?:as|to|in)\s+(?:a\s+)?(png|jpe?g|webp)\b/))) return [{ op: 'format', arg: m[1].replace('jpeg', 'jpg'), label: m[1].toUpperCase() }, { op: /\b(overwrite|replace|original)\b/.test(S) ? 'overwrite' : 'saveCopy', label: 'Save a copy' }];
  if (/\b(overwrite|replace the original|save (?:over|on top of) (?:the )?original|save the original)\b/.test(S)) return { op: 'overwrite', label: 'Overwrite the original' };
  if (/^(?:save|save it|save (?:a )?copy|save (?:my )?(?:changes|edits)|keep (?:it|this|the changes))$/.test(S)) return { op: 'saveCopy', label: 'Save a copy' };
  if (/^(?:apply|apply it|done|finish|ok)$/.test(S)) return { op: 'apply', label: 'Apply' };
  if (/^(?:cancel|stop editing|exit (?:the )?editor|close (?:the )?editor|leave (?:the )?editor)$/.test(S)) return { op: 'exitEdit', label: 'Leave the editor' };
  if (/^(?:edit|edit (?:it|this|the (?:photo|picture|image))|open (?:the )?editor|start editing)$/.test(S)) return { op: 'edit', label: 'Edit' };
  if (/^undo(?: that| it)?$/.test(S)) return { op: 'undo', label: 'Undo' };
  if (/^redo(?: that| it)?$/.test(S)) return { op: 'redo', label: 'Redo' };
  // viewing
  if (/\b(next|following)\b.*\b(photo|picture|image|one)\b|^next$/.test(S)) return { op: 'next', label: 'Next photo' };
  if (/\b(previous|prev|last|back)\b.*\b(photo|picture|image|one)\b|^(?:previous|back)$/.test(S)) return { op: 'prev', label: 'Previous photo' };
  if (/\bslide ?show\b/.test(S)) return { op: 'slideshow', label: 'Slideshow' };
  if (/\bfull ?screen\b/.test(S)) return { op: 'fullscreen', label: 'Fullscreen' };
  if (/\bzoom in\b|\bcloser\b|\bmagnify\b/.test(S)) return { op: 'zoomIn', label: 'Zoom in' };
  if (/\bzoom out\b/.test(S)) return { op: 'zoomOut', label: 'Zoom out' };
  if (/\b(fit|whole (?:photo|picture|image))\b.*\b(screen|window)?\b|^fit$/.test(S)) return { op: 'fit', label: 'Fit to the window' };
  if (/\b(copy|read|extract|grab|get)\b.*\btext\b|\bocr\b/.test(S)) return { op: 'ocr', label: 'Copy the text from the image' };
  if (/\b(info|details|exif|camera|metadata|properties)\b/.test(S)) return { op: 'info', label: 'Photo info' };
  if (/^(?:delete|trash|remove)(?: (?:it|this|the (?:photo|picture|image)))?$/.test(S)) return { op: 'delete', label: 'Delete this photo' };
  return null;
}
const label = (k) => ({ brightness: 'Brightness', contrast: 'Contrast', saturate: 'Saturation', hue: 'Hue' }[k] || k);
function numIn(S) { const m = S.match(new RegExp(`${N}\\s*(?:%|percent|degrees?|°|px)?`)); return m ? num(m[1]) : null; }
function pct(S, d) { const m = S.match(/(\d{1,3})\s*(?:%|percent)/); return m ? Math.min(100, +m[1]) : /\b(slight|little|bit|touch|light)\b/.test(S) ? 40 : d; }
const COLOURS = { red: '#ff3b30', orange: '#ff9500', yellow: '#ffcc00', green: '#34c759', blue: '#0a84ff', purple: '#af52de', pink: '#ff2d92', white: '#ffffff', black: '#000000', grey: '#8e8e93', gray: '#8e8e93' };
function colourIn(S) { const m = S.match(/\b(red|orange|yellow|green|blue|purple|pink|white|black|grey|gray)\b/); return m ? COLOURS[m[1]] : null; }

// ---------------- Player ----------------
function player(s) {
  const S = s.toLowerCase();
  let m;
  if (/^(?:play|resume|continue|unpause|start)(?: (?:it|the (?:song|video|music|track|movie)))?$/.test(S)) return { op: 'resume', label: 'Play' };
  if (/^(?:pause|hold on|wait)(?: (?:it|the (?:song|video|music|track|movie)))?$/.test(S)) return { op: 'pause', label: 'Pause' };
  if (/^stop(?: (?:it|playing|the (?:song|video|music)))?$/.test(S)) return { op: 'stop', label: 'Stop' };
  if (/\b(next|skip (?:this )?(?:song|track|video|one))\b/.test(S) && !/\bseconds?|minutes?\b/.test(S)) return { op: 'next', label: 'Next' };
  if (/\b(previous|prev|last (?:song|track|video)|go back a (?:song|track))\b/.test(S)) return { op: 'prev', label: 'Previous' };
  if (/\bunmute\b/.test(S)) return { op: 'mute', arg: { on: false }, label: 'Unmute' };
  if (/\b(mute|silence|no sound)\b/.test(S)) return { op: 'mute', arg: { on: true }, label: 'Mute' };
  if ((m = S.match(/\bvolume\b.*?(\d{1,3})\s*%?|(\d{1,3})\s*%\s*volume/))) return { op: 'volume', arg: { set: +(m[1] || m[2]) }, label: `Volume ${m[1] || m[2]}%` };
  if (/\b(louder|turn (?:it )?up|volume up|increase (?:the )?volume|raise (?:the )?volume|more volume)\b/.test(S)) return { op: 'volume', arg: { delta: /\b(lot|much|way)\b/.test(S) ? 30 : 10 }, label: 'Louder' };
  if (/\b(quieter|softer|turn (?:it )?down|volume down|decrease (?:the )?volume|lower (?:the )?volume|less volume)\b/.test(S)) return { op: 'volume', arg: { delta: /\b(lot|much|way)\b/.test(S) ? -30 : -10 }, label: 'Quieter' };
  if ((m = S.match(/(\d+(?:\.\d+)?)\s*(?:x|×|times)\b.*|\bspeed\b.*?(\d+(?:\.\d+)?)/))) { const v = +(m[1] || m[2]); if (v > 0 && v <= 4) return { op: 'speed', arg: { set: v }, label: `Speed ${v}×` }; }
  if (/\b(normal speed|regular speed|reset (?:the )?speed)\b/.test(S)) return { op: 'speed', arg: { set: 1 }, label: 'Normal speed' };
  if (/\b(faster|speed (?:it )?up)\b/.test(S)) return { op: 'speed', arg: { delta: 0.25 }, label: 'Faster' };
  if (/\b(slower|slow (?:it )?down)\b/.test(S)) return { op: 'speed', arg: { delta: -0.25 }, label: 'Slower' };
  if ((m = S.match(/\b(?:go|jump|skip|seek|move)\s+(?:to\s+)?(?:the\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?/))) { const t = m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]; return { op: 'seek', arg: { to: t }, label: `Go to ${m[0].match(/[\d:]+/)[0]}` }; }
  if ((m = S.match(/\b(?:go|jump|skip|seek|move)\s+(?:to\s+)?(?:the\s+)?(?:(\d+)\s*(?:%|percent)|(halfway|middle|half way)|(start|beginning)|(end))/))) return { op: 'seek', arg: m[1] ? { pct: +m[1] } : m[2] ? { pct: 50 } : m[3] ? { to: 0 } : { pct: 99 }, label: 'Jump' };
  if ((m = S.match(new RegExp(`\\b(?:skip|jump|go|fast forward|forward|ahead|rewind|back(?:wards)?)\\b.*?${N}\\s*(seconds?|secs?|s|minutes?|mins?|m)\\b`)))) { const k = /^m/.test(m[2]) ? 60 : 1; const back = /\b(back|rewind|backwards?)\b/.test(S); return { op: 'seek', arg: { by: (back ? -1 : 1) * num(m[1]) * k }, label: `${back ? 'Back' : 'Forward'} ${num(m[1])} ${k === 60 ? 'min' : 's'}` }; }
  if (/^(?:restart|start over|from the (?:start|beginning)|replay)$/.test(S)) return { op: 'seek', arg: { to: 0 }, label: 'From the start' };
  if (/\bshuffle\b/.test(S)) return { op: 'shuffle', label: 'Shuffle' };
  if (/\b(repeat|loop)\b/.test(S)) return /\ba ?-? ?b\b|\bsection\b|\bpart\b/.test(S) ? { op: 'ab', label: 'A-B loop' } : { op: 'loop', label: 'Repeat' };
  if (/\bfull ?screen\b/.test(S)) return { op: 'fullscreen', label: 'Fullscreen' };
  if (/\b(screenshot|snapshot|capture (?:a |the )?frame|grab (?:a |the )?frame)\b/.test(S)) return { op: 'screenshot', label: 'Screenshot' };
  if (/\b(transcri\w+|subtitles? from|captions? from|what (?:are they|is he|is she) saying|speech to text)\b/.test(S)) return { op: 'transcript', label: 'Transcript' };
  if (/\b(extract|rip|save|get|pull)\b.*\b(audio|sound|mp3)\b/.test(S)) return { op: 'extract', label: 'Extract the audio' };
  if (/\b(trim|cut|clip|shorten|edit)\b/.test(S)) return { op: 'edit', label: 'Trim / edit' };
  if (/\b(bpm|tempo|key|analy[sz]e)\b/.test(S)) return { op: 'analyze', label: 'BPM & key' };
  if (/\b(equali[sz]er|eq|bass|treble)\b/.test(S)) return { op: 'eq', label: 'Equalizer' };
  if (/\b(playlist|queue|up next)\b/.test(S)) return { op: 'list', label: 'Playlist' };
  if (/\b(info|details|codec|bitrate|resolution)\b/.test(S)) return { op: 'info', label: 'Media info' };
  if (/\b(tags?|artist|album|title)\b.*\b(edit|change|fix|set)\b|\b(edit|change|fix|set)\b.*\b(tags?|artist|album)\b/.test(S)) return { op: 'tags', label: 'Edit tags' };
  return null;
}

const PARSERS = { editor: notepad, viewer: photos, player };

// Notepad requests that need writing rather than a command: these go to the writing model.
export function writingRequest(text) {
  const S = String(text || '').toLowerCase().trim();
  const verbs = /^(?:please\s+|can you\s+|could you\s+)?(write|draft|compose|create|generate|make|summari[sz]e|sum up|shorten|condense|expand|elaborate|lengthen|rewrite|rephrase|reword|paraphrase|improve|polish|edit|proofread|fix|correct|translate|explain|simplify|continue|finish|complete|outline|brainstorm|list|suggest|give me|tell me|answer|respond|reply|turn (?:this|it) into|convert (?:this|it) (?:in)?to|make (?:it|this)|tl;?dr|describe)\b/;
  if (!verbs.test(S)) return null;
  let mode = 'insert';
  if (/^(?:please\s+|can you\s+|could you\s+)?(rewrite|rephrase|reword|paraphrase|improve|polish|edit|proofread|fix|correct|translate|simplify|shorten|condense|expand|lengthen|make (?:it|this)|turn (?:this|it) into|convert (?:this|it))/.test(S)) mode = 'replace';
  if (/^(?:please\s+|can you\s+|could you\s+)?(summari[sz]e|sum up|tl;?dr|explain|outline|describe)/.test(S)) mode = 'answer';
  if (/^(?:please\s+|can you\s+|could you\s+)?(continue|finish|complete)/.test(S)) mode = 'end';
  return { mode };
}

// suggestions shown in the assistant panel for each app
export const APP_SUGGEST = {
  editor: ['Sort the lines and remove duplicates', 'Replace “colour” with “color”', 'Make it all uppercase', 'Remove empty lines', 'How many words?', 'Format the JSON', 'Fix the grammar', 'Summarize this'],
  viewer: ['Erase everything and apply a sepia filter', 'Change the photo size to 1920 wide', 'Crop to a square', 'Make it brighter', 'Black and white', 'Rotate left', 'Save a copy as PNG'],
  player: ['Play at 1.5x', 'Skip 30 seconds', 'Louder', 'Go to 2:15', 'Extract the audio', 'Make a transcript'],
};
