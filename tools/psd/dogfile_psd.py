#!/usr/bin/env python3
"""Dogfile's Photoshop helper. A small program the Rust backend runs (backend/src/psd.rs) to read and write layered
PSD / PSB files with psd-tools, which keeps everything it doesn't change (text, smart objects, effects, adjustment
layers, masks, ICC profiles) exactly as it was.

    dogfile_psd.py version
    dogfile_psd.py info   <file> <out dir>        layers (with a PNG of each) + the flattened picture, as JSON
    dogfile_psd.py raw    <file> <out dir> <id>   one layer's own pixels, as PNG, for editing
    dogfile_psd.py render <file> <out.png> [--hide 1,2] [--show 3] [--max 2000]   the real composite with layers shown / hidden
    dogfile_psd.py save   <spec.json>             apply changes and write the file

Layer ids are the position of the layer in a top-to-bottom walk of the whole tree (groups first, then what is inside
them); the same file always gives the same ids. Everything is printed as one JSON object on stdout:
{"ok": true, ...} or {"ok": false, "error": "..."}.
"""
import json
import os
import sys
import tempfile
import traceback

VERSION = "1.0"
# a layer's pixels are only written out when the picture is not enormous
MAX_PIXELS = 700_000_000


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def fail(msg, **extra):
    out({"ok": False, "error": str(msg), **extra})
    sys.exit(0)


def load(path):
    from psd_tools import PSDImage
    return PSDImage.open(path)


def walk(psd):
    """every layer, groups before what is in them (the id of a layer is its place in this list)"""
    return list(psd.descendants())


def mode_name(psd):
    return str(getattr(psd.color_mode, "name", psd.color_mode))


def kind_of(layer):
    k = layer.kind
    return str(k)


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def layer_png(layer):
    """what the layer looks like on its own (mask and effects applied), as a PIL image the size of its box"""
    if layer.is_group():
        return None
    w, h = layer.width, layer.height
    if w <= 0 or h <= 0:
        return None
    img = safe(lambda: layer.composite(layer.bbox))
    if img is None:
        img = safe(lambda: layer.topil())
    if img is None:
        return None
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return img


def info(path, outdir):
    from PIL import Image  # noqa: F401  (psd-tools needs it; fail here, with a clear message, if it is missing)
    psd = load(path)
    os.makedirs(outdir, exist_ok=True)
    layers = walk(psd)
    ids = {id(l): i for i, l in enumerate(layers)}
    warnings = []
    big = psd.width * psd.height * max(1, len(layers)) > MAX_PIXELS
    if big:
        warnings.append("This is a very large file, so the layers are not drawn one by one. Use the accurate preview.")
    rows = []
    for i, l in enumerate(layers):
        kind = kind_of(l)
        png = None
        if not l.is_group() and not big:
            img = layer_png(l)
            if img is not None:
                png = f"layer-{i}.png"
                img.save(os.path.join(outdir, png))
        parent = l.parent
        rows.append({
            "id": i,
            "name": l.name,
            "kind": kind,
            "isGroup": bool(l.is_group()),
            "visible": bool(l.visible),
            "opacity": int(l.opacity),
            "blend": str(getattr(l.blend_mode, "name", l.blend_mode)),
            "clipping": bool(safe(lambda: l.clipping, False)),
            "left": int(l.left), "top": int(l.top), "width": int(l.width), "height": int(l.height),
            "png": png,
            "parent": ids.get(id(parent)) if parent is not None and parent is not psd else None,
            "hasMask": bool(safe(lambda: l.has_mask(), False)),
            "hasEffects": bool(safe(lambda: l.has_effects(), False)),
            "locked": bool(safe(lambda: l.lock is not None and (l.lock.transparency or l.lock.composite or l.lock.position), False)) if hasattr(l, "lock") else False,
            # only plain pixel layers can be edited without changing what they are
            "editable": kind == "pixel",
        })
    # the flattened picture, as Photoshop (or the file) stored it
    comp = safe(lambda: psd.composite()) or safe(lambda: psd.composite(apply_icc=False))
    if comp is None:
        comp = safe(lambda: psd.topil())
    comp_name = None
    if comp is not None:
        comp = comp.convert("RGBA")
        comp_name = "composite.png"
        comp.save(os.path.join(outdir, comp_name))
    adjust = [r["id"] for r in rows if r["kind"] in ("adjustment", "fill", "gradientfill", "patternfill", "solidcolorfill") or "adjust" in r["kind"].lower()]
    ok_edit = mode_name(psd) in ("RGB",)
    if not ok_edit:
        warnings.append(f"This file is in {mode_name(psd)} colour, so it can be looked at but not edited here.")
    out({
        "ok": True, "width": psd.width, "height": psd.height, "depth": int(psd.depth), "mode": mode_name(psd),
        "version": int(psd.version), "dir": outdir, "composite": comp_name, "layers": rows,
        "adjustmentIds": adjust, "canEdit": ok_edit, "warnings": warnings,
        "hasLayers": len(layers) > 0,
    })


