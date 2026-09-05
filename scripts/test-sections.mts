// Tests for the live section-search parser. Run: npm run test:sections
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
  advancedFilters,
  parseSectionPage,
  splitSectionCode,
  findSectionSearchUrl,
  findTermFormUrl,
  mostRecentTerms,
  pageStateBody,
  parseTermOptions,
  termFormFields,
  termOfUrl,
  unwrapScreenPayload,
  withTerm,
} from "../src/lib/sections";
import { offeringsByCode, seasonLabel, type SectionSyncResult } from "../src/lib/section-sync";

// linkedom needs a full document wrapper; a browser DOMParser does not.
// The adapter is where that difference belongs.
const parse = (html: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
};

const payload = JSON.parse(
  readFileSync(new URL("../src/lib/__fixtures__/sections.json", import.meta.url), "utf8")
);
const page = parseSectionPage(payload, parse);
const by = (code: string) => page.sections.find((s) => s.code === code)!;

console.log("--- section codes ---");
check("splits code and section", splitSectionCode("CSC-265-A"), { code: "CSC 265", section: "A" });
check("handles a multi-char section", splitSectionCode("ART-118-GA"), { code: "ART 118", section: "GA" });
check("handles a lettered course number", splitSectionCode("BIO-133L-A"), { code: "BIO 133L", section: "A" });
check("rejects junk", splitSectionCode("NOT A SECTION CODE"), null);

console.log("\n--- rows ---");
// A malformed row must be skipped, not crash the whole page of results.
check("malformed row skipped, rest kept", page.sections.length, 4);
check("filteredRows carried through", page.filteredRows, 1046);
check("codes normalized to catalog form", page.sections.map((s) => s.code),
  ["CSC 265", "CSC 310", "SFE 330", "ART 118"]);

console.log("\n--- seats and status ---");
check("open seats parsed", [by("CSC 265").seatsOpen, by("CSC 265").capacity], [7, 25]);
check("full section reads zero, not null", [by("CSC 310").seatsOpen, by("CSC 310").capacity], [0, 20]);
check("status carried", [by("CSC 265").status, by("CSC 310").status], ["Open", "Full"]);
check("credits numeric", by("CSC 265").credits, 3);

console.log("\n--- schedule (shape varies per section) ---");
check("days", by("CSC 265").days, "Tue, Thu");
check("time", by("CSC 265").time, "9:30-10:45 AM");
check("dates", by("CSC 265").dates, "8/24/2026 - 12/11/2026");
check("room when present", by("CSC 265").location, "Christ the Teacher - 140");
check("no room reads null, not empty string", by("CSC 310").location, null);
// An online/arranged section has no meeting pattern at all — dates must still
// come through rather than the whole field failing.
check("no meeting pattern: days null", by("SFE 330").days, null);
check("no meeting pattern: time null", by("SFE 330").time, null);
check("no meeting pattern: dates still parsed", by("SFE 330").dates, "1/12/2026 - 5/6/2026");

console.log("\n--- faculty ---");
check("name only, not the job title", by("CSC 265").faculty, "Rivera, Jordan");
check("single-line faculty", by("SFE 330").faculty, "Vance, Marek");

console.log("\n--- Jenzabar identifiers ---");
check("sectionId", by("CSC 265").sectionId, "77301");
check("yearTerm", by("CSC 265").yearTerm, "2026;10");
check("advising requirement code", by("CSC 265").advisingRequirementCode, "CSC265");
check("a different term is preserved", by("ART 118").yearTerm, "2025;20");

console.log("\n--- endpoint discovery (nothing hardcoded) ---");
{
  const html = readFileSync(
    new URL("../src/lib/__fixtures__/registration-page.html", import.meta.url), "utf8");
  const found = findSectionSearchUrl(parse(html))!;
  check("url found", found.url.includes("pagedsectiondataforsearch"), true);
  check("absolute", found.url.startsWith("https://myfranciscan.franciscan.edu/"), true);
  // The portlet id, student id and term all ride along from the page — the
  // whole point is that none of them is reconstructed by us.
  check("carries portlet id", /[?&]Id=312\b/.test(found.url), true);
  check("carries student id", /[?&]IdNumber=1000001\b/.test(found.url), true);
  check("carries the live term", /YearCode=2026&TermCode=10/.test(found.url), true);
  check("page size read from the page", found.pageSize, 15);
  check("missing table returns null", findSectionSearchUrl(parse("<body><p>no table</p></body>")), null);
}

