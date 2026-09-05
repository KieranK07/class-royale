// Tests the degree planner. Run: npm run test:plan
//
// The interesting cases aren't "does it produce a plan" — it's whether it
// produces one a student could actually follow: nothing scheduled before its
// prerequisites, nothing scheduled in a season it isn't taught, nothing
// silently dropped to make the plan look finished.
import { readFileSync } from "node:fs";
import { buildPlan, parseTermLabel, nextTerm, prerequisitesSatisfied } from "../src/lib/plan";
import type { ScheduleTemplate } from "../src/lib/schedules";
import type { Course } from "../src/lib/types";
import type { TranscriptTerm } from "../src/lib/transcript";

import { readdirSync } from "node:fs";

/**
 * Newest scraped catalog year on disk.
 *
 * Hardcoding "2025-2026" here made the tests assert against a catalog the app
 * had already stopped reading — the same staleness the scrapers were just
 * fixed for, one layer up. A test pinned to old data passes while the thing
 * it tests is broken.
 */
function newestCatalogYear(): string {
  const dir = new URL("../data/catalog/", import.meta.url);
  const years = readdirSync(dir).filter((y) => /^\d{4}-\d{4}$/.test(y)).sort();
  if (years.length === 0) throw new Error("No scraped catalog in data/catalog/ — run npm run scrape:catalog");
  return years[years.length - 1];
}
const CATALOG_YEAR = newestCatalogYear();


let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
};

const schedules = JSON.parse(
  readFileSync(new URL("../data/derived/program-schedules.json", import.meta.url), "utf8")
);
const courseData = JSON.parse(
  readFileSync(new URL(`../data/catalog/${CATALOG_YEAR}/_courses.json`, import.meta.url), "utf8")
);
const courses = new Map<string, Course>(
  courseData.courses.map((c: Course) => [c.code.toUpperCase(), c])
);

function template(name: string): ScheduleTemplate {
  const s = schedules.schedules.find((x: { name: string }) => x.name === name);
  if (!s) throw new Error(`no schedule for ${name}`);
  return s as ScheduleTemplate;
}

const CS = template("Computer Science, Bachelor of Science");

console.log("--- term arithmetic ---");
check("parses a term label", parseTermLabel("Fall 2026"), { season: "Fall", year: 2026 });
check("fall rolls into the next calendar year's spring",
  nextTerm({ season: "Fall", year: 2026 }), { season: "Spring", year: 2027 });
check("spring rolls into the same year's fall",
  nextTerm({ season: "Spring", year: 2027 }), { season: "Fall", year: 2027 });
check("ignores a label with no year", parseTermLabel("Transfer Year/Term"), null);

console.log("\n--- prerequisites read the sentence, not the list ---");
{
  const orCourse: Course = {
    code: "X", title: "", credits: 3,
    prerequisites: ["CSC 141", "CSC 171", "CSC 144"],
    prerequisiteText: "CSC 141, CSC 171 or CSC 144",
  };
  const andCourse: Course = {
    code: "Y", title: "", credits: 3,
    prerequisites: ["SFE 128", "SFE 240"],
    prerequisiteText: "SFE 128 and SFE 240",
  };
  check("one of three is enough for an OR",
    prerequisitesSatisfied(orCourse, new Set(["CSC 144"])).ok, true);
  check("none of three is not",
    prerequisitesSatisfied(orCourse, new Set(["MTH 161"])).ok, false);
  check("an AND needs both",
    prerequisitesSatisfied(andCourse, new Set(["SFE 128"])).missing, ["SFE 240"]);
  check("no prerequisites is always satisfied",
    prerequisitesSatisfied(undefined, new Set()).ok, true);
}

