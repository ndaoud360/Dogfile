// Dogfile 3D: a viewer for 3D models, CAD parts and drawings. Rotate (drag), pan (right-drag), zoom (wheel);
// textured, clay, normals and wireframe shading; turn each texture map on or off, look at one map on its own,
// or bring your own picture for any map (or just a color); a background color, picture or 360° panorama;
// animations with a scrubber and speed. Light on slow computers: it draws only when something changes, lowers
// its resolution while you move the model if frames get slow, and has a low-quality mode (auto-detected).
import { api, onMain, h, esc, DEFAULT_SETTINGS, setNativeDialogs, toast, natCmp, fileUrl, decodedUrl, DECODED_IMG, fmtSize, debounce } from './core.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { applyColors, mediaSettings } from './theme.js';
import { requirePro, initLicense } from './license.js';
import { EMBED, pendingFiles, onHost, setTitle, onAsk, showInFiles } from './embed.js';
import { three, loadModel, installCad, MODEL_EXTS, CAD_EXTS } from './model-load.js';

const $ = (id) => document.getElementById(id);
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const nameOf = (p) => p.split(/[\\/]/).pop();
const isModel = (p) => MODEL_EXTS.includes(extOf(p));
let sys = {}, settings = { ...DEFAULT_SETTINGS };
let T = null;

// what you see, remembered between sessions
const PREFS_DEFAULT = { shading: 'textured', textures: true, wire: false, grid: true, axes: false, autoRotate: false, light: 'studio', exposure: 1, quality: 'auto', bg: { kind: 'default', color: '#2a2c31', path: '', pano: false, light: true }, side: true, open: { view: true, maps: true, bg: false, light: false, info: false, perf: false }, speed: 1, loop: true, zUp: 'auto', flipY: 'auto' };
let P = structuredClone(PREFS_DEFAULT);
const savePrefs = debounce(() => api('store:set', 'model3d-prefs', P), 400);

// texture channels of a material
const CH = [
  ['map', 'Base color', true, 'Base color (albedo, diffuse)'], ['normalMap', 'Normal', false], ['roughnessMap', 'Roughness', false], ['metalnessMap', 'Metalness', false],
  ['aoMap', 'Ambient occlusion', false], ['emissiveMap', 'Emissive (glow)', true], ['alphaMap', 'Opacity', false], ['bumpMap', 'Bump / height', false],
];
const GREY = 0xb8bcc6;

const M = { list: [], idx: -1, cur: null, seq: 0 };
// per-channel switches (all materials) and per-material picks: { [uuid]: { [ch]: Texture | null } }
const chanOn = Object.fromEntries(CH.map(([k]) => [k, true]));
let target = 'all';
let mapView = 'none';

// ---------------- renderer ----------------
let R = null; // { renderer, scene, cam, ctl, root, grid, axes, lights, env, wireMat, clay, normals }
let lowEnd = false, gpuName = '';
function detectLow() {
  if (P.quality === 'low') return true;
  if (P.quality === 'high') return false;
  const weakGpu = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|gma|intel\(r\) (hd|uhd) graphics( [2-6]\d\d)?\b|mali-[gt]?[1-5]\d|adreno \(tm\) [1-5]\d\d/i.test(gpuName);
  return weakGpu || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
}
function probeGpu() {
  try { const c = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'); const d = c?.getExtension('WEBGL_debug_renderer_info'); gpuName = d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : ''; c?.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
}
const maxTex = () => (lowEnd ? 2048 : 4096);

function makeRenderer() {
  const box = $('md-view');
  lowEnd = detectLow();
  const old = R?.renderer;
  const renderer = new T.WebGLRenderer({ antialias: !lowEnd, alpha: true, powerPreference: lowEnd ? 'low-power' : 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(basePR());
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NeutralToneMapping;
  renderer.toneMappingExposure = P.exposure;
  renderer.setClearColor(0x000000, 0);
  box.innerHTML = '';
  box.append(renderer.domElement);
  if (!R) {
    const scene = new T.Scene();
    const cam = new T.PerspectiveCamera(40, 1, 0.01, 1000);
    const root = new T.Group(); scene.add(root);
    R = { scene, cam, root, lights: new T.Group() };
    scene.add(R.lights);
    R.wireMat = new T.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false });
    R.wireOnly = new T.MeshBasicMaterial({ color: 0x9fc3ff, wireframe: true });
    R.clay = new T.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 0.75, metalness: 0 });
    R.normals = new T.MeshNormalMaterial();
  }
  R.renderer = renderer;
  R.ctl?.dispose();
  R.ctl = new T.OrbitControls(R.cam, renderer.domElement);
  R.ctl.enableDamping = true; R.ctl.dampingFactor = 0.12; R.ctl.screenSpacePanning = true;
  R.ctl.addEventListener('change', () => need());
  R.ctl.addEventListener('start', () => { moving = true; stopTween(); if (P.autoRotate) { P.autoRotate = false; renderBar(); } });
  R.ctl.addEventListener('end', () => { moving = false; idleSoon(); });
  if (old) { old.dispose(); old.forceContextLoss?.(); }
  R.env?.dispose(); R.env = null;
  applyLights();
  resize();
  wirePicking(renderer.domElement);
}
// adaptive resolution: full sharpness when still, lower while moving if frames are slow
let prMove = 1;
const basePR = () => Math.min(devicePixelRatio || 1, lowEnd ? 1 : 1.5);
let moving = false, idleT = 0;
function idleSoon() { clearTimeout(idleT); idleT = setTimeout(() => { if (moving || P.autoRotate || M.cur?.anim?.playing) return; slowFrames = 0; if (R && lowered) { lowered = false; R.renderer.setPixelRatio(basePR()); resize(); } }, 400); }
function resize() {
  if (!R) return;
  const box = $('md-view'), w = box.clientWidth, hh = box.clientHeight;
  if (!w || !hh) return;
  R.renderer.setSize(w, hh, false);
  R.renderer.domElement.style.width = '100%'; R.renderer.domElement.style.height = '100%';
  R.cam.aspect = w / hh; R.cam.updateProjectionMatrix();
  need();
}

