// Parses Franciscan's live course-section search — what's actually offered
// this term, with meeting times and seat counts.
//
// Source (requires the student's own logged-in Jenzabar session):
//
//   POST /ICS/webserviceproxy/exi/rest/studentregistration/pagedsectiondataforsearch
//        ?Id=<portlet>&IdNumber=<student>&YearCode=<year>&TermCode=<term>
//   body: {"pageState":{...,"currentPage":N,"pageSize":15,...}}
//
// NONE of those four query parameters may be hardcoded. The registration
// page hands over the whole URL pre-filled — see SECTION_SEARCH_PAGE and
// findSectionSearchUrl below — so the portlet id, the student id and the
// current term are all read live, every time, from the page the student is
// actually looking at.
//
// Like the transcript, this takes a Document factory rather than doing its
// own DOM work, so the same code runs in the extension, in the page, and in
// tests.

/** The page that carries the search endpoint, pre-filled, in an attribute. */
export const SECTION_SEARCH_PAGE =
  "https://myfranciscan.franciscan.edu/ICS/Academics/Academics_Homepage.jnz" +
  "?portlet=Student_Registration&screen=StudentRegistrationPortlet_CourseSearchView&screenType=next";

export interface Section {
  /** Section identifier as shown, e.g. "ART-118-GA" */
  sectionCode: string;
  /** Normalized to catalog form, e.g. "ART 118" */
  code: string;
  /** The trailing section/campus part, e.g. "GA" */
  section: string | null;
  title: string;
  faculty: string | null;
  credits: number | null;
  /** Seats currently open */
  seatsOpen: number | null;
  /** Total capacity */
  capacity: number | null;
  /** "Open" / "Full" as the portal reports it */
  status: string | null;
  /** e.g. "Tue, Thu" — null for sections with no meeting pattern */
  days: string | null;
  /** e.g. "9:30-10:45 AM" */
  time: string | null;
  /** e.g. "8/24/2026 - 12/11/2026" */
  dates: string | null;
  location: string | null;
  /** Jenzabar's own identifiers, useful for deep links and future work */
  sectionId: string | null;
  yearTerm: string | null;
  /** Jenzabar's internal mapping of this section to a degree requirement */
  advisingRequirementCode: string | null;
}

export interface SectionPage {
  totalRows: number;
  filteredRows: number;
  sections: Section[];
}

interface RawRow {
  courseCode?: string;
  title?: string;
  faculty?: string;
  seatsOpen?: string;
  status?: string;
  schedule?: string;
  credits?: string;
}

/**
 * Turns an HTML fragment into a Document.
 *
 * In a browser or the extension that is
 * `(h) => new DOMParser().parseFromString(h, "text/html")`, which wraps a
 * bare fragment into a full document by itself. A server-side DOM shim may
 * need to add `<html><body>` — that belongs in the adapter, not here.
 */
export type ParseHtml = (html: string) => Document;

/** Every field arrives wrapped in a screen-reader label that isn't data. */
function textOf(doc: Document): string {
  doc.querySelectorAll("label.sr-only").forEach((el) => el.remove());
  return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** "ART-118-GA" -> { code: "ART 118", section: "GA" } */
export function splitSectionCode(raw: string): { code: string; section: string | null } | null {
  const m = raw.trim().match(/^([A-Z]{2,4})-(\d{3}[A-Z]?)(?:-(.+))?$/);
  if (!m) return null;
  return { code: `${m[1]} ${m[2]}`, section: m[3] ?? null };
}

/**
 * The schedule cell is markup, and its shape varies:
 *   <span>Thu</span><br/><span>8:40-11:50 AM</span><br/>1/15/2026 - 5/4/2026
 *   <span></span><br/>1/12/2026 - 5/6/2026            (no meeting pattern)
 *   ...<br/>8/24/2026 - 12/11/2026 <span>Christ the Teacher - 140</span>
 * so each part is identified by what it looks like rather than by position.
 */
function parseSchedule(html: string, parseHtml: ParseHtml) {
  const doc = parseHtml(html);
  doc.querySelectorAll("label.sr-only").forEach((el) => el.remove());

  const parts = (doc.body?.innerHTML ?? "")
    .split(/<br\s*\/?>/i)
    .map((chunk) => textOf(parseHtml(chunk)))
    .filter(Boolean);

  let days: string | null = null;
  let time: string | null = null;
  let dates: string | null = null;
  let location: string | null = null;

  for (const part of parts) {
    if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(part)) {
      const m = part.match(/^(\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)$/);
      dates = m ? m[1].trim() : part;
      if (m && m[2].trim()) location = m[2].trim();
    } else if (/\d{1,2}:\d{2}/.test(part)) {
      time = part;
    } else if (/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(part)) {
      days = part;
    } else if (!location) {
      location = part;
    }
  }
  return { days, time, dates, location };
}

