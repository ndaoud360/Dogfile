// Requests that name a Dogfile action rather than a set of files to find: settings ("dark mode", "show hidden
// files"), tools ("open the treemap", "terminal here"), history and versions, archives, tags and notes, macros,
// connections, features… matchIntent() says which one and with what details; assistant.js carries it out.
// Pure (no DOM): tested by build/test-assistant-files.mjs.

const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, single: 1, dual: 2, a: 1, an: 1 };
const num = (s) => (s == null ? null : /^\d+(\.\d+)?$/.test(s) ? +s : NUMW[String(s).toLowerCase()] ?? null);
const COLORS = 'red|orange|yellow|green|blue|purple|gr[ae]y';
const quoted = (t) => [...String(t).matchAll(/["“]([^"”]+)["”]|(?:^|\s)['‘]([^'’]+)['’](?=\s|$|[,.;:!?])/g)].map((m) => (m[1] ?? m[2]).trim());

// "every Friday at 5 PM", "daily at 8:30", "every 30 minutes", "whenever new files land in my Inbox folder"
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function parseSchedule(t) {
  const s = String(t).toLowerCase();
  const at = (() => { const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(s) || /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/.exec(s); if (!m) return null; let h = +m[1]; const mi = +(m[2] || 0); if (/^p/.test(m[3] || '') && h < 12) h += 12; if (/^a/.test(m[3] || '') && h === 12) h = 0; return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; })();
  const folder = /\b(?:whenever|when)\s+(?:new\s+)?files?\s+(?:land|arrive|appear|come|are added|show up)s?\s+in\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s*(?:\)|$|[.;,])/.exec(s);
  const day = DAYS.findIndex((d) => new RegExp(`\\b(?:every|each|on)\\s+${d}s?\\b|\\b${d}s\\b`).test(s));
  if (day >= 0) return { type: 'schedule', mode: 'weekly', day, at: at || '09:00', folder: folder?.[1] };
  if (/\b(every ?day|daily|each day|every morning|every evening|every night)\b/.test(s)) return { type: 'schedule', mode: 'daily', at: at || (/\bmorning\b/.test(s) ? '08:00' : /\bevening|night\b/.test(s) ? '20:00' : '09:00'), folder: folder?.[1] };
  const ev = /\bevery\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|thirty)?\s*(minutes?|mins?|hours?|hrs?)\b/.exec(s);
  if (ev) { const n2 = num(ev[1] || '1') || { fifteen: 15, thirty: 30 }[ev[1]] || 1; return { type: 'schedule', mode: 'every', minutes: /^h/.test(ev[2]) ? n2 * 60 : n2, folder: folder?.[1] }; }
  if (folder) return { type: 'folder', folderName: folder[1] };
  if (/\b(at|when) (?:dogfile )?start(?:s|up)\b|\bon startup\b/.test(s)) return { type: 'startup' };
  return null;
}

// "whenever a .zip arrives, move it to Archives; whenever a .dmg or .exe arrives, tag it Red",
// "recycle .log files once they are older than 14 days"
export function parseAutomation(text) {
  const rules = [];
  const parts = String(text).split(/;|\.\s+|\bwhenever\b|\band also\b|\balso\b/i).map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    const s = p.toLowerCase();
    const conds = [];
    const exts = [...s.matchAll(/(?:^|\s)\*?\.([a-z0-9]{1,8})\b/g)].map((m) => m[1]);
    if (exts.length) conds.push({ field: 'ext', value: exts.join(', ') });
    const kind = /\b(pictures?|photos?|images?)\b/.test(s) ? 'Pictures' : /\b(videos?|movies?)\b/.test(s) ? 'Videos' : /\b(songs?|music|audio)\b/.test(s) ? 'Music' : /\b(pdfs?|documents?|docs)\b/.test(s) ? 'Documents' : /\b(installers?|setups?)\b/.test(s) ? 'Installers' : /\b(archives?|zips?)\b/.test(s) && !exts.length ? 'Archives' : null;
    if (kind && !exts.length) conds.push({ field: 'kind', value: kind });
    const age = /\bolder than\s+(\d+)\s*(day|week|month|year)s?\b/.exec(s);
    if (age) conds.push({ field: 'age', op: '>', num: +age[1] * { day: 1, week: 7, month: 30, year: 365 }[age[2]] });
    const big = /\b(?:bigger|larger|over|more) than\s+(\d+)\s*(kb|mb|gb)\b/.exec(s);
    if (big) conds.push({ field: 'size', op: '>', num: +big[1], unit: big[2].toUpperCase() });
    const named = /\b(?:named|called|with)\s+["“']([^"”']+)["”']|\bname contains\s+["“']?([\w -]+)/.exec(p);
    if (named) conds.push({ field: 'name', value: (named[1] || named[2]).trim() });
    let action = null, m;
    if ((m = /\b(?:move|put|send|file)\s+(?:it|them|those|these|the files?)?\s*(?:to|into)\s+(?:the\s+|my\s+|a\s+)?["“']?([^,;"”']+?)["”']?(?:\s+folder)?\s*$/i.exec(p))) action = { type: 'move', target: m[1].trim() };
    else if ((m = /\bcopy\s+(?:it|them|those|these|the files?)?\s*(?:to|into)\s+(?:the\s+|my\s+)?["“']?([^,;"”']+?)["”']?(?:\s+folder)?\s*$/i.exec(p))) action = { type: 'copy', target: m[1].trim() };
    else if ((m = new RegExp(`\\b(?:tag|label|mark)\\s+(?:it|them|those|these)?\\s*(?:as\\s+)?(${COLORS})\\b`, 'i').exec(p))) action = { type: 'tag', tag: m[1].toLowerCase().replace('grey', 'gray') };
    else if (/\b(recycle|recycles|delete|deletes|trash|remove|removes|bin)\b/.test(s)) action = { type: 'recycle' };
    else if (/\bsort\b.*\bby (?:type|kind)\b/.test(s)) action = { type: 'byKind' };
    else if (/\bsort\b.*\bby month\b/.test(s)) action = { type: 'byMonth' };
    else if (/\bsort\b.*\bby year\b/.test(s)) action = { type: 'byYear' };
    if (action && (conds.length || /\b(any|every|all)\s+(new\s+)?files?\b/.test(s))) rules.push({ on: true, match: 'all', conditions: conds.length ? conds : [{ field: 'any' }], action });
  }
  return rules;
}