let raf = 0, dirty = true, last = 0, slowFrames = 0, lowered = false;
function need() { dirty = true; if (!raf) raf = requestAnimationFrame(tick); }
function tick(now) {
  raf = 0;
  if (!R) return;
  const dt = Math.min(0.1, last ? (now - last) / 1000 : 0); last = now;
  let more = false;
  if (R.ctl.update()) more = true;
  if (P.autoRotate && M.cur) { M.cur.spin.rotation.y += dt * 0.5; more = true; }
  if (tween) { more = stepTween(now) || more; }
  const A = M.cur?.anim;
  if (A?.playing && A.action) { A.mixer.update(dt); syncScrub(); more = true; }
  if (dirty || more) {
    draw();
    dirty = false;
    // real frame times (not just the drawing call): if they stay slow while things move, draw fewer pixels,
    // once, and go back to full sharpness when it all stops (resizing every few frames was what stuttered)
    if ((moving || P.autoRotate || A?.playing) && dt > 0.045) { if (++slowFrames > 12 && !lowered) { lowered = true; prMove = Math.max(0.6, basePR() * 0.66); R.renderer.setPixelRatio(prMove); resize(); } }
    else if (slowFrames > 0) slowFrames--;
  }
  // one frame at a time: a "changed" event during this frame has already asked for the next one
  if (more && !raf) raf = requestAnimationFrame(tick);
  if (!more && !raf) last = 0;
}
function draw() {
  const { renderer, scene, cam } = R;
  const sh = M.cur?.lines ? 'textured' : P.shading;
  scene.overrideMaterial = sh === 'clay' ? R.clay : sh === 'normals' ? R.normals : sh === 'wireframe' ? R.wireOnly : null;
  renderer.autoClear = true;
  renderer.render(scene, cam);
  if (P.wire && sh !== 'wireframe' && !M.cur?.lines) {
    renderer.autoClear = false;
    const bg = scene.background; scene.background = null;
    R.grid && (R.grid.visible = false); R.axes && (R.axes.visible = false);
    scene.overrideMaterial = R.wireMat;
    renderer.render(scene, cam);
    scene.background = bg;
    R.grid && (R.grid.visible = P.grid); R.axes && (R.axes.visible = P.axes);
    scene.overrideMaterial = null;
  }
}

// ---------------- lights, environment, background ----------------
function applyLights() {
  if (!R) return;
  const L = R.lights; L.clear();
  const studio = P.light === 'studio';
  if (studio && !lowEnd) {
    if (!R.env) { const pm = new T.PMREMGenerator(R.renderer); R.env = pm.fromScene(new T.RoomEnvironment(), 0.04).texture; pm.dispose(); }
  }
  const panoLight = P.bg.kind === 'image' && P.bg.pano && P.bg.light && R.pano;
  R.scene.environment = panoLight ? R.pano : studio && !lowEnd ? R.env : null;
  R.scene.environmentIntensity = 1;
  if (P.light === 'flat') { L.add(new T.HemisphereLight(0xffffff, 0xffffff, 2.6)); }
  else if (P.light === 'soft') { L.add(new T.HemisphereLight(0xffffff, 0x5a5d66, 2.2)); const d = new T.DirectionalLight(0xffffff, 0.8); d.position.set(2, 4, 3); L.add(d); }
  else {
    // studio: the room light, plus a key light; without it (slow computers) three plain lights
    if (lowEnd || panoLight) L.add(new T.HemisphereLight(0xffffff, 0x50535c, panoLight ? 0.3 : 1.4));
    const key = new T.DirectionalLight(0xffffff, lowEnd ? 1.8 : 1.2); key.position.set(3, 5, 4); L.add(key);
    if (lowEnd) { const fill = new T.DirectionalLight(0xdfe8ff, 0.6); fill.position.set(-4, 2, -3); L.add(fill); }
  }
  R.renderer.toneMappingExposure = P.exposure;
  need();
}
async function applyBackground() {
  const bg = $('md-bg');
  bg.style.background = ''; bg.className = '';
  if (R) R.scene.background = null;
  if (P.bg.kind === 'color') { if (R) R.scene.background = new T.Color(P.bg.color); }
  else if (P.bg.kind === 'image' && P.bg.path) {
    const p = P.bg.path, e = extOf(p);
    if (P.bg.pano) {
      try {
        if (!R.panoFor || R.panoFor !== p) {
          R.pano?.dispose();
          const tex = e === 'hdr' ? await new T.HDRLoader().loadAsync(fileUrl(p)) : e === 'exr' ? await new T.EXRLoader().loadAsync(fileUrl(p)) : await new T.TextureLoader().loadAsync(texUrl(p));
          tex.mapping = T.EquirectangularReflectionMapping;
          if (e !== 'hdr' && e !== 'exr') tex.colorSpace = T.SRGBColorSpace;
          R.pano = tex; R.panoFor = p;
        }
        R.scene.background = R.pano;
      } catch (err) { toast(`Couldn’t use this picture: ${err.message}`, { error: true }); }
    } else {
      bg.className = 'pic';
      bg.style.backgroundImage = `url("${texUrl(p).replace(/"/g, '%22')}")`;
    }
  } else bg.className = 'default';
  applyLights();
  need();
}
const NATIVE_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'jfif']);
const texUrl = (p) => (NATIVE_IMG.has(extOf(p)) ? fileUrl(p) : decodedUrl(p, maxTex()));

