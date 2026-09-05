# Scraping notes: Franciscan's systems

Findings from a HAR capture of `port.franciscan.edu` (course search / add-drop flow),
2026-08-24. Update this file as we learn more — it's the source of truth for how
data actually gets pulled, since it changes as we investigate more pages.

## Core principle: this HAR is a map, not a data source

Everything below comes from one capture of Kieran's session on one day. That's
enough to reverse-engineer **shape** — which URLs exist, what parameters they
take, what the response looks like — and that part is safe to hardcode,
because it's the API contract, not a fact about the world.

It is NOT enough to hardcode **values** — which term is current, which
catalog year is active, what's currently offered, what a specific student has
taken. Those change constantly and differ per student. Every one of those has
to be resolved live, at the moment a student actually uses the app, from
their own authenticated session — never baked in from this analysis, and
never cached server-side as some kind of shared snapshot.

Concretely: the "current fall / most recent spring" YearCode+TermCode formula
below is a fallback for understanding the encoding, not the mechanism the app
should actually use. The portal already tells a logged-in student which term
is current — the registration page's term dropdown ships with
`<option value="2026;10" selected>Fall 2026</option>`, i.e. the system itself
marks the default/current term. The right design reads that signal live, off
the page the student is actually looking at (or the equivalent live API
field, once found), every time — not date arithmetic on our side guessing
when the school's terms start. Same logic applies to the catalog year on
smartcatalogiq.com (`2025-2026` will stop being current eventually) — that
should be resolved from whatever the catalog site itself marks as current at
request time, not hardcoded as a path segment.

## The systems involved

Franciscan actually has (at least) two layers:

1. **`port.franciscan.edu`** — a newer dashboard/launcher (API at
   `api.port.franciscan.edu`, `/v1/`, `/v2/` REST endpoints). This is a portal
   shell: dashboards, notifications, groups, events, quick links. It surfaces a
   navigation menu (`GET /v2/menu/navigations/active/`) that lists every page a
   student can reach, each with a `slug` and a `description` — this is basically
   a sitemap of the whole student experience. Worth re-pulling this endpoint
   whenever we need to find where something lives.

2. **`myfranciscan.franciscan.edu`** — the actual student information system,
   built on **Jenzabar EX / ICS** (the `/ICS/...` paths, `Jenzabar.EX.Common`
   script bundles, `.jnz` portlet pages are the tell). This is where real
   academic data lives: registration, transcripts, advising.

Login is **SAML SSO through Microsoft** (`login.microsoftonline.com`,
`login.live.com`) — the portal redirects to
`myfranciscan.franciscan.edu/ICS/StaticPages/SAML/ServiceProvider/Request.aspx`,
which bounces to Microsoft for the actual username/password, then posts back to
`.../SAML/ServiceProvider/ACS.aspx` to establish the Jenzabar session. **The
password is entered on Microsoft's own page, never on a Franciscan or
third-party page.** After that, everything rides on a session cookie — the HAR
doesn't show the cookie's name or value because Chromium redacts `Cookie` /
`Set-Cookie` headers from HAR exports by default now (good — that's exactly
the kind of leak we don't want either).

## What's confirmed working so far

### Course/section search (registration data, not requirements)

```
POST https://myfranciscan.franciscan.edu/ICS/webserviceproxy/exi/rest/studentregistration/pagedsectiondataforsearch?Id=<portlet-instance-id>&IdNumber=<student-id>&YearCode=<e.g. 2026>&TermCode=<e.g. 10>
```

Returns JSON — a paged list of course sections (with seats, meeting times,
instructor, etc.) for a given term. This is what powers the "Academics &
Course Registration" add/drop page. Good for "what sections exist this term,"
not for "what has this student taken" or "what does this major require."

`Id` looks like it's tied to the specific portlet render, not a stable API
key — need another HAR capture (or trial and error) to know if it's constant
or has to be scraped off the page first.

**Response shape (confirmed from the HAR's response body):**

```json
{
  "quickFilters": null,
  "totalRows": 15,
  "filteredRows": 1118,
  "rows": [
    {
      "courseCode": "<label class='sr-only'>Course Code</label><a ... data-sectionid='77300' data-yearterm='2026;10' data-advisingrequirementcode='ACC207' ...>ACC-207-A</a>",
      "title": "...Financial Accounting",
      "faculty": "...Macre, Albert F.",
      "seatsOpen": "...0/40",
      "status": "...Full",
      "schedule": "...Tue, Thu<br/>9:30-10:45 AM<br/>8/24/2026 - 12/11/2026 ... Christ the Teacher - 140",
      "credits": "...3.00"
    }
  ]
}
```

This is exactly the data behind the course-search table in the portal UI
(course code, title, faculty, seats open, status, schedule, credits) — so
**this endpoint already covers "what's actually being offered, when, by
whom, with how many seats,"** which the public catalog does NOT have (the
catalog only has static requirement structure, not live section
scheduling/availability).

Two annoying-but-workable things about this response:
- Every field is a raw HTML string (`<label class='sr-only'>...</label>` +
  the real value), not clean JSON values — needs an HTML strip/parse step,
  not just `JSON.parse`.
- It's paginated: `pageSize: 15`, `filteredRows: 1118` for this one term —
  a full term scrape means paging through ~75 requests. The POST body
  carries a `pageState` object (current page, filters, sort) — need to see
  the pagination controls hit at least once more to confirm how `currentPage`
  advances.

**Important lead buried in the HTML:** each course link carries
`data-advisingrequirementcode='ACC207'` (and `data-studentplandetailid`,
`data-isfreeelectivesearch`). That strongly suggests Jenzabar has its own
internal "advising requirement" / "student plan" concept mapping sections to
degree requirements — which could be a more precise, personalized source for
requirement-satisfaction than scraping the public catalog and matching course
codes ourselves. Worth checking the "Academic Advising" portal page
(`academic-advising2`) for an endpoint that exposes this directly.

**`YearCode`/`TermCode` encoding — decoded from the two term searches in the
HAR:**

| Request | Schedule dates in the response | Meaning |
|---|---|---|
| `YearCode=2026&TermCode=10` | 8/24/2026 – 12/11/2026 | Fall 2026 |
| `YearCode=2025&TermCode=20` | 1/12/2026 – 5/6/2026 | Spring 2026 |

So: `TermCode` 10 = Fall, 20 = Spring. `YearCode` is **the calendar year the
Fall term starts in**, and a Fall/Spring pair that make up one academic year
share the *same* `YearCode` — Fall 2025 + Spring 2026 are both `YearCode
2025` ("AY2025"). This means Spring's `YearCode` is always Fall's `YearCode`,
and a Spring's *calendar year* is `YearCode + 1`.

**This encoding is app logic, not a data source.** Knowing that `10` means
Fall and `20` means Spring, and that they pair by `YearCode`, is fine to
hardcode — it's how the API is shaped, and that's stable. Which specific
`YearCode`/`TermCode` counts as "current" is NOT fine to hardcode or to
derive from a guessed date formula, because:

- it's wrong the moment the school's calendar doesn't match our assumption
  (an early/late start, a shifted academic year, a J-term, etc.), and
- it silently goes stale in a way nobody notices until someone's missing a
  semester of data.

The formula below was only ever a way to *verify the decoding* against the
two real captures — it is NOT what the app should run. **The app should read
"what's current" live, from the portal itself, every time a student uses
it** — e.g. the registration page already ships the current term
pre-selected (`<option value="2026;10" selected>Fall 2026</option>` was in
this HAR) — that selected/default value is the source of truth, not our math.
If we find a proper "list of terms" API (still unconfirmed — see above),
that's an even better live source: it would tell us directly which terms are
current/open, and "most recent completed spring" becomes "the entry marked
most recent" instead of anything we compute.

```
// Verification only — confirms the YearCode/TermCode decoding above is
// correct by reproducing the exact two term-codes Kieran's HAR captured.
// NOT how the running app should decide "current" — see note above.
function currentFallCode(today) {
  const y = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
  return { yearCode: y, termCode: 10 };
}
function mostRecentSpringCode(today) {
  const springCalendarYear = today.getMonth() <= 4 ? today.getFullYear() : today.getFullYear() - 1;
  return { yearCode: springCalendarYear - 1, termCode: 20 };
}
// today ~= Aug 24, 2026 → currentFallCode = {2026,10}, mostRecentSpringCode
// = {2025,20} — matches both captures exactly, confirming the encoding.
```

**Not yet confirmed:** whether Jenzabar exposes an actual "list of valid
terms" endpoint (safer than date math if the school's term start dates ever
shift). The registration page's term `<select>` only had one `<option>` in
this HAR (`2026;10`, pre-selected) — the rest of the dropdown's options
weren't captured, meaning they're probably loaded some other way (another
AJAX call triggered on dropdown-open that this HAR didn't catch, since
Kieran selected Spring by some other means already logged in the HAR). Worth
opening that term dropdown specifically in a future capture to see if there's
a canonical term list we should be reading from instead of computing it.

