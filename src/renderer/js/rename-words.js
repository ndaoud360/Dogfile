// Renaming described in words ("lowercase, replace spaces with underscores", "number them Project_Asset_001",
// "add today's date as a prefix", "by their date taken as YYYY-MM-DD_HH-mm", "using their ID3 tags as Track -
// Artist - Title", "change the extension to .jpg"). Returns the settings for the Rename Studio.
// Pure: no DOM, tested by build/test-assistant-files.mjs.

const z = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
// "YYYY-MM-DD_HH-mm" → the studio's date pattern "yyyy-mm-dd_hh-min" (MM is the month, mm after an hour is minutes)
export function datePattern(p) {
  return String(p).replace(/YYYY|yyyy/g, '\u0001').replace(/YY|yy/g, '\u0002').replace(/MM/g, '\u0003').replace(/DD|dd/g, '\u0004')
    .replace(/HH|hh/g, '\u0005').replace(/mm|MI|mi|min/g, '\u0006').replace(/SS|ss/g, '\u0007')
    .replace(/\u0001/g, 'yyyy').replace(/\u0002/g, 'yy').replace(/\u0003/g, 'mm').replace(/\u0004/g, 'dd').replace(/\u0005/g, 'hh').replace(/\u0006/g, 'min').replace(/\u0007/g, 'ss');
}
const DATE_RE = /\b((?:YYYY|yyyy|YY)[-_. ]?(?:MM)(?:[-_. ]?(?:DD|dd))?(?:[ _T.-]*(?:HH|hh)(?:[-_.:h]?(?:mm|MM|min))?(?:[-_.:]?(?:SS|ss))?)?)\b/;
// song tag words → template tokens
const TAG_TOKENS = [[/track ?(?:number|no\.?|#)?|tracknumber|track#/i, '{track}'], [/album ?artist|artist|performer|band/i, '{artist}'], [/title|song ?name|name of the song/i, '{title}'], [/album/i, '{album}'], [/year|date/i, '{year}'], [/genre/i, '{genre}'], [/bpm|tempo/i, '{bpm}'], [/key/i, '{key}']];
export function tagTemplate(text) {
  const parts = String(text).split(/\s*(?:-|–|—|_|\/|,|\band\b|\bthen\b)\s*/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) { const hit = TAG_TOKENS.find(([re]) => re.test(p)); if (hit) out.push(hit[1]); }
  return out.length ? out.join(' - ') : '';
}

export function interpretRename(text) {
  const r = { notes: [] };
  const raw = String(text || '').trim();
  let s = ' ' + raw + ' ';
  const q = (x) => x.replace(/^["'“”‘’]|["'“”‘’]$/g, '');
  const take = (re, fn) => { const m = s.match(re); if (m) { fn(m); s = s.replace(m[0], ' '); } };
  const TAIL = String.raw`(?:\s+(?:to|for|on)\s+(?:all\s+|each\s+|every\s+)?(?:the\s+|these\s+|those\s+|my\s+)?(?:selected\s+)?(?:files?|names?|items?|photos?|pictures?|them|these|it))?`;
  // dates and song tags as the new name
  take(/\b(?:by|using|with|from|to)\s+(?:their|its|the)?\s*(?:exif\s+)?(?:["'“‘]?\s*date\s+taken\s*["'”’]?|photo date|taken date|exif(?: date)?)(?:\s+(?:in|as|like|using)\s+(?:the\s+)?(\S+)(?:\s+format)?)?/i, (m) => {
    const fmt = (m[1] && DATE_RE.test(m[1]) ? m[1] : (raw.match(DATE_RE) || [])[1]) || 'YYYY-MM-DD HH.mm.ss';
    r.template = `{taken:${datePattern(fmt)}}`; r.notes.push(`date taken as ${fmt}`);
  });
  take(/\b(?:by|using|with|from)\s+(?:their|its|the)\s+(?:id3|song|music|mp3)?\s*tags?(?:\s+(?:as|like|in the form|formatted as)\s+(.+?))?(?=\s*(?:[.;]|$))/i, (m) => {
    const t = m[1] ? tagTemplate(m[1]) : '';
    r.template = t || '{artist} - {title}'; r.notes.push(`from the song tags: ${r.template.replace(/[{}]/g, '')}`);
  });
  take(/\b(?:by|using|from)\s+(?:their|its|the)\s+(?:actual\s+)?(?:text\s+)?(?:contents?|document titles?|titles?|headings?)\b[^.;]*/i, () => { r.template = '{content}'; r.notes.push('title from contents'); });
  take(/\b(lower ?case|all lower|small letters)\b[^,.;]*/i, () => { r.caseMode = 'lowercase'; r.notes.push('lowercase'); });
  take(/\b(upper ?case|all caps|capital letters)\b[^,.;]*/i, () => { r.caseMode = 'UPPERCASE'; r.notes.push('UPPERCASE'); });
  take(/\btitle ?case|capitali[sz]e (each|every) word\b/i, () => { r.caseMode = 'Title Case'; r.notes.push('Title Case'); });
  take(/\bsentence ?case\b/i, () => { r.caseMode = 'Sentence case'; r.notes.push('Sentence case'); });
  take(/\bcamel ?case\b/i, () => { r.caseMode = 'camelCase'; r.notes.push('camelCase'); });
  take(/\b(kebab ?case)\b/i, () => { r.caseMode = 'kebab-case'; r.notes.push('kebab-case'); });
  take(/\b(snake ?case)\b/i, () => { r.caseMode = 'snake_case'; r.notes.push('snake_case'); });
  take(/\b(?:replace\s+)?spaces? (?:to|with|into|as|for) underscores?\b/i, () => { r.spaces = true; r.notes.push('spaces to _'); });
  take(/\b(?:replace\s+)?spaces? (?:to|with|into|as|for) (?:dashes|hyphens)\b/i, () => { r.find = ' '; r.replace = '-'; r.notes.push('spaces to -'); });
  take(/\btrim\b/i, () => { r.trim = true; r.notes.push('trim'); });
  // extension
  take(/\b(?:change|set|switch|convert|rename)\s+(?:the\s+)?(?:file\s+)?(?:extensions?|file types?)(?:\s+of\s+[^;]*?)?\s+(?:to|into|as)\s+\.?([a-z0-9]{1,8})\b/i, (m) => { r.newExt = m[1].toLowerCase(); r.notes.push(`extension .${r.newExt}`); });
  take(/\b(?:new\s+)?extension\s+(?:to\s+|of\s+)?\.([a-z0-9]{1,8})\b/i, (m) => { r.newExt = m[1].toLowerCase(); r.notes.push(`extension .${r.newExt}`); });
  // numbering with an example: "Project_Asset_001, 002, 003"
  take(/\bnumber(?:ed)?(?:\s+(?:them|these|those|it|the\s+files?|these\s+files|all))?(?:\s+sequentially|\s+in order)?\s+(?:as|like|to)\s+["“']?([^,;"”']*?[A-Za-z_ .-]*?)\s*(\d+)["”']?(?=\s*(?:,|;|$|\band\b|\s))[^;]*/i, (m) => {
    const pre = m[1].replace(/_\s+/g, '_').replace(/\s+_/g, '_').trim();
    const w = m[2].length;
    r.template = `${pre}{n:${w}}`; r.start = +m[2]; r.notes.push(`numbered ${pre}${m[2]}…`);
  });
  take(/\bformat(?:ted)?(?: them| it| names?)? (?:as|like|to) (\S+)/i, (m) => {
    let t = q(m[1]);
    t = t.replace(/YYYY/g, '{yyyy}').replace(/(^|[^{])YY(?![a-z])/g, '$1{yy}').replace(/(^|[^{a-z])MM(?![a-z])/g, '$1{mm}').replace(/(^|[^{a-z])DD(?![a-z])/g, '$1{dd}')
      .replace(/(?<![A-Za-z{])(name|filename|original)(?![A-Za-z}])/gi, '{name}').replace(/#{2,}/g, (h) => `{n:${h.length}}`).replace(/(^|[^{])#(?!\w)/g, '$1{n}');
    r.template = t; r.notes.push('pattern ' + t);
  });
  take(/\breplace ["“']?(.+?)["”']? (?:with|by) ["“']?(.*?)["”']?(?=\s*(?:\band\b|,|;|$))/i, (m) => { r.find = q(m[1]); r.replace = q(m[2]); r.notes.push(`replace “${r.find}” with “${r.replace}”`); });
  take(/\bremove (?:all )?(numbers|digits)\b/i, () => { r.find = '\\d+'; r.replace = ''; r.regex = true; r.notes.push('remove numbers'); });
  take(/\b(?:remove|delete|strip)\s+(?:all\s+|everything\s+|anything\s+|the\s+text\s+|text\s+)?(?:that'?s\s+)?(?:inside\s+|in\s+|between\s+|within\s+)?(?:the\s+)?(?:\[\.*\]\s*)?(?:square\s+)?(brackets|parenthes[ie]s|\(.*?\))\b[^.;]*/i, () => { r.find = '\\s*[\\(\\[][^\\)\\]]*[\\)\\]]'; r.replace = ''; r.regex = true; r.notes.push('remove brackets'); });
  take(/\bremove (?:all )?spaces\b/i, () => { r.find = ' '; r.replace = ''; r.notes.push('remove spaces'); });
  // "today's date" / "the date" as a prefix or suffix
  const dateWord = (x) => (/^(?:today'?s|todays|the current|current|the)?\s*date$/i.test(x.trim()) ? today() : null);
  take(new RegExp(String.raw`\b(?:add|put|prepend|start (?:it |them )?with)\s+["“']?(.+?)["”']?\s+(?:at the (?:start|beginning|front)|in front|before(?: the name)?|as (?:a )?prefix)${TAIL}(?=\s*(?:\band\b|,|;|\.|$))`, 'i'), (m) => { const v = q(m[1]); r.prefix = (dateWord(v) || v) + (dateWord(v) ? ' ' : ''); r.notes.push(`prefix “${r.prefix.trim()}”`); });
  take(/\bprefix(?: them| it)?(?: with)? ["“']?(.+?)["”']?(?=\s*(?:\band\b|,|;|$))/i, (m) => { r.prefix = q(m[1]); r.notes.push(`prefix “${r.prefix}”`); });
  take(new RegExp(String.raw`\b(?:add|put|append|end (?:it |them )?with)\s+["“']?(.+?)["”']?\s+(?:at the end|after(?: the name)?|as (?:a )?suffix)${TAIL}(?=\s*(?:\band\b|,|;|\.|$))`, 'i'), (m) => { const v = q(m[1]); r.suffix = (dateWord(v) ? ' ' + dateWord(v) : v); r.notes.push(`suffix “${r.suffix.trim()}”`); });
  take(/\bsuffix(?: them| it)?(?: with)? ["“']?(.+?)["”']?(?=\s*(?:\band\b|,|;|$))/i, (m) => { r.suffix = q(m[1]); r.notes.push(`suffix “${r.suffix}”`); });
  take(/\b(?:remove|delete|strip) ["“']?(.+?)["”']?(?=\s*(?:\band\b|,|;|$))/i, (m) => { r.find = q(m[1].trim()); r.replace = ''; r.notes.push(`remove “${r.find}”`); });
  take(/\bnumber(?:ed| them| it)?(?: starting)?(?: (?:at|from) (\d+))?(?:,? with (\d+) digits)?(?: (?:by|step) (\d+))?/i, (m) => {
    r.start = m[1] ? +m[1] : 1; if (m[3]) r.step = +m[3];
    const w = m[2] ? +m[2] : 0;
    if (!r.template || !/\{n/.test(r.template)) r.template = (r.template || '{name}') + `_{n${w ? ':' + w : ''}}`;
    else if (w) r.template = r.template.replace(/\{n(?::\d+)?\}/, `{n:${w}}`);
    r.notes.push(`numbered from ${r.start}${w ? `, ${w} digits` : ''}`);
  });
  return r;
}
