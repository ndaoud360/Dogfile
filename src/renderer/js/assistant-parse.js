// Understanding requests to the file assistant. Runs entirely on this PC: a grammar for the things people ask a
// file manager (find, group, rename, move, copy, delete, zip, tag, how much / how many) with dates, sizes, kinds,
// places and topics. Returns a plan the assistant shows before doing anything.
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3, several: 4 };
const n = (s) => (s == null ? 1 : /^\d+(\.\d+)?$/.test(s) ? +s : NUM[s.toLowerCase()] ?? 1);
const DAY = 86400000;
export const KIND_WORDS = [
  ['pdf', /\bpdfs?\b/, ['pdf']],
  ['word', /\b(word (docs?|documents?|files?)|docx?s?)\b/, ['doc', 'docx', 'odt', 'rtf']],
  ['sheet', /\b(spreadsheets?|excel( files| sheets)?|xlsx?s?|csvs?|workbooks?)\b/, ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers']],
  ['slides', /\b(presentations?|slides?|slide ?decks?|decks?|powerpoints?|pptx?s?|keynotes?)\b/, ['ppt', 'pptx', 'odp', 'key']],
  ['screenplay', /\b(screenplays?|scripts?|teleplays?)\b/, ['fdx', 'fountain', 'celtx', 'highland', 'sexp', 'docx', 'doc', 'pdf']],
  ['document', /\b(documents?|docs)\b/, ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub', 'xls', 'xlsx', 'ppt', 'pptx']],
  ['ebook', /\b(e-?books?|epubs?|books?)\b/, ['epub', 'mobi', 'azw', 'azw3', 'pdf']],
  ['screenshot', /\b(screen ?shots?|screen captures?)\b/, ['png', 'jpg', 'jpeg']],
  ['image', /\b(photos?|pictures?|pics?|images?|selfies?|wallpapers?|jpe?gs?|pngs?)\b/, ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng']],
  ['video', /\b(videos?|movies?|clips?|films?|footage|recordings?|mp4s?)\b/, ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'm4v', 'mts', 'm2ts', '3gp']],
  ['audio', /\b(songs?|music|tracks?|audio|mp3s?|podcasts?|sounds?|beats?|samples?)\b/, ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'alac']],
  ['installer', /\b(installers?|setups?|setup files|exes?|programs? i downloaded)\b/, ['exe', 'msi', 'msix', 'appx', 'msixbundle']],
  ['archive', /\b(zips?|archives?|zipped files|rars?|7z files?|compressed files)\b/, ['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'xz', 'bz2']],
  ['code', /\b(code|source files?|scripts? i wrote|python files?|js files?)\b/, ['js', 'ts', 'py', 'cs', 'cpp', 'c', 'h', 'java', 'go', 'rs', 'json', 'html', 'css', 'sh', 'ps1']],
  ['text', /\b(text files?|txts?|notes?)\b/, ['txt', 'md', 'rtf']],
  ['font', /\bfonts?\b/, ['ttf', 'otf', 'woff', 'woff2']],
];
const PLACES = [
  ['downloads', /\b(?:in|from|inside)?\s*(?:my\s+)?downloads?(?: folder)?\b/], ['documents', /\b(?:in|from)?\s*(?:my\s+)?documents folder\b|\bin (?:my )?documents\b/], ['desktop', /\b(?:on|in|from)\s+(?:my\s+|the\s+)?desktop\b/],
  ['pictures', /\bin (?:my )?(?:pictures|photos) folder\b|\bin my pictures\b/], ['videos', /\bin (?:my )?videos folder\b|\bin my videos\b/], ['music', /\bin (?:my )?music folder\b|\bin my music\b/],
  ['here', /\b(?:in )?(?:this|the current|current) folder\b|\bhere\b/], ['everywhere', /\b(?:everywhere|on (?:my |the )?(?:pc|computer|drives?|whole drive)|all drives?|anywhere)\b/],
];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STOP = new Set('group organize organise rename move copy delete remove zip compress tag label sort tidy arrange number lowercase uppercase trash clean put send duplicate backup how much many space do does take takes taking use uses using up total size count show list help can could want need red orange yellow green blue purple gray grey their its contents content inside based assets asset a an the my me i to of for and or in on at from with by all any some every these those this that them it its find show list get give where is are was were what which who whose please can could you would like want need look looking search for files file folder folders stuff things items everything named called about regarding related concerning containing contain contains mention mentions mentioning have has had not haven hasnt don dont didnt ever been open opened use used touched since last this next ago month months year years week weeks day days today yesterday older newer than over under bigger smaller larger more less latest newest recent recently most version versions copy copies final new old into folder subfolders put by type kind date name size each own one'.split(' '));

export function parseRequest(text, { hasSelection = false, now = Date.now() } = {}) {
  const raw = String(text || '').trim();
  let s = ' ' + raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[?!.]+$/, '') + ' ';
  const plan = { raw, action: 'find', kinds: [], exts: [], topic: [], scope: null, notes: [], quoted: [] };
  const take = (re, fn) => { const m = s.match(re); if (m) { const r = fn(m); s = s.replace(m[0], ' '); return r ?? true; } return false; };
  // quoted phrases are taken literally
  s = s.replace(/"([^"]+)"|'([^']{2,})'/g, (m, a, b) => { plan.quoted.push((a || b).trim()); return ' '; });
  // ---------- action ----------
  if (/\b(how (much|big)|total size|how many|count)\b/.test(s)) plan.action = /\bhow many|count\b/.test(s) ? 'count' : 'size';
  else if (/^\s*(rename|name)\b|\brename\b/.test(s)) plan.action = 'rename';
  else if (/\b(group|organi[sz]e|sort (these|them|this|my|the)? ?.*into|tidy|arrange|file (these|them) (by|into)|put (these|them|each) in(to)? (folders|its own)|separate)\b/.test(s)) plan.action = 'group';
  else if (/^\s*(move|send)\b|\bmove (these|them|all|my|the|it)\b/.test(s)) plan.action = 'move';
  else if (/^\s*(copy|duplicate|back ?up)\b|\bcopy (these|them|all|my|the)\b/.test(s)) plan.action = 'copy';
  else if (/^\s*(delete|remove|trash|get rid of|clean up|erase)\b|\b(delete|trash|get rid of)\b/.test(s)) plan.action = 'delete';
  else if (/^\s*(zip|compress|archive)\b|\b(zip|compress) (these|them|all|my)\b/.test(s)) plan.action = 'zip';
  else if (/^\s*(tag|label|mark)\b/.test(s)) plan.action = 'tag';
  else if (/^\s*(open|play|view)\b/.test(s)) plan.action = 'open';
  // the verb itself isn't part of what to look for
  s = s.replace(/^\s*(?:please\s+|can you\s+|could you\s+|i want to\s+|i need to\s+|help me\s+)*(?:find|show(?: me)?|list|get|give me|where (?:is|are)|look for|search for|rename|group|organi[sz]e|sort|tidy(?: up)?|arrange|move|send|copy|duplicate|back ?up|delete|remove|trash|get rid of|clean up|erase|zip(?: up)?|compress|archive|tag|label|mark|open|play|view|how (?:much|many)|count)\b/, ' ');
  // ---------- what (selection) ----------
  if (/\b(these|those|them|selected|the selection|this file|these files|it)\b/.test(s) && hasSelection) { plan.scope = 'selection'; plan.notes.push('the selected items'); }
  // ---------- action details ----------
  if (plan.action === 'group') {
    take(/\b(?:by|into folders by|based on)\s+(file ?type|type|kind|extension|format)\b/, () => { plan.groupBy = 'byKind'; });
    take(/\b(?:by|based on)\s+(month|date|when|time)\b/, () => { plan.groupBy = 'byMonth'; });
    take(/\b(?:by|based on)\s+year\b/, () => { plan.groupBy = 'byYear'; });
    take(/\b(?:by|based on)\s+size\b/, () => { plan.groupBy = 'bySize'; });
    take(/\b(?:by|based on)\s+(name|topic|subject|project|breed|person|client|show|series|what'?s in the name)\b/, () => { plan.groupBy = 'byName'; });
    if (!plan.groupBy) plan.groupBy = /\bassets?\b/.test(s) ? 'byKind' : 'byName';
  }
  if (plan.action === 'rename') {
    take(/\b(using|from|based on|by|with) (their|its|the|file)? ?(contents?|text|what'?s inside|title|headings?)\b/, () => { plan.renameMode = 'content'; });
    take(/\b(using|with|by|to) (the )?(date taken|photo date|exif date)\b/, () => { plan.renameMode = 'taken'; });
    take(/\b(using|with|from) (the )?(song|music|id3)? ?(tags?|artist and title|artist - title)\b/, () => { plan.renameMode = 'tags'; });
    if (!plan.renameMode) { plan.renameMode = 'describe'; plan.renameText = raw.replace(/^\s*rename\s+(these|them|this|the selected( files)?|all|my|files?)?\s*/i, ''); }
  }
  if (plan.action === 'move' || plan.action === 'copy') {
    take(/\b(?:to|into)\s+(?:the\s+|my\s+|a\s+)?(?:new\s+)?(?:folder\s+(?:called|named)\s+)?([^,;]+?)(?:\s+folder)?\s*$/, (m) => { plan.dest = m[1].trim(); });
  }
  if (plan.action === 'tag') take(/\b(red|orange|yellow|green|blue|purple|gr[ae]y)\b/, (m) => { plan.tag = m[1].replace('grey', 'gray'); });
  // ---------- latest version ----------
  take(/\b(?:the\s+)?(latest|newest|most recent|last|current|final)\s+(?:version|draft|copy|edit)s?\s+of\b/, () => { plan.latest = true; plan.notes.push('only the newest version'); });
  take(/\b(latest|newest|most recent)\b/, () => { plan.newestFirst = true; });
  // ---------- time ----------
  const y = new Date(now).getFullYear();
  const startOf = (yy, mm = 0, dd = 1) => new Date(yy, mm, dd).getTime();
  take(/\b(?:haven'?t|have not|hasn'?t|not|never|didn'?t)\s+(?:been\s+)?(?:opened|used|touched|looked at|accessed|played|watched|edited|changed|modified)(?:\s+(?:in|for|since))?\s+(?:the\s+)?(?:last\s+|past\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few|several)?\s*(day|week|month|year)s?\b/, (m) => {
    const k = n((m[1] || '1').replace(' of', '')), unit = { day: 1, week: 7, month: 30.4, year: 365 }[m[2]];
    const edited = /edited|changed|modified/.test(m[0]);
    plan[edited ? 'before' : 'notOpenedBefore'] = now - k * unit * DAY;
    plan.notes.push(`${edited ? 'not changed' : 'not opened'} for ${k} ${m[2]}${k === 1 ? '' : 's'}`);
  });
  take(/\b(?:in|from|during|for)\s+(?:the\s+)?(?:tax\s+)?year\s+(\d{4})\b|\b(?:in|from|during)\s+(\d{4})\b/, (m) => { const yy = +(m[1] || m[2]); plan.after = startOf(yy); plan.before = startOf(yy + 1); plan.notes.push(`from ${yy}`); });
  take(/\blast year'?s?\b|\bfrom last year\b/, () => { plan.after = startOf(y - 1); plan.before = startOf(y); plan.notes.push(`from ${y - 1}`); });
  take(/\bthis year'?s?\b/, () => { plan.after = startOf(y); plan.notes.push(`from ${y}`); });
  take(/\blast month'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth() - 1); plan.before = startOf(d.getFullYear(), d.getMonth()); plan.notes.push('from last month'); });
  take(/\bthis month'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth()); plan.notes.push('from this month'); });
  take(/\b(?:last|this past|past) week'?s?\b/, () => { plan.after = now - 7 * DAY; plan.notes.push('from the last 7 days'); });
  take(/\btoday'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth(), d.getDate()); plan.notes.push('from today'); });
  take(/\byesterday'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth(), d.getDate() - 1); plan.before = startOf(d.getFullYear(), d.getMonth(), d.getDate()); plan.notes.push('from yesterday'); });
  take(/\b(?:in|from|during)\s+(?:the\s+)?(?:last|past)\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*(day|week|month|year)s?\b/, (m) => { const k = n(m[1].replace(' of', '')); plan.after = now - k * { day: 1, week: 7, month: 30.4, year: 365 }[m[2]] * DAY; plan.notes.push(`from the last ${k} ${m[2]}${k === 1 ? '' : 's'}`); });
  take(/\bolder than\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(day|week|month|year)s?\b|\b(\d+|one|two|three|six|twelve)\s*(day|week|month|year)s?\s+old\b/, (m) => { const k = n(m[1] || m[3]), u = m[2] || m[4]; plan.before = now - k * { day: 1, week: 7, month: 30.4, year: 365 }[u] * DAY; plan.notes.push(`older than ${k} ${u}${k === 1 ? '' : 's'}`); });
  take(new RegExp(`\\b(?:in|from|during)\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`), (m) => { const mi = MONTHS.indexOf(m[1]); let yy = m[2] ? +m[2] : y; if (!m[2] && startOf(yy, mi) > now) yy--; plan.after = startOf(yy, mi); plan.before = startOf(yy, mi + 1); plan.notes.push(`from ${m[1]} ${yy}`); });
  take(/\b(?:since|after)\s+(\d{4})\b/, (m) => { plan.after = startOf(+m[1]); plan.notes.push(`since ${m[1]}`); });
  take(/\bbefore\s+(\d{4})\b/, (m) => { plan.before = startOf(+m[1]); plan.notes.push(`before ${m[1]}`); });
  // ---------- size ----------
  const unit = (u) => ({ b: 1, kb: 1024, k: 1024, mb: 1048576, m: 1048576, meg: 1048576, megs: 1048576, gb: 1073741824, g: 1073741824, gig: 1073741824, gigs: 1073741824, tb: 1099511627776 }[u] || 1048576);
  take(/\b(?:bigger|larger|more|over|above|greater|at least)\s+(?:than\s+)?(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|megs?|gigs?|b)\b/, (m) => { plan.minSize = +m[1] * unit(m[2]); plan.notes.push(`over ${m[1]} ${m[2].toUpperCase()}`); });
  take(/\b(?:smaller|less|under|below|at most)\s+(?:than\s+)?(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|megs?|gigs?|b)\b/, (m) => { plan.maxSize = +m[1] * unit(m[2]); plan.notes.push(`under ${m[1]} ${m[2].toUpperCase()}`); });
  take(/\b(huge|biggest|largest|large|big)\b/, () => { if (!plan.minSize) { plan.minSize = 500 * 1048576; plan.notes.push('large (over 500 MB)'); } });
  take(/\bduplicates?\b/, () => { plan.duplicates = true; plan.notes.push('duplicates'); });
  // ---------- places ----------
  for (const [k, re] of PLACES) if (take(re, () => k)) { if (!plan.scope || plan.scope === 'selection' && k !== 'here') plan.scope = plan.scope === 'selection' ? 'selection' : k; if (plan.scope !== 'selection') plan.scope = k; }
  take(/\bon\s+(?:the\s+)?([a-z]):?\s*(?:drive)?\b|\b([a-z]):\\?(?=\s)/, (m) => { plan.scope = 'drive:' + (m[1] || m[2]).toUpperCase(); });
  // ---------- kinds ----------
  for (const [k, re, exts] of KIND_WORDS) {
    if (re.test(s)) {
      if (k === 'document' && plan.kinds.some((x) => ['pdf', 'word', 'sheet', 'slides', 'screenplay'].includes(x))) { s = s.replace(re, ' '); continue; }
      plan.kinds.push(k); exts.forEach((e) => plan.exts.includes(e) || plan.exts.push(e)); s = s.replace(re, ' ');
    }
  }
  if (plan.kinds.includes('screenshot')) plan.nameHint = ['screenshot', 'screen shot', 'capture', 'snip'];
  // ---------- topic: whatever meaningful words are left ----------
  take(/\b(?:about|regarding|related to|concerning|on the subject of|mentioning|containing|that mention|with the word|named|called|titled)\s+(.+)$/, (m) => { plan.topic.push(...words(m[1])); plan.inside = /about|regarding|related|concerning|mention|contain/.test(m[0]); });
  plan.topic.push(...words(s), ...plan.quoted);
  plan.topic = [...new Set(plan.topic)].filter((w) => !(plan.dest && plan.dest.toLowerCase().includes(w)));
  if (plan.action === 'group' && !plan.scope) plan.scope = hasSelection ? 'selection' : 'here';
  if (['rename', 'move', 'copy', 'delete', 'zip', 'tag'].includes(plan.action) && !plan.scope && hasSelection && !plan.topic.length && !plan.kinds.length) plan.scope = 'selection';
  return plan;
}
function words(str) {
  return String(str).toLowerCase().split(/[^a-z0-9À-ɏ'&-]+/).map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, '')).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d{1,2}$/.test(w));
}
// a few common topic words people use for files; helps "taxes" find "W2", "1099", "IRS"…
export const SYNONYMS = {
  tax: ['tax', 'taxes', 'irs', 'w2', 'w-2', '1099', '1040', 'hmrc', 'return', 'deduction', 'vat'],
  invoice: ['invoice', 'invoices', 'bill', 'receipt', 'statement', 'payment'],
  receipt: ['receipt', 'receipts', 'invoice', 'purchase', 'order'],
  resume: ['resume', 'résumé', 'cv', 'curriculum'],
  screenplay: ['screenplay', 'script', 'draft', 'teleplay', 'pilot', 'fdx', 'fountain'],
  contract: ['contract', 'agreement', 'nda', 'lease', 'terms'],
  wedding: ['wedding', 'bride', 'groom', 'ceremony', 'reception'],
  vacation: ['vacation', 'holiday', 'trip', 'travel'],
  bank: ['bank', 'statement', 'account', 'checking', 'savings'],
  medical: ['medical', 'doctor', 'health', 'prescription', 'lab', 'insurance'],
  insurance: ['insurance', 'policy', 'claim', 'coverage'],
  car: ['car', 'vehicle', 'auto', 'registration', 'insurance'],
  school: ['school', 'homework', 'assignment', 'class', 'course', 'syllabus'],
};
export function expandTopic(topic) {
  const out = new Set();
  for (const w of topic) {
    const s = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
    out.add(w); out.add(s);
    for (const [k, list] of Object.entries(SYNONYMS)) if (k === s || list.includes(w) || list.includes(s)) list.forEach((x) => out.add(x));
  }
  return [...out].filter((x) => x.length > 1);
}
export function describePlan(p) {
  const kinds = p.kinds.length ? p.kinds.map((k) => ({ pdf: 'PDFs', word: 'Word documents', sheet: 'spreadsheets', slides: 'presentations', screenplay: 'screenplays', document: 'documents', ebook: 'e-books', screenshot: 'screenshots', image: 'pictures', video: 'videos', audio: 'songs', installer: 'installers', archive: 'zip files', code: 'code files', text: 'text files', font: 'fonts' }[k])).join(' and ') : 'files';
  return kinds;
}