### Public course catalog — no login needed at all

`https://franciscan.smartcatalogiq.com/` is Franciscan's official catalog,
hosted by a third party (SmartCatalogIQ), and it's **fully public**. This is
the real find: **major/minor/concentration requirements can be scraped
without any login, session, or student credentials whatsoever.**

URL pattern:

```
https://franciscan.smartcatalogiq.com/en/<catalog-year>/undergraduate-catalog-<catalog-year>/academic-programs/<department-slug>/<program-slug>
```

e.g. Computer Science BS requirements:

```
https://franciscan.smartcatalogiq.com/en/2025-2026/undergraduate-catalog-2025-2026/academic-programs/computer-science/computer-science-bachelor-of-science
```

**Correction to what I said earlier:** I originally described this page as
grouped under headers like "Core Computer Science Requirements," "Mathematics
Requirements," "General Education/Core Requirements." That was wrong — it
came from an AI-summarized fetch, not the real markup, and the summarizer
invented that category structure. Kieran got the actual HTML via `curl`
(since neither my sandbox nor the device-bridge proxy can reach this site
directly — see below), and the real structure is simpler and different:

- `#degreeRequirements` on a program page holds the requirements as one or
  more `<table>`s. Rows: `td.sc-coursenumber` (an `a.sc-courselink` with the
  course code, or absent for a slot with no fixed course),
  `td.sc-coursetitle`, `td.sc-credits p.credits`.
  - *Second correction, found later:* I first wrote "ONE flat table," which
    was true of Computer Science and wrong in general. Spanish BA splits its
    requirements across several tables under `h4.sc-RequiredCoursesHeading2`
    sub-headings ("Language-Skills Courses," "Content Courses"), and puts an
    empty placeholder `<table></table>` *before* them — so "first table" got
    zero rows and 26 programs silently scraped as empty. The parser now walks
    every sibling between the first `h3.sc-RequiredCoursesHeading1` and the
    next one, collecting every table in that range and tracking the nearest
    h4 as each row's `subLabel`.
  - Only the **first** h3 section is the requirement list. The later h3s
    ("Freshman Year," "Sophomore Year," …) are a suggested four-year
    sequence that re-lists the same courses mixed with Core Curriculum —
    parsing those too would double-count.
- Cross-listed courses (e.g. `CSC 204/SFE 204`) appear as two
  `a.sc-courselink` tags in the same cell — same course, either code
  satisfies it.
- A row with title exactly `"OR"` and no course code is a separator meaning
  "the row before and the row after are alternatives, pick one" (e.g. CSC
  391 OR CSC 392).
