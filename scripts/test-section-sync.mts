// Tests the sync orchestration against a scripted portal: term switching, the
// verify step that keeps a mis-served term from being mislabeled, page-size
// negotiation, and putting the term selector back where it was.
//
// Run: npm run test:section-sync
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { syncSections, offeringsByCode, seasonLabel, type SectionTransport } from "../src/lib/section-sync";

const parseHtml = (html: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
};

const SCREEN = readFileSync(
  new URL("../src/lib/__fixtures__/registration-screen.json", import.meta.url), "utf8");

/** One fake section row, in the shape the portal's JSON actually uses. */
function row(code: string, yearTerm: string, seats = 5) {
  return {
    courseCode:
      `<label class='sr-only'>Course Code</label><a href='javascript:void(0);' ` +
      `data-yearterm='${yearTerm}' data-sectionid='${code}-${yearTerm}' ` +
      `data-advisingrequirementcode='${code.replace(/[- ]/g, "")}'>${code}</a>`,
    title: "A Course",
    faculty: "Doe, Jane",
    seatsOpen: `${seats} / 20`,
    status: seats > 0 ? "Open" : "Full",
    schedule: "<span>Mon</span><br/><span>9:00-9:50 AM</span><br/>8/24/2026 - 12/11/2026",
    credits: "3",
  };
}

interface PortalOptions {
  /** yearTerm -> the section codes it offers */
  catalogByTerm: Record<string, string[]>;
  /** Does switching term actually work, or does the portal ignore it? */
  termSwitch: "works" | "fails" | "ignored";
  /** Does the server honor a requested pageSize larger than 15? */
  honorsPageSize: boolean;
  /** Page sizes above this time out, the way a busy Jenzabar does. */
  timesOutAbove?: number;
  /**
   * Like the real portal: rows only come back when the paging body carries a
   * populated advancedFilters array. Default true, because that IS the real
   * behaviour (HAR: [] -> 0 rows, 19 empty-valued keys -> 1118) and a test
   * portal that skips it hides the bug this cost two rounds to find.
   */
  requiresFilters?: boolean;
}

interface PortalLog {
  termsRequested: string[];
  searchesRun: string[];
  pageSizes: number[];
  requests: number;
}

function portal(opts: PortalOptions): { transport: SectionTransport; log: PortalLog } {
  const log: PortalLog = { termsRequested: [], searchesRun: [], pageSizes: [], requests: 0 };
  const requiresFilters = opts.requiresFilters !== false;
  // The screen the portal is currently showing. Starts on Fall 2026, which is
  // what the fixture has selected.
  let selected = "2026;10";

  const screenFor = (term: string) =>
    SCREEN.replace(/YearCode=2026&TermCode=10/g, `YearCode=${term.split(";")[0]}&TermCode=${term.split(";")[1]}`);

  return {
    log,
    transport: {
      parseHtml,
      async fetchSectionSearchPage() {
        return { ok: true, html: screenFor(selected) };
      },
      // The term-change post. Jenzabar's own JS sends two flags that are not
      // elements on the page, so serializing the form alone isn't enough —
      // this portal refuses the post without them, the way a portal that
      // ignored them would leave us silently on the wrong term.
      async fetchTermPage(_url, fields) {
        log.termsRequested.push(fields.stuRegTermSelect);
        if (fields.AjaxPortletFormSubmitted !== "true" || fields.IsAjaxPortletSource !== "true") {
          return { ok: false, reason: "http", message: "400 missing ajax portlet flags" };
        }
        if (opts.termSwitch === "fails") return { ok: false, reason: "http", message: "500" };
        if (opts.termSwitch === "works") selected = fields.stuRegTermSelect;
        // "ignored": the portal answers 200 but stays on the old term.
        return { ok: true, html: screenFor(selected) };
      },
      async fetchSectionsPage(url, body) {
        log.requests++;
        const asked = JSON.parse(body).pageState;
        log.pageSizes.push(asked.pageSize);
        if (opts.timesOutAbove !== undefined && asked.pageSize > opts.timesOutAbove) {
          return { ok: false, reason: "timeout" };
        }
        const size = opts.honorsPageSize ? asked.pageSize : Math.min(asked.pageSize, 15);

        const m = url.match(/YearCode=(\d+)&TermCode=(\d+)/)!;
        const urlTerm = `${m[1]};${m[2]}`;
        // A portlet id bound to one term is exactly the failure mode we're
        // guarding against: the URL says one term, the rows say another.
        const servedTerm = opts.termSwitch === "ignored" ? selected : urlTerm;

        // [] means "no search has been run" and the endpoint answers with
        // nothing — at 200, with no error.
        const codes =
          requiresFilters && (asked.advancedFilters ?? []).length === 0
            ? []
            : opts.catalogByTerm[servedTerm] ?? [];
        const start = asked.currentPage * size;
        const rows = codes.slice(start, start + size).map((c) => row(c, servedTerm));
        return { ok: true, payload: { totalRows: rows.length, filteredRows: codes.length, rows } };
      },
    },
  };
}

const FALL = ["CSC-265-A", "CSC-310-A", "THE-101-A"];
const SPRING = ["ART-118-GA", "CSC-265-B", "THE-101-B"];