def raw(path, outdir, idx):
    psd = load(path)
    layers = walk(psd)
    if not 0 <= idx < len(layers):
        fail("No such layer")
    l = layers[idx]
    img = safe(lambda: l.topil())
    if img is None:
        fail("This layer has no pixels of its own to edit")
    img = img.convert("RGBA")
    os.makedirs(outdir, exist_ok=True)
    name = f"raw-{idx}.png"
    img.save(os.path.join(outdir, name))
    out({"ok": True, "png": name, "left": int(l.left), "top": int(l.top), "width": img.width, "height": img.height})


def render(path, dest, hide, show, maxside, force=False):
    psd = load(path)
    layers = walk(psd)
    for i in hide:
        if 0 <= i < len(layers):
            layers[i].visible = False
    for i in show:
        if 0 <= i < len(layers):
            l = layers[i]
            l.visible = True
            p = l.parent
            while p is not None and p is not psd:
                p.visible = True
                p = p.parent
    if hide or show or force:
        psd.mark_updated()
    force = bool(hide or show or force)
    try:
        img = psd.composite(force=force)
    except Exception:
        # a colour profile that can't be applied must not stop the picture from being drawn
        img = psd.composite(force=force, apply_icc=False)
    if img is None:
        fail("This file could not be drawn")
    img = img.convert("RGBA")
    if maxside and max(img.size) > maxside:
        img.thumbnail((maxside, maxside))
    img.save(dest)
    out({"ok": True, "width": img.width, "height": img.height})


def replace_pixels(psd, layer, img, left, top):
    """put new pixels into a pixel layer and keep everything else about it (mask, effects, blend mode, name…)"""
    from psd_tools import PSDImage
    from psd_tools.api.layers import PixelLayer
    from psd_tools.constants import ChannelID
    masks = (ChannelID.USER_LAYER_MASK, ChannelID.REAL_USER_LAYER_MASK)
    # the new channels are made in a scratch document (with a transparency band, like a Photoshop layer) so the real one
    # gets no extra layer
    scratch = PSDImage.new("RGBA", psd.size, depth=int(psd.depth))
    fresh = PixelLayer.frompil(img, scratch, name=layer.name, top=int(top), left=int(left))
    rec, new = layer._record, fresh._record
    old = list(zip(rec.channel_info, layer._channels))
    kept = [(ci, d) for ci, d in old if ci.id in masks]
    made = [(ci, d) for ci, d in zip(new.channel_info, fresh._channels) if ci.id not in masks]
    # the document holds these very lists, so they are changed in place (a new list would not be written)
    infos = [ci for ci, _ in made] + [ci for ci, _ in kept]
    datas = [d for _, d in made] + [d for _, d in kept]
    del rec.channel_info[:]
    rec.channel_info.extend(infos)
    del layer._channels[:]
    layer._channels.extend(datas)
    rec.top, rec.left, rec.bottom, rec.right = new.top, new.left, new.bottom, new.right


def save(spec_path):
    from PIL import Image
    spec = json.load(open(spec_path, encoding="utf-8"))
    src, dest = spec["src"], spec["dest"]
    psd = load(src)
    layers = walk(psd)
    if mode_name(psd) != "RGB" and (spec.get("layers") or spec.get("doc")):
        fail("Only RGB files can be changed here")
    base = os.path.dirname(spec_path)
    deletions = []
    for key, ch in (spec.get("layers") or {}).items():
        i = int(key)
        if not 0 <= i < len(layers):
            fail(f"Layer {i} is not in this file")
        l = layers[i]
        if "visible" in ch:
            l.visible = bool(ch["visible"])
        if "opacity" in ch:
            l.opacity = max(0, min(255, int(ch["opacity"])))
        if "name" in ch and ch["name"] is not None:
            l.name = str(ch["name"])
        if ch.get("delete"):
            deletions.append(l)
            continue
        if "pixels" in ch:
            if kind_of(l) != "pixel":
                fail(f"“{l.name}” is a {kind_of(l)} layer. Dogfile keeps those exactly as they are; edit them in Photoshop.")
            img = Image.open(os.path.join(base, ch["pixels"]) if not os.path.isabs(ch["pixels"]) else ch["pixels"]).convert("RGBA")
            replace_pixels(psd, l, img, ch.get("left", l.left), ch.get("top", l.top))
    for l in deletions:
        l.delete_layer()
    doc = spec.get("doc") or {}
    if doc.get("crop"):
        crop_canvas(psd, doc["crop"])
    if doc.get("rotate") or doc.get("flipH") or doc.get("flipV"):
        turn_document(psd, int(doc.get("rotate") or 0), bool(doc.get("flipH")), bool(doc.get("flipV")))
    if spec.get("layers") or doc:
        psd.mark_updated()  # the flattened picture inside the file is made again from the layers
    d = os.path.dirname(os.path.abspath(dest)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".dogfile-psd-", suffix=".tmp", dir=d)
    os.close(fd)
    try:
        psd.save(tmp)
        # make sure the file we wrote can be read again before it replaces anything
        again = load(tmp)
        if len(walk(again)) != len(walk(psd)):
            raise RuntimeError("The saved file did not read back with the same layers")
        os.replace(tmp, dest)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    out({"ok": True, "path": dest, "layers": len(walk(psd))})


