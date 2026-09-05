// Tests the prerequisite-sentence parser. Run: npm run test:prereq
import { readFileSync } from "node:fs";
import { checkPrerequisites, describe } from "../src/lib/prereq";
import type { Course } from "../src/lib/types";

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
const met = (text: string, have: string[], earnedCredits?: number) =>
  checkPrerequisites(text, [], { completed: new Set(have), earnedCredits }).met;

console.log("--- shape ---");
check("plain and", describe("SFE 128 and SFE 240"), "(SFE 128 AND SFE 240)");
check("plain or", describe("CSC 141 or CSC 144"), "(CSC 141 OR CSC 144)");
check("parenthesised mix", describe("SFE 128 and (SFE 240 or CSC 256)"),
  "(SFE 128 AND (SFE 240 OR CSC 256))");
check("comma list closed by or", describe("CSC 141, CSC 171 or CSC 144"),
  "(CSC 141 OR CSC 171 OR CSC 144)");
check("comma list closed by and", describe("SFE 112, MTH 161 and PHY 220"),
  "(SFE 112 AND MTH 161 AND PHY 220)");
check("standing plus course", describe("Sophomore Standing and CSC 144 or CSC 171"),
  "((sophomore-standing AND CSC 144) OR CSC 171)");
check("prose is ignored", describe("CSC 144 or permission of instructor"),
  "(CSC 144 OR permission)");

console.log("\n--- the case both old readings got wrong ---");
{
  const text = "SFE 128 and (SFE 240 or CSC 256)";
  // planner.ts read any "or" as making the whole thing a disjunction:
  check("SFE 128 alone is NOT enough", met(text, ["SFE 128"]), false);
  // plan.ts read any "and" as making the whole thing a conjunction:
  check("SFE 128 + SFE 240 IS enough", met(text, ["SFE 128", "SFE 240"]), true);
  check("the other branch also works", met(text, ["SFE 128", "CSC 256"]), true);
  check("neither branch fails", met(text, ["CSC 256"]), false);
}

console.log("\n--- three-valued: unknown is not false ---");
check("permission is unknown, not blocked", met("permission of instructor", []), "unknown");
check("a met course beats an unknown", met("CSC 144 or permission of instructor", ["CSC 144"]), true);
check("standing with no credit count is unknown", met("Junior Standing", []), "unknown");
check("standing evaluates when credits are known", met("Junior Standing", [], 61), true);
check("and fails it when short", met("Junior Standing", [], 12), false);
check("an unmet AND branch is false even with an unknown",
  met("CSC 999 and permission of instructor", []), false);

console.log("\n--- missing lists stay useful ---");
{
  const r = checkPrerequisites("SFE 128 and (SFE 240 or CSC 256)", [], { completed: new Set(["SFE 128"]) });
  check("only the failing branch is reported", r.missing, ["SFE 240", "CSC 256"]);
  const s = checkPrerequisites("CSC 141 or CSC 144", [], { completed: new Set(["CSC 144"]) });
  check("a satisfied or reports nothing missing", s.missing, []);
}

console.log("\n--- unparseable falls back to fail-safe ---");
{
  const r = checkPrerequisites("Consult the department.", ["BIO 101"], { completed: new Set() });
  check("the flat code list is required", r.missing, ["BIO 101"]);
  check("and it is not silently met", r.met, false);

  // "For CAT majors only" names no course, so there is nothing to check — but
  // it is emphatically not "no prerequisites".
  const s2 = checkPrerequisites("For CAT majors only.", [], { completed: new Set() });
  check("a condition we cannot check is unknown, not met", s2.met, "unknown");
  check("and the condition travels with it", s2.notes, ["For CAT majors only."]);
}

console.log("\n--- lists and concurrency ---");
check("oxford comma keeps the last item", describe("BUS 202, BUS 215, and ECO 212"),
  "(BUS 202 AND BUS 215 AND ECO 212)");
check("leading prose doesn't swallow the sentence",
  describe("All freshman, sophomore, and junior-level nursing courses and NUR 401 or NUR 402 or permission of the instructor."),
  "(NUR 401 OR NUR 402 OR permission)");
// "~" marks a corequisite in the debug shape.
check("concurrent prerequisites are marked, not required",
  describe("CHM 112 (may be taken concurrently), CHM 116"), "(CHM 112~ AND CHM 116)");
check("a concurrent prerequisite does not block",
  met("CHM 112 (may be taken concurrently), CHM 116", ["CHM 116"]), "unknown");
check("but a real one still does",
  met("CHM 112 (may be taken concurrently), CHM 116", ["CHM 112"]), false);

console.log("\n--- course sequences ---");
check("a hyphenated sequence needs both", describe("BIO 133- BIO 134; CHM 114"),
  "(BIO 133 AND BIO 134 AND CHM 114)");
check("tight hyphen too", describe("BIO 142-BIO 143"), "(BIO 142 AND BIO 143)");

console.log("\n--- against every real prerequisite in the catalog ---");
{
  const data = JSON.parse(
    readFileSync(new URL(`../data/catalog/${CATALOG_YEAR}/_courses.json`, import.meta.url), "utf8"));
  const withText = (data.courses as Course[]).filter((c) => c.prerequisiteText);
  let unparsed = 0;
  const lostCodes: string[] = [];
  for (const c of withText) {
    const shape = describe(c.prerequisiteText!);
    if (shape === "-") { unparsed++; continue; }
    // Every code the scraper found should appear in the parse, or we've
    // dropped a requirement while reading the sentence.
    for (const code of c.prerequisites ?? []) {
      if (!shape.includes(code.toUpperCase())) lostCodes.push(`${c.code}: ${code} not in ${shape}`);
    }
  }
  console.log(`      ${withText.length} sentences, ${unparsed} with no parseable structure`);
  check("no prerequisite code is lost while parsing", lostCodes.slice(0, 5), []);
  // The ones that don't parse should be the ones with no course code in them
  // at all ("For CAT majors only") — never a sentence naming a course.
  const unparsedWithCodes = withText.filter(
    (c) => describe(c.prerequisiteText!) === "-" && /[A-Z]{2,4}\s?\d{3}/.test(c.prerequisiteText!)
  );
  check("every sentence naming a course parses", unparsedWithCodes.map((c) => c.code), []);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
