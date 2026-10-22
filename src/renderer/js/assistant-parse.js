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
  ['markdown', /\b(markdown(?: files?)?|\.?md files?)\b/, ['md', 'markdown']],
  ['config', /\b(config(?:uration)? files?|configs|settings files?|dotfiles?|env files?)\b/, ['env', 'ini', 'cfg', 'conf', 'config', 'yaml', 'yml', 'toml', 'json', 'xml', 'properties']],
  ['temp', /\b(temp(?:orary)? files?|junk files?|leftover files?)\b/, ['tmp', 'temp', 'bak', 'old', 'dmp', 'chk', 'crdownload', 'part']],
  ['log', /\b(log files?|logs)\b/, ['log']],
  ['text', /\b(text files?|txts?|notes?)\b/, ['txt', 'md', 'rtf']],
  ['font', /\bfonts?\b/, ['ttf', 'otf', 'woff', 'woff2']],
];
const PLACES = [
  ['downloads', /\b(?:in|from|inside|across)?\s*(?:my\s+|the\s+)?downloads?(?: folders?)?\b|\b(?:i\s+)?downloaded\b/],
  ['documents', /\b(?:in|from|across)?\s*(?:my\s+|the\s+)?documents folders?\b|\bin (?:my )?documents\b/],
  ['desktop', /\b(?:on|in|from|across)?\s*(?:my\s+|the\s+)?desktop(?: folders?)?\b/],
  ['pictures', /\b(?:in|from|across)?\s*(?:my\s+|the\s+)?(?:pictures|photos) folders?\b|\bin my pictures\b/],
  ['videos', /\b(?:in|from|across)?\s*(?:my\s+|the\s+)?videos folders?\b|\bin my videos\b/],
  ['music', /\b(?:in|from|across)?\s*(?:my\s+|the\s+)?music folders?\b|\bin my music\b/],
  ['here', /\b(?:in |inside |from )?(?:this|the current|current|the active|this active) (?:folder|directory|dir)\b|\bhere\b/],
  ['everywhere', /\b(?:everywhere|on (?:my |the )?(?:pc|computer|drives?|whole drive)|(?:on |across |in )?(?:all|every|each) (?:of my )?drives?|anywhere)\b/],
];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STOP = new Set('group organize organise rename move copy delete remove zip compress tag label sort tidy arrange number lowercase uppercase trash clean put send duplicate backup how much many space do does take takes taking use uses using up total size count show list help can could want need red orange yellow green blue purple gray grey their its contents content inside based assets asset a an the my me i to of for and or in on at from with by all any some every these those this that them it its find show list get give where is are was were what which who whose please can could you would like want need look looking search for files file folder folders stuff things items everything named called about regarding related concerning containing contain contains mention mentions mentioning have has had not haven hasnt don dont didnt ever been open opened use used touched since last this next ago month months year years week weeks day days today yesterday older newer than over under bigger smaller larger more less latest newest recent recently most version versions copy copies final new old into folder subfolders put by type kind date name size each own one phrase phrases string strings key word words same across individual sequentially exact exactly whole entire just only created modified made added taken shot changed edited downloaded vs versus selected preview previews before deleting organized organised sorted grouped so together three ones right now'.split(' '));

// musical keys → Camelot codes (harmonic mixing wheel)
const CAMELOT = { 'ab minor': '1A', 'g# minor': '1A', 'b major': '1B', 'eb minor': '2A', 'd# minor': '2A', 'f# major': '2B', 'gb major': '2B', 'bb minor': '3A', 'a# minor': '3A', 'db major': '3B', 'c# major': '3B',
  'f minor': '4A', 'ab major': '4B', 'g# major': '4B', 'c minor': '5A', 'eb major': '5B', 'd# major': '5B', 'g minor': '6A', 'bb major': '6B', 'a# major': '6B', 'd minor': '7A', 'f major': '7B',
  'a minor': '8A', 'c major': '8B', 'e minor': '9A', 'g major': '9B', 'b minor': '10A', 'd major': '10B', 'f# minor': '11A', 'gb minor': '11A', 'a major': '11B', 'db minor': '12A', 'c# minor': '12A', 'e major': '12B' };
