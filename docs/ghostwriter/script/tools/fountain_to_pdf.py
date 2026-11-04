#!/usr/bin/env python3
"""Minimal Fountain -> screenplay PDF (Courier 12, industry margins, ~54 lines/page).

Usage: fountain_to_pdf.py input.fountain output.pdf
Supports: title page, scene headings, action, character/dialogue/parenthetical,
transitions (> TEXT), centered (>TEXT<), lyrics/inserts (~text), page breaks (===).
"""
import re
import sys
import textwrap
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

LINE_H = 12.0
CHAR_W = 7.2
LEFT = 108.0          # 1.5"
TOP = 72.0            # 1.0"
BOTTOM = 60.0         # 55 lines per page (industry norm is 54-56)
PAGE_W, PAGE_H = letter
LINES_PER_PAGE = int((PAGE_H - TOP - BOTTOM) / LINE_H)   # 54

W_ACTION = 60
W_DIALOGUE = 35
W_PAREN = 22
W_LYRIC = 40
X_DIALOGUE = 10
X_PAREN = 16
X_CHAR = 22
X_LYRIC = 10


def wrap(text, width):
    text = re.sub(r"\s+", " ", text.strip())
    if not text:
        return [""]
    return textwrap.wrap(text, width=width, break_long_words=False, break_on_hyphens=False) or [""]


class El:
    def __init__(self, kind, lines, before, **kw):
        self.kind = kind          # scene, action, dialogue, transition, center, lyric
        self.lines = lines        # list of (col_offset, text, style, align)
        self.before = before
        self.__dict__.update(kw)


def is_scene(line):
    return bool(re.match(r"^(INT|EXT|EST|INT\./EXT|INT/EXT|I/E)[\. ]", line, re.I)) or line.startswith(".")


def is_character(line, prev_blank, next_nonblank):
    if not (prev_blank and next_nonblank):
        return False
    core = re.sub(r"\(.*?\)", "", line).strip()
    if not core or core != core.upper() or not re.search(r"[A-Z]", core):
        return False
    if line.startswith(("!", ">", "~", "=", "#", "@")) or is_scene(line):
        return False
    return True


def parse(text):
    raw = text.replace("\r\n", "\n").split("\n")
    # title page: key: value lines at the top until first blank line
    title = {}
    i = 0
    while i < len(raw) and raw[i].strip() and re.match(r"^[A-Za-z ]+:", raw[i]):
        k, v = raw[i].split(":", 1)
        title[k.strip().lower()] = v.strip()
        i += 1
    lines = raw[i:]
    # strip page-break markers
    elements = []
    n = len(lines)
    j = 0
    while j < n:
        line = lines[j].rstrip()
        if not line.strip() or line.strip() == "===":
            j += 1
            continue
        prev_blank = (j == 0) or (not lines[j - 1].strip())
        next_nonblank = (j + 1 < n) and bool(lines[j + 1].strip())

        # transition / centered
        if line.startswith(">"):
            body = line[1:].strip()
            if body.endswith("<"):
                elements.append(El("center", [(0, body.rstrip("<").strip(), "", "center")], 1))
            else:
                elements.append(El("transition", [(0, body, "", "right")], 1))
            j += 1
            continue

        # scene heading
        if is_scene(line) and prev_blank:
            head = line.lstrip(".").upper().replace(" - ", " - ")
            elements.append(El("scene", [(0, head, "", "left")], 2))
            j += 1
            continue

        # lyrics / inserts (consecutive ~ lines)
        if line.startswith("~"):
            out = []
            while j < n and lines[j].startswith("~"):
                seg = lines[j][1:].strip()
                for w in wrap(seg, W_LYRIC):
                    out.append((X_LYRIC, w, "italic", "left"))
                j += 1
            elements.append(El("lyric", out, 1))
            continue

        # character + dialogue
        if is_character(line, prev_blank, next_nonblank):
            cue = line.strip()
            body = []
            k = j + 1
            while k < n and lines[k].strip():
                seg = lines[k].strip()
                if seg.startswith("(") and seg.endswith(")"):
                    for w in wrap(seg, W_PAREN):
                        body.append((X_PAREN, w, "", "left"))
                else:
                    for w in wrap(seg, W_DIALOGUE):
                        body.append((X_DIALOGUE, w, "", "left"))
                k += 1
            elements.append(El("dialogue", body, 1, cue=cue))
            j = k
            continue

        # action (paragraph of consecutive lines)
        para = []
        while j < n and lines[j].strip() and lines[j].strip() != "===":
            para.append(lines[j].strip().lstrip("!"))
            j += 1
        out = [(0, w, "", "left") for w in wrap(" ".join(para), W_ACTION)]
        elements.append(El("action", out, 1))
    return title, elements