console.log("\n--- terms (read live off the page, never hardcoded) ---");
{
  const html = readFileSync(
    new URL("../src/lib/__fixtures__/registration-page.html", import.meta.url), "utf8");
  const doc = parse(html);
  const terms = parseTermOptions(doc);
  check("every term in the dropdown is read", terms.map((t) => t.value),
    ["2026;10", "2025;10", "2025;20"]);
  check("labels come through without the leading nbsp", terms.map((t) => t.label),
    ["Fall 2026", "Fall 2025", "Spring 2026"]);
  // The season word is the portal's, not a mapping we invented from the code.
  check("season taken from the label", terms.map((t) => t.season), ["Fall", "Fall", "Spring"]);
  check("selected term identified", terms.filter((t) => t.selected).map((t) => t.value), ["2026;10"]);

  // The whole point of the feature: the two most recent terms, which here are
  // one Fall and one Spring, so a course can be labeled with the term it runs in.
  check("two most recent, newest first", mostRecentTerms(terms, 2).map((t) => t.label),
    ["Fall 2026", "Spring 2026"]);
  check("three most recent stays chronological", mostRecentTerms(terms, 3).map((t) => t.label),
    ["Fall 2026", "Spring 2026", "Fall 2025"]);
  check("no dropdown yields no terms, not a crash", parseTermOptions(parse("<p>nothing</p>")), []);

  check("term form url found and absolutized",
    findTermFormUrl(doc),
    "https://myfranciscan.franciscan.edu/ICS/Academics/Academics_Homepage.jnz?portlet=Student_Registration");
  // Byte-for-byte the field set Jenzabar's own JS posts, from the HAR:
  //   CurrentPortletState=Default&ScreenToProcessForm=…&NextScreenToLoad=…
  //   &PostUrl=…&stuRegTermSelect=2025;20&ddCodeSearchType=0&txtCourse=
  //   &ddTitleSearchType=0&txtCourseTitle=&ddDivision=&txtInstructor=
  //   &txtDepartment=&txtLocation=&AjaxPortletFormSubmitted=true
  //   &IsAjaxPortletSource=true
  // The last two are not elements on the page, which is why serializing the
  // form on its own wasn't enough.
  const sortedFields = Object.fromEntries(
    Object.entries(termFormFields(doc, "2025;20")).sort(([a], [b]) => (a < b ? -1 : 1))
  );
  check("term switch posts exactly what Jenzabar posts", sortedFields, {
    AjaxPortletFormSubmitted: "true",
    CurrentPortletState: "Default",
    IsAjaxPortletSource: "true",
    NextScreenToLoad: "StudentRegistrationPortlet_CourseSearchView",
    PostUrl: "/ICS/Academics/Academics_Homepage.jnz?portlet=Student_Registration&screen=StudentRegistrationPortlet_CourseSearchView&screenType=next",
    ScreenToProcessForm: "StudentRegistrationPortlet_CourseSearchView",
    ddCodeSearchType: "0",
    ddDivision: "",
    ddTitleSearchType: "0",
    stuRegTermSelect: "2025;20",
    txtCourse: "",
    txtCourseTitle: "",
    txtDepartment: "",
    txtInstructor: "",
    txtLocation: "",
  });

  const url = findSectionSearchUrl(doc)!.url;
  check("term read back off a built url", termOfUrl(url), "2026;10");
  const rewritten = withTerm(url, terms.find((t) => t.value === "2025;20")!);
  check("rewrite fallback changes only the term", termOfUrl(rewritten), "2025;20");
  check("rewrite keeps the portlet and student ids", /Id=312&IdNumber=1000001/.test(rewritten), true);
}

