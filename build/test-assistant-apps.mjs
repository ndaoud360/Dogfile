// node build/test-assistant-apps.mjs — checks how the assistant reads requests for Notepad, Photos and the Player
import { parseAppRequest, writingRequest } from '../src/renderer/js/assistant-apps.js';
const cases = [
  ['editor', 'Sort the lines and remove duplicates', ['lines:sortAsc', 'lines:unique']],
  ['editor', 'replace cats and dogs with birds', ['replace']],
  ['editor', 'Replace “colour” with “color”', ['replace']],
  ['editor', 'make it all uppercase', ['case:upper']],
  ['editor', 'remove empty lines then sort descending', ['lines:removeEmpty', 'lines:sortDesc']],
  ['editor', 'how many words?', ['count']],
  ['editor', 'how many times does hello appear', ['count']],
  ['editor', 'format the json', ['json']],
  ['editor', 'delete lines containing error', ['filterLines']],
  ['editor', 'keep only lines with TODO', ['filterLines']],
  ['editor', 'go to line 40', ['goto']],
  ['editor', 'add "- " to the start of every line', ['affix']],
  ['editor', 'number the lines', ['lines:number']],
  ['editor', 'clear everything', ['clear']],
  ['editor', 'turn on word wrap', ['wrap']],
  ['editor', 'set the language to python', ['lang']],
  ['editor', 'extract all emails', ['extract']],
  ['editor', 'join the lines with a comma', ['joinLines']],
  ['editor', 'split at commas', ['splitLines']],
  ['editor', 'capitalize each word', ['case:title']],
  ['editor', 'insert today\'s date', ['date']],
  ['editor', 'find hello', ['find']],
  ['editor', 'save', ['save']],
  ['editor', 'Remove trailing spaces and save', ['lines:trimTrailing', 'save']],
  ['viewer', 'Erase everything and apply sepia filter', ['resetAll', 'adjust']],
  ['viewer', 'Change photo size to 1920x1080', ['resize']],
  ['viewer', 'change the photo size to 800 wide', ['resize']],
  ['viewer', 'make it 50% smaller', ['resize']],
  ['viewer', 'crop to square', ['cropAspect', 'applyCrop']],
  ['viewer', 'make it brighter and add more contrast', ['adjust', 'adjust']],
  ['viewer', 'black and white', ['adjust']],
  ['viewer', 'rotate left then flip it', ['rotateL', 'flip']],
  ['viewer', 'apply the vintage filter', ['filter']],
  ['viewer', 'remove my drawing', ['clearDrawing']],
  ['viewer', 'save a copy as png', ['format', 'saveCopy']],
  ['viewer', 'resize to half', ['resize']],
  ['viewer', 'blur it a little', ['adjust']],
  ['player', 'play at 1.5x', ['speed']],
  ['player', 'skip 30 seconds', ['seek']],
  ['player', 'louder', ['volume']],
  ['player', 'go to 2:15', ['seek']],
  ['player', 'extract the audio', ['extract']],
  ['player', 'pause', ['pause']],
];
let bad = 0;
for (const [app, text, want] of cases) {
  const r = parseAppRequest(app, text);
  const got = r.steps.map((s) => s.op + (s.op === 'lines' ? ':' + s.arg.fn : s.op === 'case' ? ':' + s.arg.to : ''));
  const ok = JSON.stringify(got) === JSON.stringify(want) && !r.rest.length;
  if (!ok) { bad++; console.log('FAIL', app, JSON.stringify(text), '→', JSON.stringify(got), 'rest', JSON.stringify(r.rest), JSON.stringify(r.steps.map((s) => s.arg))); }
}
for (const [t, want] of [['fix the grammar', 'replace'], ['summarize this', 'answer'], ['write an email to my boss asking for friday off', 'insert'], ['sort the lines', null]]) {
  const w = writingRequest(t);
  if ((w?.mode ?? null) !== want) { bad++; console.log('FAIL writing', t, w); }
}
const r = parseAppRequest('editor', 'replace "a, b and c" with x');
if (r.steps[0]?.arg.find !== 'a, b and c') { bad++; console.log('FAIL quoted', JSON.stringify(r)); }
console.log(bad ? `${bad} failed` : `all ${cases.length + 5} passed`);
process.exit(bad ? 1 : 0);