def paginate(elements):
    pages = [[]]   # each page: list of (blank_before, [lines])
    y = 0

    def newpage():
        nonlocal y
        pages.append([])
        y = 0

    i = 0
    while i < len(elements):
        el = elements[i]
        before = 0 if y == 0 else el.before
        if el.kind == "dialogue":
            cue_line = [(X_CHAR, el.cue, "", "left")]
            block = cue_line + el.lines
        else:
            block = el.lines
        need = before + len(block)

        if el.kind == "scene":
            nxt = elements[i + 1] if i + 1 < len(elements) else None
            extra = 0
            if nxt is not None:
                nb = len(nxt.lines) + (1 if nxt.kind == "dialogue" else 0)
                extra = 1 + min(2, nb)
            if y + need + extra > LINES_PER_PAGE:
                newpage()
                before = 0
            pages[-1].append((before, block))
            y += before + len(block)
            i += 1
            continue

        if y + need <= LINES_PER_PAGE:
            pages[-1].append((before, block))
            y += need
            i += 1
            continue

        # does not fit
        avail = LINES_PER_PAGE - y - before
        if el.kind == "dialogue":
            # split with (MORE) / (CONT'D) if reasonable
            take = avail - 1            # reserve a line for (MORE)
            rest = len(block) - take
            if take >= 3 and rest >= 2 and len(block) >= 5:
                first = block[:take] + [(X_DIALOGUE, "(MORE)", "", "left")]
                pages[-1].append((before, first))
                cont_cue = re.sub(r"\s*\(CONT'D\)", "", el.cue) + " (CONT'D)"
                remaining = [(X_CHAR, cont_cue, "", "left")] + block[take:]
                newpage()
                elements[i] = El("dialogue", remaining[1:], 1, cue=cont_cue)
                continue
            newpage()
            continue
        if el.kind == "action" and len(block) >= 4:
            take = avail
            rest = len(block) - take
            if take >= 2 and rest >= 2:
                pages[-1].append((before, block[:take]))
                newpage()
                elements[i] = El("action", block[take:], 1)
                continue
            if take >= 2 and rest == 1:
                take -= 1
                if take >= 2:
                    pages[-1].append((before, block[:take]))
                    newpage()
                    elements[i] = El("action", block[take:], 1)
                    continue
        newpage()
    return pages


def draw_line(c, x, y, text, style, align):
    font = "Courier-Oblique" if style == "italic" else "Courier"
    c.setFont(font, 12)
    if align == "right":
        x = LEFT + W_ACTION * CHAR_W - len(text) * CHAR_W
    elif align == "center":
        x = LEFT + (W_ACTION * CHAR_W - len(text) * CHAR_W) / 2.0
    c.drawString(x, y, text)


def render(title, pages, out):
    c = canvas.Canvas(out, pagesize=letter)
    c.setTitle(title.get("title", "Screenplay"))
    c.setAuthor(title.get("author", ""))

    # title page
    c.setFont("Courier", 12)
    cy = PAGE_H - 250
    t = title.get("title", "").upper()
    for w in textwrap.wrap(t, 40):
        draw_line(c, 0, cy, w, "", "center")
        cy -= LINE_H
    # underline
    cy -= LINE_H
    draw_line(c, 0, cy, title.get("credit", "").upper(), "", "center")
    cy -= LINE_H * 3
    draw_line(c, 0, cy, "Written by", "", "center")
    cy -= LINE_H * 2
    draw_line(c, 0, cy, title.get("author", ""), "", "center")
    by = 150
    for key, label in (("source", ""), ("notes", ""), ("draft date", "Draft: ")):
        if title.get(key):
            for w in textwrap.wrap(label + title[key], 58):
                c.setFont("Courier", 12)
                c.drawString(LEFT, by, w)
                by -= LINE_H
    c.showPage()

    # script pages
    start = int(title.get("start page", "1"))
    for pno, page in enumerate(pages, start=1):
        c.setFont("Courier", 12)
        num = start + pno - 1
        if num > 1:
            label = f"{num}."
            c.drawString(LEFT + W_ACTION * CHAR_W - len(label) * CHAR_W, PAGE_H - 48, label)
        row = 0
        for before, block in page:
            row += before
            for (col, text, style, align) in block:
                y = PAGE_H - TOP - (row + 1) * LINE_H + 3
                draw_line(c, LEFT + col * CHAR_W, y, text, style, align)
                row += 1
        c.showPage()
    c.save()


def main():
    src, out = sys.argv[1], sys.argv[2]
    text = open(src, encoding="utf-8").read()
    title, elements = parse(text)
    pages = paginate(elements)
    render(title, pages, out)
    used = sum(b + len(blk) for pg in pages for (b, blk) in pg)
    print(f"script pages: {len(pages)}  (lines/page={LINES_PER_PAGE}, total lines={used})")


if __name__ == "__main__":
    main()
