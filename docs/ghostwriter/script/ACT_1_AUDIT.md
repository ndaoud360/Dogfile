# Act One: Standards and Audit (Draft 2)

Companion to `THE_GHOSTWRITER_ACT_1.fountain`. Page numbers refer to the full-script PDF (`THE_GHOSTWRITER_FULL_SCRIPT.pdf`), where Act One runs from page 1 to page 21. This page records the screenplay standards used, the results of the pass, and the checklist to apply to every later act.

## 1. Standards applied

Sources are working-industry craft sources (Script Magazine, Final Draft, John August, McKee, No Film School), not a formal rulebook. Where they disagree, an unknown writer gets the stricter reading, because a reader decides in the first few pages ([Script Magazine](https://scriptmag.com/features/the-magic-bullet-action-lines)).

**Action lines**
1. **Only what a camera and microphone can capture.** No thoughts, realizations, knowledge, backstory or "seems." Show feeling through behavior ([Script Magazine: The Magic Bullet](https://scriptmag.com/features/the-magic-bullet-action-lines); [Neil Chase](https://neilchasefilm.com/how-to-write-effective-screenplay-action-lines/); [Script Magazine: The Key Is POV](https://scriptmag.com/features/script-gods-must-die-action-lines-key-pov)).
2. **No "as if," "as though" or similes.** They put images in the reader's head that are not on screen ([Tom Lazarus](https://www.tomlazarus.com/written-by-tom-lazarus-script-consultant/common-screenwriting-mistakes-that-ruin-your-screenplay.html), as summarized in search results).
3. **Present tense, strong verbs, fewest words** ([Neil Chase](https://neilchasefilm.com/how-to-write-effective-screenplay-action-lines/)).
4. **Short paragraphs.** Three lines or fewer; never more than five ([Magic Bullet](https://scriptmag.com/features/the-magic-bullet-action-lines); [Key Is POV](https://scriptmag.com/features/script-gods-must-die-action-lines-key-pov)).
5. **No camera directions, no "we see," no transitions.** Imply framing through description. John August and Craig Mazin defend "we see/we hear" as a convention ([Scriptnotes](https://johnaugust.com/2022/we-see-and-we-hear)); for an unknown writer it is safer to avoid it.
6. **Clear geography early**, so a sink or a window does not appear only when needed ([15 Mistakes](https://scriptmag.com/features/screenwriting-mistakes-to-avoid-this-scene-sucks)).
7. **Character introductions:** CAPS name once, age, one or two telling visual details, no unseen backstory ([Final Draft](https://www.finaldraft.com/blog/how-to-introduce-characters-in-your-script-like-these-iconic-examples)). Minor characters get no name.

**Dialogue**
8. **Subtext over on-the-nose lines;** exposition is hidden under conflict ([Final Draft: Subtext](https://www.finaldraft.com/blog/how-to-write-subtext-in-dialogue); [15 Mistakes](https://scriptmag.com/features/screenwriting-mistakes-to-avoid-this-scene-sucks)).
9. **Parentheticals are rare:** addressing someone or a necessary action only, never a feeling a line reading can carry, never "(beat)," never ending a block ([Final Draft: Parentheticals](https://www.finaldraft.com/blog/lets-talk-about-parentheticals)).
10. **V.O. for voices not physically present** (radio, phone, pages read aloud); **O.S.** for a character in the scene but off screen ([V.O. vs O.S.](https://blog.quoteunquoteapps.com/v-o-vs-o-s-voice-over-off-screen-dialogue-explained/)).

**Scenes**
11. **Enter late, leave early** ([No Film School](https://nofilmschool.com/start-late-leave-early)).
12. **Every scene turns.** A value (trust, safety, hope) must change charge between the first and last moment; a scene that doesn't is exposition and should be cut or folded elsewhere ([McKee](https://mckeestory.com/do-your-scenes-turn/)).
13. **Every exchange carries conflict** ([15 Mistakes](https://scriptmag.com/features/screenwriting-mistakes-to-avoid-this-scene-sucks)).
14. **Flashbacks and voice-over must earn their place:** short, and each must change the meaning of the present ([Flashbacks & Voiceovers](https://scriptmag.com/screenplays/advanced-script-editing-flashbacks-voiceovers)).
15. **Horror:** short lines for speed, longer description only to slow a moment for dread ([GL Coverage](https://glcoverage.com/blog/writing-horror-scenes/)). The first ten pages must hook ([Script Shadow](https://scriptshadow.net/the-top-ten-things-a-reader-cares-about-when-reading-a-script/)).

## 2. Results

`tools/lint_script.py` checks every action line against rules 1–5 and 9. Draft 1 versus Draft 2:

| Measure | Draft 1 | Draft 2 |
|---|---|---|
| Errors | 63 | **0** |
| Warnings | 240 | 7 (all reviewed, see below) |
| "as if / as though" | 13 | 0 |
| Interior-state verbs (thinks, knows, feels, hears, sees) | 14 | 0 |
| Camera / transition lines | 17 | 0 |
| Parentheticals | 43 | 2 |
| Action paragraphs over 4 lines | 11 | 0 |
| Script pages | 26 | 21 |

The linter finds patterns. A full line-by-line read caught what it cannot, for example "The silence is wrong," "something settles," "a woman who has smelled something from her childhood," and "the way you hide something from yourself."

**The 7 remaining warnings, all reviewed:** three are "year(s)" inside "five-year-old," "ten-year-old" and the SUPER; two are text Theo writes or reads on a page ("IT WAS," "There was nobody on the ledge"); two are "blur" (ink on a page; Ellie, below).

## 3. Deliberate exceptions

1. **Ellie's face blurs whenever Theo looks at it.** One story-critical visual device, written as what appears on screen.
2. **Two short flashbacks** (the pages' version of the rescue). Each is under a minute and each changes the present scene.
3. **SUPER lines and the centered title card;** ALL CAPS only for printed text on screen (labels, signage, the phone display).
4. **`~` lines** are text on a page, a scrap, or an envelope.

## 4. Scene audit (every scene must turn)

| Scene | Pages | Value: open → close | Plot job | Changed in this pass |
|---|---|---|---|---|
| 1987 kitchen | 1–2 | Nell safe → Nell gone | The wound, "in a minute," the name Theodore | Boy's face stays hidden by staging, not camera notes |
| Station wagon | 2–6 | Theo's pride → exposed block; June's trust → resignation | Deadline, the public lie, Tomas | Bet rewritten to "I took the other side"; Priya plants "read me one sentence out loud" |
| Farmhouse kitchen and hall | 6–8 | Theo's control → June breaks his silence | Photo with hidden face, cellar, sealed room | Hand-over-hand block; creak behind the door |
| Kitchen, night | 8 | Hope of writing → failure and surrender | Block; the pencil in the wall; June's note | Backstory lines cut; the ritual is shown, not told |
| Kitchen, morning | 8–10 | Safety → destabilized | **Inciting incident: the first page** | Handwriting proved with the atlas flyleaf; page hidden in his own novel |
| Dayroom | 10–12 | Hope of reaching Ingrid → rebuke | The refrain; Ellie's agenda; the clock | **Dr. Haskell cut;** Ellie now carries the information, and presses Theo to come |
| Parking lot | 13 | Denial → doubt | "She said both" | Button: June waits in the rain |
| Hall, night | 13–14 | Rationalization → terror and denial | First scare | One location; wet slap; mopping |
| Sitting room | 14 | Stinger | The figure | "Three frames" became "half a second" |
| Diner | 14–16 | Isolation → warning | Walter, the prints | **Donna cut** (unnamed waitress); filmable intro |
| Mailbox, pages, flashback | 16–18 | Skepticism → temptation | The name Theodore; the false memory | V.O. trimmed |
| Ingrid's room | 18–20 | Hope of truth → "You weren't there" | The family lie; wet hand; dry sink | Interior lines replaced with behavior |
| Kitchen, night | 20–21 | Doubt → adoption | **Act turn** | "First joy in eight years" shown as a smile; reflection scene filmable throughout |

## 5. Checklist for Act Two

- Can a camera film it, or a microphone record it? If not, rewrite or cut.
- No "as if," "seems," "feels," "realizes," "we see," "CLOSE ON," "CUT TO."
- Paragraphs of three lines or fewer.
- A parenthetical only for addressing someone or a necessary action.
- Backstory only in dialogue, props, or behavior.
- Name a character in CAPS once, with age and one visual detail.
- Start late, leave early, and end on a button.
- State the value at the open and at the close. If it didn't change, cut the scene.
- Run `python3 tools/lint_script.py <file> --verbose` and read the whole script once more.

## 6. Tools

```bash
python3 tools/lint_script.py THE_GHOSTWRITER_ACT_1.fountain --verbose
python3 tools/fountain_to_pdf.py THE_GHOSTWRITER_ACT_1.fountain THE_GHOSTWRITER_ACT_1.pdf   # one act, numbered from 1
python3 tools/build_full_script.py                                                          # all three acts into one script and one PDF
```

The PDF tool needs `reportlab`.

## 7. Changes made during the full-script pass

- *June's story is planted* (p. 5): "It's eleven pages. It's a ghost story with a lighthouse." Before, she called it "a crossover," so the lighthouse first appeared at the Act Two dinner and again in the last scene of Act Three.
- *A line that was not filmable* (p. 6): June "waves a hand at the smell" became "waves a hand in front of her nose."
- *Sensory lines made visible actions:* "the radio is loud in the quiet" is now "the radio is the only sound" (p. 2); "smells them" is "holds them to his nose" (pp. 9 and 14).
- *Two missing (CONT'D)* on the boy's voice-over in the flashback (p. 17).
- Nothing else changed. All 21 pages were read again against the checklist above.
