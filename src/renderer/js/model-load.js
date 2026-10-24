// Loading 3D files for Dogfile 3D and the details pane: every format three.js reads (glTF/GLB, FBX, OBJ+MTL,
// STL, PLY, 3MF, Collada, 3DS, USDZ, VRML, AMF), CAD through OpenCascade (STEP, IGES, BREP: fetched once, in a
// worker so the window never freezes), DXF drawings, and DWG through the ODA File Converter when installed.
// Textures the model refers to are found next to it even when the file holds the artist's own folders
// (C:\Users\someone\textures\wood.png → wood.png beside the model, or in a textures folder near it).
import { api, fileUrl, decodedUrl, DECODED_IMG } from './core.js';

export const MESH_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', '3mf', 'dae', '3ds', 'usdz', 'wrl', 'vrml', 'amf'];
export const CAD_EXTS = ['step', 'stp', 'iges', 'igs', 'brep', 'brp'];
export const DRAWING_EXTS = ['dxf', 'dwg'];
export const MODEL_EXTS = [...MESH_EXTS, ...CAD_EXTS, ...DRAWING_EXTS];
// files usually drawn with Z pointing up (3D printing, CAD)
const Z_UP = new Set(['stl', '3mf', 'amf', 'step', 'stp', 'iges', 'igs', 'brep', 'brp']);
const IMG = /\.(png|jpe?g|gif|webp|bmp|tga|dds|psd|tiff?|exr|hdr|ktx2?)$/i;

const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = (p) => p.split(/[\\/]/).pop();

let T = null;
export async function three() { return T || (T = await import('../vendor/three3d.js')); }

/** pictures near the model, by name: the model's folder, its subfolders, and texture folders beside it */
async function textureIndex(dir) {
  const idx = new Map(), full = new Map();
  const add = (it) => { if (!it.isDir && IMG.test(it.name)) { const k = it.name.toLowerCase(); if (!idx.has(k)) idx.set(k, it.path); full.set(it.path.toLowerCase(), it.path); } };
  const list = async (d) => (await api('fs:list', d).catch(() => null))?.items || [];
  const top = await list(dir);
  top.forEach(add);
  const subs = top.filter((i) => i.isDir).slice(0, 30);
  await Promise.all(subs.map(async (s) => (await list(s.path)).forEach(add)));
  // ../textures, ../Textures, ../maps next to the model's folder
  const up = dirOf(dir);
  if (up && up !== dir) {
    const sib = (await list(up)).filter((i) => i.isDir && /^(tex|textures?|maps?|images?|materials?)$/i.test(i.name));
    await Promise.all(sib.map(async (s) => (await list(s.path)).forEach(add)));
  }
  return { idx, full };
}

/** a LoadingManager whose relative and foreign texture paths land on real files */
async function managerFor(path, { maxTex = 4096 } = {}) {
  const T = await three();
  const dir = dirOf(path), sep = sepOf(path);
  const { idx, full } = await textureIndex(dir).catch(() => ({ idx: new Map(), full: new Map() }));
  const urlFor = (p) => {
    const e = extOf(p);
    // TGA has its own reader (models also carry TGA inside them); other pictures the web view can't show are decoded
    return DECODED_IMG.has(e) && e !== 'tga' ? decodedUrl(p, maxTex) : fileUrl(p);
  };
  const mgr = new T.LoadingManager();
  const missing = new Set();
  mgr.setURLModifier((u) => {
    if (!u || /^(data|blob):/.test(u) || u.startsWith('/f/?') || u.startsWith('/img?') || /^https?:/.test(u)) return u;
    let rel = u.startsWith('/f/') ? u.slice(3) : u;
    try { rel = decodeURIComponent(rel); } catch {}
    const norm = rel.replace(/[\\/]+/g, sep);
    const abs = /^([a-z]:|[\\/])/i.test(norm);
    const joined = abs ? norm : dir + sep + norm.replace(/^\.[\\/]/, '');
    const hit = full.get(joined.toLowerCase()) || idx.get(baseOf(norm).toLowerCase());
    if (hit) return urlFor(hit);
    if (IMG.test(norm)) missing.add(baseOf(norm));
    return urlFor(joined);
  });
  mgr.addHandler(/\.tga$/i, new T.TGALoader(mgr));
  // textures keep arriving after the model: settled() waits for the last one (or 20 s)
  let pending = 0;
  const start = mgr.itemStart.bind(mgr), end = mgr.itemEnd.bind(mgr);
  mgr.itemStart = (u) => { pending++; start(u); };
  mgr.itemEnd = (u) => { pending--; end(u); };
  const settled = () => new Promise((res) => { const t0 = Date.now(); const chk = () => (pending <= 0 || Date.now() - t0 > 20000 ? res() : setTimeout(chk, 150)); chk(); });
  return { mgr, missing, settled };
}