def require_plain(psd, what, masks_ok):
    """crop / turn the whole picture: everything must be plain pixels, because text, shapes, smart objects and fills keep
    their position inside their own data, which this helper does not rewrite"""
    others = sorted({kind_of(x) for x in walk(psd) if not x.is_group()} - {"pixel"})
    if others:
        fail(f"{what} needs every layer to be a plain pixel layer. This file also has {', '.join(others)} layers, "
             "which Dogfile keeps exactly as they are; use Photoshop for this change.")
    if any(x.is_group() and type(x).__name__ == "Artboard" for x in walk(psd)):
        fail(f"{what} isn't available for files with artboards.")
    for x in walk(psd):
        if x.is_group():
            continue
        if safe(lambda: x.has_vector_mask(), False):
            fail(f"“{x.name}” has a vector mask, so {what.lower()} isn't available. Edit it in Photoshop.")
        if not masks_ok and (safe(lambda: x.has_mask(), False) or safe(lambda: x.has_effects(), False)):
            fail(f"“{x.name}” has a mask or effects, so {what.lower()} isn't available. Edit it in Photoshop.")


def crop_canvas(psd, box):
    """crop the picture the way Photoshop does without 'delete cropped pixels': the page gets smaller, layers keep their
    pixels (those outside are kept, just off the page)"""
    require_plain(psd, "Cropping", True)
    l, t, r, b = [int(x) for x in box]
    if r - l < 1 or b - t < 1:
        fail("The crop is empty")
    for layer in walk(psd):
        if layer.is_group():
            continue  # a group's box comes from what is in it
        rec = layer._record
        if rec is None:
            continue
        rec.left -= l; rec.right -= l; rec.top -= t; rec.bottom -= t
        m = safe(lambda: rec.mask_data)
        if m is not None:
            for a in ("left", "right"):
                setattr(m, a, getattr(m, a) - l)
            for a in ("top", "bottom"):
                setattr(m, a, getattr(m, a) - t)
    psd._record.header.width = r - l
    psd._record.header.height = b - t


def turn_document(psd, degrees, flip_h, flip_v):
    from PIL import Image
    require_plain(psd, "Turning the whole picture", False)
    W, H = psd.width, psd.height
    ops = []
    if flip_h: ops.append(Image.Transpose.FLIP_LEFT_RIGHT)
    if flip_v: ops.append(Image.Transpose.FLIP_TOP_BOTTOM)
    deg = degrees % 360
    if deg == 90: ops.append(Image.Transpose.ROTATE_270)   # PIL turns the other way
    elif deg == 180: ops.append(Image.Transpose.ROTATE_180)
    elif deg == 270: ops.append(Image.Transpose.ROTATE_90)
    for x in walk(psd):
        if x.is_group():
            continue
        img = safe(lambda: x.topil())
        if img is None:
            continue
        img = img.convert("RGBA")
        l, t = x.left, x.top
        w, h = img.size
        cw, ch = W, H
        for op in ops:
            img = img.transpose(op)
            if op == Image.Transpose.FLIP_LEFT_RIGHT: l = cw - (l + w)
            elif op == Image.Transpose.FLIP_TOP_BOTTOM: t = ch - (t + h)
            elif op == Image.Transpose.ROTATE_180: l, t = cw - (l + w), ch - (t + h)
            elif op == Image.Transpose.ROTATE_270:   # clockwise 90
                l, t = ch - (t + h), l; cw, ch = ch, cw; w, h = h, w
            elif op == Image.Transpose.ROTATE_90:    # clockwise 270
                l, t = t, cw - (l + w); cw, ch = ch, cw; w, h = h, w
        replace_pixels(psd, x, img, l, t)
    if deg in (90, 270):
        psd._record.header.width, psd._record.header.height = H, W


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # file names and layer names in any language
        except Exception:
            pass
    if len(argv) < 2:
        fail("No command")
    cmd = argv[1]
    try:
        if cmd == "version":
            import psd_tools
            out({"ok": True, "helper": VERSION, "psdTools": psd_tools.__version__})
        elif cmd == "info":
            info(argv[2], argv[3])
        elif cmd == "raw":
            raw(argv[2], argv[3], int(argv[4]))
        elif cmd == "render":
            rest = argv[4:]
            def opt(name):
                if name in rest:
                    i = rest.index(name)
                    return rest[i + 1] if i + 1 < len(rest) else ""
                return ""
            ints = lambda s: [int(x) for x in s.split(",") if x.strip()]
            render(argv[2], argv[3], ints(opt("--hide")), ints(opt("--show")), int(opt("--max") or 0), "--force" in rest)
        elif cmd == "save":
            save(argv[2])
        else:
            fail(f"Unknown command {cmd}")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-1200:])


if __name__ == "__main__":
    main(sys.argv)
