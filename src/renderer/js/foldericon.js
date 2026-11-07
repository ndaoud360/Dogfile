// Folder icons: a picture set as a folder's icon. It is written the way Windows does it (so Explorer shows it too), and
// Dogfile remembers which folders have one so it can draw it in the lists.
import { api, state, bus, toast, fileUrl, normalize, errText, basename } from './core.js';

const key = (p) => String(normalize(p) || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
let map = {};

export async function loadFolderIcons() {
  try { map = (await api('store:get', 'folderIcons')) || {}; } catch { map = {}; }
  if (Object.keys(map).length) bus.emit('refreshPanes');
}
const save = () => api('store:set', 'folderIcons', map).catch(() => {});

/** the picture to draw for this folder, or null for the normal folder */
export function folderIconUrl(path) {
  const e = map[key(path)];
  return e ? `${fileUrl(e.icon)}&v=${e.at}` : null;
}

export async function setFolderIcon(folder, image) {
  try {
    const r = await api('fs:setFolderIcon', folder, image);
    map[key(folder)] = { icon: r.icon, at: Date.now() };
    await save();
    bus.emit('refreshPanes');
    toast(`“${basename(folder) || folder}” now uses this picture as its icon. Explorer may need a refresh (F5) to show it.`, { ok: true, ms: 6000 });
  } catch (e) { toast(errText(e), { error: true, ms: 9000 }); }
}

export async function resetFolderIcon(folder) {
  try { await api('fs:clearFolderIcon', folder); } catch (e) { toast(errText(e), { error: true }); return; }
  delete map[key(folder)];
  await save();
  bus.emit('refreshPanes');
  toast('The folder has its normal icon again', { ok: true });
}

export const hasFolderIcon = (path) => !!map[key(path)];