// ---------------- CAD: OpenCascade in a worker ----------------
let cadWorker = null, cadSeq = 0;
const cadWaiting = new Map();
/** whether the CAD reader is here; install() fetches it (about 8 MB), calling progress(received, total) */
export async function cadReady() { return !!(await api('m3d:cadStatus').catch(() => ({})))?.ready; }
export async function installCad(progress) {
  let s = await api('m3d:cadInstall');
  if (s?.ready) return true;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    s = await api('m3d:cadStatus');
    progress?.(s.received || 0, s.total || 0);
    if (s.ready) return true;
    if (!s.downloading) throw new Error(s.error || 'The CAD reader couldn’t be downloaded');
  }
}
/** the CAD worker holds 50+ MB once used: stopped when the viewer closes */
export function stopCad() { cadWorker?.terminate(); cadWorker = null; }
async function readCad(path, ext, { quality = 'normal' } = {}) {
  const st = await api('m3d:cadStatus');
  if (!st?.ready) { const e = new Error('The CAD reader isn’t installed yet'); e.code = 'NO_CAD'; throw e; }
  const sep = sepOf(st.dir);
  const abs = (p) => new URL(fileUrl(p), location.href).href;
  if (!cadWorker) {
    cadWorker = new Worker(new URL('./occt-worker.js', import.meta.url));
    cadWorker.onmessage = (e) => { const w = cadWaiting.get(e.data.id); if (w) { cadWaiting.delete(e.data.id); e.data.ok ? w.ok(e.data.result) : w.fail(new Error(e.data.error)); } };
    cadWorker.onerror = (e) => { for (const w of cadWaiting.values()) w.fail(new Error(e.message || 'The CAD reader stopped')); cadWaiting.clear(); cadWorker = null; };
  }
  const buf = await (await fetch(fileUrl(path))).arrayBuffer();
  const format = ext === 'stp' ? 'step' : ext === 'igs' ? 'iges' : ext === 'brp' ? 'brep' : ext;
  // finer triangles look better; coarser ones keep big assemblies light on slow computers
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: quality === 'low' ? 0.004 : 0.001, angularDeflection: quality === 'low' ? 0.8 : 0.5 };
  const id = ++cadSeq;
  const result = await new Promise((ok, fail) => {
    cadWaiting.set(id, { ok, fail });
    cadWorker.postMessage({ id, jsUrl: abs(st.dir + sep + 'occt-import-js.js'), wasmUrl: abs(st.dir + sep + 'occt-import-js.wasm'), buffer: buf, format, params }, [buf]);
  });
  if (!result?.success) throw new Error('This CAD file couldn’t be read');
  const T = await three();
  const group = new T.Group();
  const mats = new Map();
  const matFor = (c) => { const k = c ? c.join(',') : 'none'; if (!mats.has(k)) mats.set(k, new T.MeshStandardMaterial({ color: c ? new T.Color(c[0], c[1], c[2]) : 0xb8bcc6, metalness: 0.15, roughness: 0.55, side: T.DoubleSide, name: c ? `Color ${k}` : 'Part' })); return mats.get(k); };
  const build = (node, parent) => {
    const g = new T.Group(); g.name = node.name || '';
    for (const mi of node.meshes || []) {
      const m = result.meshes[mi];
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(m.attributes.position.array, 3));
      if (m.attributes.normal) geo.setAttribute('normal', new T.Float32BufferAttribute(m.attributes.normal.array, 3));
      geo.setIndex(m.index.array);
      if (!m.attributes.normal) geo.computeVertexNormals();
      // faces can have their own colors: one group per run of a color
      let mat = matFor(m.color);
      const faces = m.brep_faces || [];
      if (faces.some((f) => f.color)) {
        const list = [];
        const id2 = new Map();
        for (const f of faces) {
          const c = f.color || m.color;
          const k = c ? c.join(',') : 'none';
          if (!id2.has(k)) { id2.set(k, list.length); list.push(matFor(c)); }
          geo.addGroup(f.first * 3, (f.last - f.first + 1) * 3, id2.get(k));
        }
        mat = list;
      }
      const mesh = new T.Mesh(geo, mat); mesh.name = m.name || '';
      g.add(mesh);
    }
    for (const c of node.children || []) build(c, g);
    parent.add(g);
  };
  build(result.root, group);
  return group;
}

