# Full-script review (Draft 1)

Companion to `THE_GHOSTWRITER_FULL_SCRIPT.pdf` (97 pages). This records the start-to-finish reread of all three acts against the standards in `ACT_1_AUDIT.md` (action lines a camera and microphone can capture; no similes or "as if"; no interior states; short paragraphs; no camera directions or transitions; sparing parentheticals; clear geography; one introduction per character; every scene turns). Page numbers are for the full-script PDF.

**Status.** The review was first written for the 100-page script. The development pass that followed an outside review (`DEVELOPMENT_PASS_2.md`) rebuilt part of Act Two, so every page number, count and the calendar below now describe the current 97-page script, and the one item the rebuild made obsolete is marked *superseded*. The checks in section 1 were run again after the rebuild.

## 1. What was checked, and how

| Check | How | Result |
|---|---|---|
| Every action line | Read in full: Act One, Act Two, Act Three (Act Three twice, plus a line-by-line read of every change made in each pass; Act Two again in full after the development pass) | Fixes listed in section 3 |
| Linter (patterns) | `tools/lint_script.py` on each act and on the joined script | 0 errors; 15 warnings, all reviewed: five "year(s)" (five-year-old, ten-year-old, the SUPER); three "was" inside text written on a page; four "blur" (ink on a page, Ellie's face three times, the last of which is the payoff); three "once/still" |
| Character cues and (CONT'D) | Script that tracks the last speaker in each scene | 8 wrong or missing (CONT'D) found and fixed in the first pass; 0 remain after the development pass |
| Voice-over and off-screen | Listed every extension | V.O. only for radio, phone, voicemail, the archive interview, the pages read by the boy and the rope; O.S. only for people in the scene but off screen |
| Scene headings | Parsed all 70 (73 before the development pass) | All follow INT./EXT. LOCATION - TIME; location names consistent |
| Character introductions | Listed every CAPS-with-age introduction | Two repeats removed (Walter in Act Three, the waitress in Act Two); minor characters unnamed |
| Emotion labels and sensory words | Scanned every action line for feeling words, smell, taste, silence, hedges, camera words | Eleven hits reviewed; four rewritten (listed below) |
| Spelling | Dictionary pass over all three acts | No misspellings; the only unknown words are deliberate (reversed fog writing, "RALLEC") |
| Typography | Scanned for double spaces, trailing spaces, repeated words, curly quotes, dashes | Clean |
| Page breaks | Scanned the PDF for lead-ins, headings and cues stranded at a page foot | None; three dialogue splits with (MORE) |
| Timeline | Rebuilt the day-by-day sequence from every clock, weekday and "last night" in the dialogue | Consistent after one fix (below); rebuilt again after the development pass moved Mara's arrival |
| Props, wounds, wet and dry | Tracked the notebook, pencil, rope, photographs, the dress, the bruise, the Fair Copy lines | Consistent after the fixes below |
| The eight laws | Checked each scene against Laws 1 to 8 | No contradictions; one cost left unnamed, now fixed |
| Plants and payoffs | 104 named anchors (a phrase each) looked up in the rendered PDF after every rebuild | Every plant and payoff still present after the development pass |

## 2. The full script

97 pages, 70 scene headings, about 19,500 words, 2 parentheticals, no camera directions, no transitions beyond `FADE IN:` and the title cards. Act One is pages 1–21, Act Two pages 21–58, Act Three pages 59–97; the acts join mid-page (Act One to Act Two) and at the top of a page (Act Two to Act Three), and the "END OF ACT" cards are removed from the joined script (`tools/build_full_script.py` does this).

## 3. Problems found and fixed

### Plot and logic

1. **The cost of the truth Theo tells Mara was never named.** He says "I don't know what" to Walter and Mara, and Act Three only paid off the other costs. Now: Theo whistles two falling notes in the happy first scene of Act Two and says it was his father's call to bring the children in (p. 22); Theodore names it in the Study and Theo cannot whistle (p. 70); it returns in the last kitchen, where June says "You're whistling" (p. 96).
2. **June's middle name was never written down before it became the cost.** It is now on her transfer form (p. 26).
3. **The writing on June's palms had no source.** It is now her own neat capitals, a child's reminders (CALL MOM 9. 11 PAGES. DAD.), fading (p. 68).
4. **The three strokes of a pencil heard under the floor (twice in Act One, once in Act Two) were never explained.** The back of the final page now has three lines (p. 73), one for each stroke.
5. **June never meets her Aunt Nell.** She names "Aunt Nell" in Act One but does not recognize Ellie. At the pond she asks "Aunt Nell?" and Nell says "Hi, June" (p. 89).
6. **A child who has just drowned is not taken to a hospital.** Mara: "Get up. She's getting checked, and so are you" (p. 90).
7. **An adult watched Theo freeze.** The quarryman who dives in now runs past him "without a glance," so the family's "he was home" holds (p. 80).
8. **June's living arrangement and the house sale were left open.** A sticky note on the refrigerator (CALL MOM 9) shows June is staying and calling her mother; the FOR SALE sign lies face down in the grass (p. 95).
9. **Loose objects.** The yellow duck dress (Act Two's cellar tin) is on the pillow in Nell's room; the photograph under the lobster magnet, whose boy's face was hidden in Act One, lies on the table with Tomas's face clear: freckled, grinning, a pencil behind his ear (p. 95); the story June wanted read was "a crossover" in Act One and a lighthouse story in Act Two, so Act One now says "a ghost story with a lighthouse" (p. 5).
10. **Priya read forty pages in the time it takes to send an email.** The email goes at 2:07 and she calls at 3:22 (p. 27).
11. **Mara's evidence.** *Superseded.* The first pass fixed a photograph grid in the lab call that showed one line on Theo's arm when he already had two. The development pass removed the lab scene; Mara now reads the arm itself, four lines, in the kitchen (p. 33).
12. **The week.** Mara said she would be back Saturday and arrived on a Sunday. Now she says "I'll be back Sunday" (p. 35) and the porch scene is a Sunday (p. 49).

### Continuity and format

- Eight (CONT'D) errors: a cue after another speaker's line, or a missing one after action.
- The reflection in the bathroom was cued THEODORE before Theo said the name; it is now REFLECTION until he does (p. 39).
- Walter was introduced in capitals again in Act Three; so was the diner waitress in Act Two.
- A Fair Copy line on the wrong limb in Act Three (the forearm line had already faded; the collarbone line pales).
- Nell's testimony said Tomas "had me by the arms"; the True Memory has him swimming her in. Now consistent.
- A stale line from the bible: Theodore says "I told you to get rid of him" (he never did). Now: "The wet one has her. I did ask what he wants."
- The flood geometry: a desk cannot be an island in waist-high water. The flood now rises to the desktop.
- The desk's blotter was used in a scene but never introduced; it is now in the Study description.
- A heading's lead-in stranded at the foot of a page (the memorial inscription) was fixed by reordering.
- The per-act PDFs repaginated differently from the joined script. They are retired; one PDF now carries the page numbers every document cites.
- After the development pass the per-act "Start page" keys were reset (Act Two starts at page 22 and Act Three at page 60 when the acts are rendered one at a time); the joined script is the reference.

### Filmability

- "The smell of wet leaves" (not recordable) became "Wet leaves lie on the sill."
- Hidden similes: "as through a tin can", "dark as new graphite", "as steam".
- Emotions written as labels: "white with rage", "in fear", "unbothered", "She is waiting for him to say yes".
- Sound and smell lines made visible actions: "the radio is loud in the quiet" is now "the radio is the only sound"; "smells them" is "holds them to his nose"; a stray "Silence." was removed.
- A June line that said she "waves a hand at the smell" now says she waves a hand in front of her nose.

## 4. The calendar the script now implies

The script never states weekdays on screen except in dialogue. The dialogue fixes the following, and nothing contradicts it:

| Day | Weekday | What happens | What fixes the weekday |
|---|---|---|---|
| 1 | Friday | Arrival; fresh marigolds at the memorial; first night | Marit leaves marigolds every Friday |
| 2 | Saturday | The first page; Alder Hill; the hall prints | |
| 3 | Sunday | Walter at the diner; pages two and three; Ingrid's room; the 11:40 reading | |
| 4 | Monday | June reads the pages; the library; typing through the night | |
| 5 | Tuesday | The transfer form (Perry Street); the night email at 2:07 | Walter: "I've felt it since Tuesday" (the day Theo began to copy in earnest) |
| 6 | Wednesday | Priya at 3:22 a.m.; that night Alder Hill, the key, the cellar, the near-drowning at 11:50; June phones Mara at midnight | Ingrid: "Is it Thursday?" (she is confused) |
| 7 | Thursday | Mara arrives at dawn ("Five hours. She called me at midnight."); Walter's study; the bathroom | Mara: "I'll be back Sunday" |
| 8 | Friday | The memorial re-cut; the town's welcome | The sexton: "Every Friday" |
| 9 | Saturday | The diner at 7:15; the car; the dinner | |
| 10 | Sunday | Mara on the porch; Walter's last scene; the Turnover | Mara returns as promised |
| 11 | Monday | The pond at night; Nell at 3:58 a.m.; Act Three begins | |
| later | Friday | The Marker; the brown marigolds are last Friday's | "FRIDAY" |

The 1987 day, August 14, was a Friday, as the radio says.

## 5. The eight laws against the script

| Law | Where it works | Status |
|---|---|---|
| 1 Retention (truth costs) | The street and a novel (Act Two, p. 26); the whistle (the truth told to Mara); "Elise" (the Turnover); the gift (Act Three) | Every cost is now named and, except the gift, returned through Witness |
| 2 Weight | The heavy rooms (cellar, white door); Theo's eyes sliding off Ellie's face and Tomas's | Consistent |
| 3 Bleed | Wet prints, pencil scratching, rain-hand, fog writing, the Fair Copy | Tomas handles objects only in heavy places or at the Turnover; the mop passes through him in the hall |
| 4 Attribution | "Reading is signing"; the back readable only by someone who accepts the blame; Walter's three "don'ts" (p. 37) | Reading the true sentence aloud is the cure |
| 5 Revision | Memorial, town, Priya, Mara, the photograph | Undone: memorial, photograph, Walter's books; Priya's and Mara's false memories go quietly |
| 6 Completion | Writing the true clause; the Study dissolves; Visitors released | Walter, the children and the others finish their gestures |
| 7 Witness | Nell and Mara at the rope; "June Elise Lindqvist-Hale"; telling Marit, June and Nell | Consistent |
| 8 Voice | Theodore cannot say "Tomas" until the clause is finished (p. 47); Tomas speaks only his last words | Consistent |

## 6. Left as it is, and why

- **Tomas's exit** (he walks away dry; no last glimpse of him) and **Theodore's last words** ("Tomas," "Thank you"): still your call; see `ACT_3_AUDIT.md`, section 6.
- **Running time.** About 97 pages. The held sequences run long, so plan on roughly 1:50 to 2:00 until there is an edit.
- **Why Theo froze.** Unanswered by design. The last line he writes is "I don't know why I didn't move."
- **The formal introduction of Theodore** (45) is in the car, his first full-body appearance. In the bathroom he is a reflection.
- **The one deliberate exception.** Ellie's face blurs when Theo looks at it, and stays sharp from the end of Act Two. It is the one device in the script that depends on focus, and the payoff is why it exists.

## 7. Rebuilding

```bash
python3 tools/build_full_script.py     # joins the three act files; writes the full script and its PDF
python3 tools/lint_script.py THE_GHOSTWRITER_FULL_SCRIPT.fountain --verbose
```

The three act files are the source of truth. Edit them, then rebuild.