// ---------------- the model ----------------
function disposeModel(c) {
  if (!c) return;
  c.anim?.mixer?.stopAllAction();
  c.spin.removeFromParent();
  c.object.traverse((o) => {
    o.geometry?.dispose?.();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { for (const [k] of CH) m[k]?.dispose?.(); m.dispose?.(); }
  });
  for (const v of Object.values(c.preview || {})) v.dispose?.();
  for (const per of Object.values(c.picks || {})) for (const t of Object.values(per)) t?.dispose?.();
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function pick(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) r[k] = v; return r; }
// Phong, Lambert and Toon become physically based, so roughness and metalness maps mean something
function toStandard(m) {
  if (!(m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial)) return m;
  const s = new T.MeshStandardMaterial(pick({
    name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, normalScale: m.normalScale, bumpMap: m.bumpMap, bumpScale: m.bumpScale,
    emissive: m.emissive, emissiveMap: m.emissiveMap, emissiveIntensity: m.emissiveIntensity, alphaMap: m.alphaMap, aoMap: m.aoMap, aoMapIntensity: m.aoMapIntensity,
    opacity: m.opacity, transparent: m.transparent, side: m.side, vertexColors: m.vertexColors, alphaTest: m.alphaTest, flatShading: m.flatShading,
    displacementMap: m.displacementMap, displacementScale: m.displacementScale, lightMap: m.lightMap,
    roughness: m.isMeshPhongMaterial ? clamp(1 - Math.sqrt((m.shininess ?? 30) / 100) * 0.85, 0.2, 1) : 0.85, metalness: 0,
  }));
  s.userData = { ...m.userData };
  return s;
}
function prepare(object) {
  const conv = new Map(), mats = new Map();
  let verts = 0, tris = 0, meshes = 0, lines = 0, texs = new Set();
  object.traverse((o) => {
    if (o.isSkinnedMesh) o.frustumCulled = false;
    if (o.isLine || o.isPoints) lines++;
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    if (g?.attributes?.position) { verts += g.attributes.position.count; tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3; }
    const one = (m) => {
      if (!conv.has(m.uuid)) { const s = toStandard(m); if (s !== m) m.dispose(); conv.set(m.uuid, s); }
      const s = conv.get(m.uuid);
      if (!mats.has(s.uuid)) {
        // no picture and plain white: show the default grey
        if (!s.map && s.color && s.color.r > 0.999 && s.color.g > 0.999 && s.color.b > 0.999 && !s.vertexColors && !s.isMeshBasicMaterial) s.color.setHex(GREY);
        const orig = { color: s.color?.getHex(), emissive: s.emissive?.getHex(), roughness: s.roughness, metalness: s.metalness, transparent: s.transparent };
        for (const [k] of CH) { orig[k] = s[k] || null; if (s[k]) texs.add(s[k].uuid); }
        mats.set(s.uuid, { mat: s, orig, name: s.name || `Material ${mats.size + 1}` });
      }
      return s;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : o.material ? one(o.material) : one(new T.MeshStandardMaterial({ color: GREY }));
  });
  return { mats: [...mats.values()], info: { verts, tris: Math.round(tris), meshes, lines, textures: texs.size } };
}

async function show(i) {
  if (!M.list.length) { $('md-empty').style.display = ''; return; }
  i = (i + M.list.length) % M.list.length;
  M.idx = i;
  const path = M.list[i];
  const seq = ++M.seq;
  $('md-empty').style.display = 'none';
  setErr(null);
  busy(`Opening ${nameOf(path)}…`);
  setTitle(`${nameOf(path)} · Dogfile 3D`);
  $('md-name').textContent = nameOf(path);
  $('md-count').textContent = M.list.length > 1 ? `${i + 1} / ${M.list.length}` : '';
  let r;
  try { r = await loadModel(path, { maxTex: maxTex(), quality: lowEnd ? 'low' : 'normal' }); }
  catch (e) { if (seq !== M.seq) return; busy(null); return failed(path, e); }
  if (seq !== M.seq) { r.object.traverse((o) => o.geometry?.dispose?.()); return; }
  disposeModel(M.cur);
  const ext = extOf(path);
  const zUp = P.zUp === 'auto' ? r.zUp : P.zUp === 'z';
  const spin = new T.Group(), holder = new T.Group();
  holder.add(r.object);
  if (zUp && !r.flat) holder.rotation.x = -Math.PI / 2;
  spin.add(holder);
  R.root.add(spin);
  const { mats, info } = prepare(r.object);
  // sit on the floor, centered (drawings: centered, seen from above)
  const bb = new T.Box3().setFromObject(spin);
  if (bb.isEmpty()) bb.set(new T.Vector3(-1, -1, -1), new T.Vector3(1, 1, 1));
  const size = bb.getSize(new T.Vector3()), center = bb.getCenter(new T.Vector3());
  holder.position.set(-center.x, r.flat ? -center.y : -bb.min.y, -center.z);
  const radius = Math.max(size.length() / 2, 1e-6);
  M.cur = { path, ext, object: r.object, spin, holder, mats, info: { ...info, size, animations: r.animations.length }, flat: r.flat, lines: r.flat, gltf: r.gltf, zUp, radius, picks: {}, preview: {}, missing: [], anim: null, height: r.flat ? 0 : size.y };
  setupGrid();
  frame(r.flat ? 'top' : 'iso', false);
  setupAnim(r.animations);
  applyMaterials();
  busy(null);
  renderSide(); renderBar();
  api('fs:stat', path).then((s) => { if (M.cur?.path === path) { M.cur.info.bytes = s?.size; renderSide(); } }).catch(() => {});
  // textures that never arrived show as the default grey instead of black
  r.settled().then(() => {
    if (M.cur?.path !== path) return;
    let fixed = false;
    for (const e of M.cur.mats) for (const [ch] of CH) { const t = e.orig[ch]; if (t && !t.isCompressedTexture && !t.image && !t.source?.data) { e.orig[ch] = null; fixed = true; if (ch === 'map' && e.mat.color?.getHex() === 0xffffff) e.orig.color = GREY; } }
    M.cur.missing = [...r.missing];
    if (fixed) { resetPreviews(); applyMaterials(); }
    renderSide();
    if (M.cur.missing.length) osd(`${M.cur.missing.length} texture${M.cur.missing.length > 1 ? 's' : ''} not found next to the model`);
  });
  need();
}
function setupGrid() {
  R.grid?.removeFromParent(); R.grid?.geometry.dispose(); R.axes?.removeFromParent();
  const c = M.cur; if (!c) return;
  const step = Math.pow(10, Math.floor(Math.log10(c.radius)));
  const size = Math.ceil((c.radius * 3) / step) * step;
  R.grid = new T.GridHelper(size, Math.min(60, Math.round(size / (step / 2))), 0x5c6070, 0x34363d);
  R.grid.material.transparent = true; R.grid.material.opacity = 0.7; R.grid.material.depthWrite = false;
  if (c.flat) { R.grid.rotation.x = Math.PI / 2; R.grid.position.z = -c.radius * 0.001; }
  R.grid.visible = P.grid; R.scene.add(R.grid);
  R.axes = new T.AxesHelper(c.radius * 0.8); R.axes.visible = P.axes; R.scene.add(R.axes);
}

// ---------------- camera ----------------
const VIEWS = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], iso: [1, 0.75, 1.3] };
let tween = null;
function stopTween() { tween = null; }
function frame(view = 'iso', animate = true) {
  const c = M.cur; if (!c) return;
  const dir = c.flat && view === 'top' ? new T.Vector3(0, 0, 1) : new T.Vector3(...VIEWS[view]).normalize();
  const tgt = new T.Vector3(0, c.flat ? 0 : c.height / 2, 0);
  const dist = (c.radius / Math.sin((R.cam.fov * Math.PI) / 360)) * 1.05;
  const pos = tgt.clone().addScaledVector(dir, dist);
  R.cam.near = Math.max(dist / 2000, c.radius / 5000); R.cam.far = dist * 50 + c.radius * 10; R.cam.updateProjectionMatrix();
  R.ctl.minDistance = c.radius / 500; R.ctl.maxDistance = dist * 20;
  if (!animate) { R.cam.position.copy(pos); R.ctl.target.copy(tgt); R.ctl.update(); need(); return; }
  tween = { t0: performance.now(), from: R.cam.position.clone(), fromT: R.ctl.target.clone(), pos, tgt };
  need();
}
function stepTween(now) {
  const k = Math.min(1, (now - tween.t0) / 350), e = 1 - Math.pow(1 - k, 3);
  R.cam.position.lerpVectors(tween.from, tween.pos, e);
  R.ctl.target.lerpVectors(tween.fromT, tween.tgt, e);
  dirty = true;
  if (k >= 1) { tween = null; return false; }
  return true;
}

