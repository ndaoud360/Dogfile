#!/usr/bin/env python3
"""Join the three act files into one Fountain script and render one PDF.

The three `THE_GHOSTWRITER_ACT_n.fountain` files remain the source of truth.
This tool strips each act's title page, drops the "END OF ACT" cards (a feature
has no act cards; `>THE END<` stays), puts one title page on the front, writes
`THE_GHOSTWRITER_FULL_SCRIPT.fountain`, and renders `THE_GHOSTWRITER_FULL_SCRIPT.pdf`
with continuous page numbers.

Usage (from the script/ folder):
    python3 tools/build_full_script.py
"""
import os
import re
import subprocess
import sys

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


def main():
    parts = [body(p) for p in ACTS]
    full = TITLE_PAGE + "\n".join(parts)
    full = re.sub(r"\n{3,}", "\n\n", full)
    open(OUT_FOUNTAIN, "w", encoding="utf-8").write(full)
    subprocess.check_call([sys.executable, os.path.join(HERE, "fountain_to_pdf.py"), OUT_FOUNTAIN, OUT_PDF])
    print("wrote", os.path.relpath(OUT_FOUNTAIN, ROOT), "and", os.path.relpath(OUT_PDF, ROOT))


if __name__ == "__main__":
    main()
