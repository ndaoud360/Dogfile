# The Ghostwriter from the 6th Dimension: screenplay

| File | What it is |
|---|---|
| `THE_GHOSTWRITER_FULL_SCRIPT.pdf` | The complete script, 97 pages. Read this one. |
| `THE_GHOSTWRITER_FULL_SCRIPT.fountain` | The same script as plain text, for screenwriting software. Generated; do not edit. Text written on a page (the boy's pages, ink on skin, the newspaper, the inscriptions) is an ordinary action line here; in the act files it starts with `~` so the PDF can italicize it. |
| `THE_GHOSTWRITER_ACT_1.fountain`, `_ACT_2`, `_ACT_3` | The source of truth. Edit these. |
| `ACT_1_AUDIT.md`, `ACT_2_AUDIT.md`, `ACT_3_AUDIT.md` | Standards, scene-by-scene value turns, departures from the bible, continuity ledgers, open questions. |
| `FULL_SCRIPT_REVIEW.md` | The start-to-finish review of all three acts: what was checked, what was fixed, the calendar, the rules check. |
| `DEVELOPMENT_PASS_2.md` | The response to an outside review: what was tightened, clarified and added (the rules, June's choices, the title's meaning), what was left alone, and what is still your call. |
| `tools/lint_script.py` | Flags unfilmable or amateur action lines, long paragraphs and parentheticals. |
| `tools/fountain_to_pdf.py` | Formats a Fountain file as a Courier 12 screenplay PDF (needs `reportlab`). |
| `tools/build_full_script.py` | Joins the three act files into one script, renders the PDF, and writes the editor copy of the `.fountain` (the `~` markers become plain action lines). |

After editing an act:

```bash
python3 tools/lint_script.py THE_GHOSTWRITER_ACT_1.fountain --verbose   # or _2, _3
python3 tools/build_full_script.py
```

Page numbers cited in the audits and in the development bible refer to the full-script PDF and change when the script changes; rerun the build and update them.
