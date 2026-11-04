#!/usr/bin/env python3
"""Spec-script linter for Fountain files.

Checks ACTION lines for unfilmable or amateur patterns (interior states, similes,
"as if", camera directions, transitions, backstory) and checks dialogue
parentheticals and paragraph lengths. Dialogue text itself is not linted.

Usage: lint_script.py script.fountain [--verbose]
Exit code is 1 if any ERROR-level finding exists.
"""
import re
import sys
import textwrap

ERRORS = {
    "as-if / as-though": r"\b(as if|as though)\b",
    "seems / appears-to": r"\b(seems?|seemed|seeming|appears? to|appeared to|looks as)\b",
    "interior verb": r"\b(thinks?|thought|realizes?|realized|knows?|knew|remembers?|remembered|wonders?|decides?|decided|wants?|wanted|feels?|felt|senses?|sensed|hears?|heard|notices?|noticed|sees|saw|imagines?|believes?)\b",
    "camera / transition": r"(\bwe (see|hear|watch|never|can)\b|\bcamera\b|\bangle on\b|\bPOV\b|\bCLOSE (ON|UP)\b|\bCUT TO\b|\bSMASH\b|\bDISSOLVE\b|\bMATCH CUT\b|\bpans? (to|across|left|right)\b|\bzooms?\b|\b(one|two|three|four|five|\d+) frames?\b|\bFLASH\b|\bseen from\b|\bINSERT\b|\bour\b|\bus\b)",
    "begins / starts to": r"\b(begins? to|starts? to|continues to|tries to)\b",
    "narrator commentary": r"\b(unmistakabl\w+|impossibl\w+|somehow|nobody asked|the most human)\b",
}
WARNINGS = {
    "simile (like ...)": r"\blike (a|an|the|some\w*|he|she|they|it|his|her|their|that|this|you)\b",
    "'the way'": r"\bthe way\b",
    "backstory / habit": r"\b(has|have|had|always|never|since|used to|years?|once|still)\b",
    "past tense 'was/were'": r"\b(was|were)\b",
    "vague word": r"\b(something|almost|nearly|slightly|a little|kind of|sort of|suddenly|just)\b",
    "evaluative": r"\b(wrong|strange|eerie|creepy|ominous|perfect\w*|beautiful|enormous|tender|gentle\w*|joy\w*|quiet\w*)\b",
    "adverb (-ly)": r"\b\w{4,}ly\b",
    "visual-effect direction (blur/focus)": r"\b(blurs?|focus|soft focus)\b",
}
PAREN_OK = re.compile(r"^\((to [A-Za-z' .]+|into phone|reading|V\.O\.|O\.S\.)\)$", re.I)


def is_scene(line):
    return bool(re.match(r"^(INT|EXT|EST|INT\./EXT|INT/EXT|I/E)[\. ]", line, re.I)) or line.startswith(".")


def is_character(line, prev_blank, next_nonblank):
    if not (prev_blank and next_nonblank):
        return False
    core = re.sub(r"\(.*?\)", "", line).strip()
    if not core or core != core.upper() or not re.search(r"[A-Z]", core):
        return False
    return not (line.startswith(("!", ">", "~", "=", "#", "@")) or is_scene(line))


