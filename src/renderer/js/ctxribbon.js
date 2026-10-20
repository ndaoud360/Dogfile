// Contextual ribbon tab next to View: Zip inside/for archives, Audio / Video / Pictures for selected media,
// and Editor / Audio for a built-in app open in a tab.
import { state, KINDS, dirname, basename } from './core.js';
import { activeTab, selectedItems, navigate } from './pane.js';
import * as A from './actions.js';
import { activeAppTab, appCmd } from './apptabs.js';
import { convertMedia, analyzeDialog, convertImages, setWallpaper } from './mediatools.js';

const B = (icon, label, run, big = false) => ({ icon, label, run, big });
const isAudio = (i) => !i.isDir && KINDS.audio.includes(i.ext);
const isVideo = (i) => !i.isDir && (KINDS.video.includes(i.ext) || ['mkv', 'm2ts', 'mts', 'vob', 'ts'].includes(i.ext));
const isPic = (i) => !i.isDir && KINDS.image.includes(i.ext);
const isArc = (i) => !i.isDir && KINDS.archive.includes(i.ext);

export function contextRibbon() {
  const app = activeAppTab();
  if (app) {
    const st = app.appState || {};
    if (app.app === 'viewer') return { key: 'editor', label: 'Editor', groups: [
      ['Edit', [B('rename', 'Edit', () => appCmd('edit'), true), B('crop', 'Crop', () => appCmd('crop'), true), B('palette', 'Filters', () => appCmd('filters')), B('rename', 'Draw', () => appCmd('draw'))]],
      ['Rotate', [B('undo', 'Rotate left', () => appCmd('rotateL')), B('redo', 'Rotate right', () => appCmd('rotateR')), B('swap', 'Flip', () => appCmd('flip'))]],
      ['Save', [B('copy', 'Save as copy', () => appCmd('saveCopy'), true), B('save', 'Overwrite original', () => appCmd('overwrite')), B('undo', 'Undo', () => appCmd('undo')), B('redo', 'Redo', () => appCmd('redo'))]],
      ['View', [B('pplay', 'Slideshow', () => appCmd('slideshow'), true), B('fullscreen', 'Fullscreen', () => appCmd('fullscreen')), B('zoomIn', 'Zoom in', () => appCmd('zoomIn')), B('zoomOut', 'Zoom out', () => appCmd('zoomOut')), B('max', 'Fit', () => appCmd('fit')), B('listMusic', 'Queue', () => appCmd('queue')), B('info', 'Info', () => appCmd('info'))]],
      ['Text', [B('scan', 'Copy text from image', () => appCmd('ocr'), true)]],
      ['Photo', [B('pprev', 'Previous', () => appCmd('prev')), B('pnext', 'Next', () => appCmd('next')), B('trash', 'Delete', () => appCmd('delete'))]],
    ] };
    if (app.app === 'player' && st.kind === 'audio') return { key: 'audio', label: 'Audio', groups: [
      ['Playback', [B('pplay', 'Play / pause', () => appCmd('play'), true), B('pprev', 'Previous', () => appCmd('prev')), B('pnext', 'Next', () => appCmd('next')), B('shuffle', 'Shuffle', () => appCmd('shuffle')), B('repeat', 'Repeat', () => appCmd('loop')), B('listMusic', 'Queue', () => appCmd('list'))]],
      ['Analyze', [B('music', 'BPM & key', () => appCmd('analyze'), true), B('tag', 'Edit tags', () => appCmd('tags'), true), B('info', 'Media info', () => appCmd('info'))]],
      ['Sound', [B('sliders', 'Equalizer', () => appCmd('eq'), true), B('back', 'Slower', () => appCmd('speedDown')), B('forward', 'Faster', () => appCmd('speedUp')), B('repeat', 'A-B loop', () => appCmd('ab'))]],
      ['Edit', [B('scissors', 'Trim / convert', () => appCmd('edit'), true), B('cc', 'Transcript', () => appCmd('transcript'))]],
    ] };
    if (app.app === 'player') return { key: 'editor', label: 'Editor', groups: [
      ['Edit', [B('scissors', 'Trim / edit', () => appCmd('edit'), true), B('cc', 'Transcript', () => appCmd('transcript'), true), B('music', 'Extract audio', () => appCmd('extract')), B('camera', 'Screenshot', () => appCmd('screenshot'))]],
      ['Playback', [B('pplay', 'Play / pause', () => appCmd('play'), true), B('pprev', 'Previous', () => appCmd('prev')), B('pnext', 'Next', () => appCmd('next')), B('back', 'Slower', () => appCmd('speedDown')), B('forward', 'Faster', () => appCmd('speedUp')), B('repeat', 'A-B loop', () => appCmd('ab'))]],
      ['View', [B('fullscreen', 'Fullscreen', () => appCmd('fullscreen'), true), B('listMusic', 'Playlist', () => appCmd('list')), B('sliders', 'Equalizer', () => appCmd('eq')), B('info', 'Media info', () => appCmd('info'))]],
    ] };
    return null;
  }
  const t = activeTab();
  if (!t) return null;
  const sel = selectedItems(t).filter((i) => !i.virtual);
  const paths = sel.map((i) => i.path);
  const zip = A.arcOf(t.path);
  if (zip || (sel.length && sel.every(isArc))) {
    const arcSel = sel.filter((i) => i.archive);
    return { key: 'zip', label: 'Zip', groups: [
      ['Extract', [
        B('extract', zip ? 'Extract all' : 'Extract here', () => (zip ? A.extract([]) : A.extract(sel)), true),
        !zip && B('extract', 'Extract to folder', () => A.extract(sel, 'folder')),
        B('folderOpen', 'Extract to…', () => (zip ? A.extract([]) : A.extract(sel, 'choose'))),
        zip && arcSel.length && B('extract', 'Extract selected…', () => A.buildItemsMenu(t, arcSel)[2].run()),
        !zip && sel.length === 1 && B('open', 'Browse contents', () => navigate(t, `atlas:zip|${sel[0].path}|`)),
      ]],
      ['Modify', [
        zip && B('plus', 'Add files…', () => A.addFilesToArchive(zip.arc, zip.inner), true),
        !zip && B('plus', 'Add files…', () => A.addFilesToArchive(sel[0].path), true),
        zip && arcSel.length === 1 && B('rename', 'Rename', () => A.renameInArchive(arcSel[0])),
        zip && arcSel.length && B('trash', 'Remove', () => A.deleteFromArchive(arcSel)),
      ]],
      ['Convert', [B('convert', 'To ZIP', () => A.convertArchive(sel, 'zip')), B('convert', 'To 7Z', () => A.convertArchive(sel, '7z')), B('convert', 'To TAR.GZ', () => A.convertArchive(sel, 'tar.gz')), B('convert', 'To RAR', () => A.convertArchive(sel, 'rar'))]],
      ['Check', [B('check', 'Test archive', () => A.testArchives(sel), true)]],
      zip && ['Archive', [B('up', 'Close archive', () => navigate(t, dirname(zip.arc), { select: zip.arc }), true), B('copy', 'Copy archive path', () => A.copyPaths([{ path: zip.arc, name: basename(zip.arc) }]))]],
    ].filter(Boolean) };
  }
  if (!sel.length) return null;
  if (sel.every(isAudio)) return { key: 'audio', label: 'Audio', groups: [
    ['Play', [B('pplay', sel.length > 1 ? 'Play all' : 'Play', () => A.openAllIn('player', paths), true), B('listMusic', 'Add to queue', () => import('./apptabs.js').then((m) => m.openTool('player', paths, { append: true, play: false })))]],
    ['Tags', [B('tag', sel.length > 1 ? 'Edit tags' : 'Edit tags', () => import('./tageditor.js').then((m) => m.openTagEditor(paths)), true), B('wand', 'Auto-tag', () => import('./tageditor.js').then((m) => m.openTagEditor(paths)))]],
    ['Analyze', [B('music', 'BPM & key', () => analyzeDialog(paths), true), B('listMusic', 'Whole folder', () => import('./gallery.js').then((m) => m.analyzeFolder())), B('dupes', 'Similar songs', () => import('./gallery.js').then((m) => m.findSimilarMedia())), B('info', 'Properties', () => A.properties(sel))]],
    ['Convert', [B('convert', 'To MP3', () => convertMedia(paths, 'mp3')), B('convert', 'To FLAC', () => convertMedia(paths, 'flac')), B('convert', 'To WAV', () => convertMedia(paths, 'wav')), B('convert', 'To M4A', () => convertMedia(paths, 'm4a')), B('sliders', 'Normalize loudness', () => convertMedia(paths, sel[0].ext === 'mp3' ? 'mp3' : 'm4a', { normalize: true }))]],
    ['Edit', [B('scissors', 'Trim…', () => A.openAllIn('player', [paths[0]]), true)]],
  ] };
  if (sel.every(isVideo)) return { key: 'video', label: 'Video', groups: [
    ['Play', [B('pplay', sel.length > 1 ? 'Play all' : 'Play', () => A.openAllIn('player', paths), true)]],
    ['Convert', [B('convert', 'To MP4', () => convertMedia(paths, 'mp4')), B('convert', 'To MKV', () => convertMedia(paths, 'mkv')), B('music', 'Extract audio (MP3)', () => convertMedia(paths, 'mp3', { audioOnly: true }))]],
    ['Edit', [B('scissors', 'Trim…', () => A.openAllIn('player', [paths[0]]), true), B('viewGrid', 'Contact sheet', () => import('./gallery.js').then((m) => m.contactSheets(sel)))]],
    ['Find', [B('dupes', 'Similar videos', () => import('./gallery.js').then((m) => m.findSimilarMedia()))]],
  ] };
  if (sel.every(isPic)) return { key: 'pictures', label: 'Pictures', groups: [
    ['View', [B('image', sel.length > 1 ? 'View all' : 'View', () => A.openAllIn('viewer', paths), true), B('pplay', 'Slideshow', () => A.openAllIn('viewer', paths.length > 1 ? paths : paths, { slideshow: true, autoPlaylist: paths.length === 1 }))]],
    ['Convert', [B('convert', 'To JPG', () => convertImages(paths, 'jpg')), B('convert', 'To PNG', () => convertImages(paths, 'png')), B('convert', 'To WebP', () => convertImages(paths, 'webp')), B('zoomOut', 'Resize to 1920px', () => convertImages(paths, 'jpg', { maxSide: 1920 }))]],
    ['Browse', [B('gallery', 'Gallery view', () => { t.view = 'gallery'; import('./pane.js').then((m) => m.renderTabPanes(t)); }, true), B('filter', 'Filter by colour…', () => document.querySelector('.pane.active .mf-btn')?.click())]],
    ['Use', [sel.length === 1 && B('desktop', 'Set as background', () => setWallpaper(paths[0]), true), B('zip', 'Add to zip', () => A.quickZip(sel))]],
  ] };
  return null;
}