// ---------------- materials and maps ----------------
const targets = () => (!M.cur ? [] : target === 'all' ? M.cur.mats : M.cur.mats.filter((x) => x.mat.uuid === target));
function effective(entry, ch) {
  const per = M.cur.picks[entry.mat.uuid] || {};
  if (!P.textures || !chanOn[ch]) return null;
  return ch in per ? per[ch] : entry.orig[ch];
}
function applyMaterials() {
  const c = M.cur; if (!c) return;
  for (const e of c.mats) {
    const m = e.mat;
    let changed = false;
    for (const [ch] of CH) {
      if (!(ch in m)) continue;
      const t = effective(e, ch);
      if ((m[ch] || null) !== t) { if (!!m[ch] !== !!t) changed = true; m[ch] = t; }
    }
    // values a picture is multiplied by: neutral when a picked picture is there, as the file had them otherwise
    const per = c.picks[m.uuid] || {};
    if ('roughness' in m) m.roughness = per.roughnessMap ? 1 : e.orig.roughness;
    if ('metalness' in m) m.metalness = per.metalnessMap ? 1 : e.orig.metalness;
    if (m.emissive) { if (m.emissiveMap && (e.orig.emissive ?? 0) === 0) m.emissive.setHex(0xffffff); else m.emissive.setHex(e.orig.emissive ?? 0); }
    if (per.color != null && m.color) m.color.setHex(per.color);
    else if (m.color && e.orig.color != null) m.color.setHex(per.map ? 0xffffff : e.orig.color);
    m.transparent = !!m.alphaMap || !!e.orig.transparent;
    if (changed) m.needsUpdate = true;
  }
  applyMapView();
  need();
}
// one map on its own, unlit, for every material
function applyMapView() {
  const c = M.cur; if (!c) return;
  c.object.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.dfMat) o.userData.dfMat = o.material;
    const real = o.userData.dfMat;
    if (mapView === 'none') { o.material = real; return; }
    const sw = (m) => {
      const e = c.mats.find((x) => x.mat === m);
      const key = m.uuid + mapView;
      if (!c.preview[key]) {
        const t = e ? effective(e, mapView) : null;
        c.preview[key] = new T.MeshBasicMaterial({ map: t, color: t ? 0xffffff : 0x303238, side: m.side, transparent: false });
        if (t && mapView !== 'map' && mapView !== 'emissiveMap') c.preview[key].map = t; // data maps are shown as they are
      }
      return c.preview[key];
    };
    o.material = Array.isArray(real) ? real.map(sw) : sw(real);
  });
}
function resetPreviews() { const c = M.cur; if (!c) return; for (const v of Object.values(c.preview)) v.dispose(); c.preview = {}; }

async function loadTexture(p, ch) {
  const e = extOf(p);
  const tex = e === 'tga' ? await new T.TGALoader().loadAsync(fileUrl(p)) : await new T.TextureLoader().loadAsync(texUrl(p));
  const srgb = CH.find((x) => x[0] === ch)?.[2];
  tex.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
  tex.flipY = P.flipY === 'auto' ? !M.cur?.gltf : P.flipY === 'yes';
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.anisotropy = lowEnd ? 1 : Math.min(8, R.renderer.capabilities.getMaxAnisotropy());
  tex.userData.path = p;
  tex.needsUpdate = true;
  return tex;
}
const IMG_FILTER = [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'dds', 'psd', 'tif', 'tiff', 'exr', 'hdr', 'avif'] }];
async function importMap(ch) {
  if (!M.cur) return;
  if (!(await requirePro('model3d'))) return;
  const f = await api('dialog:openFiles', { title: `Choose a picture for ${CH.find((x) => x[0] === ch)[1]}`, filters: IMG_FILTER });
  if (!f?.length) return;
  busy('Loading the picture…');
  try {
    const tex = await loadTexture(f[0], ch);
    for (const e of targets()) { const per = (M.cur.picks[e.mat.uuid] ||= {}); per[ch]?.dispose?.(); per[ch] = tex; if (ch === 'map') delete per.color; }
    chanOn[ch] = true; P.textures = true;
    resetPreviews(); applyMaterials(); renderSide();
  } catch (e) { toast(`Couldn’t use this picture: ${e.message}`, { error: true }); }
  busy(null);
}
function clearMap(ch) { for (const e of targets()) (M.cur.picks[e.mat.uuid] ||= {})[ch] = null; resetPreviews(); applyMaterials(); renderSide(); }
function originalMap(ch) { for (const e of targets()) { const per = M.cur.picks[e.mat.uuid]; if (per) delete per[ch]; } resetPreviews(); applyMaterials(); renderSide(); }
function setColor(hex) { for (const e of targets()) (M.cur.picks[e.mat.uuid] ||= {}).color = parseInt(hex.slice(1), 16); applyMaterials(); }
function resetAllMaterials() { if (!M.cur) return; M.cur.picks = {}; for (const [k] of CH) chanOn[k] = true; P.textures = true; resetPreviews(); applyMaterials(); renderSide(); renderBar(); }
function plainGrey() { if (!M.cur) return; for (const e of M.cur.mats) { const per = (M.cur.picks[e.mat.uuid] = {}); for (const [k] of CH) per[k] = null; per.color = GREY; } resetPreviews(); applyMaterials(); renderSide(); }

// click a part to pick its material
function wirePicking(el) {
  let down = null;
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0 || !M.cur || M.cur.mats.length < 2 || !P.open.maps) return;
    const r = el.getBoundingClientRect();
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), R.cam);
    const hit = ray.intersectObject(M.cur.object, true).find((x) => x.object.isMesh);
    if (!hit) return;
    const real = hit.object.userData.dfMat || hit.object.material;
    const m = Array.isArray(real) ? real[hit.face?.materialIndex ?? 0] : real;
    if (m && M.cur.mats.some((x) => x.mat === m)) { target = m.uuid; renderSide(); osd(`Material: ${M.cur.mats.find((x) => x.mat === m).name}`); }
  });
}