console.log("--- the happy path: two terms, one label each ---");
{
  const { transport, log } = portal({
    catalogByTerm: { "2026;10": FALL, "2025;20": SPRING },
    termSwitch: "works",
    honorsPageSize: true,
  });
  const result = await syncSections(undefined, transport);
  check("ok", result.ok, true);
  check("covered the two most recent terms", result.terms.map((t) => t.label), ["Fall 2026", "Spring 2026"]);
  check("sections from both", result.sections.length, 6);
  // Term already selected -> search only. Other term -> switch, then search.
  // Then one post to put the selector back.
  check("one post to switch term, one to put it back",
    log.termsRequested, ["2025;20", "2026;10"]);
  check("no separate search request exists", log.searchesRun, []);

  const offered = offeringsByCode(result);
  check("Fall-only course", seasonLabel(offered.get("CSC 310") ?? []), "Fall");
  check("Spring-only course", seasonLabel(offered.get("ART 118") ?? []), "Spring");
  check("both terms, newest first", seasonLabel(offered.get("CSC 265") ?? []), "Fall · Spring");
  check("both terms for a course taught every term", seasonLabel(offered.get("THE 101") ?? []), "Fall · Spring");
}

console.log("\n--- a portal that ignores the term switch must not mislabel ---");
{
  // The URL is re-pointed at Spring, the portal serves Fall rows anyway. If we
  // trusted the request rather than the rows, every Fall course would come back
  // labeled "Fall · Spring" — a wrong answer that looks more informative than
  // the right one, which is the worst kind.
  const { transport } = portal({
    catalogByTerm: { "2026;10": FALL, "2025;20": SPRING },
    termSwitch: "ignored",
    honorsPageSize: true,
  });
  const result = await syncSections(undefined, transport);
  const offered = offeringsByCode(result);
  check("only the term actually served is claimed", result.terms.map((t) => t.label), ["Fall 2026"]);
  check("no course is credited with the unserved term",
    [...offered.values()].every((terms) => terms.every((t) => t.value === "2026;10")), true);
  check("and it says so", /Spring 2026/.test(result.error ?? ""), true);
}

console.log("\n--- a term switch that fails falls back to the rewrite ---");
{
  const { transport } = portal({
    catalogByTerm: { "2026;10": FALL, "2025;20": SPRING },
    termSwitch: "fails",
    honorsPageSize: true,
  });
  const result = await syncSections(undefined, transport);
  // Now that the criteria ride in the paging body rather than in session
  // state, re-pointing the URL is a real fallback rather than a formality —
  // and it stays honest because the rows are still checked against their own
  // term before anything is labeled.
  check("both terms still covered", result.terms.map((t) => t.label),
    ["Fall 2026", "Spring 2026"]);
  check("the fallback route is recorded, not hidden",
    result.perTerm.map((t) => t.via), ["current", "rewritten"]);
}

console.log("\n--- page size is negotiated, never assumed ---");
{
  const big = portal({ catalogByTerm: { "2026;10": FALL, "2025;20": SPRING }, termSwitch: "works", honorsPageSize: true });
  await syncSections(undefined, big.transport);
  check("asks for a big page first", big.log.pageSizes[0], 100);
  check("one request per term when honored", big.log.requests, 2);

  // 40 courses at a server-enforced 15 per page: asking for 100 and believing
  // it would skip rows 15-99 entirely. The count is the test.
  const many = Array.from({ length: 40 }, (_, i) => `CSC-${100 + i}-A`);
  const small = portal({ catalogByTerm: { "2026;10": many, "2025;20": [] }, termSwitch: "works", honorsPageSize: false });
  const result = await syncSections(undefined, small.transport);
  check("falls back to what the server actually gave", small.log.pageSizes.slice(0, 2), [100, 15]);
  check("no rows skipped", result.sections.length, 40);
  check("not reported as truncated", result.truncated, false);
}

console.log("\n--- a page size the server is too slow for backs off, not out ---");
{
  // The real failure: 100 rows per page timed out, and the whole term came
  // back as "stopped after 0 sections", which is indistinguishable from a term
  // with nothing in it. Asking for less is the answer; giving up is not.
  const many = Array.from({ length: 60 }, (_, i) => `CSC-${100 + i}-A`);
  const { transport, log } = portal({
    catalogByTerm: { "2026;10": many, "2025;20": [] },
    termSwitch: "works",
    honorsPageSize: true,
    timesOutAbove: 25,
  });
  const result = await syncSections(undefined, transport);
  check("walks the ladder down until the server keeps up",
    [...new Set(log.pageSizes)], [100, 50, 25]);
  check("every row still arrives", result.sections.length, 60);
  check("and it isn't reported as a failure", result.perTerm[0].error, undefined);
}

console.log("\n--- a search that runs and finds nothing says so differently ---");
{
  // Distinguishing "we couldn't ask" from "we asked and there's nothing" is
  // the difference between a bug report and a fact about the term.
  const { transport } = portal({ catalogByTerm: {}, termSwitch: "works", honorsPageSize: true });
  const result = await syncSections(undefined, transport);
  check("not ok", result.ok, false);
  check("no terms claimed", result.terms, []);
  check("and reports what Franciscan actually said",
    /Franciscan reported 0 courses for this term/.test(result.error ?? ""), true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