- A row with no course code but a real title/credits (e.g. "CSC or SFE
  Elective," "Statistics Elective," "Natural Science Core with Lab") is a
  generic slot that doesn't resolve to a specific course from this page
  alone — flagged `unresolved: true` in the scraper output rather than
  guessed at.
- **The university-wide Core Curriculum (Theology, Philosophy, Literature,
  History, etc.) is NOT in this table.** It only shows up further down the
  page, mixed into a suggested year-by-year/semester-by-semester schedule
  (`h3.sc-RequiredCoursesHeading1` repeating for "Freshman Year," "Sophomore
  Year," etc., each with its own table). That schedule is illustrative, not
  the requirement source — Core Curriculum requirements are the same for
  every student regardless of major and should get scraped once, separately,
  not re-derived per program. **Done** — see "The Core Curriculum" below.

#### Three different page shapes, not one

Not every program page has a requirements table at all. A full crawl turns up
exactly three shapes, and the scraper labels each program with a `kind` so
nothing is ever silently empty:

| `kind` | Count | What it is |
|---|---|---|
| `tables` | 121 | The normal case described above. |
| `narrative` | 5 | A real degree program whose requirements are **prose**, no table anywhere on the page. |
| `informational` | 3 | Not a degree program — partner-school admission pathways. |

- **`narrative`** — Biology Minor, Spanish Minor, Bioinformatics Certificate,
  High School Teaching (AYA Licensure), engineering Honors Program. These
  pages have `div.programTables` but nothing inside it except `<p>`, no
  `#degreeRequirements` and no `sc-coursenumber` cells at all. In full, the
  Biology Minor's requirements are the sentence *"18 credit hours with
  minimum of 9 credit hours in 200-400 level biology courses. BIO 106 is
  excluded."* There is no table being missed — the rules are genuinely
  unstructured on the university's end. The scraper keeps the prose verbatim
  in `narrative[]` and pulls inline course codes into `mentionedCodes[]`
  (Spanish Minor alone yields 22 real codes that were previously lost).
  These need a structured-requirements pass before the overlap engine can
  score them properly; until then they should be surfaced to the student as
  the prose rule, not silently treated as "no requirements."
- **`informational`** — DYouville PharmD, Duquesne PharmD, MA Theology 4+1.
  No `div.programTables` at all; content sits loose in `#main`. These are
  admission-criteria pages for programs at *other* institutions. Captured for
  completeness but should be excluded from "free major/minor" candidates.

Course codes in prose are matched against the set of subject prefixes the
crawl actually saw in real course links (43 of them this year: ACC, ANT, ART,
…), gathered during the run rather than hardcoded — otherwise the bare
`[A-Z]{2,4} \d{3}` regex happily matches things like "GPA 300."

The department landing page (`.../academic-programs/computer-science`) links
out to each specific program (BS, concentration, minor, certificate) via
`/academic-programs/<dept-slug>/<program-slug>` hrefs, and the
`academic-programs` index page lists every department the same way, one
level up. Both confirmed against real HTML, not summarized — see below.

**This means the "scrape every major's requirements" part of the MVP doesn't
need Kieran's login at all** — confirmed with working, tested code (see
`scripts/scrape-catalog.mjs`).

### Getting the real HTML — network access, and one Node gotcha

Originally both my cloud sandbox and the device-bridge shell on Kieran's Mac
(`device_bash`) were blocked from this domain by an allowlist-enforcing
proxy (`403 blocked-by-allowlist`), so Kieran ran the first `curl` commands
himself in his own Terminal and sent the HTML back. That's the ground truth
the parser was originally built against.

Kieran then widened the egress allowlist in Cowork's **Settings →
Capabilities**, which opened up my own sandbox — so I can now fetch these
pages and run full crawls directly. (The device bridge to his Mac is still
proxy-restricted; that's separate.)

**The device bridge to Kieran's Mac is still restricted, including npm.**
Its shell proxies through the allowlist and `npm install` gets a 403 from
`registry.npmjs.org` — it stalls rather than failing loudly, and can leave a
half-extracted package behind (`node_modules/<pkg>/` containing only a nested
`node_modules/`). Installs have to be run from Kieran's own Terminal. Worth
recognizing the symptom: a hung `npm install` over the bridge is a blocked
registry, not a slow disk.

**Gotcha worth remembering:** after that change `curl` worked but the
scraper's `fetch()` still got 403. Cause: `curl` automatically honors the
`https_proxy` / `HTTPS_PROXY` env var; **Node's built-in `fetch` (undici)
does not.** Fix is at the top of `scrape-catalog.mjs` — install `undici` and
call `setGlobalDispatcher(new ProxyAgent(proxyUrl))`, conditional on the env
var being set. On a normal machine with no proxy env var (Kieran's own
terminal, the common case) it's a no-op.

### The scraper: `scripts/scrape-catalog.mjs`

Written and tested against the three real HTML files (verified the
department list, the CS program list, and the full CS BS requirement
parsing all come out correct). It:

1. Resolves the current catalog year live from the catalog homepage's own
   links (highest year found — not a hardcoded string).
2. Crawls the department index → each department page → each program page,
   using path-shape matching (`/academic-programs/<one-segment>` = a
   department, `/academic-programs/<two-segments>` = a program) rather than
   fragile CSS classes, so it isn't tied to exact markup that might shift.
3. Classifies each page as `tables` / `narrative` / `informational` and
   parses accordingly, writing the raw row-by-row `slots` (nothing thrown
   away), a best-effort `requirements` grouping (RequirementGroup shape),
   and `narrative[]` / `mentionedCodes[]` for prose pages, per department to
   `data/catalog/<year>/<dept-slug>.json`.
4. Does a second local pass at the end to resolve prose course codes against
   the subject prefixes the crawl actually saw (no refetching).
5. Checkpoints per department — safe to re-run, already-scraped departments
   are skipped (`--force` to redo everything). Rate-limited (400ms between
   requests) to not hammer their server.
6. Writes `data/catalog/<year>/_report.json` with the full breakdown,
   including an `unparsedPrograms` list — pages that *had* a requirements
   block but produced no rows. **That list should always be empty; anything
   in it is a parser bug**, as distinct from the narrative/informational
   pages, which are expected.

Validated against committed fixtures in `scripts/__fixtures__/` (CS BS,
Spanish BA, Biology Minor, Spanish Minor, DYouville PharmD — one of each
shape plus the two regression cases) and by two independent full live
crawls, on Kieran's machine and in my sandbox, which produced identical
output.

**Current state of the data:** full crawl done, 129 programs — 121 from
tables, 5 narrative, 3 informational, **0 unparsed**. Living in
`data/catalog/2025-2026/`.

### The Core Curriculum: `scripts/scrape-core.mjs`

The ~42-45 credits every Franciscan undergraduate takes regardless of major.
It lives **outside** `/academic-programs/` entirely:

```
.../undergraduate-catalog-<year>/degree-requirements-and-graduation/core-curriculum-requirements
```

so `scrape-catalog.mjs` never sees it. Hence a second script. Output:
`data/catalog/<year>/_core-curriculum.json`.

Its shape is different from a major's, which is why it isn't just another
program record. A major says "take these specific courses." The Core says
"take N from this pool," ten times over:

| Code | Category | Eligible courses |
|---|---|---|
| AFP | American Founding Principles | 3 |
| CFA | Catholic Traditions in Fine Arts | 3 |
| ECO | Economics | 2 |
| HST | History | 5 |
| LIT | Literature | 2 |
| MTH | Mathematics | 9 |
| NSC | Natural Science | 21 |
| PHL | Philosophy | 3 |
| SSC | Social Science | 14 |
| THE | Theology | 3 |

Those tables parse cleanly (same `sc-coursenumber` / `sc-coursetitle` /
`sc-credits` markup as everywhere else, one `h3.sc-RequiredCoursesHeading1`
per category). The loose `<div>`s between tables carry real eligibility
caveats — "HCC 404: HCC majors only", "BIO 150: EDU, HDFS, & SWK majors
only", "ECO 201 is required for ECO majors" — kept as `notes` per category.

**How many you take from each pool is only ever stated in English**, in three
`<p>` blocks above the tables (one each for BA, BS, AA/AS). And the rules
aren't a flat per-category count — they cross categories:

- BA: *"either one math or one economics course"* → one course, from either pool
- BS: *"five philosophy and theology courses"* → one pool of five, drawn from two categories
- AA/AS: several of these (*"one history or social science or American founding principles core"*)

So each parsed rule carries a **list** of category codes, not one:

```
BA     45 credits  1×AFP 1×CFA 1×HST 2×LIT 1×MTH/ECO 2×NSC 3×PHL 1×SSC 3×THE
                   plus: intermediate foreign language requirement
BS     42 credits  1×AFP 1×CFA 1×ECO 1×HST 1×LIT 1×MTH 2×NSC 5×PHL/THE 1×SSC
AA/AS  21 credits  1×THE 1×PHL 1×THE/PHL 1×HST/SSC/AFP 1×NSC 1×LIT/CFA 1×MTH/ECO
```

Parsing English is fragile, so **the parser doesn't trust itself**: every
Core course is 3 credits, so it cross-checks the course count it derived
against the credit total stated in the same sentence (45, 42, 21). A
mismatch throws at scrape time. If the catalog rewrites these sentences next
year, the script fails loudly instead of quietly producing a wrong degree
audit. Same reasoning for the category headings — a heading that doesn't
match `<Name> Core (<CODE>):` throws rather than being skipped.

Per the standing principle, *none* of this is hardcoded: catalog year,
category list, eligible courses, and the per-degree rules are all re-derived
from the live page on every run. The only hardcoded things are structural
facts about the page (the markup selectors) and the 3-credits-per-Core-course
assumption, which exists specifically so it can be checked.

**Related find:** the Honors Program page states an explicit Honors→Core
substitution table in prose (`HON 101 = literature core (ENG 210 or ENG 211)
or history core`, and so on for HON 102/201/202/301/302/401/402), plus which
Core requirements Honors does *not* cover (Catholic traditions in fine arts,
natural science, THE 101, THE 115). Captured as a `department-page` narrative
by `scrape-catalog.mjs`. It needs structuring before the overlap engine can
use it, but it's the exact substitution data that engine wants.

### Transcripts — "what has this student actually taken"

From the transcript HAR, 2026-08-25. **This is the piece that was missing**;
the catalog says what a degree requires, this says what a student has done.

```
GET https://myfranciscan.franciscan.edu/ICS/Registration/New_Undergraduate.jnz
      ?portlet=My_Unofficial_Transcript&hideUI=1
```

Reached from the portal page `api.port.franciscan.edu/v1/pages/slug/transcripts/`,
which is just a content page that embeds the above in an iframe. `hideUI=1`
strips the Jenzabar chrome — that's the version to parse.

**There is no JSON API here.** Unlike course search (which has a real REST
endpoint returning JSON), the transcript is rendered server-side as HTML.
The page *is* the interface. That's not a limitation to work around; it just
means the parser takes a DOM.

**Page structure** (all inside `#pg0_V_divTranscriptDetails`):

- One summary `table#pg0_V_tblDivisonData` — rows `Transfer` / `Local` /
  `Career`, columns Attempted / Earned / GPA Credits / Quality Points / GPA.
- Then one `table.GroupedGrid` per term, each preceded by sibling `<div>`s
  holding the term label ("Fall 2025", "Transfer Year/Term") and any honors
  ("DEAN'S LIST"). The label divs are *siblings before* the table, not a
  wrapper — so walking must stop at the previous `<table>` or honors from an
  earlier term leak forward into a later one.
- Course columns: Course, Title, Grade, Repeat, Attempted Credits, Earned
  Credits, GPA Credits, Quality Points, GPA. The parser maps these by header
  text rather than fixed index.
- The last two rows of every term table are `Term Totals:` and
  `Career Totals:` — real data, but not courses. They have to be filtered or
  they show up as phantom classes.

**Two things that will silently corrupt an audit if missed:**

1. **The course cell carries section and delivery-mode suffixes.**
   `CSC 145 A`, `ECO 201 HY B` (hybrid), `ECO 212 OL A` (online),
   `CHM 116 M L`, `SFE 240 NA`. Transfer rows have no suffix at all
   (`CSC 141`). Everything after the three-digit number must come off before
   matching against catalog codes, or nothing matches anything.

2. **Grade codes decide whether a course counts.**

   | Grade | Meaning | Counts toward requirements? |
   |---|---|---|
   | `A`–`F` | normal letter grade | yes |
   | `WIP` | work in progress — enrolled now, not yet graded | **no** — but "you're already in it" matters for planning |
   | `TR#` | transfer credit accepted | yes (earned credits, 0 GPA credits) |
   | `P`/`S`/`CR` | pass / satisfactory | yes, no GPA impact |
   | `W`/`WD` | withdrawn | no — 0 earned credits |

   Counting `WIP` as done would overstate progress; ignoring `TR#` would
   understate it. The parser splits these explicitly and any grade code it
   doesn't recognize goes into `warnings` rather than being guessed at.

**Parser:** `src/lib/transcript.ts`, tested by `npm run test:transcript`
(24 assertions). It takes a `Document`, not an HTML string, so the same code
runs against a live page in an extension (`document`), a fetched string
(`new DOMParser().parseFromString(...)`), and the test fixture — with no
server-side HTML parser anywhere in the path. Verified against the real
transcript: 24 courses across 4 terms, 0 warnings.

**The fixture is synthetic and must stay that way.** A real transcript page
contains the student's name, ID number, every grade and their GPA.
`src/lib/__fixtures__/transcript.html` keeps the real markup but with
invented courses and grades (plus one deliberately bogus grade code, to
exercise the warning path). `.gitignore` now blocks `*.har` and stray
`transcript*.html` so a real one can't be committed by accident.

#### This settles the architecture question

`New_Undergraduate.jnz` requires the student's Jenzabar session cookie, and
`myfranciscan.franciscan.edu` sends no CORS headers. So:

- A **web app** at some other origin *cannot* fetch this, even with the
  student logged in. The browser blocks it. No amount of client-side code
  gets around that.
- A **server-side fetch** could — but only by holding the student's
  credentials or session cookie, which is exactly the thing Kieran ruled out.

Those are the only two options for a plain website, and both are dead. What
works is a **browser extension** (or userscript): it runs on the
`myfranciscan.franciscan.edu` origin itself, so the session cookie is already
attached and CORS doesn't apply, the password is only ever typed into
Microsoft's own login page, and the parsed result never has to leave the
student's machine. The app can then be a static site with no backend at all —
nothing to breach, because it stores nothing.

That's a design decision worth confirming before building on it, since it
changes what "the website" means: the site becomes a viewer, and the
extension is what actually reads the student's data.

#### h3 sections: the rule that took three tries

`#degreeRequirements` is divided by `h3.sc-RequiredCoursesHeading1`. Surveying
all 130 table-based pages (375 sections) gives the real vocabulary:

| Kind | Sections | Handling |
|---|---|---|
| Year schedule ("Freshman Year", "Summer Session") | 229 | **Skipped** — re-lists courses required elsewhere, mixed with Core. Parsing them double-counts. |
| Main requirement list ("… Degree Requirements for …", or empty) | 76 | Every row required. |
| Explicit choice ("One of the following:", "Any three of the following courses:") | ~10 | Heading carries the count; rows are the options. |
| Other headings | ~60 | Rows required; flagged if the wording hints at a choice. |

Version 1 took only the first section — right for majors, badly wrong for
minors. The British and American Literature Minor is *"ENG 325, plus one of
these 4, plus one of these 7, plus three of these 20"* across four sections,
and scraped as a **one-course minor**. Fixing this took total captured
requirement groups from 1,479 to 2,586.

Two traps inside the heading parser, both found by checking output against
real pages rather than trusting the regex:

- **The unit belongs to the number it's attached to.** *"3 of these 4
  required and 9 credits in other anthropology courses"* — matching the
  heading for `/credit/` anywhere turns a 3-**course** requirement into a
  3-**credit** one. Only a `credit` immediately following the number counts.
  A heading with a second number is flagged, since one group can't hold it.
- **15 programs have no requirements section at all** (Education licensure
  tracks, the 2+2 engineering pathways) — the four-year schedule is the only
  listing. Skipping year sections left them empty, so they fall back to the
  schedule and carry `requirementsFromSchedule: true`, because those
  requirements include Core courses and will overlap the Core card.

Headings that read like a choice but state no count are never guessed at —
they're treated as all-required (the safe reading) and listed in
`_report.json` under `uncertainSections` for review. Currently 9.

#### Separator rows: "OR" and "and"

A row with no course code whose title is exactly `OR` or `and` is punctuation
between the rows around it, not a requirement. Getting this wrong put
requirements literally named **"OR"** into 26 programs.

- **`and` is a conjunction** — `CHM 111 / and / CHM 116` means take both. Drop
  the row; the neighbours stand as separate required groups.
- **`OR` is a choice, and it chains.** The Theology Minor has
  `THE 110 / OR / CAT 302 / OR / HON 201` — one three-way choice. Consuming
  only the first pair left the second `OR` as the current row, which then
  became its own group. The parser now absorbs the whole chain.
- **Both sides can be code-less.** `Philosophy Core / OR / Theology Core` has
  no course codes at all. An earlier version only merged when both sides had
  codes, so these split into two mandatory rows plus a stray "OR". They now
  merge into one `unresolved` credit-unit group.

Result: 0 requirements named "OR" or "and", 166 merged choice groups.

#### Pages that aren't programs

Three kinds of catalog page exist that nobody declares, and all were showing up
in the "pick a major" list:

- **Department overviews** — `Physics`, `Modern Languages and Literatures`,
  `Military Science (Army ROTC Program)`, `Honors Program`. Typed `reference`
  and kept, because some carry real rules in prose (the Honors page states the
  entire Honors-to-Core substitution table), but never offered as a major.
- **Reference listings** — `Courses Grouped By Field`, a Political Science page
  listing courses by category. Matched narrowly on a title beginning "Courses".
  A keyword test for degree words would be wrong here: plenty of real programs
  have none ("Software Engineering", "Greek Language and Civilization",
  "Nursing RN to BSN").
- **Partner pathways** — the two PharmD agreements and MA Theology 4+1,
  already excluded as `informational`.

Two programs are listed under two departments each (`Honors Program` under
Engineering and its own department; `Bioinformatics Certificate Program` under
both Biology and Computer Science). They're genuinely separate pages with
different content, so the loader keeps the richer one — real requirements beat
prose, more prose beats less.

Not every thin-looking program is a bug: the French BA really is stated as
"24 credits of upper-level (300-400) French courses" plus a thesis-or-seminar
choice. Two requirement groups is the correct reading of that page.

### Cross-checking the whole catalog: `scripts/verify-catalog.mjs`

The scraper agreeing with itself proves nothing. This re-reads every program
page with a **separate, deliberately dumber implementation** — "collect every
course link in every section that isn't a year schedule" — and diffs that
against what actually landed in `data/catalog/`. Reusing the scraper's own
parsing would just reproduce its bugs and agree.

Run it after any parser change:

```bash
node scripts/verify-catalog.mjs
```

It exits non-zero on any discrepancy, in either direction: a course on the page
that never made it into the data, or a course in the data that isn't on the
page.

**First run found 46 of 121 programs losing courses.** Every one traced to the
same root cause: **requirement data that isn't in a table.**

- `div.sc-requirementsNote` holds the option list that RESOLVES an unresolved
  elective row. The table says bare "Social Work Elective"; the note beside it
  says *"Social Work Elective Options: SWK 316, SWK 317, …"*. Those are now
  bound onto the requirement and marked `optionsFromNote`.
- Plain `<p>` inside the requirements block holds substitution rules — the
  French BA's *"Students may substitute a maximum of two non-FRN-coded
  courses…"* names ten specific ones.
- Some notes sit **outside** `#degreeRequirements` entirely, as siblings within
  `.programTables` (Narrative Arts Minor, the History AYA track).
- Some sit **inside the same wrapper as a table**, so parsing the tables and
  returning skipped them (Management Minor).
- And notes in a choose-N section were skipped outright, because that branch
  ends in `continue` before note handling ran.

Binding is deliberately conservative. A note only supplies options if it says
so (`Options:`, `one of the following`, `complete one of`, `choose`) **and**
names at least two courses. Otherwise it's kept verbatim in `notes[]` and shown
under "From the catalog page". Without that rule, *"Elective: BUS 400 Internship
may be applied for here"* would narrow a free elective down to exactly one
course — worse than leaving it unresolved.

Current state: **0 discrepancies across all 121 table-based programs.** 24
requirements resolved from notes, 339 prose notes kept, 438 requirements still
genuinely unresolved (the catalog names no courses for them anywhere).

### Course descriptions: `scripts/scrape-courses.mjs`

`scrape-catalog.mjs` reads PROGRAMS, so it only ever learns about courses some
requirement table happens to mention. The catalog's own `/courses` section is
the real course list — and the only place prerequisites exist.

```
.../undergraduate-catalog-<year>/courses/<subject>-course-descriptions
```

**One request per subject (50), not per course (~1000).** Each subject page
carries every course in that subject in full: `h2.course-name` followed by
sibling blocks until the next one — a `.desc` with the description, a
`.sc-credithours`, then further `.desc` blocks whose `h3.courseListHeader`
says what they are ("Prerequisites", "Cross Listed Courses", "Corequisites").

Output: `data/catalog/<year>/_courses.json` — 993 courses, 988 with credits,
441 with prerequisite chains.

**One subject writes its headings backwards.** HDF reads `"435 HDF Seminar"`
rather than `"HDF 435 Seminar"`, so the whole subject scraped as zero courses
and nothing said so. Both orders are now handled, and any heading matching
neither pattern is *reported* rather than skipped silently — the same
principle as `unparsedPrograms`.

#### Prerequisites are a sentence, not a list

`CSC 141, CSC 171 or CSC 144` and `CSC 141 and CSC 171` scrape to similar code
lists and mean completely different things. The code list alone would tell a
student they're blocked from a course they can actually take, or vice versa.

So `prerequisiteText` keeps the catalog's sentence verbatim, and
`src/lib/planner.ts` reads the connective: an "or" anywhere means any one of
the listed courses suffices, otherwise all are required. The sentence is shown
in the UI so the call can be checked rather than trusted.

#### Ranking what to take next

"Ready to take" ranks by **scarcity**, not by how many requirements a course
ticks. Twenty-one Natural Science options each cover two requirements and
buried CSC 265 — the only course that satisfies its own requirement, and the
one actually worth planning around. Each requirement also caps how many of its
options appear, so one broad pool can't crowd out every other requirement on
the list.

#### A minor must be a *second* academic area

Straight from the catalog's "Other Degree Options" page:

> A minor in a **second academic area** is available to students who are
> earning an undergraduate degree in a primary area.

So a Computer Science major cannot add a Computer Science minor. This matters
more than it sounds: a major covers its own minor almost entirely, so that
minor sorts to the **top** of "cheapest to add" every single time. The single
most prominent recommendation on the page was the one thing the student
couldn't do.

**Matched on word containment over the program name, not its department.**
Departments are far too coarse — Engineering holds nine majors and three
minors, and a Mechanical Engineering major has every right to a Cybersecurity
minor.

**The parenthetical has to be kept.** Stripping it reduced "Computer Science
(Cybersecurity Concentration)" to just `{computer, science}`, which never
matched `{cybersecurity}` — so a Cybersecurity-concentration student was
offered a *Cybersecurity minor* as their top recommendation. A concentration
names a sub-area, and that sub-area is exactly what a minor must differ from.

Containment runs both ways over lightly stemmed words:

| Program | Area words | Blocks |
|---|---|---|
| Computer Science (Cybersecurity Concentration) | computer, science, cybersecurity | CS Minor, **Cybersecurity Minor** |
| Computer Science, BS | computer, science | CS Minor only — Cybersecurity is a second area |
| Mathematics with AYA Math Licensure | mathematic | Mathematical Science Minor (stemming) |
| Mechanical Engineering, BS | mechanical, engineering | Mechanical Engineering Minor only |

65 pairings blocked across 75 programs, each checked by hand against the
program list.

**One explicit exception**, because the catalog never defines how far
"academic area" extends and somewhere a human has to decide. It lives in
`SAME_AREA_EXCEPTIONS` with its reasoning attached, rather than as a fudge
inside a regex:

> "Catechetics and Evangelization **with Youth Ministry Concentration**" vs
> "**Catholic** Youth Ministry Minor" — the minor's extra word breaks
> containment, but the concentration FORCES 6 of the minor's 8 named
> requirements and both are entirely CAT-coded.

Scoped to the concentration deliberately: plain "Catechetics and
Evangelization, BA" forces only **2 of 8**, so for that major the minor is a
genuine second area and stays on offer. Worth noting the general lesson —
heavy course overlap is *not* on its own evidence of the same area. A plain
Computer Science major is allowed a Cybersecurity minor despite the major
covering most of it.

The catalog doesn't define how far "academic area" reaches, so same-department
pairings in different areas (Theology → Franciscan Studies, English/Writing
concentration → Writing Minor) are still listed, with a note to check them
with an advisor. Guessing tighter would hide real options; guessing looser
already produced a wrong headline recommendation.

### Live section data: built

`src/lib/sections.ts` + `src/lib/section-sync.ts`, driven through the
extension. This is the piece the public catalog can never have: what's
actually offered, when, with whom, and how many seats are left.

#### Nothing about the request is reconstructed

The four query parameters (`Id`, `IdNumber`, `YearCode`, `TermCode`) are the
exact things the standing principle says must never be hardcoded — and they
don't have to be, because **the registration page renders the whole URL
pre-filled**:

```html
<table id='CourseSearchResultsTable'
  data-url='/ICS/.../pagedsectiondataforsearch?Id=312&IdNumber=…&YearCode=2026&TermCode=10'
  data-paging-size='15'>
```

So the flow is: fetch that page → read `data-url` → POST to it. The portlet
id, the student id, the page size and the current term all arrive from the
page the student is looking at. The portlet id isn't even stable — the same
session uses `312` on one screen and `308` on another — which is exactly why
reading it beats deriving it.

Page: `Academics_Homepage.jnz?portlet=Student_Registration&screen=StudentRegistrationPortlet_CourseSearchView&screenType=next`

POST body is `{"pageState":{…,"currentPage":N,"pageSize":15,…}}`, `currentPage`
0-indexed. ~70 pages covers a term's 1,046 sections.

#### The worker stays a dumb pipe

An MV3 service worker has no `DOMParser`, so it *cannot* read the endpoint off
the page even if we wanted it to. That forced the right architecture anyway:
the worker fetches, the page parses. Two operations only —
`FETCH_SECTION_PAGE` (fixed URL) and `FETCH_SECTIONS` (POST) — and the second
**re-validates** the URL the page hands it, checking host and exact pathname.
The URL has to come from the page, but a worker that would POST anywhere on a
student's Franciscan session is a request proxy, not a sync tool.

#### Parsing quirks

Every field is markup, and the schedule cell's shape varies:

```
<span>Thu</span><br/><span>8:40-11:50 AM</span><br/>1/15/2026 - 5/4/2026
<span></span><br/>1/12/2026 - 5/6/2026                    ← online/arranged
…<br/>8/24/2026 - 12/11/2026 <span>Christ the Teacher - 140</span>
```

so each part is identified by what it looks like — a date range, a time, a
weekday list — rather than by position. A section with no meeting pattern
still yields its dates instead of failing wholesale.

Section codes carry more than the course: `ART-150-GA-2` is `ART 150`,
section `GA-2`. Faculty is `Name<br/>Job title` and only the name is wanted.
A row whose code doesn't parse is skipped, not fatal — one malformed row must
not lose the other fourteen.

#### Version mismatch must not look like a network problem

First real-world run failed with *"Couldn't open the registration page
(timeout)"* — because the installed extension was the previous build, which
had never heard of the `SECTION_PAGE` message, and the bridge dropped unknown
message types silently. The page then waited out its 12-second timeout and
reported a network-shaped error for what was actually a stale install.

Two fixes, both about never letting a knowable condition present as a mystery:

- The bridge now **replies to unknown message types** with
  `{ok: false, reason: "unsupported"}` instead of dropping them.
- `READY` carries the extension's `version` and a `supports` list, so the page
  knows what the installed build can do *before* asking. An out-of-date
  extension hides the button and says "reload it at opera://extensions"
  instead of offering something that will fail.

An extension announcing no `supports` list at all is treated as
transcript-only rather than assumed capable.

The `SECTION_PAGE` timeout is also 30s rather than 12s — the registration page
is a heavy Jenzabar render, and the shorter budget was borrowed from a plain
message round trip.

#### Seats are deliberately not cached

Live section results are held in memory only. A cached "4 seats left" from
this morning is worse than no number, so it is never written to
localStorage alongside the transcript.

Verified end to end in a real Chromium with the extension loaded, against a
mock Franciscan serving the real response shape: transcript sync, endpoint
discovery, paging (stopping correctly on the first empty page), parsing, and
rendering — `CSC-265-A · Tue, Thu 9:30-10:45 AM · Rivera, Jordan · 7/25 seats
· Christ the Teacher - 140`.

#### Which term a course runs in, not whether it runs *now*

"Not this term" was the wrong answer to give a student. Offerings rotate — a
course that runs every Fall and never in Spring is not "unavailable", it's a
Fall course — so the label now names the terms: **Fall**, **Spring**, or
**Fall · Spring**, drawn from the two most recent semesters.

Everything that makes that work is read live:

- **The term list** is the registration page's own `stuRegTermSelect`
  dropdown: which terms exist, what they're called, which is selected. No term
  code, season name or academic year appears anywhere in the source.
- **The season word** ("Fall", "Spring") comes from the option's own label,
  not from a `TermCode 10 = Fall` mapping we'd have invented. The mapping is
  the registrar's to define.
- **Chronological order** is the dropdown's own document order — the selected
  term first, then "Past Registration Periods" oldest-first. A numeric key
  (`YearCode`, then `TermCode`) is computed too, and used only when it agrees
  with document order; if they ever disagree the portal's ordering wins.

##### The screen is a JSON envelope, and parsing it raw half-works

`...&screenType=next` doesn't return HTML. It returns
`{ NextScreen, Html, … }`, and `Html` is the markup. Feeding that envelope
straight to `DOMParser` *looks* like it works — single-quoted attributes
survive, so `#CourseSearchResultsTable[data-url]` is found — but `\"`-escaped
ones don't, so the term dropdown silently isn't. Half a page, no error.
`unwrapScreenPayload` JSON-parses first when the body starts with `{`, and
there's a test asserting the raw parse loses the dropdown, so nobody
"simplifies" it back.

##### Each portlet `Id` looks bound to one term

Observed: `Id=312` only ever with `YearCode=2026&TermCode=10`, `Id=308` only
with `2025;20`. So rewriting `YearCode`/`TermCode` on a URL while keeping its
`Id` is **not** known to be safe — it may quietly serve the other term's rows.

The primary path therefore asks the page rather than rewriting the URL: POST
the term to the dropdown's own `data-ajaxformsubmit`
(`/ICS/Academics/Academics_Homepage.jnz?portlet=Student_Registration`) with
the page's own hidden fields, then re-read `data-url` off the re-rendered
screen — which carries that term's correct `Id`. The URL rewrite survives only
as a fallback for when that POST fails.

What makes the fallback safe to have at all: **every row states its own term**
(`data-yearterm='2025;20'`). Labels are built from that, never from which
request the row came back on, and rows tagged with a term we didn't ask for
are dropped rather than mislabeled. If the portal ignores a term switch, the
result is "we only covered Fall 2026" plus a note saying so — not a Fall course
wearing a Spring label. There's a test for exactly that portal.

The term selector is put back the way it was found afterwards, so a student
who opens registration next sees the term they left it on.

##### The search criteria are in the paging request, not the session

The most expensive misunderstanding in this feature, and it took two wrong
fixes to land on the right one. The symptom: paging returned **zero rows, at
200, with no error**. That doesn't read as a failure — it reads as a term in
which nothing is offered, which is a confident wrong answer about someone's
degree.

The page's own attribute sent me the wrong way:

```
data-no-rows-text='To see courses, enter criteria in any fields, and click
                   Search Courses. To narrow the results, enter more criteria.'
```

I read that as "the criteria live in server-side session state, so submit the
search form first" and built two versions of that — one POST, then two. Both
failed, because that isn't where the criteria live.

The HAR had the answer the whole time. Same endpoint, same session, same page:

| `advancedFilters` in the POST body | `filteredRows` in the response |
|---|---|
| `[]` | **0** |
| 19 named keys | **1118** |

And **every one of those 19 values is empty**. It isn't the criteria that
matter — it's whether the array is populated at all. An empty array means "no
search has been run"; a populated one with blank values means "search
everything". There is no search request to submit. There never was.

So `pageStateBody` now carries the full filter set, built by `advancedFilters`.
The names are the endpoint's own parameter vocabulary, the same kind of thing
as the `pageState` keys beside them; where a filter corresponds to one of the
page's search inputs its value is read from that input, so a student's own
criteria would flow through untouched.

##### Two fields that aren't on the page

The term-change POST is confirmed byte-for-byte from the HAR:

```
CurrentPortletState=Default&ScreenToProcessForm=…CourseSearchView
&NextScreenToLoad=…CourseSearchView&PostUrl=…&stuRegTermSelect=2025;20
&ddCodeSearchType=0&txtCourse=&ddTitleSearchType=0&txtCourseTitle=
&ddDivision=&txtInstructor=&txtDepartment=&txtLocation=
&AjaxPortletFormSubmitted=true&IsAjaxPortletSource=true
```

The last two are not elements on the page — Jenzabar's JS adds them — which is
why serializing the form on its own was never going to be enough. The test
portal now rejects a post without them, so this can't quietly regress.

The same capture also settles the portlet-`Id` question: the response to that
POST carries `Id=308` where the previous screen had `Id=312`. Switching term
really does hand back a new endpoint, which is why asking the page beats
rewriting the URL.

Replaying the recorded traffic through the real `syncSections` — the portal
being the HAR's own responses — yields 105 sections across both terms, 37
distinct courses, 8 Fall-only, 14 Spring-only, 15 both.

##### Page size is negotiated, not assumed

Two terms at the portal's own 15 rows/page is ~150 requests. The body's
`pageState.pageSize` is ours to set, so the first request of each term asks
for 100 — but pages are addressed by *index*, so believing a page size the
server didn't honor would skip rows 15-99 silently. The first response settles
it: if fewer rows come back than were asked for while more remain, that count
becomes the page size. Against the mock (which honors it) the whole sync is
two requests.

##### Seats belong to the term you can still register for

Last spring's "3 seats open" is a fact about a closed term. The seat pill and
the section list are filtered to the newest covered term; the term label spans
both.

Extension v0.3.0 adds the `TERM_PAGE` message for this. The worker bounds it
the same way it bounds the section endpoint — that one pathname, that one
`portlet=Student_Registration` query, and an allowlist of five field names —
so it can't become a way to post arbitrary form data into a student's Jenzabar
session. A v0.2.x extension still works; it just can only speak for the
selected term, and the UI says so instead of showing a wrong "not offered".

## Still need

- **Academic Advising page** (nav slug: `academic-advising2` — "View core
  requirements, major and program guides, forms, and advisor office hours")
  — worth a quick look in case Jenzabar exposes an actual personalized degree
  audit tool here (vs. just linking back to the static catalog/PDFs). Lower
  priority now that the public catalog covers raw requirements.
- **Structuring the prose requirements.** Five narrative programs, four
  department pages, and the Honors→Core substitution table are captured as
  verbatim text with course codes extracted, but not as machine-checkable
  requirements. Until they are, the overlap engine can't score them — they
  should be surfaced to the student as the prose rule rather than silently
  treated as "no requirements."
- **Advanced filters on section search.** We page through everything and
  filter locally. The endpoint accepts `keywordFilter` and `advancedFilters`
  whose shapes we haven't captured. Less urgent now that the page size is
  negotiated up — a term is a handful of requests when the server honors it —
  but still the right fix if it ever doesn't.
- **Whether the portal rate-limits a full two-term sweep.** Untested against
  the real server; `MAX_PAGES` and the 120ms delay are the only guard.
- **Whether one portlet `Id` can serve two terms.** Still unknown, and now
  mostly moot: the form post returns a fresh URL carrying the right `Id`, and
  rows are verified against their own `data-yearterm` either way.

## The login-gated parts: why this has to be an extension

Given the constraint "no student password or session data should ever touch
Kieran's own server," and given that auth is Microsoft SSO (password entered
on Microsoft's page) followed by a Jenzabar session cookie scoped to
`myfranciscan.franciscan.edu`:

A normal server-side scraper (Playwright with stored credentials, or a
proxy login) is exactly the pattern we're trying to avoid — it would mean the
app's backend either stores student passwords or handles a session cookie
that's just as sensitive.

The transcript HAR confirmed this isn't just a preference, it's forced.
`New_Undergraduate.jnz` needs the session cookie and the host sends no CORS
headers, so a website at any other origin is blocked by the browser no matter
how the code is written. The only two ways to read it are from the
`myfranciscan.franciscan.edu` origin itself, or by holding the student's
session server-side — and the second one is the thing we ruled out.

So: a **browser extension (or userscript)** that runs *in the student's own
browser*, on `myfranciscan.franciscan.edu`, after they log in the normal way
through Microsoft SSO like they always do. It reads the transcript page with
the session the student already has, parses it with `src/lib/transcript.ts`,
and hands Class Royale the *parsed academic data* — course codes, grades,
credits. Never credentials, never cookies.

The upside of being forced here: Class Royale itself needs **no backend at
all**. It's a static site that receives already-parsed data. There's no
database of student records to breach, because there isn't one.

Scope consequence worth being explicit about: this project is two pieces, not
one — a Next.js site *and* a browser extension. The site alone can never show
a real student their own data. Worth confirming before building around it.

### The extension, built and confirmed working

`extension/` — three files, ~140 lines. Verified end to end on Kieran's own
machine, real session, real transcript: **"Synced 24 courses."**

1. `worker.js` — background `fetch` of the transcript URL with
   `credentials: "include"`
2. `bridge.js` — content script on the Class Royale origin, relaying between
   page and worker
3. the page runs `parseTranscript()` on the returned HTML

The extension does **no parsing**. It hands back HTML and the app parses it,
so there is one parser to fix when Jenzabar changes their markup.

#### The open question, now answered

The one thing that couldn't be settled from the HAR: Chromium redacts
`Set-Cookie` from HAR exports, so the session cookie's `SameSite` attribute
was unknown. If it were `SameSite=Strict`, a background fetch from an
extension service worker might not carry the session, and the whole design
would have needed a content script on the myfranciscan page instead.

**It carries.** A background fetch with `credentials: "include"` gets the
session, so the simpler architecture holds and no content script on
Franciscan's pages is needed. Worth knowing before building the live
course-search flow, which will use the same mechanism against the
`pagedsectiondataforsearch` endpoint documented above — same origin, same
session, same worker.