console.log("\n--- the screen arrives as a JSON envelope ---");
{
  // Parsing the envelope as HTML half-works: single-quoted attributes survive
  // and \"-escaped ones don't, so the results table is found while the term
  // dropdown silently isn't. That silent half-success is the bug worth a test.
  const raw = readFileSync(
    new URL("../src/lib/__fixtures__/registration-screen.json", import.meta.url), "utf8");
  check("envelope, parsed raw, loses the dropdown", parseTermOptions(parse(raw)).length, 0);

  const doc = parse(unwrapScreenPayload(raw));
  check("unwrapped, the dropdown is there", parseTermOptions(doc).map((t) => t.label),
    ["Fall 2026", "Fall 2025", "Spring 2026"]);
  check("unwrapped, the endpoint is there",
    termOfUrl(findSectionSearchUrl(doc)!.url), "2026;10");
  check("plain html passes through untouched",
    unwrapScreenPayload("<p>hi</p>"), "<p>hi</p>");
  check("json without an Html field passes through", unwrapScreenPayload('{"a":1}'), '{"a":1}');
}

console.log("\n--- request body ---");
{
  const body = JSON.parse(pageStateBody(2, 15));
  check("currentPage is 0-indexed and passed through", body.pageState.currentPage, 2);
  check("pageSize passed through", body.pageState.pageSize, 15);
  check("enabled flag present", body.pageState.enabled, true);

  // The single thing that decides whether ANY rows come back. From the HAR,
  // same endpoint and session: advancedFilters [] -> filteredRows 0;
  // the 19 keys below, every value empty -> filteredRows 1118.
  check("advancedFilters is populated, never empty", body.pageState.advancedFilters.length, 19);
  check("filter names match the endpoint's vocabulary",
    body.pageState.advancedFilters.map((f: { name: string }) => f.name),
    ["courseCode", "courseCodeType", "courseTitle", "courseTitleType", "requestNumber",
     "instructorIds", "departmentIds", "locationIds", "competencyIds", "beginsAfter",
     "beginsBefore", "instructionalMethods", "sectionStatus", "startCourseNumRange",
     "endCourseNumRange", "division", "place", "subterm", "meetsOnDays"]);
  const value = (n: string) =>
    body.pageState.advancedFilters.find((f: { name: string }) => f.name === n)?.value;
  check("search-type defaults", [value("courseCodeType"), value("courseTitleType")], ["0", "0"]);
  check("no weekday filter is all zeroes", value("meetsOnDays"), "0,0,0,0,0,0,0");

  // A student's own criteria, if the page carried any, flow through.
  const html = readFileSync(
    new URL("../src/lib/__fixtures__/registration-page.html", import.meta.url), "utf8");
  const fromPage = advancedFilters(parse(html));
  check("values read off the page's search inputs",
    fromPage.find((f) => f.name === "courseCode")?.value, "");
  check("blank page yields blank criteria, which is what returns everything",
    fromPage.every((f) => f.value === "" || f.value === "0" || f.value === "0,0,0,0,0,0,0"), true);
}

console.log("\n--- which terms a course is offered in ---");
{
  const html = readFileSync(
    new URL("../src/lib/__fixtures__/registration-page.html", import.meta.url), "utf8");
  const allTerms = parseTermOptions(parse(html));
  const covered = mostRecentTerms(allTerms, 2); // Fall 2026, Spring 2026

  // The fixture's rows are tagged 2026;10 except ART 118, which is 2025;20.
  const result = {
    ok: true, sections: page.sections, terms: covered, allTerms, perTerm: [], truncated: false,
  } as unknown as SectionSyncResult;
  const offered = offeringsByCode(result);

  check("a Fall-only course says Fall", seasonLabel(offered.get("CSC 265") ?? []), "Fall");
  check("a Spring-only course says Spring", seasonLabel(offered.get("ART 118") ?? []), "Spring");
  check("a course with no sections is absent, not empty", offered.has("THE 101"), false);
  // Labels are built from each row's own yearTerm, so a course can only ever
  // be labeled with a term the portal itself put it in.
  check("both terms reads newest first", seasonLabel(covered), "Fall · Spring");

  // A row tagged with a term we didn't cover must not invent a label.
  const stray = {
    ...result,
    sections: [{ ...page.sections[0], code: "XXX 100", yearTerm: "1999;10" }],
  } as unknown as SectionSyncResult;
  check("a row from an unlisted term is ignored", offeringsByCode(stray).has("XXX 100"), false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