export function camelotOf(note, mode = 'major') {
  const n = String(note).toLowerCase().replace(/\s*sharp$/, '#').replace(/\s*flat$/, 'b').replace('♯', '#').replace('♭', 'b');
  const m = /^(m|min|minor)$/i.test(mode) ? 'minor' : 'major';
  return CAMELOT[`${n} ${m}`] || null;
}
const CAMERA_WORDS = /^(?:sony|canon|nikon|fuji(?:film)?|olympus|panasonic|lumix|leica|pentax|ricoh|gopro|dji|samsung|google|pixel|iphone|apple|huawei|xiaomi|oneplus|motorola|nokia|lg|oppo|vivo|hasselblad)/i;
const CODECS = { hevc: 'hevc', 'h.265': 'hevc', h265: 'hevc', x265: 'hevc', 'h.264': 'h264', h264: 'h264', avc: 'h264', x264: 'h264', av1: 'av1', vp9: 'vp9', vp8: 'vp8', prores: 'prores', 'mpeg-2': 'mpeg2video', mpeg2: 'mpeg2video', xvid: 'mpeg4', divx: 'mpeg4', 'mpeg-4': 'mpeg4' };

export function parseRequest(text, { hasSelection = false, now = Date.now() } = {}) {
  const raw = String(text || '').trim();
  const plan = { raw, action: 'find', kinds: [], exts: [], topic: [], scope: null, notes: [], quoted: [] };
  // ---------- pieces read from the original text (case matters) ----------
  let rawWork = raw;
  const rx = /\b(?:matching|that match(?:es)?|matches|with names? matching|named like)\s+(?:the\s+)?(?:regex|regular expression|reg ?ex|pattern)\s+(\S+)/i.exec(rawWork);
  if (rx) { plan.regex = rx[1].replace(/(\$)\.$/, '$1').replace(/[.,;]$/, (m) => (/\\$/.test(rx[1].slice(0, -1)) ? m : '')); rawWork = rawWork.replace(rx[0], ' '); plan.notes.push(`names matching ${plan.regex}`); }
  let s = ' ' + rawWork.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[?!.]+$/, '') + ' ';
  const take = (re, fn) => { const m = s.match(re); if (m) { const r = fn(m); s = s.replace(m[0], ' '); return r ?? true; } return false; };
  // examples in brackets ("(e.g. put poodle photos …)", "(sound effects)") are not part of the request
  s = s.replace(/\((?:e\.g\.?|eg|for example|like|such as|i\.e\.?)[^)]*\)/g, ' ');
  // quoted phrases are taken literally
  s = s.replace(/"([^"]+)"|(?:^|\s)'([^']{2,})'(?=\s|$|[,.;])/g, (m, a, b) => { plan.quoted.push((a || b).trim()); return ' '; });
  // ---------- action ----------
  if (/\b(how (much|big)|total size|how many|count)\b/.test(s)) plan.action = /\bhow many|count\b/.test(s) ? 'count' : 'size';
  else if (/^\s*(?:please\s+)?(group|organi[sz]e|sort|tidy|arrange)\b/.test(s) && !/\bdrop ?shelf\b/.test(s)) plan.action = 'group';
  else if (/^\s*(rename|name)\b|\brename\b|\bas (?:a )?(?:prefix|suffix)\b|\b(?:file ?names?)\b|\b(?:replace|convert)\b.*\b(?:underscores|lower ?case|upper ?case|title ?case)\b|^\s*number (?:these|them|the|all|my)\b|\b(?:change|set|switch) (?:the )?(?:file )?extensions?\b/.test(s)) plan.action = 'rename';
  else if (/\b(drop ?shelf|the shelf)\b/.test(s)) plan.action = 'shelf';
  else if (/\binto (?:sub)?folders (?:organi[sz]ed |sorted |grouped |arranged )?(?:by|based on|for each)\b|\b(?:its|their) own (?:individual |separate )?folders?\b/.test(s)) plan.action = 'group';
  else if (/\b(group|organi[sz]e|sort (these|them|this|my|the)? ?.*into|tidy|arrange|file (these|them) (by|into)|put (these|them|each) in(to)? (folders|its own)|separate)\b/.test(s)) plan.action = 'group';
  else if (/^\s*(move|send)\b|\bmove (these|them|all|my|the|it|every)\b/.test(s)) plan.action = 'move';
  else if (/^\s*(copy|duplicate|back ?up)\b|\bcopy (these|them|all|my|the|every)\b/.test(s)) plan.action = 'copy';
  else if (/^\s*(delete|remove|trash|recycle|get rid of|clean up|erase)\b|\b(delete|deleting|trash|recycle|get rid of)\b/.test(s)) plan.action = 'delete';
  else if (/^\s*(zip|compress|archive)\b|\b(zip|compress) (these|them|all|my|the)\b/.test(s)) plan.action = 'zip';
  else if (/^\s*(tag|label|mark)\b/.test(s)) plan.action = 'tag';
  else if (/^\s*(open|play|view)\b/.test(s)) plan.action = 'open';
  // the verb itself isn't part of what to look for
  s = s.replace(/^\s*(?:please\s+|can you\s+|could you\s+|i want to\s+|i need to\s+|help me\s+)*(?:find|show(?: me)?|list|get|give me|where (?:is|are)|look for|search(?: for)?|scan|collect|gather|rename|group|organi[sz]e|sort|tidy(?: up)?|arrange|move|send|copy|duplicate|back ?up|delete|remove|trash|recycle|get rid of|clean up|erase|zip(?: up)?|compress|archive|tag|label|mark|open|play|view|how (?:much|many)|count)\b/, ' ');
  // ---------- what (selection) ----------
  const strongSel = /\b(these|those|selected|the selection|this file|these files)\b/.test(s), weakSel = /\b(them|it)\b/.test(s);
  if ((strongSel || weakSel) && hasSelection) { plan.scope = 'selection'; plan.notes.push('the selected items'); }
  // ---------- what's left out ----------
  take(/\b(?:that|which)\s+(?:aren'?t|are not|isn'?t|is not)\s+(?:an?\s+)?([a-z]+)|\b(?:except(?: for)?|excluding|other than|but not|apart from|not including|without)\s+(?:the\s+|any\s+)?([a-z]+)/, (m) => {
    const w = m[1] || m[2];
    const k = KIND_WORDS.find(([, re]) => re.test(w));
    if (k) { plan.excludeExts = [...k[2]]; plan.notes.push(`not ${describePlan({ kinds: [k[0]] })}`); }
  });
  // ---------- action details ----------
  if (plan.action === 'group') {
    take(/\b(?:its|their) own (?:individual |separate )?folders?(?: named after (?:the|each|their|its) (?:file|name)s?)?\b/, () => { plan.groupBy = 'own'; });
    take(/\b(?:by|into folders by|based on|for each)\s+(?:the\s+|their\s+)?(file ?type|type|kind|extension|format)s?\b/, () => { plan.groupBy = 'byKind'; });
    take(/\b(?:by|based on|for each)\s+(?:the\s+|their\s+)?(month|date|when|time)s?\b/, () => { plan.groupBy = 'byMonth'; });
    take(/\b(?:by|based on|for each)\s+(?:the\s+|their\s+)?years?\b(?:\s+(?:they were|it was|when)\s+(?:created|made|taken|modified|changed))?/, () => { plan.groupBy = 'byYear'; });
    take(/\b(?:by|based on)\s+(?:the\s+|their\s+)?size\b/, () => { plan.groupBy = 'bySize'; });
    take(/\b(?:by|based on)\s+(?:the\s+|their\s+)?(name|topic|subject|project|breed|person|client|show|series|what'?s in the name)s?\b(?:\s+(?:based on|from|in) (?:their|the) (?:file ?)?names?)?/, () => { plan.groupBy = 'byName'; });
    if (!plan.groupBy) plan.groupBy = /\bassets?\b/.test(s) ? 'byKind' : 'byName';
  }
  if (plan.action === 'rename') {
    take(/\b(using|from|based on|by|with) (their|its|the|file)? ?(actual )?(text )?(contents?|text|what'?s inside|title|headings?)\b[^.;]*/, () => { plan.renameMode = 'content'; });
    if (!plan.renameMode) { plan.renameMode = 'describe'; plan.renameText = raw.replace(/^\s*rename\s+(these|them|this|the selected( files)?|all|my|files?)?\s*/i, ''); }
  }
  if (plan.action === 'move' || plan.action === 'copy') {
    // the destination keeps its capitals ("Music\Unsorted")
    const dm = /\b(?:to|into)\s+(?:the\s+|my\s+|a\s+)?(?:new\s+)?(?:folder\s+(?:called|named)\s+)?([^,;]+?)(?:\s+folder)?\s*[.!]?\s*$/i.exec(rawWork);
    if (dm && !/\bother (?:open )?pane\b/i.test(dm[1])) { plan.dest = dm[1].trim().replace(/^["'“‘]|["'”’]$/g, ''); const low = dm[0].toLowerCase().replace(/[.!]\s*$/, '').trim(); s = s.replace(low, ' ').replace(low.replace(/\s+folder$/, ''), ' '); }
  }
  if (plan.action === 'zip') {
    const zm = /\b(?:into|as|to|called|named)\s+["'“‘]?([^"'”’]+?\.(?:zip|7z|tar\.gz|tgz|tar))\b/i.exec(rawWork);
    if (zm) { plan.zipName = zm[1].trim(); s = s.replace(zm[0].toLowerCase(), ' '); plan.notes.push(`as ${plan.zipName}`); }
  }
  // tags: one or more colours, or a name in quotes
  if (plan.action === 'tag') {
    const cols = [...s.matchAll(/\b(red|orange|yellow|green|blue|purple|gr[ae]y)\b/g)].map((m) => m[1].replace('grey', 'gray'));
    plan.tags = [...new Set(cols)];
    if (!plan.tags.length && plan.quoted.length) plan.tags = [plan.quoted.shift()];
    plan.tag = plan.tags[0];
    s = s.replace(/\b(red|orange|yellow|green|blue|purple|gr[ae]y)\b/g, ' ');
  }
  // ---------- explicit extensions (".env", "*.psd", ".tar.gz") ----------
  s = s.replace(/(?:^|\s)\*?\.([a-z0-9]{1,8}(?:\.gz)?)\b(?:\s+files?)?/g, (m, e) => { if (!plan.exts.includes(e)) plan.exts.push(e); return ' '; });
  s = s.replace(/\b(json|xml|yaml|yml|csv|ini|env|psd|ai|svg|iso|dmg|apk|torrent|srt|heic|raw|webp|gif|bmp|tiff?|flac|wav|m4a|aac|ogg|mkv|mov|avi|wmv|webm|epub|odt|rtf|ps1|bat|py|js|ts|sh)\s+(?:files?|pictures?|images?|photos?|videos?|songs?|tracks?|audio|documents?)\b/g, (m, e) => { if (!plan.exts.includes(e)) plan.exts.push(e); return ' ' + m.split(/\s+/).slice(1).join(' ') + ' '; });
  if (plan.exts.length) plan.notes.push(plan.exts.map((e) => '.' + e).join(' '));
  // ---------- latest version / old versions ----------
  take(/\b(?:the\s+)?(?:old(?:er)?|previous|earlier)\s+(?:versions?|drafts?|copies)\s+of\b/, () => { plan.oldVersions = true; plan.notes.push('older versions of the same file'); });
  take(/\b(?:the\s+)?(latest|newest|most recent|last|current|final)\s+(?:version|draft|copy|edit)s?\s+of\b/, () => { plan.latest = true; plan.notes.push('only the newest version'); });
  // ---------- how many, by what ----------
  take(/\b(?:top|the|my)?\s*(\d+)\s+(largest|biggest|smallest|newest|oldest|most recent|latest)\b|\btop\s+(\d+)\b/, (m) => { plan.top = +(m[1] || m[3]); const w = m[2] || 'largest'; plan.sortBy = /smallest/.test(w) ? 'sizeAsc' : /newest|recent|latest/.test(w) ? 'newest' : /oldest/.test(w) ? 'oldest' : 'size'; plan.notes.push(`top ${plan.top}`); });
  // ---------- pictures, videos and songs: what's in the file ----------
  take(/\b(?:taken|shot|photographed)\s+(?:with|on|by|using)\s+(?:my\s+|an?\s+|the\s+)?([a-z0-9][\w -]*?)(?:\s+(?:camera|phone))?(?:\s+or\s+(?:with\s+)?(?:my\s+|an?\s+|the\s+)?([a-z0-9][\w -]*?)(?:\s+(?:camera|phone))?)?(?=\s*$|\s+(?:that|which|in|from|on|during|with)\b|,)/, (m) => { plan.cameras = [m[1], m[2]].filter(Boolean).map((x) => x.trim()); plan.notes.push(`taken with ${plan.cameras.join(' or ')}`); if (!plan.kinds.length) plan.kinds.push('image'); });
  take(/\b(?:with|have|having|has|that have|containing|including)\s+(?:a\s+|any\s+)?(?:gps|location|geo ?tags?|coordinates)(?:\s+(?:location|data|info(?:rmation)?|coordinates|tags?))*\b|\bgeo-?tagged\b/, () => { plan.gps = true; plan.notes.push('with a GPS location'); });
  take(/\bportrait(?:[- ]orient(?:ation|ed))?\b/, () => { plan.orient = 'portrait'; plan.notes.push('portrait'); });
  take(/\blandscape(?:[- ]orient(?:ation|ed))?\b/, () => { plan.orient = 'landscape'; plan.notes.push('landscape'); });
  take(/\bwider than\s+(\d+)\s*(?:px|pixels?)?/, (m) => { plan.minW = +m[1]; plan.notes.push(`wider than ${m[1]} px`); });
  take(/\btaller than\s+(\d+)\s*(?:px|pixels?)?/, (m) => { plan.minH = +m[1]; plan.notes.push(`taller than ${m[1]} px`); });
  take(/\b(?:at least|over|bigger than|larger than)\s+(\d{3,5})\s*(?:px|pixels)\b/, (m) => { plan.minSide = +m[1]; plan.notes.push(`over ${m[1]} px`); });
  take(/\b(?:where\s+)?(?:the\s+)?(?:dominant|main|most common)\s+colou?r\s+(?:is\s+|of\s+)?(red|orange|yellow|green|teal|blue|purple|pink|brown|black|gr[ae]y|white)\b|\bmostly\s+(red|orange|yellow|green|teal|blue|purple|pink|brown|black|gr[ae]y|white)\b|\b(red|orange|yellow|green|teal|blue|purple|pink|brown|black|gr[ae]y|white)(?:[- ]colou?red| ones| tones?)\b/, (m) => { plan.color = (m[1] || m[2] || m[3]).replace('grey', 'gray'); plan.notes.push(`mostly ${plan.color}`); if (!plan.kinds.length) plan.kinds.push('image'); });
  take(/\b(?:at|around|about|near|roughly|approximately|~)\s*(\d{2,3})\s*bpm\b|\b(\d{2,3})\s*bpm\b|\bbetween\s+(\d{2,3})\s+and\s+(\d{2,3})\s*bpm\b|\b(?:faster|more) than\s+(\d{2,3})\s*bpm\b|\b(?:slower|less) than\s+(\d{2,3})\s*bpm\b/, (m) => {
    if (m[3]) { plan.minBpm = +m[3]; plan.maxBpm = +m[4]; } else if (m[5]) plan.minBpm = +m[5]; else if (m[6]) plan.maxBpm = +m[6];
    else { const b = +(m[1] || m[2]); const fuzzy = !!m[1]; plan.minBpm = b - (fuzzy ? 4 : 1); plan.maxBpm = b + (fuzzy ? 4 : 1); }
    plan.notes.push(plan.minBpm && plan.maxBpm ? `${plan.minBpm}–${plan.maxBpm} BPM` : plan.minBpm ? `over ${plan.minBpm} BPM` : `under ${plan.maxBpm} BPM`); if (!plan.kinds.length) plan.kinds.push('audio');
  });
  take(/\b(?:in\s+)?(?:the\s+)?key\s+(?:of\s+)?([a-g])(\s*(?:#|♯|b\b|♭|sharp|flat))?\s*(major|minor|maj|min|m)?\b(\s+or\s+(?:a\s+|any\s+)?(?:compatible|neighbou?ring|matching|harmonic) keys?)?/, (m) => {
    const note = m[1] + (m[2] ? m[2].trim().replace('sharp', '#').replace('flat', 'b').replace('♯', '#').replace('♭', 'b') : '');
    plan.key = camelotOf(note, m[3] || 'major'); plan.keyCompat = !!m[4];
    if (plan.key) plan.notes.push(`key ${note.toUpperCase()} ${/^m/.test(m[3] || '') ? 'minor' : 'major'} (${plan.key})${plan.keyCompat ? ' or compatible' : ''}`);
    if (!plan.kinds.length) plan.kinds.push('audio');
  });
  const secs = (n2, u) => +n2 * (/^h/.test(u) ? 3600 : /^m/.test(u) ? 60 : 1);
  take(/\b(?:longer|more|over|greater)\s+than\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|s)\b|\bover\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\s+long\b/, (m) => { plan.minDur = secs(m[1] || m[3], m[2] || m[4]); plan.notes.push(`longer than ${m[1] || m[3]} ${m[2] || m[4]}`); });
  take(/\b(?:shorter|less|under)\s+than\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|s)\b|\bunder\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\s+long\b/, (m) => { plan.maxDur = secs(m[1] || m[3], m[2] || m[4]); plan.notes.push(`shorter than ${m[1] || m[3]} ${m[2] || m[4]}`); });
  take(/\b(?:encoded|recorded|compressed|that are|which are)?\s*(?:in|with|using|as)\s+(hevc|h\.?265|x265|h\.?264|avc|x264|av1|vp9|vp8|prores|mpeg-?2|mpeg-?4|xvid|divx)\b|\b(hevc|h\.?265|h\.?264|av1|vp9|prores)\s+(?:videos?|files?|encoded)\b/, (m) => { const c = (m[1] || m[2]).replace(/^h(\d)/, 'h.$1'); plan.vcodec = CODECS[c] || CODECS[c.replace('.', '')] || c; plan.notes.push(`encoded in ${c.toUpperCase()}`); if (!plan.kinds.length) plan.kinds.push('video'); });
  const taken = /\b(?:taken|shot|photographed)\b/.test(s);
  // ---------- time ----------
  const y = new Date(now).getFullYear();
  const startOf = (yy, mm = 0, dd = 1) => new Date(yy, mm, dd).getTime();
  take(/\b(?:haven'?t|have not|hasn'?t|not|never|didn'?t)\s+(?:been\s+)?(?:opened|used|touched|looked at|accessed|played|watched|edited|changed|modified)(?:\s+(?:in|for|since))?\s+(?:the\s+)?(?:last\s+|past\s+)?(?:over\s+|more than\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few|several)?\s*(day|week|month|year)s?\b/, (m) => {
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
  take(/\b(?:last|this past|past|this) week'?s?\b/, () => { plan.after = now - 7 * DAY; plan.notes.push('from the last 7 days'); });
  take(/\btoday'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth(), d.getDate()); plan.notes.push('from today'); });
  take(/\byesterday'?s?\b/, () => { const d = new Date(now); plan.after = startOf(d.getFullYear(), d.getMonth(), d.getDate() - 1); plan.before = startOf(d.getFullYear(), d.getMonth(), d.getDate()); plan.notes.push('from yesterday'); });
  take(/\b(?:in|from|during|within)\s+(?:the\s+)?(?:last|past)\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*(day|week|month|year)s?\b/, (m) => { const k = n(m[1].replace(' of', '')); plan.after = now - k * { day: 1, week: 7, month: 30.4, year: 365 }[m[2]] * DAY; plan.notes.push(`from the last ${k} ${m[2]}${k === 1 ? '' : 's'}`); });
  take(/\bolder than\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(day|week|month|year)s?\b|\b(\d+|one|two|three|six|twelve)\s*(day|week|month|year)s?\s+old\b/, (m) => { const k = n(m[1] || m[3]), u = m[2] || m[4]; plan.before = now - k * { day: 1, week: 7, month: 30.4, year: 365 }[u] * DAY; plan.notes.push(`older than ${k} ${u}${k === 1 ? '' : 's'}`); });
  take(new RegExp(`\\b(?:in|from|during)\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`), (m) => { const mi = MONTHS.indexOf(m[1]); let yy = m[2] ? +m[2] : y; if (!m[2] && startOf(yy, mi) > now) yy--; plan.after = startOf(yy, mi); plan.before = startOf(yy, mi + 1); plan.notes.push(`from ${m[1]} ${yy}`); });
  take(/\b(?:since|after)\s+(\d{4})\b/, (m) => { plan.after = startOf(+m[1]); plan.notes.push(`since ${m[1]}`); });
  take(/\bbefore\s+(\d{4})\b/, (m) => { plan.before = startOf(+m[1]); plan.notes.push(`before ${m[1]}`); });
  // "created …" dates are the creation date; "taken …" dates come from the photo itself
  if (/\b(?:created|made|added)\b/.test(s) && (plan.after || plan.before) && plan.action !== 'group') { plan.createdAfter = plan.after; plan.createdBefore = plan.before; delete plan.after; delete plan.before; plan.notes.push('by date created'); }
  else if (taken && (plan.after || plan.before)) { plan.takenAfter = plan.after; plan.takenBefore = plan.before; delete plan.after; delete plan.before; if (!plan.kinds.length) plan.kinds.push('image'); }
  // ---------- size ----------
  const unit = (u) => ({ b: 1, kb: 1024, k: 1024, mb: 1048576, m: 1048576, meg: 1048576, megs: 1048576, gb: 1073741824, g: 1073741824, gig: 1073741824, gigs: 1073741824, tb: 1099511627776 }[u] || 1048576);
  take(/\b(?:bigger|larger|more|over|above|greater|at least)\s+(?:than\s+)?(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|megs?|gigs?|b)\b/, (m) => { plan.minSize = +m[1] * unit(m[2]); plan.notes.push(`over ${m[1]} ${m[2].toUpperCase()}`); });
  take(/\b(?:smaller|less|under|below|at most)\s+(?:than\s+)?(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|megs?|gigs?|b)\b/, (m) => { plan.maxSize = +m[1] * unit(m[2]); plan.notes.push(`under ${m[1]} ${m[2].toUpperCase()}`); });
  take(/\b(huge|biggest|largest|large|big)\b/, () => { if (!plan.minSize && !plan.top) { plan.minSize = (plan.notOpenedBefore ? 100 : 500) * 1048576; plan.notes.push(plan.notOpenedBefore ? 'large (over 100 MB)' : 'large (over 500 MB)'); } });
  take(/\b(?:exact\s+)?duplicates?\b/, () => { plan.duplicates = true; plan.notes.push('duplicates'); });
  take(/\bempty (?:sub)?(?:folders?|directories|dirs)\b/, () => { plan.emptyDirs = true; plan.notes.push('empty folders'); });
  // ---------- places ----------
  const scopes = [];
  for (const [k, re] of PLACES) while (take(re, () => k)) if (!scopes.includes(k)) scopes.push(k);
  take(/\b(?:and|including|with)\s+(?:all\s+)?(?:its|their|the)\s+sub ?folders\b|\b(?:and\s+)?(?:all\s+)?(?:its\s+)?sub ?folders\b|\brecursively\b/, () => { plan.recursive = true; });
  take(/\b(?:on|in|from|across)\s+(?:my\s+|the\s+)?([a-z]):?\s*drive\b|\bdrive\s+([a-z]):|\b([a-z]):(?:\\|\s|$)/, (m) => { scopes.push('drive:' + (m[1] || m[2] || m[3]).toUpperCase()); });
  take(/\b(?:in|inside|from|under|within)\s+(?:my|the|our)\s+([a-z0-9][\w .'&-]{1,40}?)\s+(?:folder|directory|dir)\b/, (m) => { plan.folderName = m[1].trim(); });
  if (scopes.length) {
    if (plan.scope === 'selection' && strongSel && scopes.every((x) => x === 'here')) { /* "these … here": the selection */ }
    else { plan.scope = scopes[0]; if (scopes.length > 1) plan.scopes = scopes; }
  }
  // ---------- kinds ----------
  for (const [k, re, exts] of KIND_WORDS) {
    if (re.test(s)) {
      if (k === 'document' && plan.kinds.some((x) => ['pdf', 'word', 'sheet', 'slides', 'screenplay'].includes(x))) { s = s.replace(re, ' '); continue; }
      if (!plan.kinds.includes(k)) plan.kinds.push(k);
      if (!(k === 'installer' && plan.exts.some((e) => exts.includes(e)))) exts.forEach((e) => plan.exts.includes(e) || plan.exts.push(e));
      s = s.replace(re, ' ');
    }
  }
  if (plan.excludeExts) plan.exts = plan.exts.filter((e) => !plan.excludeExts.includes(e));
  if (plan.kinds.includes('screenshot')) plan.nameHint = ['screenshot', 'screen shot', 'capture', 'snip'];
  // ---------- topic: whatever meaningful words are left ----------
  s = s.replace(/\([^)]*\)/g, ' ');
  take(/\b(?:inside the (?:text|files?|documents?|contents?)|in (?:the|their|its) (?:text|contents?)|inside (?:them|it))\b/, () => { plan.inside = true; });
  take(/\b(?:about|regarding|related to|concerning|on the subject of|mentioning|mention|containing|contains?|that mention|that contains?|with the word|for the (?:key|word|phrase|text|string|term)|named|called|titled)\s+(.+)$/, (m) => { plan.topic.push(...words(m[1])); plan.inside = plan.inside || /about|regarding|related|concerning|mention|contain|for the/.test(m[0]); });
  if (/\b(?:mention|contain|for the (?:key|word|phrase))/.test(raw.toLowerCase()) || /\binside (?:the )?(?:text|contents?)\b/i.test(raw)) plan.inside = true;
  // a key like apiKey: keep its capitals for the content search
  const keyM = /\bfor the (?:key|word|phrase|term|string)\s+["'“‘]?([\w.$-]+)/i.exec(rawWork);
  if (keyM) { plan.contentText = keyM[1].replace(/[.,;:!?]+$/, ''); plan.inside = true; }
  if (plan.duplicates && plan.action === 'group') { plan.action = 'find'; delete plan.groupBy; }
  if (plan.action === 'rename' && /\bextensions?\b/.test(raw.toLowerCase()) && plan.exts.length > 1) plan.newExt = plan.exts.pop();
  s = s.replace(/\b(?:drop ?)?shelf\b/g, ' ');
  plan.topic.push(...words(s), ...plan.quoted);
  plan.topic = [...new Set(plan.topic)].filter((w) => !(plan.dest && plan.dest.toLowerCase().includes(w)));
  if (plan.action === 'rename' && plan.renameMode !== 'content') plan.topic = plan.topic.filter((w) => !plan.quoted.includes(w));
  if (plan.action === 'rename') { plan.topic = []; delete plan.after; delete plan.before; delete plan.createdAfter; delete plan.createdBefore; }
  if (plan.action === 'group' && !plan.scope) plan.scope = hasSelection ? 'selection' : 'here';
  if (['rename', 'move', 'copy', 'delete', 'zip', 'tag', 'shelf'].includes(plan.action) && !plan.scope && hasSelection && !plan.topic.length && !plan.kinds.length && !plan.exts.length && !plan.emptyDirs) plan.scope = 'selection';
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
  const kinds = p.kinds.length ? p.kinds.map((k) => ({ pdf: 'PDFs', word: 'Word documents', sheet: 'spreadsheets', slides: 'presentations', screenplay: 'screenplays', document: 'documents', ebook: 'e-books', screenshot: 'screenshots', image: 'pictures', video: 'videos', audio: 'songs', installer: 'installers', archive: 'zip files', code: 'code files', text: 'text files', font: 'fonts', markdown: 'Markdown files', config: 'settings files', temp: 'temporary files', log: 'log files' }[k] || k)).join(' and ') : p.exts?.length ? p.exts.map((e) => '.' + e).join(' / ') + ' files' : 'files';
  return kinds;
}
