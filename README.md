# Class Royale

A replacement for Franciscan University's degree-planning pages. It shows what
you've taken, what your program still needs, which of those you're actually
eligible to register for right now, and which minor you're closest to
finishing by accident.

## Why it exists

Franciscan's planner will tell you a course exists. It won't tell you whether
you've met its prerequisites, whether it runs in the term you're planning for,
or what it would count toward if you took it. Answering that means having the
catalog, the registration search and your own transcript open at once and
doing the join by hand — every advising meeting, every registration window.

I wrote a first version of this in March: two Python scrapers and a static
planner page. It worked, but to read the registration API it had to log in as
me and cache the session cookie in a dotfile next to the script. That's
tolerable for something that only ever runs on my laptop and completely wrong
for anything anyone else would install. So this version starts from the
opposite constraint — no server of mine ever holds a student's session — and
most of the architecture below is a consequence of that one rule.

## How it works

Two data sources, and only one of them needs a login.

**The public catalog.** `franciscan.smartcatalogiq.com` needs no
authentication at all. `scripts/scrape-catalog.mjs`, `scrape-core.mjs` and
`scrape-courses.mjs` crawl it into `data/catalog/<year>/`, which is committed —
so a clone renders the whole catalog with no scrape and no network. Two years
are in the tree (2025-2026 and 2026-2027); the app loads the newest one it
finds on disk rather than a hardcoded year. 2026-2027 comes out as 61 majors,
50 minors and 14 concentrations over 1,296 courses and 2,677 requirement rows,
with nothing the scraper failed to parse.

**Your transcript and the live section list.** These live behind Microsoft SSO
on `myfranciscan.franciscan.edu`, a Jenzabar EX/ICS system that sends no CORS
headers and restricts framing. A page served from any other origin physically
cannot read them — that's the browser refusing to let one site read your
authenticated pages on another, and it's the correct behaviour. So there are
two ways in: paste the transcript text yourself, or install `extension/`,
which runs with permission you grant and is scoped to that one host.

The extension is deliberately stupid. It fetches with
`credentials: "include"` — which asks *the browser* to attach the session it
already has, so the code never touches a cookie — and hands the raw HTML or
JSON straight back to the tab. It parses nothing. All parsing lives in
`src/lib/transcript.ts` and `src/lib/sections.ts`, so there's one parser to fix
when Jenzabar changes their markup, and the privileged component stays small
enough to read in a sitting: three files, about 330 lines. Its two POST paths
(the registration portlet's own form, and a page of search results) are pinned
to one pathname each and its form fields are bounded by shape, so it can't be
repurposed into a general request proxy sitting on someone's session.

Because of that split, **there is no backend**. No database of student records
to breach, because there isn't one. The transcript never leaves the browser.

What the app does with the data:

| | |
|---|---|
| `progress.ts` | how much of a program is satisfied — options are alternatives, and satisfaction is capped at what the group asks for |
| `prereq.ts` | parses a prerequisite *sentence* as the boolean expression it is, three-valued so "permission of instructor" comes back `unknown` rather than `false` |
| `planner.ts` | what you're eligible to take next, ranked by scarcity |
| `overlap.ts` | the "free minor" math — counts what you've finished plus what your major forces on you anyway |
| `plan.ts` | a semester-by-semester plan, laid out from the department's own published four-year schedule rather than generated from constraints |
| `section-sync.ts` | pages through the live section search for the two most recent terms, so "not offered" becomes "Fall" |

The prerequisite parser exists because two contradictory readings of the same
sentence were live in this codebase at once: `planner.ts` treated any "or" as
making the whole sentence a disjunction (too permissive — offers you courses
you can't register for), `plan.ts` treated any "and" as a conjunction (too
strict — pushes a sophomore course past graduation). Now the sentence is
parsed once and both callers use the result.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

The scraped catalog is committed, so it works immediately, logged out. To see
your own progress, either paste your transcript into the sync panel or load
`extension/` unpacked (`chrome://extensions` → Developer mode → Load unpacked)
and click Sync — that path reads the pages of whoever is logged into the
browser, so it only ever shows you your own record. See `extension/README.md`.

| | |
|---|---|
| `npm run scrape:catalog` | re-scrape program requirements (~2 min) |
| `npm run scrape:core` | re-scrape the Core Curriculum |
| `npm run scrape:courses` | re-scrape course descriptions and prerequisites |
| `npm run verify:catalog` | cross-check scraped data against the live pages |
| `npm run stats` | data health summary |
| `npm test` | transcript parser, requirement engines, section parsing, prereq, plan |

`npm test` and `verify:catalog` are the two that matter. The engine tests
exist because the two worst bugs so far were both in there and both silent —
options treated as a checklist rather than alternatives, and one course
satisfying several requirements at once. Neither threw; both produced
plausible wrong numbers.

`verify:catalog` re-reads every program page with a separate, deliberately
dumber implementation ("every course link in every section that isn't a year
schedule") and diffs it against what was scraped. Reusing the scraper's own
parsing would only prove the scraper agrees with itself. It exits non-zero on
any discrepancy.

## Layout

```
src/lib/          types, parsers (transcript, sections, prereq) and the
                  requirement engines (progress, overlap, planner, plan)
src/components/   Explorer (the page), SyncPanel, Planner
scripts/          scrapers, the independent verifier, tests
data/catalog/     scraped programs, Core Curriculum, courses, per year
data/derived/     requirements recovered from catalog prose (validated)
extension/        the sync extension — manifest, content script, worker
docs/             a running log of how the scraping actually works, and why
```

## Design principle

A missing requirement is recoverable; a fabricated one silently ruins a degree
audit. So wherever the two trade off, this drops data rather than guesses.

- Requirement rows the catalog gives no courses for are shown as unresolved,
  not filled in with something plausible.
- Data recovered from catalog prose is validated against the source text and
  discarded when the evidence quote isn't verbatim — `data/derived/_dropped.json`
  is what got thrown away.
- The scrapers report what they couldn't parse (`unparsedPrograms`,
  `uncertainSections`, unmatched course headings) instead of skipping it
  quietly.

## Status and known gaps

Working end to end. The catalog side stands on its own; the login-gated side
has been confirmed against exactly one real session (mine), in Opera GX. The
extension is plain MV3 and should behave the same in Chrome and Edge, but I
haven't checked.

- **135 of 2,677 requirement rows (5%) have no course list**, because the
  catalog never states one anywhere. They render as unresolved rather than
  guessed at. `npm run stats` prints the current numbers.
- **The derived layer is still keyed to 2025-2026.** `elective-rules.json`,
  `graduation-requirements.json` and `prose-programs.json` are stamped
  2025-2026, but `loadCatalog()` picks the newest catalog year on disk and
  applies them without a year check. They match by program and course name, so
  it mostly holds, but it hasn't been re-derived for 2026-2027.
- **Double-counting a course between a major and a minor is assumed allowed.**
  The catalog states no limit either way. Worth confirming with an advisor
  before planning around a "free" minor.
- **"Academic area" is undefined by the catalog**, so the rule that a minor
  must be a *second* area is approximate. Minors in your own subject are
  correctly hidden; same-department pairings in arguably different areas
  (Theology → Franciscan Studies) are still listed and flagged to check.
- The extension's content script matches `http://localhost:3000/*`. Deploying
  Class Royale anywhere else means adding that origin to `manifest.json`.
- The department `.xlsx` advising handouts aren't in the repo — they're
  Franciscan's documents, not mine to redistribute. `npm run parse:guides`
  reads whatever you drop into `data/program-guides/`; its output is committed.
- No CI. The tests are scripts you run.