// ---------------- animation ----------------
function setupAnim(clips) {
  const c = M.cur;
  const bar = $('md-anim');
  bar.innerHTML = '';
  if (!clips?.length) { bar.classList.remove('show'); return; }
  const mixer = new T.AnimationMixer(c.object);
  mixer.timeScale = P.speed;
  c.anim = { mixer, clips, action: null, playing: true, idx: 0 };
  playClip(0);
  bar.classList.add('show');
  renderAnim();
}
function playClip(i) {
  const A = M.cur.anim;
  A.action?.stop();
  A.idx = i;
  A.action = A.mixer.clipAction(A.clips[i]);
  A.action.setLoop(P.loop ? T.LoopRepeat : T.LoopOnce, Infinity);
  A.action.clampWhenFinished = true;
  A.action.reset().play();
  A.playing = true;
  need();
}
function togglePlay() {
  const A = M.cur?.anim; if (!A) return;
  if (!A.playing && A.action && !P.loop && A.action.time >= A.clips[A.idx].duration - 1e-3) A.action.reset().play();
  A.playing = !A.playing;
  renderAnim(); need();
}
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;
function renderAnim() {
  const A = M.cur?.anim, bar = $('md-anim');
  if (!A) return;
  const clip = A.clips[A.idx];
  bar.innerHTML = '';
  const play = h('button', { class: 'pb', title: 'Play / pause (Space)', html: icon(A.playing ? 'pause' : 'play'), onclick: togglePlay });
  const sel = h('select', { class: 'md-sel', title: 'Animation', onchange: () => { playClip(+sel.value); renderAnim(); } }, ...A.clips.map((c, i) => h('option', { value: i, selected: i === A.idx }, c.name || `Animation ${i + 1}`)));
  const scrub = h('input', { type: 'range', id: 'md-scrub', min: 0, max: clip.duration || 1, step: 0.001, value: A.action?.time || 0 });
  scrub.addEventListener('input', () => { A.playing = false; A.action.paused = false; A.action.time = +scrub.value; A.mixer.update(0); $('md-time').textContent = `${fmtT(+scrub.value)} / ${fmtT(clip.duration)}`; play.innerHTML = icon('play'); need(); });
  const speed = h('select', { class: 'md-sel', title: 'Speed', onchange: () => { P.speed = +speed.value; A.mixer.timeScale = P.speed; savePrefs(); } }, ...[0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((s) => h('option', { value: s, selected: s === P.speed }, `${s}×`)));
  const loop = h('button', { class: 'pb' + (P.loop ? ' on' : ''), title: 'Loop', html: icon('repeat'), onclick: () => { P.loop = !P.loop; A.action.setLoop(P.loop ? T.LoopRepeat : T.LoopOnce, Infinity); savePrefs(); renderAnim(); } });
  bar.append(play, sel, scrub, h('span', { id: 'md-time' }, `${fmtT(A.action?.time || 0)} / ${fmtT(clip.duration)}`), speed, loop);
}
let scrubT = 0;
function syncScrub() {
  const now = performance.now(); if (now - scrubT < 90) return; scrubT = now;
  const A = M.cur.anim, s = $('md-scrub'); if (!s || !A.action) return;
  s.value = A.action.time;
  const tl = $('md-time'); if (tl) tl.textContent = `${fmtT(A.action.time)} / ${fmtT(A.clips[A.idx].duration)}`;
  if (!P.loop && !A.action.isRunning() && A.action.time >= A.clips[A.idx].duration - 1e-3) { A.playing = false; renderAnim(); }
}

// ---------------- the side panel ----------------
const sec = (key, title, ...kids) => {
  const d = h('details', { class: 'md-sec', open: !!P.open[key] }, h('summary', {}, title), h('div', { class: 'md-body' }, ...kids.filter(Boolean)));
  d.addEventListener('toggle', () => { P.open[key] = d.open; savePrefs(); });
  return d;
};
const seg = (opts, val, set) => h('div', { class: 'md-seg' }, ...opts.map(([v, l, t]) => h('button', { class: v === val ? 'on' : '', title: t || '', onclick: () => set(v) }, l)));
const check = (label, on, set, title) => { const i = h('input', { type: 'checkbox', checked: !!on }); i.onchange = () => set(i.checked); return h('label', { class: 'md-check', title: title || '' }, i, h('span', {}, label)); };
const row = (label, ...ctl) => h('div', { class: 'md-row' }, h('span', { class: 'md-lbl' }, label), ...ctl);

function renderSide() {
  const side = $('md-side');
  document.body.classList.toggle('no-side', !P.side);
  const c = M.cur;
  side.innerHTML = '';
  const lines = c?.lines;
  side.append(sec('view', 'View',
    !lines && seg([['textured', 'Textured'], ['clay', 'Clay', 'Plain grey, to see the shape'], ['normals', 'Normals', 'Which way each surface faces'], ['wireframe', 'Wire', 'Only the edges of the triangles']], P.shading, (v) => { P.shading = v; savePrefs(); renderSide(); renderBar(); need(); }),
    !lines && check('Textures', P.textures, (v) => { P.textures = v; savePrefs(); resetPreviews(); applyMaterials(); renderBar(); }, 'T'),
    !lines && check('Wireframe on top', P.wire, (v) => { P.wire = v; savePrefs(); renderBar(); need(); }, 'W'),
    check('Grid', P.grid, (v) => { P.grid = v; if (R.grid) R.grid.visible = v; savePrefs(); renderBar(); need(); }, 'G'),
    check('Axes', P.axes, (v) => { P.axes = v; if (R.axes) R.axes.visible = v; savePrefs(); need(); }),
    check('Turn slowly', P.autoRotate, (v) => { P.autoRotate = v; savePrefs(); renderBar(); need(); }, 'R'),
    row('Up is', h('select', { class: 'md-sel', onchange: (e) => { P.zUp = e.target.value; savePrefs(); show(M.idx); } }, ...[['auto', 'Automatic'], ['y', 'Y (games, animation)'], ['z', 'Z (CAD, 3D printing)']].map(([v, l]) => h('option', { value: v, selected: P.zUp === v }, l)))),
    h('div', { class: 'md-views' }, ...['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((v) => h('button', { class: 'btn small', onclick: () => frame(v) }, v === 'iso' ? '3D' : v[0].toUpperCase() + v.slice(1))))));

  if (c && !lines && c.mats.length) {
    const tsel = h('select', { class: 'md-sel', onchange: () => { target = tsel.value; renderSide(); } },
      h('option', { value: 'all', selected: target === 'all' }, `All materials (${c.mats.length})`), ...c.mats.map((e) => h('option', { value: e.mat.uuid, selected: target === e.mat.uuid }, e.name)));
    const tg = targets();
    const rows = CH.map(([ch, label]) => {
      const here = tg.map((e) => effective(e, ch)).filter(Boolean);
      const any = tg.some((e) => e.orig[ch] || (M.cur.picks[e.mat.uuid] || {})[ch]);
      const picked = tg.some((e) => ch in (M.cur.picks[e.mat.uuid] || {}));
      const t = here[0];
      const thumb = h('span', { class: 'md-thumb' + (t ? '' : ' none'), title: t?.userData?.path || t?.name || (any ? 'Off' : 'No picture') });
      if (t?.image) { try { const cv = document.createElement('canvas'); cv.width = cv.height = 40; cv.getContext('2d').drawImage(t.image, 0, 0, 40, 40); thumb.style.backgroundImage = `url(${cv.toDataURL()})`; } catch {} }
      const on = h('input', { type: 'checkbox', checked: chanOn[ch], title: 'Show this map' });
      on.onchange = () => { chanOn[ch] = on.checked; resetPreviews(); applyMaterials(); renderSide(); };
      const kids = [on, thumb, h('span', { class: 'md-chname', title: CH.find((x) => x[0] === ch)[3] || label }, label)];
      if (ch === 'map') {
        const cur = tg[0] ? (M.cur.picks[tg[0].mat.uuid]?.color ?? tg[0].mat.color?.getHex() ?? GREY) : GREY;
        const col = h('input', { type: 'color', value: '#' + cur.toString(16).padStart(6, '0'), title: 'Color (used when there’s no picture, and tints it when there is)' });
        col.oninput = () => setColor(col.value);
        kids.push(col);
      }
      kids.push(h('span', { class: 'ctl-spacer' }),
        h('button', { class: 'icon-btn small', title: 'Choose a picture…', html: icon('image'), onclick: () => importMap(ch) }),
        h('button', { class: 'icon-btn small', title: 'No picture', html: icon('close'), disabled: !here.length, onclick: () => clearMap(ch) }),
        h('button', { class: 'icon-btn small', title: 'Back to the file’s own', html: icon('undo'), disabled: !picked, onclick: () => originalMap(ch) }));
      return h('div', { class: 'md-chan' + (chanOn[ch] ? '' : ' off') }, ...kids);
    });
    const mv = h('select', { class: 'md-sel', onchange: () => { mapView = mv.value; resetPreviews(); applyMapView(); renderBar(); need(); } },
      h('option', { value: 'none', selected: mapView === 'none' }, 'Everything together'), ...CH.map(([k, l]) => h('option', { value: k, selected: mapView === k }, `${l} only`)));
    side.append(sec('maps', 'Materials & textures',
      row('Change', tsel), c.mats.length > 1 && h('div', { class: 'md-hint' }, 'Tip: click a part of the model to pick its material.'),
      ...rows,
      row('Show', mv),
      row('Flip pictures', h('select', { class: 'md-sel', title: 'Pictures you choose: some models need them upside down', onchange: (e) => { P.flipY = e.target.value; savePrefs(); } }, ...[['auto', 'Automatic'], ['yes', 'Yes'], ['no', 'No']].map(([v, l]) => h('option', { value: v, selected: P.flipY === v }, l)))),
      h('div', { class: 'md-btns' }, h('button', { class: 'btn small', onclick: plainGrey, title: 'No pictures, default grey' }, 'No textures'), h('button', { class: 'btn small', onclick: resetAllMaterials, title: 'As the file has them' }, 'Reset materials'))));
  }

  const bgk = P.bg.kind;
  const col = h('input', { type: 'color', value: P.bg.color });
  col.oninput = () => { P.bg.color = col.value; P.bg.kind = 'color'; savePrefs(); applyBackground(); };
  side.append(sec('bg', 'Background',
    seg([['default', 'Default'], ['color', 'Color'], ['image', 'Picture']], bgk, async (v) => { if (v === 'image' && !P.bg.path) return pickBackground(); P.bg.kind = v; savePrefs(); await applyBackground(); renderSide(); }),
    bgk === 'color' && row('Color', col),
    bgk === 'image' && h('div', { class: 'md-file' }, h('span', { class: 'md-fname', title: P.bg.path }, nameOf(P.bg.path || '')), h('button', { class: 'btn small', onclick: pickBackground }, 'Change…')),
    bgk === 'image' && check('Wrap around (360° panorama)', P.bg.pano, (v) => { P.bg.pano = v; savePrefs(); applyBackground(); renderSide(); }, 'For panoramas and HDR pictures: the background turns with the model'),
    bgk === 'image' && P.bg.pano && check('Light the model with it', P.bg.light, (v) => { P.bg.light = v; savePrefs(); applyLights(); }),
    h('div', { class: 'md-btns' }, h('button', { class: 'btn small', disabled: bgk === 'default', onclick: () => { P.bg = { ...P.bg, kind: 'default', path: '', pano: false }; savePrefs(); applyBackground(); renderSide(); } }, 'No background'))));

  const ex = h('input', { type: 'range', min: 0.2, max: 3, step: 0.05, value: P.exposure });
  ex.oninput = () => { P.exposure = +ex.value; R.renderer.toneMappingExposure = P.exposure; savePrefs(); need(); };
  side.append(sec('light', 'Lighting',
    seg([['studio', 'Studio'], ['soft', 'Soft'], ['flat', 'Flat', 'Even light everywhere: good for checking textures']], P.light, (v) => { P.light = v; savePrefs(); applyLights(); renderSide(); }),
    row('Brightness', ex, h('button', { class: 'icon-btn small', title: 'Reset', html: icon('undo'), onclick: () => { P.exposure = 1; savePrefs(); applyLights(); renderSide(); } }))));

  if (c) {
    const i = c.info, s = i.size;
    const n = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
    const unit = CAD_EXTS.includes(c.ext) ? ' mm' : '';
    side.append(sec('info', 'About this model', h('div', { class: 'md-info' }, ...[
      ['File', nameOf(c.path)], ['Size', i.bytes != null ? fmtSize(i.bytes) : '…'], ['Format', c.ext.toUpperCase()],
      ['Dimensions', `${n(s.x)} × ${n(c.zUp && !c.flat ? s.z : s.y)} × ${n(c.zUp && !c.flat ? s.y : s.z)}${unit}`],
      ['Triangles', i.tris.toLocaleString()], ['Vertices', i.verts.toLocaleString()], ['Parts', (i.meshes + i.lines).toLocaleString()],
      ['Materials', String(c.mats.length)], ['Textures', String(i.textures)], ['Animations', String(i.animations)],
      c.missing?.length && ['Missing textures', c.missing.slice(0, 6).join(', ') + (c.missing.length > 6 ? '…' : '')],
    ].filter(Boolean).map(([k, v]) => h('div', { class: 'md-kv' }, h('span', {}, k), h('span', { title: v }, v))))));
  }
  side.append(sec('perf', 'Performance',
    seg([['auto', 'Automatic'], ['low', 'Light'], ['high', 'Best']], P.quality, (v) => { P.quality = v; savePrefs(); makeRenderer(); applyBackground(); renderSide(); }),
    h('div', { class: 'md-hint' }, lowEnd ? 'Light mode uses less detail so things stay smooth on slower PCs.' : 'Full quality. If it feels slow, choose Light.'),
    gpuName && h('div', { class: 'md-hint dim' }, gpuName)));
}
async function pickBackground() {
  if (!(await requirePro('model3d'))) return;
  const f = await api('dialog:openFiles', { title: 'Choose a background picture', filters: IMG_FILTER });
  if (!f?.length) return;
  P.bg.path = f[0]; P.bg.kind = 'image';
  if (['hdr', 'exr'].includes(extOf(f[0]))) P.bg.pano = true;
  else { try { const s = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im.naturalWidth / im.naturalHeight); im.onerror = no; im.src = texUrl(f[0]); }); if (Math.abs(s - 2) < 0.05) P.bg.pano = true; } catch {} }
  savePrefs(); await applyBackground(); renderSide();
}

// ---------------- bottom bar ----------------
function renderBar() {
  const bar = $('md-bar');
  const b = (ic, title, run, on, dis) => h('button', { class: 'pb' + (on ? ' on' : '') + (dis ? ' dim' : ''), title, html: icon(ic), onclick: run });
  const many = M.list.length > 1;
  bar.innerHTML = '';
  bar.append(...[
    b('open', 'Open… (Ctrl+O)', openDialog),
    many && b('pprev', 'Previous (←)', () => show(M.idx - 1)), many && b('pnext', 'Next (→)', () => show(M.idx + 1)),
    h('span', { class: 'bar-sep' }),
    b('refresh', 'Reset view (F)', () => frame(M.cur?.flat ? 'top' : 'iso')),
    b('cube', 'Turn slowly (R)', () => { P.autoRotate = !P.autoRotate; savePrefs(); renderBar(); need(); }, P.autoRotate),
    !M.cur?.lines && b('image', 'Textures (T)', () => { P.textures = !P.textures; savePrefs(); resetPreviews(); applyMaterials(); renderSide(); renderBar(); }, P.textures),
    !M.cur?.lines && b('hash', 'Wireframe on top (W)', () => { P.wire = !P.wire; savePrefs(); renderSide(); renderBar(); need(); }, P.wire),
    b('layout4', 'Grid (G)', () => { P.grid = !P.grid; if (R.grid) R.grid.visible = P.grid; savePrefs(); renderSide(); renderBar(); need(); }, P.grid),
    mapView !== 'none' && h('span', { class: 'md-chip' }, `Showing: ${CH.find((x) => x[0] === mapView)?.[1]}`, h('button', { html: icon('close'), title: 'Show everything', onclick: () => { mapView = 'none'; applyMapView(); renderSide(); renderBar(); need(); } })),
    h('span', { class: 'ctl-spacer' }),
    b('camera', 'Save a picture of the view', snapshot, false, !M.cur),
    M.cur && b('folder', 'Show in Dogfile', () => showInFiles(M.cur.path)),
    b('fullscreen', 'Full screen (F11)', toggleFs),
    b('sliders', 'Panel (P)', () => { P.side = !P.side; savePrefs(); renderSide(); setTimeout(resize, 30); }, P.side)].filter(Boolean));
}
async function toggleFs() { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('fs', !!document.fullscreenElement); setTimeout(resize, 60); });

async function snapshot() {
  if (!M.cur) return;
  const cv = R.renderer.domElement;
  draw();
  const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
  const g = out.getContext('2d');
  const bgEl = $('md-bg');
  if (P.bg.kind === 'image' && !P.bg.pano && P.bg.path) {
    try {
      const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = texUrl(P.bg.path); });
      const k = Math.max(out.width / im.naturalWidth, out.height / im.naturalHeight);
      g.drawImage(im, (out.width - im.naturalWidth * k) / 2, (out.height - im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k);
    } catch {}
    draw();
  } else if (P.bg.kind === 'default') { g.fillStyle = getComputedStyle(bgEl).backgroundColor || '#1a1b1f'; g.fillRect(0, 0, out.width, out.height); }
  g.drawImage(cv, 0, 0);
  const data = out.toDataURL('image/png');
  const dir = M.cur.path.replace(/[\\/][^\\/]*$/, ''), stem = nameOf(M.cur.path).replace(/\.[^.]+$/, '');
  try {
    const target = await api('fs:uniqueName', dir, `${stem} (view).png`, 'number');
    await api('fs:writeDataUrl', target, data);
    toast(`Saved ${nameOf(target)}`, { action: { label: 'Show', run: () => showInFiles(target) } });
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------------- busy, errors, messages ----------------
function busy(msg, frac) {
  const b = $('md-busy');
  b.classList.toggle('show', !!msg);
  if (msg) b.querySelector('.msg').textContent = msg;
  b.classList.toggle('prog', frac != null);
  if (frac != null) b.querySelector('.bar i').style.width = `${Math.round(frac * 100)}%`;
}
function setErr(node) { const e = $('md-err'); e.innerHTML = ''; e.classList.toggle('show', !!node); if (node) e.append(node); }
let osdT = 0;
function osd(t) { const o = $('md-osd'); o.textContent = t; o.classList.add('show'); clearTimeout(osdT); osdT = setTimeout(() => o.classList.remove('show'), 2600); }
function failed(path, e) {
  disposeModel(M.cur); M.cur = null; setupAnim([]); renderSide(); renderBar(); need();
  if (e.code === 'NO_CAD') {
    return setErr(h('div', { class: 'md-errbox' }, h('div', { class: 'err-title' }, 'One more step for CAD files'),
      h('div', { class: 'err-msg' }, 'CAD files need a small add-on (about 8 MB). Dogfile downloads it once.'),
      h('button', { class: 'btn primary', onclick: async () => {
        setErr(null);
        try { await installCad((got, total) => busy('Downloading the CAD reader…', total ? got / total : null)); busy(null); show(M.idx); }
        catch (err) { busy(null); setErr(h('div', { class: 'md-errbox' }, h('div', { class: 'err-title' }, 'Couldn’t download it'), h('div', { class: 'err-msg' }, err.message), h('button', { class: 'btn', onclick: () => show(M.idx) }, 'Try again'))); }
      } }, 'Download and open')));
  }
  if (e.code === 'NO_ODA') {
    return setErr(h('div', { class: 'md-errbox' }, h('div', { class: 'err-title' }, 'DWG needs a free converter'),
      h('div', { class: 'err-msg' }, 'Install the free ODA File Converter and Dogfile will use it to open DWG drawings. Saving the drawing as DXF works too.'),
      h('div', { class: 'md-btns' },
        h('button', { class: 'btn primary', onclick: () => api('shell:openExternal', 'https://www.opendesign.com/guestfiles/oda_file_converter') }, 'Get ODA File Converter'),
        h('button', { class: 'btn', onclick: async () => { const f = await api('dialog:openFiles', { title: 'Where is ODAFileConverter?', filters: sys.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [] }); if (f?.length) { settings.odaConverter = f[0]; await api('store:set', 'settings', settings); show(M.idx); } } }, 'It’s installed…'),
        h('button', { class: 'btn', onclick: () => show(M.idx) }, 'Try again'))));
  }
  setErr(h('div', { class: 'md-errbox' }, h('div', { class: 'err-title' }, `Couldn’t open ${nameOf(path)}`), h('div', { class: 'err-msg' }, e.message || String(e)),
    M.list.length > 1 && h('button', { class: 'btn', onclick: () => show(M.idx + 1) }, 'Next file')));
}

// ---------------- files ----------------
async function setQueue(files, { autoPlaylist = false, append = false } = {}) {
  files = (files || []).filter(isModel);
  if (!files.length) { if (!M.list.length) $('md-empty').style.display = ''; return toast('Those aren’t 3D files Dogfile can open', { error: true }); }
  if (append) { const at = M.list.length; M.list.push(...files.filter((f) => !M.list.includes(f))); return show(at); }
  let start = 0;
  if (autoPlaylist && files.length === 1) {
    // one file: its neighbors in the folder come along, so ← and → go through them
    const dir = files[0].replace(/[\\/][^\\/]*$/, '');
    const r = await api('fs:list', dir).catch(() => null);
    const sibs = (r?.items || []).filter((i) => !i.isDir && isModel(i.name)).map((i) => i.path).sort((a, b) => natCmp(nameOf(a), nameOf(b)));
    if (sibs.includes(files[0])) { start = sibs.indexOf(files[0]); files = sibs; }
  }
  M.list = files;
  return show(start);
}
async function openDialog() {
  const f = await api('dialog:openFiles', { title: 'Open 3D files', filters: [{ name: '3D files', extensions: MODEL_EXTS }] });
  if (f?.length) setQueue(f, { autoPlaylist: f.length === 1 });
}

function wire() {
  $('md-open').onclick = openDialog;
  new ResizeObserver(() => resize()).observe($('md-view'));
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let hd = true;
    if (e.ctrlKey && k === 'o') openDialog();
    else if (e.ctrlKey || e.altKey || e.metaKey) hd = false;
    else if (k === ' ') togglePlay();
    else if (k === 'f') frame(M.cur?.flat ? 'top' : 'iso');
    else if (k === 'w') { P.wire = !P.wire; savePrefs(); renderSide(); renderBar(); need(); }
    else if (k === 't') { P.textures = !P.textures; savePrefs(); resetPreviews(); applyMaterials(); renderSide(); renderBar(); }
    else if (k === 'g') { P.grid = !P.grid; if (R.grid) R.grid.visible = P.grid; savePrefs(); renderSide(); renderBar(); need(); }
    else if (k === 'r') { P.autoRotate = !P.autoRotate; savePrefs(); renderBar(); need(); }
    else if (k === 'p') { P.side = !P.side; savePrefs(); renderSide(); setTimeout(resize, 30); }
    else if (k === '1') frame('front'); else if (k === '3') frame('right'); else if (k === '7') frame('top'); else if (k === '5') frame('iso');
    else if (k === 'ArrowLeft' && M.list.length > 1) show(M.idx - 1);
    else if (k === 'ArrowRight' && M.list.length > 1) show(M.idx + 1);
    else if (k === 'F11') toggleFs();
    else hd = false;
    if (hd) e.preventDefault();
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.atlas?.pathForFile?.(f)).filter(Boolean);
    if (!paths.length) return;
    // a picture dropped on the model: use it as the base color; elsewhere it's ignored
    const pics = paths.filter((p) => /\.(png|jpe?g|webp|bmp|tga|dds|psd|tiff?|exr|hdr)$/i.test(p));
    const models = paths.filter(isModel);
    if (models.length) setQueue(models, { autoPlaylist: models.length === 1 });
    else if (pics.length && M.cur && !M.cur.lines) (async () => { if (!(await requirePro('model3d'))) return; busy('Loading the picture…'); try { const tex = await loadTexture(pics[0], 'map'); for (const x of targets()) { const per = (M.cur.picks[x.mat.uuid] ||= {}); per.map = tex; delete per.color; } chanOn.map = true; P.textures = true; resetPreviews(); applyMaterials(); renderSide(); } catch (err) { toast(err.message, { error: true }); } busy(null); })();
  });
}