console.log("\n--- a freshman with one term done ---");
{
  const past: TranscriptTerm[] = [
    {
      label: "Fall 2025",
      honors: [],
      termTotals: null,
      courses: [
        { code: "CSC 144", term: "Fall 2025", creditsEarned: 3, grade: "A" },
        { code: "CSC 142", term: "Fall 2025", creditsEarned: 1, grade: "A" },
        { code: "MTH 161", term: "Fall 2025", creditsEarned: 4, grade: "B" },
      ],
    },
  ];
  const plan = buildPlan({ transcriptTerms: past, template: CS, courses });

  check("the past is the transcript, unchanged", plan.terms[0].label, "Fall 2025");
  check("history is marked as history", plan.terms[0].kind, "past");
  check("earned credits come from the transcript", plan.earnedCredits, 8);
  check("the plan starts the term after the last real one", plan.terms[1].label, "Spring 2026");

  const future = plan.terms.filter((t) => t.kind === "future");
  const placed = future.flatMap((t) => t.entries.map((e) => e.codes[0] ?? e.label));
  check("courses already taken aren't scheduled again",
    placed.some((c) => c === "CSC 144" || c === "MTH 161"), false);

  // The load has to look like something a person would register for.
  const loads = future.filter((t) => t.entries.length).map((t) => t.credits);
  check("no term exceeds the overload ceiling", loads.every((c) => c <= 18), true);
  // A light FINAL term is a real result — you don't pad a last semester with
  // courses a student doesn't need. A light term in the middle is a bug.
  check("no term before the last is trivially small",
    loads.slice(0, -1).filter((c) => c < 9).length, 0);

  // Nothing before its prerequisites, checked against the real catalog.
  const seen = new Set(["CSC 144", "CSC 142", "MTH 161"]);
  const violations: string[] = [];
  for (const t of future) {
    for (const e of t.entries) {
      const c = e.codes[0] ? courses.get(e.codes[0]) : undefined;
      const res = prerequisitesSatisfied(c, seen);
      if (!res.ok) violations.push(`${e.codes[0]} in ${t.label} needs ${res.missing.join(", ")}`);
    }
    for (const e of t.entries) for (const c of e.codes) seen.add(c);
  }
  check("nothing is scheduled before its prerequisites", violations, []);

  // Seasons come from the department's own layout, and constrain named
  // courses only: where the schedule puts a slot is where that year had room,
  // not a claim that electives are taught one semester a year.
  const wrongSeason = future.flatMap((t) =>
    t.entries
      .filter((e) => e.kind === "course" && e.season && t.season && e.season !== t.season)
      .map((e) => `${e.label} in ${t.label}`)
  );
  check("no course is scheduled out of season", wrongSeason, []);
  const slotSeasons = new Set(
    future.flatMap((t) => t.entries.filter((e) => e.kind !== "course").map(() => t.season))
  );
  check("slots are not pinned to one season", slotSeasons.size > 1, true);
}

console.log("\n--- the transcript lists terms newest-first ---");
{
  // Exactly how it arrives from Jenzabar. Taking "the last element" as the
  // most recent term starts the plan a year in the student's own past.
  const past: TranscriptTerm[] = [
    { label: "Fall 2026", honors: [], termTotals: null, courses: [
      { code: "CSC 145", term: "Fall 2026", creditsEarned: 3 }] },
    { label: "Spring 2026", honors: [], termTotals: null, courses: [
      { code: "CSC 144", term: "Spring 2026", creditsEarned: 3 }] },
    { label: "Fall 2025", honors: [], termTotals: null, courses: [
      { code: "MTH 161", term: "Fall 2025", creditsEarned: 4 }] },
    { label: "Transfer Year/Term", honors: [], termTotals: null, courses: [] },
  ];
  const plan = buildPlan({ transcriptTerms: past, template: CS, courses });
  const first = plan.terms.find((t) => t.kind === "future")!;
  check("the plan starts after the most recent term, not the last listed",
    first.label, "Spring 2027");
  const history = plan.terms.filter((t) => t.kind === "past").map((t) => t.label);
  check("history reads oldest-first",
    history, ["Transfer Year/Term", "Fall 2025", "Spring 2026", "Fall 2026"]);
}

console.log("\n--- nothing is dropped to make the plan look finished ---");
{
  const past: TranscriptTerm[] = [
    { label: "Fall 2025", honors: [], termTotals: null, courses: [] },
  ];
  // One term of room for a whole degree: the plan must overflow loudly.
  const plan = buildPlan({
    transcriptTerms: past, template: CS, courses, options: { maxTerms: 1 },
  });
  const placed = plan.terms.filter((t) => t.kind === "future").reduce((n, t) => n + t.entries.length, 0);
  const templateEntries = CS.terms.reduce((n, t) => n + t.entries.length, 0);
  check("every requirement is either placed or reported",
    placed + plan.unplaced.length, templateEntries);
  check("and each overflow says why", plan.unplaced.every((u) => !!u.blockedBy), true);
}

console.log("\n--- a program with no published schedule ---");
{
  const plan = buildPlan({
    transcriptTerms: [{ label: "Fall 2025", honors: [], termTotals: null, courses: [] }],
    template: null,
    courses,
  });
  check("history still renders", plan.terms.length, 1);
  check("no future is invented", plan.terms.filter((t) => t.kind === "future").length, 0);
  check("and it says why", plan.warnings.length > 0, true);
}

console.log("\n--- every published schedule can be planned from ---");
{
  const past: TranscriptTerm[] = [
    { label: "Spring 2026", honors: [], termTotals: null, courses: [] },
  ];
  const bad: string[] = [];
  for (const s of schedules.schedules as ScheduleTemplate[]) {
    const plan = buildPlan({ transcriptTerms: past, template: s, courses });
    const future = plan.terms.filter((t) => t.kind === "future");
    const over = future.filter((t) => t.credits > 18);
    if (over.length) bad.push(`${s.name}: ${over.length} overloaded term(s)`);
    const total = future.reduce((n, t) => n + t.entries.length, 0) + plan.unplaced.length;
    const expected = s.terms.reduce((n, t) => n + t.entries.length, 0);
    if (total !== expected) bad.push(`${s.name}: ${expected - total} entries vanished`);
  }
  check(`all ${schedules.schedules.length} programs lay out without losing entries`, bad.slice(0, 5), []);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