def main():
    path = sys.argv[1]
    verbose = "--verbose" in sys.argv
    lines = open(path, encoding="utf-8").read().replace("\r\n", "\n").split("\n")
    # skip title page
    i = 0
    while i < len(lines) and lines[i].strip() and re.match(r"^[A-Za-z ]+:", lines[i]):
        i += 1
    n = len(lines)
    findings = []  # (level, lineno, label, text)
    counts = {}
    paras = 0
    long_paras = []
    parens = []
    char_cues = set()
    dialogue_blocks = []
    scenes = 0
    # first pass: character cue names
    j = i
    while j < n:
        line = lines[j].rstrip()
        prev_blank = j == 0 or not lines[j - 1].strip()
        nxt = j + 1 < n and bool(lines[j + 1].strip())
        if line.strip() and is_character(line, prev_blank, nxt):
            char_cues.add(re.sub(r"\(.*?\)", "", line).strip())
        j += 1

    while i < n:
        line = lines[i].rstrip()
        if not line.strip() or line.strip() == "===":
            i += 1
            continue
        prev_blank = i == 0 or not lines[i - 1].strip()
        nxt = i + 1 < n and bool(lines[i + 1].strip())
        if line.startswith(">") or line.startswith("~"):
            if line.startswith(">") and re.search(r"\b(TO:|SMASH|CUT)\b", line):
                findings.append(("ERROR", i + 1, "transition", line.strip()))
            i += 1
            continue
        if is_scene(line) and prev_blank:
            scenes += 1
            i += 1
            continue
        if is_character(line, prev_blank, nxt):
            k = i + 1
            body = 0
            while k < n and lines[k].strip():
                seg = lines[k].strip()
                if seg.startswith("(") and seg.endswith(")"):
                    parens.append((k + 1, seg))
                    if not PAREN_OK.match(seg):
                        findings.append(("WARN", k + 1, "parenthetical", seg))
                    if re.search(r"\(beat\)", seg, re.I):
                        findings.append(("ERROR", k + 1, "(beat)", seg))
                else:
                    body += len(textwrap.wrap(seg, 35))
                k += 1
            # a block must not end on a parenthetical
            last = lines[k - 1].strip()
            if last.startswith("(") and last.endswith(")"):
                findings.append(("ERROR", k, "block ends on parenthetical", last))
            if body > 8:
                findings.append(("WARN", i + 1, f"long dialogue block ({body} lines)", line.strip()))
            dialogue_blocks.append(body)
            i = k
            continue
        # action paragraph
        start = i
        para = []
        while i < n and lines[i].strip() and lines[i].strip() != "===" and not lines[i].startswith(("~", ">")):
            para.append(lines[i].strip().lstrip("!"))
            i += 1
        text = " ".join(para)
        paras += 1
        wrapped = textwrap.wrap(text, 60)
        if len(wrapped) > 4:
            findings.append(("ERROR", start + 1, f"action paragraph is {len(wrapped)} lines (max 4)", text[:60] + "..."))
        elif len(wrapped) > 3:
            long_paras.append(start + 1)
            findings.append(("WARN", start + 1, f"action paragraph is {len(wrapped)} lines (aim for 3 or fewer)", text[:60] + "..."))
        for sent in re.split(r"(?<=[.!?])\s+", text):
            if len(sent.split()) > 28:
                findings.append(("WARN", start + 1, f"long sentence ({len(sent.split())} words)", sent[:70] + "..."))
        # strip printed text / signage in caps before checks (labels, names)
        check = text
        for label, pat in ERRORS.items():
            for m in re.finditer(pat, check, re.I):
                findings.append(("ERROR", start + 1, label, m.group(0) + "  <- " + text[:70]))
        for label, pat in WARNINGS.items():
            for m in re.finditer(pat, check, re.I):
                findings.append(("WARN", start + 1, label, m.group(0) + "  <- " + text[:70]))

    err = [f for f in findings if f[0] == "ERROR"]
    warn = [f for f in findings if f[0] == "WARN"]
    for f in findings:
        counts[(f[0], f[2].split(" <-")[0].split(" (")[0])] = counts.get((f[0], f[2].split(" <-")[0].split(" (")[0]), 0) + 1

    print(f"{path}")
    print(f"scenes: {scenes}   action paragraphs: {paras}   parentheticals: {len(parens)}")
    print(f"ERRORS: {len(err)}   WARNINGS: {len(warn)}")
    print()
    print("By category:")
    for (lvl, label), c in sorted(counts.items(), key=lambda kv: (kv[0][0], -kv[1])):
        print(f"  {lvl:5} {c:3}  {label}")
    if verbose:
        print()
        for lvl, ln, label, text in findings:
            print(f"  {lvl:5} L{ln:<4} {label:32} {text}")
    sys.exit(1 if err else 0)


if __name__ == "__main__":
    main()