const R = (re) => (t) => re.exec(t);
// [id, test (text, lower) → args or null]; first match wins, so the specific ones come first
const INTENTS = [
  // ---------- questions about Dogfile itself go to the help, even when they name a feature ----------
  ['help', (t, s) => (/^\s*(how (?:do|can|should) i|what(?:'s| is) the (?:keyboard )?shortcut|why (?:did|does|is|isn'?t|won'?t|can'?t)|what does|where (?:is|do i find)|is there a way|can i)\b/.test(s) && !/\b(write|create|make|build)\b.*\b(dogmod|feature)\b/.test(s) ? {} : null)],
  // ---------- features you write yourself ----------
  ['checkFeature', (t, s) => (/\b(check|review|lint|validate|look at|fix)\b.*\b(\.?dogmod|feature|script|extension)\b/.test(s) && /\b(permission|header|missing|error|wrong|work)\b/.test(s) ? { api: (/\b((?:atlas|dogfile)\.[\w.]+)/i.exec(t) || [])[1] || null } : null)],
  ['writeFeature', (t, s) => (/\b(write|make|create|build|generate|code)\b.*\b(\.?dogmod|feature|extension|plugin|add-?on)\b/.test(s) ? { text: t } : null)],
  // ---------- appearance & settings ----------
  ['glass', (t, s) => (/\b(glass|aero|frosted|translucent|see-?through)\b.*\bsidebar\b|\bsidebar\b.*\b(glass|aero|frosted|transparent|translucent)\b|\bliquid glass\b/.test(s) ? { on: !/\b(off|disable|remove|turn off|stop|no more|without)\b/.test(s) } : null)],
  ['theme', (t, s) => { const m = /\b(dark|light|system)\s*(?:mode|theme)\b|\b(?:theme|mode)\s+(?:to\s+)?(dark|light|system)\b|\b(?:go|switch|turn)\s+(dark|light)\b/.exec(s); return m ? { theme: m[1] || m[2] || m[3] } : null; }],
  ['density', (t, s) => { const m = /\b(touch|compact|comfortable|automatic)\s+(?:mode|density|rows|layout)\b|\bdensity\s+(?:to\s+)?(touch|compact|comfortable|automatic)\b/.exec(s); return m ? { density: (m[1] || m[2]).replace('automatic', 'auto') } : null; }],
  ['uiMode', (t, s) => { if (!/\b(simple|full)\s+mode\b/.test(s)) return null; const m = /\bto\s+(?:the\s+)?(simple|full)\s+mode\b/.exec(s) || /\b(simple|full)\s+mode\b/.exec(s); return { mode: m[1] }; }],
  ['workspace', (t, s) => { if (!/\bworkspaces?\b/.test(s)) return null; const name = quoted(t)[0] || (/\bworkspace\s+(?:called|named)\s+([\w -]+)/i.exec(t) || [])[1]?.trim() || null; return { save: /\b(save|store|keep|remember|create|make)\b/.test(s), name }; }],
  ['profile', (t, s) => { if (!/\bprofiles?\b/.test(s)) return null; const names = quoted(t); const m = /\b(?:switch|change|go|use)\s+(?:to\s+)?(?:the\s+|my\s+)?([\w ]+?)\s+profile\b/i.exec(t) || /\bprofile\s+(?:called\s+|named\s+)?["“']?([\w ]+)/i.exec(t); return { name: names[0] || m?.[1]?.trim() || null, alts: names.slice(1) }; }],
  ['layout', (t, s) => {
    const m = /\b(\d|one|two|three|four|single|dual)[- ]?panes?\b/.exec(s) || /\b(split|side by side|stacked)\s+(?:view|panes?)\b/.exec(s);
    const sync = /\bsync(?:ed|hroni[sz]ed|hronised)?\s+(?:brows|navigat)/.test(s);
    if (!m && !sync) return null;
    const n = m ? (num(m[1]) || (/split|side|stacked/.test(m[1]) ? 2 : null)) : null;
    return { panes: n, stacked: /\bstacked|top and bottom|above\b/.test(s), sync: sync ? !/\b(off|stop|turn off|disable)\b.*\bsync|\bsync\w*\s+\w+\s+off\b/.test(s) : null, view: (/\b(grid|list|details|gallery|columns)\s+(?:view|layout)\b/.exec(s) || [])[1] || null };
  }],
  ['view', (t, s) => { const m = /\b(?:switch|change|go|set)\b.*\b(?:to\s+)?(grid|list|details|gallery|columns)\s+view\b|^\s*(grid|list|details|gallery|columns)\s+view\b/.exec(s); return m ? { view: m[1] || m[2] } : null; }],
  ['toggles', (t, s) => {
    if (!/\b(turn on|turn off|show|hide|enable|disable|display|stop showing|switch on|switch off)\b/.test(s)) return null;
    const set = {};
    const off = (key) => new RegExp(`\\b(hide|turn off|disable|stop showing|switch off|don'?t show)\\b[^.;]*?${key}|${key}[^.;]*?\\b(off|hidden)\\b`).test(s);
    if (/\bhidden (?:files|items|folders)\b/.test(s)) set.showHidden = !off('hidden');
    if (/\b(?:file )?extensions\b/.test(s)) set.showExtensions = !off('extensions');
    if (/\bfolder sizes?\b|\bsize badges\b|\bsizes? of (?:every )?(?:sub)?folders?\b/.test(s)) set.folderSizes = !off('(?:folder )?size');
    if (/\bcheck ?boxes\b/.test(s)) set.checkboxes = !off('check ?boxes');
    if (/\bstatus bar\b/.test(s)) set.showStatusBar = !off('status bar');
    if (/\bpreview (?:pane|panel)\b/.test(s)) set.showPreview = !off('preview');
    if (/\bprotected (?:system|operating system) files\b|\bsystem files\b/.test(s)) set.showSystem = !off('system files');
    if (/\bthumbnails\b/.test(s)) set.thumbnails = !off('thumbnails');
    return Object.keys(set).length ? { set } : null;
  }],
  ['exportSettings', (t, s) => (/\b(export|back ?up|save|copy)\b.*\b(settings|preferences|config(?:uration)?)\b/.test(s) && !/\bimport\b/.test(s) ? {} : null)],
  ['importSettings', (t, s) => (/\b(import|restore|load|bring in)\b.*\b(settings|preferences)\b/.test(s) ? {} : null)],
  // ---------- connections, cloud, macros, automations, collections ----------
  ['connect', (t, s) => {
    const cloud = /\b(google drive|gdrive|onedrive|one drive|dropbox|amazon s3|s3|wasabi|backblaze|r2)\b/.exec(s);
    if (cloud && /\b(add|connect|link|sign in|set up|mount|account|use)\b/.test(s)) return { type: { 'google drive': 'gdrive', gdrive: 'gdrive', onedrive: 'onedrive', 'one drive': 'onedrive', dropbox: 'dropbox' }[cloud[1]] || 's3', cloudOnlyNote: /\bcloud-?only|un-?downloaded|without (?:downloading|installing)/.test(s) };
    const srv = /\b(sftp|ftps?|webdav|smb|nas|network share|windows share|server)\b/.exec(s);
    if (srv && /\b(connect|add|mount|map|set up|open)\b/.test(s)) return { type: { sftp: 'sftp', ftp: 'ftp', ftps: 'ftp', webdav: 'webdav' }[srv[1]] || 'smb', both: /\bsmb\b.*\b(or|and)\b.*\bsftp\b|\bsftp\b.*\b(or|and)\b.*\bsmb\b/.test(s) };
    return null;
  }],
  ['macro', (t, s) => (/\bmacros?\b/.test(s) && /\b(record|start|make|create|new)\b/.test(s) ? { trigger: parseSchedule(t) } : /\bmacros?\b/.test(s) ? { manage: true } : null)],
  ['automation', (t, s) => (/\bautomation\b|\bwhenever\b.*\b(arrives?|lands?|appears?|comes? in|is added|shows? up|download(?:s|ed)?)\b|\bautomatically\s+(?:move|sort|tag|recycle|delete|file)\b|\b(?:recycles?|deletes?)\b.*\bonce they(?:'re| are) older than\b/.test(s) ? { rules: parseAutomation(t) } : null)],
  ['collection', (t, s) => {
    if (!/\b(smart collection|saved search|collection)\b/.test(s) || !/\b(create|make|add|new|set up|save)\b/.test(s)) return null;
    const tags = quoted(t);
    const cols = [...s.matchAll(new RegExp(`\\btagged\\s+(${COLORS})\\b`, 'g'))].map((m) => m[1]);
    const stars = /\b(?:rated|rating(?: of)?)\s+(\d|one|two|three|four|five)(?:\s*(?:\+|or more|or higher|and up))?\s*(?:-?\s*stars?)?|(\d|one|two|three|four|five)[- ]stars?\b/.exec(s);
    return { tags: [...tags, ...cols], stars: stars ? num(stars[1] || stars[2]) : null, any: /\bor\b/.test(s) };
  }],
  // ---------- tags, ratings, notes, properties ----------
  ['writeTags', (t, s) => (/\b(write|save|store|put|copy|sync)\b.*\btags?\b.*\b(into|in|to|inside)\b.*\b(files?|windows|explorer|properties|metadata)\b|\bso (?:file )?explorer can see\b/.test(s) ? {} : null)],
  ['autoTag', (t, s) => (/\bauto-?(?:matically )?tag/.test(s) ? {} : null)],
  ['rate', (t, s) => {
    const st = /\b(\d|one|two|three|four|five|zero|no)[- ]?stars?\b|\brat(?:e|ing)\s+(?:of\s+|it\s+|them\s+)?(\d|one|two|three|four|five)\b/.exec(s);
    const lb = new RegExp(`\\b(${COLORS}|pink|teal)\\s+(?:colou?r\\s+)?label\\b|\\blabel\\s+(?:it\\s+|them\\s+)?(${COLORS}|pink|teal)\\b`).exec(s);
    if (!st && !lb) return null;
    return { stars: st ? (/no|zero/.test(st[1] || '') ? 0 : num(st[1] || st[2])) : null, label: lb ? (lb[1] || lb[2]).replace('grey', 'gray') : null };
  }],
  ['folderNote', (t, s) => { if (!/\bfolder note\b|\bnote (?:to|at) the top of (?:this|the) (?:folder|directory|project)/.test(s)) return null; const m = /\b(?:with|saying|that says|containing|:)\s*(?:a\s+)?(?:to-?do\s+)?(?:check ?list|list)?\s*:?\s*(.+)$/i.exec(t); const body = m ? m[1] : ''; const items = [...body.matchAll(/\[\s*[xX ]?\s*\]\s*([^,;\[\]]+)/g)].map((x) => x[1].trim().replace(/\.$/, '')); return { items, text: items.length ? '' : body.replace(/\.$/, '').trim() }; }],
  ['note', (t, s) => { if (!/\b(add|put|write|attach|leave)\s+(?:a\s+|this\s+)?(?:personal\s+)?note\b|\bnote (?:on|to) (?:this|the|these)\b/.test(s) || /\bfolder note\b/.test(s)) return null; const q = quoted(t)[0]; const m = /\b(?:saying|that says|with the text|reading|:)\s*["“']?(.+?)["”']?\s*\.?$/i.exec(t); return { text: q || m?.[1]?.trim() || '' }; }],
  ['docProps', (t, s) => (/\b(change|edit|set|update|fix)\b.*\b(author|title|subject|company|keywords|comments?|manager|category)\b/.test(s) && /\b(propert|metadata|details|docx?|word|pdf|documents?|files?)\b/.test(s) && !/\bsong|mp3|music|album|artist\b/.test(s) ? { fields: [...s.matchAll(/\b(author|title|subject|company|keywords|comments?|manager|category)\b/g)].map((m) => m[1]) } : null)],
  ['songDetails', (t, s) => (/\bacoustid\b|\bidentify\b.*\b(song|audio|track|music|by (?:its )?sound)\b|\bwhat song is (?:this|that)\b/.test(s) ? { identify: true } : /\b(auto-?fill|fill in|look up|find|get|fix|add|download)\b.*\b(artist|album|cover(?: art)?|song details|song info|track info|metadata|id3)\b|\bmusicbrainz\b|\bitunes\b.*\b(tags?|details|info)\b/.test(s) ? { identify: false } : null)],
  ['analyzeAudio', (t, s) => (/\b(analy[sz]e|detect|work out|calculate|get|find)\b.*\b(bpm|tempo)\b.*\bkeys?\b|\b(analy[sz]e|detect)\b.*\b(bpm|tempo|musical key)\b/.test(s) && !/\b(around|about|near)\s+\d|\d+\s*bpm\b|\bkey of\b/.test(s) ? {} : null)],
  // ---------- archives ----------
  ['archiveDelete', (t, s) => { const m = /\b(?:delete|remove|take out|drop)\s+(?:the\s+)?["“']?([^"”']+?)["”']?\s+(?:file\s+|folder\s+)?(?:from\s+)?(?:inside|in|within|out of|from)\s+(?:this|the|that)\s+(?:\.?(?:zip|7z|rar|tar|archive))\b/i.exec(t); return m ? { name: m[1].replace(/\s+file$/i, '').trim() } : null; }],
  ['convertArchive', (t, s) => { const m = /\bconvert\b.*\b(?:rar|zip|7z|tar|archive|iso)\b.*\b(?:to|into)\s+(?:an?\s+)?\.?(7z|zip|tar\.gz|tgz|tar)\b/.exec(s); return m ? { format: m[1] === 'tgz' ? 'tar.gz' : m[1] } : null; }],
  ['testArchive', (t, s) => (/\btest\b.*\b(archive|zip|rar|7z|iso)\b|\b(check|verify|make sure)\b.*\b(archive|zip|rar|7z)\b.*\b(corrupt|broken|ok|damaged|fine)\b/.test(s) ? {} : null)],
  ['extract', (t, s) => (/\b(extract|unzip|unpack|decompress|unrar|open up)\b/.test(s) && !/\b(text|ocr|audio|sound|emails?|urls?|links|numbers)\b/.test(s) ? { ownFolder: /\b(own|separate|clean|new|its|their)\s+(?:clean\s+)?folders?\b/.test(s), here: /\bhere\b|\bthis folder\b/.test(s) && !/\bown\b/.test(s) } : null)],
  ['renamePreset', (t, s) => (/\b(save|store|keep|remember)\b.*\brename\b.*\b(preset|pattern|template)\b|\brename (?:studio )?presets?\b/.test(s) ? {} : null)],
  // ---------- versions, history, checksums ----------
  ['trackVersions', (t, s) => (/\b(automatic|auto)(?:matic)?\s+version|\bversion (?:tracking|history)\b.*\b(on|turn|start|enable)|\bevery (?:save|change) (?:is |gets )?(?:backed up|saved|kept)\b|\bkeep (?:a )?versions? (?:of|automatically|every)/.test(s) ? { on: !/\b(off|stop|disable)\b/.test(s) } : null)],
  ['restoreVersion', (t, s) => (/\b(restore|go back to|roll back|revert to|bring back)\b.*\b(version|copy)\b/.test(s) ? { when: t } : null)],
  ['snapshot', (t, s) => (/\b(save|take|make|create|keep)\s+(?:a\s+)?(?:snapshot|version|backup|restore point|copy of the current version)\b/.test(s) && !/\bevery\b/.test(s) ? { note: quoted(t)[0] || (/\bbefore\s+i\s+(?:edit|change|work on|modify)/i.test(t) ? 'Before editing' : /\bbefore\s+(.+?)[.?!]?$/i.exec(t)?.[1] ? `Before ${/\bbefore\s+(.+?)[.?!]?$/i.exec(t)[1]}` : '') } : null)],
  ['makeChecksums', (t, s) => (/\b(generate|create|make|write|compute|calculate)\b.*\b(\.?sha-?256|\.?sha-?1|\.?md5|checksums?|hash(?:es)? file)\b/.test(s) && !/\bverify|check if\b/.test(s) ? { algo: /md5/.test(s) ? 'md5' : /sha-?1\b/.test(s) ? 'sha1' : 'sha256' } : null)],
  ['verifyChecksums', (t, s) => (/\b(verify|check|validate)\b.*\b(\.?sha-?256|\.?sha-?1|\.?md5|checksums?|hashes)\b|\b(altered|tampered with)\b/.test(s) ? {} : null)],
  ['history', (t, s) => {
    if (!/\b(history|undo the|undo my|put back the|reverse the)\b/.test(s)) return null;
    const what = (/\b(rename|move|copy|delete|recycle|trash)\w*/.exec(s.replace(/^.*?\b(?:undo|put back|reverse)\b/, '')) || [])[1] || null;
    const ago = /\b(\d+|an?|one|two|three|five|ten|twenty|thirty)\s*(minutes?|mins?|hours?|hrs?)\s+ago\b/.exec(s);
    const mins = ago ? (num(ago[1]) || { twenty: 20, thirty: 30 }[ago[1]] || 1) * (/^h/.test(ago[2]) ? 60 : 1) : null;
    return { undo: /\b(undo|put back|reverse)\b/.test(s), what: what ? { renam: 'renamed', rename: 'renamed', mov: 'moved', move: 'moved', cop: 'created', copy: 'created', delet: 'trashed', delete: 'trashed', recycl: 'trashed', recycle: 'trashed', trash: 'trashed' }[what.replace(/(ed|ing|e)$/, '')] || { rename: 'renamed', move: 'moved', copy: 'created', delete: 'trashed', recycle: 'trashed', trash: 'trashed' }[what] || null : null, folder: /\bfolder\b/.test(s), minutesAgo: mins, today: /\btoday\b/.test(s) };
  }],
  ['whoLocks', (t, s) => (/\b(what|which)\b.*\b(program|process|app|application)\b.*\b(locking|using|has .* open|holding|blocking)\b|\bwho(?:'s| is) (?:locking|using)\b|\bwhat'?s (?:locking|using)\b|\bin use by\b/.test(s) ? {} : null)],
  // ---------- pictures, songs & videos ----------
  ['similarTo', (t, s) => (/\b(?:look|looks|looking)\s+(?:like|similar to)\s+(?:this|these|the selected|that|the one)|\bsimilar to (?:this|these|the selected)\b|\blike this (?:one|picture|photo|image|video|song)\b/.test(s) ? {} : null)],
  ['similarPics', (t, s) => (/\bsimilar(?:[- ]looking)?\s+(?:burst\s+)?(?:photos|pictures|images|shots|pics)\b|\bburst (?:photos|shots|pictures)\b|\bnear[- ]duplicates?\b|\bphotos that look (?:alike|the same)\b/.test(s) ? {} : null)],
  ['similarMedia', (t, s) => (/\bsimilar\s+(?:videos|songs|music|tracks|clips)\b/.test(s) ? {} : null)],
  ['classifyPics', (t, s) => (/\bscreenshots?\b.*\b(?:vs\.?|versus|from|or|and)\b.*\bcamera\b|\b(?:sort|split|separate|tell apart|classify|which are)\b.*\bscreenshots?\b.*\b(photos|artwork)\b/.test(s) ? {} : null)],
  ['convertImages', (t, s) => { const m = /\b(?:convert|change|turn|save|export|batch convert)\b.*\b(?:png|webp|jpe?g|gif|bmp|heic|tiff?|images?|pictures?|photos?|screenshots?)\b.*\b(?:to|into|as)\s+(?:an?\s+)?\.?(jpe?g|png|webp)\b/.exec(s); return m && !/\bextensions?\b/.test(s) && (/\b(all|every|batch|these|the selected|folder|them)\b/.test(s)) ? { format: m[1].replace('jpeg', 'jpg'), maxSide: +(/\b(\d{3,5})\s*(?:px|pixels)\b/.exec(s) || [])[1] || 0 } : null; }],
  ['convertMedia', (t, s) => { const m = /\b(?:convert|change|turn|transcode|export|re-?encode)\b.*\b(?:flac|wav|m4a|mp3|ogg|aac|wma|opus|audio|songs?|music|tracks?|videos?|mkv|avi|mov|wmv|webm|mp4)\b.*\b(?:to|into|as)\s+(?:(\d{2,3})\s*k(?:bps|b\/s)?\s+)?\.?(mp3|flac|wav|m4a|aac|ogg|opus|mp4|mkv|mov|webm)\b/.exec(s); return m && /\b(all|every|batch|these|the selected|folder|them)\b/.test(s) ? { format: m[2] === 'aac' ? 'm4a' : m[2], bitrate: +(m[1] || (/\b(\d{2,3})\s*kbps\b/.exec(s) || [])[1] || 0) } : null; }],
  ['transformPics', (t, s) => (/\b(rotate|flip|mirror)\b/.test(s) && /\b(these|the selected|all|every|selected|photos|pictures|images)\b/.test(s) ? { rotate: /\b(?:counter-?|anti-?)clockwise|left\b/.test(s) ? -90 : /\b180\b|upside down/.test(s) ? 180 : /\brotate\b/.test(s) ? 90 : 0, flipH: /\b(?:flip|mirror)\b.*\b(horizontal|horizontally|left to right|sideways)\b|\bmirror\b(?!.*vertical)/.test(s) || (/\bflip\b/.test(s) && !/\bvertical/.test(s)), flipV: /\b(?:flip|mirror)\b.*\b(vertical|vertically|upside down|top to bottom)\b/.test(s) } : null)],
  ['contactSheet', (t, s) => (/\bcontact sheets?\b|\bthumbnail (?:grid|sheet)\b|\bstoryboard\b/.test(s) ? {} : null)],
  ['transcript', (t, s) => (/\btranscri(?:be|pt|ption)|\bspeech[- ]to[- ]text\b|\bsubtitles? (?:for|from)\b/.test(s) && !/\bdelay|shift|earlier|later\b/.test(s) ? {} : null)],
  // ---------- disk space ----------
  ['analyze', (t, s) => (/\b(disk space analy[sz]er|space analy[sz]er|treemap|tree map|analy[sz]e (?:the |my )?(?:disk|drive|storage)?\s*space|what(?:'s| is) (?:taking|using) (?:up )?(?:all )?(?:the |my )?space)\b/.test(s) ? {} : null)],
  ['selSize', (t, s) => (/\b(?:total |exact |combined )?size of (?:the |all |my |these )?(?:files? |items? |folders? )?(?:(?:that )?i(?:'ve| have)? )?selected\b|\bhow (?:big|large) (?:is|are) (?:the |my )?(?:selected|selection)\b|\bselection(?:'s)? (?:total )?size\b|\bcalculate (?:the )?(?:exact )?(?:total )?size\b/.test(s) ? {} : null)],
  ['cleanup', (t, s) => (/\bbreak(?:\s|-)?down\b.*\b(space|storage|size|disk)\b|\b(space|storage)\b.*\bby (?:file )?type and (?:age|date)\b|\bstorage cleanup\b|\bfree (?:up )?(?:some )?(?:disk )?space\b/.test(s) ? {} : null)],
  ['emptyRecycle', (t, s) => (/\bempty (?:my |the )?(?:recycle bin|trash|bin)\b/.test(s) ? {} : null)],
  // ---------- moving & linking ----------
  ['toOtherPane', (t, s) => { const m = /\b(copy|move)\b.*\bto the other (?:open |side |)?pane\b/.exec(s); return m ? { mode: m[1], conflict: /\bskip(?:ping)? identical\b.*\breplac\w* older|\breplac\w* older\b|\bonly (?:if|when) newer\b|\bnewer ones?\b/.test(s) ? 'newer' : /\bskip(?:ping)? identical\b/.test(s) ? 'skipIdentical' : /\bkeep(?:ing)? both\b/.test(s) ? 'keepBoth' : /\bskip(?:ping)? (?:existing|duplicates)\b/.test(s) ? 'skip' : /\b(?:replac|overwrit)\w* (?:all|existing|everything)\b/.test(s) ? 'replace' : null } : null; }],
  ['symlink', (t, s) => (/\b(symbolic link|symlink|soft link|junction|hard link)\b/.test(s) ? { where: /\bdesktop\b/.test(s) ? 'desktop' : /\bother pane\b/.test(s) ? 'other' : /\bdocuments\b/.test(s) ? 'documents' : null } : null)],
  ['declutter', (t, s) => (/\bdeclutter\b|\btidy (?:up )?(?:this|the current|this messy|my messy|the messy)?\s*(?:messy\s+)?(?:folder|directory|mess)\b|\btidy up\b.*\b(preview|reasons|where everything)\b/.test(s) && !/\b(downloads|desktop|documents|pictures|music|videos)\b/.test(s) ? {} : null)],
  ['viewGroup', (t, s) => { const m = /\bgroup\s+(?:this|the|my|the current)\s+(?:view|list|folder view)\s+by\s+(?:file\s+)?(\w+)|\bgroup\s+(?:these\s+|the\s+|my\s+)?(?:files\s+)?by\s+(tags?|colou?r tags?)\b|\b(?:ungroup|stop grouping|group(?:ing)? off)\b/.exec(s); if (!m) return null; const w = m[1] || m[2] || 'none'; return { by: /kind|type|ext/.test(w) ? 'type' : /date|month|time|modif/.test(w) ? 'date' : /size/.test(w) ? 'size' : /tag|colou?r/.test(w) ? 'tag' : /name|letter/.test(w) ? 'name' : 'none', alsoTag: /\bby tags?\b/.test(s) && !!m[1] }; }],
  ['flatten', (t, s) => (/\bflatten\b|\b(?:every|all) files? (?:inside|in|from) (?:all )?(?:the )?sub ?folders? in (?:a |one )?(?:single )?(?:list|view)\b/.test(s) ? {} : null)],
  // ---------- terminal, scripts, git, editors ----------
  ['adminShell', (t, s) => (/\b(admin(?:istrator)?|elevated)\b.*\b(powershell|terminal|command prompt|cmd|shell|console)\b|\b(powershell|terminal|command prompt|cmd)\b.*\bas (?:an? )?admin/.test(s) ? { kind: /\bpowershell\b/.test(s) ? 'powershell' : /\bcmd|command prompt\b/.test(s) ? 'cmd' : null } : null)],
  ['runScript', (t, s) => (/\brun\b.*\b(\.?ps1|\.?py|\.?bat|\.?cmd|\.?sh|\.?js|scripts?|this file|the selected file)\b/.test(s) && !/\bmacro\b/.test(s) ? {} : null)],
  ['terminal', (t, s) => (/\b(open|show|toggle|start|launch|bring up)\b.*\b(terminal|powershell|command prompt|console|cmd)\b|^\s*terminal\b/.test(s) ? { drawer: !/\bwindow\b/.test(s) || /\b(drawer|built-?in|inside|panel)\b/.test(s), kind: /\bpowershell\b/.test(s) ? 'powershell' : /\bcommand prompt|cmd\b/.test(s) ? 'cmd' : null } : null)],
  ['copyPaths', (t, s) => (/\bcopy\b.*\bpaths?\b|\bpaths?\b.*\bto (?:the )?clipboard\b/.test(s) ? { fmt: /\bjson\b/.test(s) && !/\bor as a json\b/.test(s) ? 'json' : /\bforward[- ]?slash|unix|posix|\/\b/.test(s) ? 'forward' : /\bquoted|in quotes\b/.test(s) ? 'quoted' : /\bnames? only|just the names?\b/.test(s) ? 'names' : 'path', alts: [/\bjson\b/.test(s) && 'json', /\bquoted\b/.test(s) && 'quoted'].filter(Boolean) } : null)],
  ['gitStatus', (t, s) => (/\buncommitted\b|\bgit status\b|\b(?:git|repo(?:sitory)?)\b.*\b(changed|changes|modified|status|dirty)\b/.test(s) ? {} : null)],
  ['codeEditor', (t, s) => (/\b(open|edit|show)\b.*\b(code editor|vs ?code|visual studio code|cursor|sublime|notepad\+\+|my editor|an ide)\b/.test(s) ? {} : null)],
  ['hex', (t, s) => (/\bhex(?:adecimal)?\b|\bbinary view\b|\bhex ?dump\b|\braw bytes\b/.test(s) ? {} : null)],
  ['compare', (t, s) => (/\b(compare|sync|mirror|synchroni[sz]e|diff)\b.*\b(folders?|backup|directories|with|against)\b/.test(s) && !/\bsync(?:ed|hroni[sz]ed)?\s+(?:brows|navigat)/.test(s) && !/\btext file\b|\.\w{2,5}\b(?!.*folder)/.test(s) ? { mirror: /\bmirror\b|\bleft to right\b|\bone[- ]way\b/.test(s), rightToLeft: /\bright to left\b/.test(s) } : null)],
];

/** the details of one intent (by id) read from text: the model picked the feature, this reads its specifics */
export function intentParams(id, text) {
  const t = String(text || '').trim();
  const s = ' ' + t.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'") + ' ';
  const it = INTENTS.find(([k]) => k === id);
  return (it && it[1](t, s)) || {};
}
export function matchIntent(text) {
  const t = String(text || '').trim();
  // file names (History.txt, "Macros list.docx") are files, not features: hidden from the feature words
  const s = ' ' + t.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/"[^"]+\.[a-z0-9]{1,5}"|'[^']+\.[a-z0-9]{1,5}'|\b[\w()&+-]+(?: [\w()&+-]+){0,3}\.(?!com\b|net\b|org\b)[a-z][a-z0-9]{0,4}\b/g, (m) => (/^\.?(dogmod|sha256|sha1|md5|ps1|py|bat|cmd|sh|js)$/.test(m.slice(m.lastIndexOf('.'))) || /^(?:the |a |an )?\.?[a-z0-9]{1,5}$/.test(m) ? m : ' a-file ')) + ' ';
  for (const [id, test] of INTENTS) {
    const r = test(t, s);
    if (r) return { id, ...r };
  }
  return null;
}
// intents that also apply while Notepad, Photos or the Player is the tab (they're about files, not the open one)
export const OVER_APPS = new Set(['convertImages', 'convertMedia', 'glass', 'theme', 'density', 'uiMode', 'toggles', 'layout', 'profile', 'workspace', 'exportSettings', 'importSettings', 'connect', 'macro', 'automation', 'collection', 'history', 'emptyRecycle', 'analyze', 'cleanup', 'checkFeature', 'writeFeature', 'terminal', 'adminShell', 'compare', 'gitStatus']);
