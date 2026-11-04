#!/usr/bin/env python3
"""Join the three act files into one Fountain script and render one PDF.

The three `THE_GHOSTWRITER_ACT_n.fountain` files remain the source of truth.
This tool strips each act's title page, drops the "END OF ACT" cards (a feature
has no act cards; `>THE END<` stays), puts one title page on the front, and
renders `THE_GHOSTWRITER_FULL_SCRIPT.pdf` with continuous page numbers.

In the act files, text written on a page (the boy's pages, ink on Theo's skin,
the newspaper, the inscriptions) starts with `~`. The PDF formatter uses that
marker to set the text in italics and the linter uses it to skip the text. Some
screenwriting programs read `~` as a lyric or as dialogue, so the joined
`THE_GHOSTWRITER_FULL_SCRIPT.fountain` is written for editors: every `~` line
becomes an ordinary action line (see `editor_version`). The PDF is rendered from
the version that still has the markers, so it keeps its italics.

Usage (from the script/ folder):
    python3 tools/build_full_script.py
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # .../script
ACTS = [os.path.join(ROOT, "THE_GHOSTWRITER_ACT_%d.fountain" % n) for n in (1, 2, 3)]
OUT_FOUNTAIN = os.path.join(ROOT, "THE_GHOSTWRITER_FULL_SCRIPT.fountain")
OUT_PDF = os.path.join(ROOT, "THE_GHOSTWRITER_FULL_SCRIPT.pdf")

TITLE_PAGE = """Title: THE GHOSTWRITER FROM THE 6TH DIMENSION
Credit: FEATURE SCREENPLAY
Author: [Writer]
Source: Original screenplay
Draft date: November 2026
Notes: Draft 1, complete. Built from the three act files by tools/build_full_script.py.

===

"""


def body(path):
    text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    # everything after the first page-break marker is the body; the title page is above it
    head, sep, rest = text.partition("\n===\n")
    if not sep:
        sys.exit("no title-page break (===) found in %s" % path)
    rest = re.sub(r"^\s*>END OF ACT [A-Z]+<\s*$", "", rest, flags=re.M)
    return rest.strip("\n") + "\n"


def looks_like_cue(line):
    """True if a Fountain parser would take this line for a character cue when
    another line follows it: no lowercase letters, at least one capital letter."""
    return line == line.upper() and re.search(r"[A-Z]", line) is not None


def editor_version(text):
    """Replace every `~` written-text line with an ordinary Fountain action line.

    Only the marker is removed; the words are untouched. Two cases need care so
    that a parser still reads the result as action:

    * A block of lines whose first line is all capitals (the memorial
      inscriptions) would be read as a character cue followed by dialogue. Each
      line becomes its own paragraph instead, as "BLACK." already is.
    * A first line that begins with `!` (the margin note "!!") would be read as
      Fountain's force-action marker and lose one `!`, so a second `!` is added.

    Returns (new_text, lines_converted, blocks_converted).
    """
    lines = text.split("\n")
    out = []
    n_lines = n_blocks = 0
    i = 0
    while i < len(lines):
        if not lines[i].startswith("~"):
            out.append(lines[i])
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j].startswith("~"):
            j += 1
        block = [l[1:] for l in lines[i:j]]
        n_lines += len(block)
        n_blocks += 1
        first = block[0]
        if first.startswith("!"):
            block[0] = "!" + first
        elif first[:1] in ".@#=>([" or first.startswith("/*"):
            sys.exit("a written-text block begins with Fountain markup: %r" % first)
        elif len(block) > 1 and looks_like_cue(first):
            spaced = []
            for line in block:
                spaced.extend([line, ""])
            block = spaced[:-1]
        out.extend(block)
        i = j
    result = "\n".join(out)
    if re.search(r"(?m)^~", result):
        sys.exit("a ~ marker survived the conversion")
    return result, n_lines, n_blocks


def main():
    parts = [body(p) for p in ACTS]
    full = TITLE_PAGE + "\n".join(parts)
    full = re.sub(r"\n{3,}", "\n\n", full)

    # The PDF is rendered from the version that still has the ~ markers (italics).
    with tempfile.TemporaryDirectory() as tmp:
        marked = os.path.join(tmp, "THE_GHOSTWRITER_FULL_SCRIPT.fountain")
        open(marked, "w", encoding="utf-8").write(full)
        subprocess.check_call([sys.executable, os.path.join(HERE, "fountain_to_pdf.py"), marked, OUT_PDF])

    editor, n_lines, n_blocks = editor_version(full)
    open(OUT_FOUNTAIN, "w", encoding="utf-8").write(editor)
    print("wrote", os.path.relpath(OUT_FOUNTAIN, ROOT), "and", os.path.relpath(OUT_PDF, ROOT))
    print("editor copy: %d written-text lines (%d blocks) are plain action lines" % (n_lines, n_blocks))


if __name__ == "__main__":
    main()