// ---------------- DXF drawings ----------------
async function readDxf(path) {
  const T = await three();
  const text = await (await fetch(fileUrl(path))).text();
  const dxf = new T.DxfParser().parseSync(text);
  const layers = dxf?.tables?.layer?.layers || {};
  const lines = [], lcol = [], faces = [], fcol = [], pts = [], pcol = [];
  let skipped = 0;
  const colorOf = (e) => { const c = e.color ?? layers[e.layer]?.color ?? 0xffffff; return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]; };
  const seg = (a, b, c) => { lines.push(a.x, a.y, a.z, b.x, b.y, b.z); lcol.push(...c, ...c); };
  const poly = (ps, c, closed) => { for (let i = 0; i + 1 < ps.length; i++) seg(ps[i], ps[i + 1], c); if (closed && ps.length > 2) seg(ps[ps.length - 1], ps[0], c); };
  const arcPts = (cx, cy, z, r, a0, a1, rx, ry, rot = 0) => {
    while (a1 <= a0) a1 += Math.PI * 2;
    const n = Math.max(8, Math.min(256, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96)));
    const out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; const x = (rx ?? r) * Math.cos(a), y = (ry ?? r) * Math.sin(a); out.push(new T.Vector3(cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot), z)); }
    return out;
  };
  // a polyline segment with a bulge is an arc
  const bulgePts = (a, b, bulge) => {
    if (!bulge) return [a, b];
    const th = 4 * Math.atan(bulge), d = Math.hypot(b.x - a.x, b.y - a.y), r = d / (2 * Math.sin(th / 2));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2)) * Math.sign(bulge) * (Math.abs(th) > Math.PI ? -1 : 1);
    const cx = mx - (h * (b.y - a.y)) / d, cy = my + (h * (b.x - a.x)) / d;
    let a0 = Math.atan2(a.y - cy, a.x - cx), a1 = Math.atan2(b.y - cy, b.x - cx);
    const ps = bulge > 0 ? arcPts(cx, cy, a.z || 0, Math.abs(r), a0, a1) : arcPts(cx, cy, a.z || 0, Math.abs(r), a1, a0).reverse();
    return ps;
  };
  const V = (p, m) => new T.Vector3(p?.x || 0, p?.y || 0, p?.z || 0).applyMatrix4(m);
  const draw = (ents, m, depth) => {
    for (const e of ents || []) {
      const c = colorOf(e);
      switch (e.type) {
        case 'LINE': seg(V(e.vertices[0], m), V(e.vertices[1], m), c); break;
        case 'LWPOLYLINE': case 'POLYLINE': {
          const vs = e.vertices || [];
          if (e.is3dPolyline || e.type === 'POLYLINE' && vs.some((v) => v.faces)) { poly(vs.map((v) => V(v, m)), c, e.shape); break; }
          const ps = [];
          for (let i = 0; i < vs.length; i++) {
            const a = vs[i], b = vs[(i + 1) % vs.length];
            if (i === vs.length - 1 && !e.shape) { ps.push(V(a, m)); break; }
            const arc = bulgePts(new T.Vector3(a.x, a.y, a.z || 0), new T.Vector3(b.x, b.y, b.z || 0), a.bulge || 0);
            arc.slice(0, -1).forEach((p) => ps.push(p.applyMatrix4(m)));
            if (i === vs.length - 1) ps.push(V(b, m));
          }
          poly(ps, c, false);
          break;
        }
        case 'CIRCLE': poly(arcPts(e.center.x, e.center.y, e.center.z || 0, e.radius, 0, Math.PI * 2).map((p) => p.applyMatrix4(m)), c, false); break;
        case 'ARC': poly(arcPts(e.center.x, e.center.y, e.center.z || 0, e.radius, e.startAngle, e.endAngle).map((p) => p.applyMatrix4(m)), c, false); break;
        case 'ELLIPSE': {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, R = Math.hypot(mx, my);
          poly(arcPts(e.center.x, e.center.y, e.center.z || 0, R, e.startAngle ?? 0, e.endAngle ?? Math.PI * 2, R, R * e.axisRatio, Math.atan2(my, mx)).map((p) => p.applyMatrix4(m)), c, false);
          break;
        }
        case 'SPLINE': {
          const fp = e.fitPoints?.length > 1 ? e.fitPoints : null;
          if (fp) { const cv = new T.CatmullRomCurve3(fp.map((p) => new T.Vector3(p.x, p.y, p.z || 0))); poly(cv.getPoints(Math.min(400, fp.length * 12)).map((p) => p.applyMatrix4(m)), c, false); }
          else if (e.controlPoints?.length > 1) poly(bspline(e.controlPoints, e.degreeOfSplineCurve || 3, e.knotValues).map((p) => V(p, m)), c, false);
          break;
        }
        case 'POINT': { const p = V(e.position, m); pts.push(p.x, p.y, p.z); pcol.push(...c); break; }
        case '3DFACE': case 'SOLID': {
          const vs = e.vertices || e.points || [];
          if (vs.length < 3) break;
          const q = vs.map((v) => V(v, m));
          // SOLID corners are listed in a Z order
          if (e.type === 'SOLID' && q.length === 4) [q[2], q[3]] = [q[3], q[2]];
          const tri = (a, b, d) => { faces.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z); fcol.push(...c, ...c, ...c); };
          tri(q[0], q[1], q[2]);
          if (q.length === 4 && !q[3].equals(q[2])) tri(q[0], q[2], q[3]);
          break;
        }
        case 'INSERT': {
          const b = dxf.blocks?.[e.name];
          if (!b || depth > 8) break;
          const mm = new T.Matrix4().compose(
            new T.Vector3(e.position?.x || 0, e.position?.y || 0, e.position?.z || 0),
            new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), ((e.rotation || 0) * Math.PI) / 180),
            new T.Vector3(e.xScale ?? 1, e.yScale ?? 1, e.zScale ?? 1));
          const base = new T.Matrix4().makeTranslation(-(b.position?.x || 0), -(b.position?.y || 0), -(b.position?.z || 0));
          draw(b.entities, m.clone().multiply(mm).multiply(base), depth + 1);
          break;
        }
        default: skipped++;
      }
    }
  };
  draw(dxf.entities, new T.Matrix4(), 0);
  const g = new T.Group();
  if (lines.length) { const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(lines, 3)); geo.setAttribute('color', new T.Float32BufferAttribute(lcol, 3)); g.add(new T.LineSegments(geo, new T.LineBasicMaterial({ vertexColors: true, name: 'Lines' }))); }
  if (faces.length) { const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(faces, 3)); geo.setAttribute('color', new T.Float32BufferAttribute(fcol, 3)); geo.computeVertexNormals(); g.add(new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, side: T.DoubleSide, name: 'Faces' }))); }
  if (pts.length) { const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pts, 3)); geo.setAttribute('color', new T.Float32BufferAttribute(pcol, 3)); g.add(new T.Points(geo, new T.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false }))); }
  if (!g.children.length) throw new Error('This drawing has nothing Dogfile can draw (text and hatches aren’t shown)');
  return g;
}
// a B-spline from its control points (de Boor), for splines saved without fit points
function bspline(cp, k, knots) {
  const n = cp.length;
  k = Math.min(k, n - 1);
  if (!knots || knots.length !== n + k + 1) { knots = []; for (let i = 0; i < n + k + 1; i++) knots.push(i <= k ? 0 : i >= n ? n - k : i - k); }
  const lo = knots[k], hi = knots[n], out = [];
  const steps = Math.min(400, n * 16);
  for (let s = 0; s <= steps; s++) {
    const t = lo + ((hi - lo) * s) / steps;
    let i = k; while (i < n - 1 && t >= knots[i + 1]) i++;
    const d = []; for (let j = 0; j <= k; j++) { const p = cp[i - k + j]; d.push([p.x, p.y, p.z || 0]); }
    for (let r = 1; r <= k; r++) for (let j = k; j >= r; j--) {
      const a = (t - knots[i - k + j]) / ((knots[i + 1 + j - r] - knots[i - k + j]) || 1);
      d[j] = d[j].map((v, q) => (1 - a) * d[j - 1][q] + a * v);
    }
    out.push({ x: d[k][0], y: d[k][1], z: d[k][2] });
  }
  return out;
}