function num(text: string | undefined): number | null {
  if (!text) return null;
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

export function parseSectionRow(row: RawRow, parseHtml: ParseHtml): Section | null {
  const codeDoc = parseHtml(row.courseCode ?? "");
  const link = codeDoc.querySelector("a");
  const rawCode = textOf(codeDoc);
  const split = splitSectionCode(rawCode);
  if (!split) return null;

  const seats = textOf(parseHtml(row.seatsOpen ?? ""));
  const seatMatch = seats.match(/(\d+)\s*\/\s*(\d+)/);

  // Faculty is "Name<br/>Title, Department" — only the name is wanted.
  const facultyDoc = parseHtml(row.faculty ?? "");
  facultyDoc.querySelectorAll("label.sr-only").forEach((el) => el.remove());
  const facultyFirstLine = (facultyDoc.body?.innerHTML ?? "").split(/<br\s*\/?>/i)[0] ?? "";
  const faculty = textOf(parseHtml(facultyFirstLine));

  const schedule = parseSchedule(row.schedule ?? "", parseHtml);

  return {
    sectionCode: rawCode,
    code: split.code,
    section: split.section,
    title: textOf(parseHtml(row.title ?? "")),
    faculty: faculty || null,
    credits: num(textOf(parseHtml(row.credits ?? ""))),
    seatsOpen: seatMatch ? parseInt(seatMatch[1], 10) : null,
    capacity: seatMatch ? parseInt(seatMatch[2], 10) : null,
    status: textOf(parseHtml(row.status ?? "")) || null,
    ...schedule,
    sectionId: link?.getAttribute("data-sectionid") ?? null,
    yearTerm: link?.getAttribute("data-yearterm") ?? null,
    advisingRequirementCode: link?.getAttribute("data-advisingrequirementcode") ?? null,
  };
}

export function parseSectionPage(payload: unknown, parseHtml: ParseHtml): SectionPage {
  const p = (payload ?? {}) as { totalRows?: number; filteredRows?: number; rows?: RawRow[] };
  const sections: Section[] = [];
  for (const row of p.rows ?? []) {
    const parsed = parseSectionRow(row, parseHtml);
    if (parsed) sections.push(parsed);
  }
  return {
    totalRows: p.totalRows ?? sections.length,
    filteredRows: p.filteredRows ?? sections.length,
    sections,
  };
}

/**
 * Pulls the search endpoint out of the registration page.
 *
 * The page renders the results table with the whole URL already built:
 *
 *   <table id='CourseSearchResultsTable'
 *          data-url='/ICS/.../pagedsectiondataforsearch?Id=312&IdNumber=…&YearCode=2026&TermCode=10'
 *          data-paging-size='15'>
 *
 * Reading it means the portlet id, the student id and the current term are
 * never hardcoded or guessed — they come from the page the student is looking
 * at, which is the only thing that can be right about all three at once. The
 * portlet id isn't even stable: the same session uses 312 on one screen and
 * 308 on another.
 */
export function findSectionSearchUrl(
  doc: Document
): { url: string; pageSize: number } | null {
  const table =
    doc.querySelector("#CourseSearchResultsTable[data-url]") ??
    doc.querySelector("table[data-url*='pagedsectiondataforsearch']");
  const url = table?.getAttribute("data-url");
  if (!url) return null;
  const size = parseInt(table?.getAttribute("data-paging-size") ?? "", 10);
  return {
    url: url.startsWith("http") ? url : `https://myfranciscan.franciscan.edu${url}`,
    pageSize: Number.isFinite(size) && size > 0 ? size : 15,
  };
}

/**
 * The search criteria, as the endpoint wants them.
 *
 * This is the thing that decides whether anything comes back at all. From the
 * HAR, same endpoint, same session, same page:
 *
 *   advancedFilters: []          -> filteredRows 0
 *   advancedFilters: [19 keys]   -> filteredRows 1118
 *
 * and every one of those 19 values is EMPTY. So it isn't the criteria that
 * matter — it's whether the array is populated at all. An empty array reads as
 * "no search has been run" and the endpoint answers with nothing, at 200, with
 * no error. That is not a distinguishable failure; it looks exactly like a
 * term in which no courses are offered.
 *
 * The names below are the endpoint's own parameter vocabulary, the same kind
 * of thing as the pageState keys around them — not data scraped from a page.
 * Where a filter corresponds to one of the page's search inputs, its value is
 * read from that input, so a student's own criteria would flow through
 * untouched.
 */
export function advancedFilters(doc?: Document): { name: string; value: string }[] {
  const field = (selector: string, fallback = "") => {
    const el = doc?.querySelector(selector);
    if (!el) return fallback;
    if (el.tagName.toLowerCase() === "select") {
      const options = [...el.querySelectorAll("option")];
      const chosen = options.find((o) => o.hasAttribute("selected")) ?? options[0];
      return chosen?.getAttribute("value") ?? fallback;
    }
    return el.getAttribute("value") ?? fallback;
  };

  return [
    { name: "courseCode", value: field("[name='txtCourse']") },
    { name: "courseCodeType", value: field("[name='ddCodeSearchType']", "0") },
    { name: "courseTitle", value: field("[name='txtCourseTitle']") },
    { name: "courseTitleType", value: field("[name='ddTitleSearchType']", "0") },
    { name: "requestNumber", value: "" },
    { name: "instructorIds", value: field("[name='txtInstructor']") },
    { name: "departmentIds", value: field("[name='txtDepartment']") },
    { name: "locationIds", value: field("[name='txtLocation']") },
    { name: "competencyIds", value: "" },
    { name: "beginsAfter", value: "" },
    { name: "beginsBefore", value: "" },
    { name: "instructionalMethods", value: "" },
    { name: "sectionStatus", value: "" },
    { name: "startCourseNumRange", value: "" },
    { name: "endCourseNumRange", value: "" },
    { name: "division", value: field("[name='ddDivision']") },
    { name: "place", value: "" },
    { name: "subterm", value: "" },
    // One flag per weekday, "no day filter" being all zeroes.
    { name: "meetsOnDays", value: "0,0,0,0,0,0,0" },
  ];
}

/** The POST body the endpoint expects. `currentPage` is 0-indexed. */
export function pageStateBody(
  currentPage: number,
  pageSize: number,
  filters: { name: string; value: string }[] = advancedFilters()
): string {
  return JSON.stringify({
    pageState: {
      enabled: true,
      keywordFilter: "",
      quickFilters: [],
      sortColumn: "",
      sortAscending: true,
      currentPage,
      pageSize,
      showingAll: false,
      selectedAll: false,
      excludedFromSelection: [],
      includedInSelection: [],
      advancedFilters: filters,
      totalRows: 0,
      filteredRows: 0,
      quickFilterCounts: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Terms
//
// Course offerings rotate — a course taught this Fall may not run again until
// next Fall — so "is it offered?" is only a useful answer if it names WHICH
// term. The portal states the terms it knows about in a <select> on the
// registration page. That list is read live, every time: no term code, season
// name or academic year is hardcoded anywhere below. Even the season word
// ("Fall", "Spring") is taken from the option's own label rather than mapped
// from the term code, because the mapping is the catalog's to define, not
// ours.
// ---------------------------------------------------------------------------

export interface TermOption {
  /** The portal's own value, e.g. "2026;10" — also what section rows carry */
  value: string;
  yearCode: string;
  termCode: string;
  /** As shown to the student, e.g. "Fall 2026" */
  label: string;
  /** First word of the label, e.g. "Fall" — the portal's word, not ours */
  season: string | null;
  selected: boolean;
}

/**
 * The registration screen is served two ways.
 *
 * `...&screenType=next` returns a JSON envelope — `{ NextScreen, Html, … }` —
 * whose `Html` is the real markup. Feeding that envelope straight to an HTML
 * parser half-works (single-quoted attributes survive, `\"`-escaped ones do
 * not), which is worse than failing: the results table is found but the term
 * dropdown silently isn't. Unwrap first, and both come through clean.
 */
export function unwrapScreenPayload(body: string): string {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("{")) return body;
  try {
    const parsed = JSON.parse(trimmed) as { Html?: unknown };
    return typeof parsed.Html === "string" ? parsed.Html : body;
  } catch {
    return body;
  }
}

/** Reads the term dropdown. Returns [] if the page doesn't have one. */
export function parseTermOptions(doc: Document): TermOption[] {
  const select =
    doc.querySelector("select[name='stuRegTermSelect']") ??
    doc.querySelector("#stuRegTermSelect") ??
    doc.querySelector("select#termSelect");
  if (!select) return [];

  const terms: TermOption[] = [];
  select.querySelectorAll("option").forEach((opt) => {
    const value = (opt.getAttribute("value") ?? "").trim();
    const m = value.match(/^(\d{4});(\d+)$/);
    if (!m) return;
    // &nbsp; survives parsing as U+00A0 and would otherwise lead every label.
    const label = (opt.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const seasonMatch = label.match(/^([A-Za-z]+)/);
    terms.push({
      value,
      yearCode: m[1],
      termCode: m[2],
      label,
      season: seasonMatch ? seasonMatch[1] : null,
      selected: opt.hasAttribute("selected"),
    });
  });
  return terms;
}

/**
 * Chronological rank. Within one YearCode the term codes ascend in the order
 * the terms actually happen (Fall 10, then Spring 20), which is also the order
 * the portal lists them in — see mostRecentTerms, which checks that agreement
 * rather than assuming it.
 */
export function termSortKey(t: TermOption): number {
  return parseInt(t.yearCode, 10) * 1000 + parseInt(t.termCode, 10);
}

/**
 * The n most recent terms the portal offers, newest first.
 *
 * The dropdown's own document order is the authority; the numeric key is only
 * used to confirm it. If the two ever disagree — the portal reorders, or adds
 * a term code that doesn't sort the way it runs — the numeric key is dropped
 * and document order wins, because it's the portal's statement rather than
 * our inference.
 */
export function mostRecentTerms(terms: TermOption[], n = 2): TermOption[] {
  if (terms.length === 0) return [];

  // Document order runs oldest-first inside "Past Registration Periods", with
  // the currently-selected term rendered ahead of the group. Undo that to get
  // newest-first.
  const selectedFirst = terms[0]?.selected === true;
  const past = selectedFirst ? terms.slice(1) : terms;
  const docOrder = [...(selectedFirst ? [terms[0]] : []), ...past.slice().reverse()];

  const byKey = [...terms].sort((a, b) => termSortKey(b) - termSortKey(a));
  const agree = byKey.every((t, i) => t.value === docOrder[i]?.value);
  return (agree ? byKey : docOrder).slice(0, n);
}

/** "2026;10" -> the matching TermOption, if the portal listed it. */
export function findTerm(terms: TermOption[], value: string | null): TermOption | null {
  if (!value) return null;
  return terms.find((t) => t.value === value) ?? null;
}

/** The YearCode/TermCode a built search URL is pointing at, as "2026;10". */
export function termOfUrl(url: string): string | null {
  const m = url.match(/[?&]YearCode=(\d+)&TermCode=(\d+)/);
  return m ? `${m[1]};${m[2]}` : null;
}

/**
 * Re-point a search URL at another term. Fallback only.
 *
 * Each portlet `Id` observed so far has been bound to exactly one term, so
 * rewriting the term while keeping the id is NOT known to be safe — it may
 * quietly return the other term's rows. Asking the page for a fresh URL is the
 * primary path (see termFormFields); this exists for when that request fails,
 * and callers must still verify what came back, which they can: every section
 * row carries its own `data-yearterm`.
 */
export function withTerm(url: string, term: TermOption): string {
  return url.replace(/([?&]YearCode=)\d+(&TermCode=)\d+/, `$1${term.yearCode}$2${term.termCode}`);
}

/** The form the term dropdown posts to when a student changes it. */
export function findTermFormUrl(doc: Document): string | null {
  const select =
    doc.querySelector("select[name='stuRegTermSelect'][data-ajaxformsubmit]") ??
    doc.querySelector("[data-ajaxformsubmit]");
  const url = select?.getAttribute("data-ajaxformsubmit");
  if (!url) return null;
  return url.startsWith("http") ? url : `https://myfranciscan.franciscan.edu${url}`;
}

/** The hidden fields the portlet's forms carry. */
export const TERM_FORM_FIELDS = [
  "CurrentPortletState",
  "ScreenToProcessForm",
  "NextScreenToLoad",
  "PostUrl",
] as const;

/**
 * The fields to POST to switch the registration portlet to another term.
 *
 * All of them are copied off the page's own hidden inputs; the only value this
 * code supplies is which term to select, and that came from the page's own
 * dropdown too.
 */
export function termFormFields(doc: Document, termValue: string): Record<string, string> {
  const fields: Record<string, string> = {
    ...serializePortletForm(doc),
    stuRegTermSelect: termValue,
    // Both are in the request Jenzabar's own JS sends, and neither is an
    // element on the page — which is why serializing the form alone wasn't
    // enough. Straight from the HAR.
    AjaxPortletFormSubmitted: "true",
    IsAjaxPortletSource: "true",
  };
  return fields;
}

// ---------------------------------------------------------------------------
// The portlet's form
//
// Used only to change term. The search criteria do NOT live here — see
// advancedFilters, further down, for where they actually go and why that
// distinction cost two wrong fixes.
// ---------------------------------------------------------------------------

/**
 * Serializes the portlet's form the way the browser would.
 *
 * Field NAMES are read off the page rather than listed here on purpose: the
 * search form has eight inputs today and Jenzabar may well have a different
 * eight next year. Copying whatever is actually there keeps this from
 * silently dropping a field the server now requires.
 */
export function serializePortletForm(doc: Document): Record<string, string> {
  const scope = doc.querySelector(".AjaxPortletForm") ?? doc;
  const fields: Record<string, string> = {};

  scope.querySelectorAll("input[name], textarea[name]").forEach((el) => {
    const name = el.getAttribute("name");
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (!name || type === "button" || type === "submit" || type === "reset") return;
    if ((type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) return;
    fields[name] = el.getAttribute("value") ?? "";
  });

  scope.querySelectorAll("select[name]").forEach((el) => {
    const name = el.getAttribute("name");
    if (!name) return;
    const options = [...el.querySelectorAll("option")];
    const chosen = options.find((o) => o.hasAttribute("selected")) ?? options[0];
    fields[name] = chosen?.getAttribute("value") ?? "";
  });

  return fields;
}