function applyMediaTheme() {
  const dark = applyColors(mediaSettings(settings));
  if (!EMBED && sys?.platform === 'win32') api('win:overlay', dark ? { color: '#101012', symbolColor: '#c9cacc' } : { color: getComputedStyle(document.documentElement).getPropertyValue('--tabbar').trim() || '#efeff0', symbolColor: '#3a3a3a' });
}
async function boot() {
  sys = await api('sys:info');
  document.body.classList.toggle('win-overlay', sys.platform === 'win32' && !EMBED);
  const st = await api('store:get', 'settings');
  if ((st?.language || 'auto') !== 'en') import('./i18n.js').then((m) => m.initI18n(st?.language || 'auto')).catch(() => {});
  settings = { ...DEFAULT_SETTINGS, ...(st || {}) };
  setNativeDialogs(settings.nativeDialogs);
  applyMediaTheme();
  const saved = await api('store:get', 'model3d-prefs').catch(() => null);
  if (saved) P = { ...P, ...saved, bg: { ...P.bg, ...(saved.bg || {}) }, open: { ...P.open, ...(saved.open || {}) } };
  if ((sys.platform !== 'win32' || sys.customControls) && !EMBED) {
    const wc = $('win-ctl');
    const mk = (ic, act, title) => { const b = h('button', { class: 'wc-btn ' + act, title, html: icon(ic) }); b.addEventListener('click', () => api('win:control', act)); return b; };
    wc.append(mk('min', 'min', 'Minimize'), mk('max', 'max', 'Maximize'), mk('close', 'close', 'Close'));
  }
  T = await three();
  probeGpu();
  makeRenderer();
  await applyBackground();
  wire(); renderSide(); renderBar();
  const pending = await pendingFiles();
  if (pending?.files?.length) await setQueue(pending.files, { autoPlaylist: !!pending.autoPlaylist || pending.files.length === 1 });
  document.body.classList.add('ready');
}
onMain('model:open', ({ files, autoPlaylist }) => setQueue(files, { autoPlaylist: autoPlaylist || files.length === 1 }));
onMain('settings:changed', (s) => { settings = { ...settings, ...s }; applyMediaTheme(); });
onHost({ open: (m) => setQueue(m.files, { autoPlaylist: m.autoPlaylist || m.files.length === 1, append: !!m.append }), cmd: (id) => ({ frame: () => frame('iso'), wire: () => { P.wire = !P.wire; renderBar(); need(); }, textures: () => { P.textures = !P.textures; applyMaterials(); renderBar(); }, snapshot, play: togglePlay }[id]?.()), settings: (s) => { settings = { ...settings, ...s }; applyMediaTheme(); } });
onAsk(async (op) => {
  if (op === 'context') return { ok: true, name: M.cur ? nameOf(M.cur.path) : '', path: M.cur?.path || '', triangles: M.cur?.info.tris, materials: M.cur?.mats.length, animations: M.cur?.anim?.clips.length || 0 };
  return { ok: false, msg: `I can’t do “${op}” in Dogfile 3D yet` };
});
// closing: give the graphics memory back straight away instead of whenever the browser gets round to it
window.addEventListener('pagehide', () => {
  try {
    cancelAnimationFrame(raf);
    disposeModel(M.cur); M.cur = null;
    R?.env?.dispose(); R?.pano?.dispose();
    R?.renderer?.dispose(); R?.renderer?.forceContextLoss?.();
    import('./model-load.js').then((m) => m.stopCad?.()).catch(() => {});
  } catch {}
});
window.__m3d = { M, get P() { return P; }, get R() { return R; }, show, setQueue, frame, importMap, loadTexture, targets, applyMaterials, chanOn, setMap: (v) => { mapView = v; resetPreviews(); applyMapView(); renderBar(); need(); }, applyBackground, snapshot, draw };
boot().then(() => initLicense({ test: true })).catch((e) => { console.error(e); document.body.innerHTML = `<pre style="padding:20px;color:#f66">${esc(e.stack || e.message)}</pre>`; });