/**
 * Load a 3D file. Answers { object, animations, zUp, flat, gltf, missing: Set of texture names not found,
 * settled(): resolves once the textures have arrived or failed }.
 * opts: { maxTex, quality: 'low'|'normal' }
 */
export async function loadModel(path, opts = {}) {
  const T = await three();
  const ext = extOf(path);
  const url = fileUrl(path);
  let object, animations = [], flat = false, gltf = false, missing = new Set(), settled = async () => {};
  if (CAD_EXTS.includes(ext)) object = await readCad(path, ext, opts);
  else if (ext === 'dxf') { object = await readDxf(path); flat = true; }
  else if (ext === 'dwg') {
    let dxf;
    try { dxf = await api('m3d:dwgToDxf', path); } catch (e) { if (/NO_ODA/.test(e.message)) { const x = new Error('DWG drawings need the free ODA File Converter'); x.code = 'NO_ODA'; throw x; } throw e; }
    object = await readDxf(dxf); flat = true;
  } else {
    const M = await managerFor(path, opts);
    const mgr = M.mgr; missing = M.missing; settled = M.settled;
    if (ext === 'glb' || ext === 'gltf') {
      const L = new T.GLTFLoader(mgr);
      const draco = new T.DRACOLoader(mgr); draco.setDecoderPath(new URL('../vendor/draco/', import.meta.url).href); L.setDRACOLoader(draco);
      L.setMeshoptDecoder(T.MeshoptDecoder);
      const r = await L.loadAsync(url);
      object = r.scene; animations = r.animations || []; gltf = true;
      draco.dispose();
    } else if (ext === 'fbx') { object = await new T.FBXLoader(mgr).loadAsync(url); animations = object.animations || []; }
    else if (ext === 'obj') {
      const text = await (await fetch(url)).text();
      const L = new T.OBJLoader(mgr);
      // materials: the .mtl the file names, or one with the same name beside it
      const names = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
      const cands = [...names, baseOf(path).replace(/\.obj$/i, '.mtl')];
      for (const n of cands) {
        try { const mtl = await new T.MTLLoader(mgr).loadAsync('/f/' + encodeURIComponent(n).replace(/%2F/gi, '/')); mtl.preload(); L.setMaterials(mtl); break; } catch {}
      }
      object = L.parse(text);
    } else if (ext === 'stl' || ext === 'ply') {
      const geo = await (ext === 'stl' ? new T.STLLoader(mgr) : new T.PLYLoader(mgr)).loadAsync(url);
      // a PLY without faces is a point cloud (3D scans)
      if (ext === 'ply' && !geo.index) {
        object = new T.Points(geo, new T.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!geo.attributes.color, color: geo.attributes.color ? 0xffffff : 0xb8bcc6, name: 'Points' }));
      } else {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        object = new T.Mesh(geo, new T.MeshStandardMaterial({ color: geo.attributes.color ? 0xffffff : 0xb8bcc6, metalness: 0.1, roughness: 0.6, vertexColors: !!geo.attributes.color, name: 'Surface' }));
      }
    } else if (ext === '3mf') object = await new T.ThreeMFLoader(mgr).loadAsync(url);
    else if (ext === 'dae') { const r = await new T.ColladaLoader(mgr).loadAsync(url); object = r.scene; animations = r.scene.animations || r.animations || []; }
    else if (ext === '3ds') { const L = new T.TDSLoader(mgr); L.setResourcePath('/f/'); object = await L.loadAsync(url); }
    else if (ext === 'usdz') object = await new T.USDZLoader(mgr).loadAsync(url);
    else if (ext === 'wrl' || ext === 'vrml') object = await new T.VRMLLoader(mgr).loadAsync(url);
    else if (ext === 'amf') object = await new T.AMFLoader(mgr).loadAsync(url);
    else throw new Error(`.${ext} files can’t be shown`);
  }
  if (!object) throw new Error('Nothing to show in this file');
  return { object, animations, zUp: Z_UP.has(ext), flat, gltf, missing, settled };
}
