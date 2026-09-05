"use client";

// Drives the live section fetch: read the endpoint off the registration page,
// then page through the results — once for each of the two most recent terms.
//
// Why two terms: offerings rotate. A course that runs every Fall and never in
// Spring looks "not offered" to anyone who only checks Spring, and a student
// who plans around that answer waits a year for a course that was always going
// to be there. Reading the most recent Fall and the most recent Spring turns
// "not this term" into "Fall", which is the answer worth having.
//
// Every request goes through the extension, because the endpoint needs the
// student's Jenzabar session and a website at another origin can't have it.

import { fetchSectionSearchPage, fetchSectionsPage, fetchTermPage } from "./extension-bridge";
import {
  advancedFilters,
  findSectionSearchUrl,
  findTermFormUrl,
  mostRecentTerms,
  pageStateBody,
  parseSectionPage,
  parseTermOptions,
  termFormFields,
  termOfUrl,
  unwrapScreenPayload,
  withTerm,
  type Section,
  type TermOption,
} from "./sections";

export interface TermSyncResult {
  term: TermOption;
  sections: number;
  filteredRows: number;
  truncated: boolean;
  /** Set when this term's own fetch failed; the other term may still be fine */
  error?: string;
  /**
   * How the endpoint for this term was obtained. "page" means the portal
   * handed it over after we asked it to switch term; "rewritten" means we
   * re-pointed the current term's URL, which is a fallback and is only trusted
   * because every row states its own term (see `sections` tagging below).
   */
  via: "current" | "page" | "rewritten";
}

export interface SectionSyncResult {
  ok: boolean;
  /** Every section found, across every term covered. Each carries `yearTerm`. */
  sections: Section[];
  /** The terms we actually covered, newest first */
  terms: TermOption[];
  /** Every term the portal listed — more than we fetch, kept for display */
  allTerms: TermOption[];
  perTerm: TermSyncResult[];
  /** True when any term stopped early — the UI must say so rather than imply completeness */
  truncated: boolean;
  error?: string;
  needsLogin?: boolean;
}

/**
 * ~75 requests at the portal's own page size of 15 covers a full term, and we
 * do that per term. The cap exists so a change on their end can't turn this
 * into thousands of requests against their server — and when it bites,
 * `truncated` says so. A silent cap would read as "these are all the
 * sections", which is worse than showing fewer.
 */
const MAX_PAGES = 90;
const DELAY_MS = 120;

/**
 * Asking for a bigger page is worth ~5x fewer requests against their server,
 * but only if they honor it. The first response says whether they did — see
 * effectivePageSize — and nothing is assumed either way.
 */
const PREFERRED_PAGE_SIZE = 100;

/** How many terms back to look. Two = the most recent Fall and Spring. */
const TERMS_TO_FETCH = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything that touches the outside world, in one bag.
 *
 * The default is the real extension bridge and the browser's own parser. It's
 * injectable so the orchestration below — term switching, the verify step, the
 * page-size negotiation — can be exercised against a scripted portal instead of
 * a live Jenzabar session, which is the only way any of it gets tested before a
 * student runs it.
 */
export interface SectionTransport {
  fetchSectionSearchPage: typeof fetchSectionSearchPage;
  fetchSectionsPage: typeof fetchSectionsPage;
  fetchTermPage: typeof fetchTermPage;
  parseHtml: (html: string) => Document;
}

const browserTransport = (): SectionTransport => ({
  fetchSectionSearchPage,
  fetchSectionsPage,
  fetchTermPage,
  parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
});

/** Reads a registration screen — envelope or raw — into a Document. */
function screenDoc(t: SectionTransport, html: string): Document {
  return t.parseHtml(unwrapScreenPayload(html));
}

interface TermFetch {
  sections: Section[];
  filteredRows: number;
  truncated: boolean;
  error?: string;
}

/**
 * Page through one term's worth of sections.
 *
 * The page size is negotiated rather than assumed: we ask for a big page, and
 * the number of rows that actually come back tells us what the server decided
 * to give. Guessing wrong in the optimistic direction would skip rows silently
 * — pages are addressed by index, so a page size we believe but the server
 * doesn't means every page after the first lands in the wrong place.
 */
async function fetchTermSections(
  t: SectionTransport,
  url: string,
  pagePageSize: number,
  filters: { name: string; value: string }[],
  onPage: (sections: Section[], filteredRows: number) => void
): Promise<TermFetch> {
  // Biggest first. A timeout means the server couldn't build a page that
  // large in time, so the answer is to ask for less — not to give up, and not
  // to report an empty term. The page's own size is the floor: if Jenzabar
  // can't serve what its own table asks for, that's a real failure.
  const ladder = [...new Set([PREFERRED_PAGE_SIZE, 50, 25, pagePageSize])]
    .filter((n) => n > 0)
    .sort((a, b) => b - a);

  let attempt = 0;
  let lastError: string | undefined;

  while (attempt < ladder.length) {
    const pageSize = ladder[attempt];
    // Changing page size mid-run would misaddress every later page, since
    // pages are addressed by index. Restarting the term is a few wasted
    // requests and no arithmetic to get wrong.
    const seen = new Set<string>();
    const sections: Section[] = [];
    let filteredRows = 0;
    let truncated = false;
    let restart: "smaller" | "capped" | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await sleep(DELAY_MS);
      const res = await t.fetchSectionsPage(url, pageStateBody(page, pageSize, filters));

      if (!res.ok) {
        const smallerLeft = attempt < ladder.length - 1;
        if (res.reason === "timeout" && smallerLeft) {
          restart = "smaller";
          break;
        }
        // Partial results are still useful — return what we have and say so.
        return {
          sections,
          filteredRows,
          truncated: true,
          error: `stopped after ${sections.length} sections at ${pageSize} per page (${
            res.message ?? res.reason
          })`,
        };
      }

      const parsed = parseSectionPage(res.payload, t.parseHtml);
      filteredRows = parsed.filteredRows || filteredRows;

      // The server may quietly cap the page size. Pages are addressed by
      // index, so believing a size it didn't honor would skip everything
      // between. Restart at what it actually gave.
      const returned = parsed.sections.length;
      if (page === 0 && returned > 0 && returned < pageSize && filteredRows > returned) {
        ladder[attempt] = returned;
        restart = "capped";
        break;
      }

      for (const s of parsed.sections) {
        // Cross-listed sections repeat across pages under different codes.
        const key = s.sectionId ?? `${s.sectionCode}|${s.dates}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sections.push(s);
      }
      onPage(sections, filteredRows);

      if (parsed.sections.length === 0) break;
      if (filteredRows && sections.length >= filteredRows) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (restart === "capped") {
      // The server told us its real page size; retry this term at that size
      // rather than moving down the ladder.
      continue;
    }
    if (restart === "smaller") {
      lastError = `${pageSize} rows per page was too slow`;
      attempt++;
      continue;
    }
    return { sections, filteredRows, truncated };
  }

  return { sections: [], filteredRows: 0, truncated: true, error: lastError };
}

export async function syncSections(
  onProgress?: (loaded: number, total: number, termLabel?: string) => void,
  transport: SectionTransport = browserTransport()
): Promise<SectionSyncResult> {
  const t = transport;
  const empty = {
    sections: [] as Section[],
    terms: [] as TermOption[],
    allTerms: [] as TermOption[],
    perTerm: [] as TermSyncResult[],
    truncated: false,
  };

  const pageResult = await t.fetchSectionSearchPage();
  if (!pageResult.ok) {
    const message =
      pageResult.reason === "auth"
        ? "You're not logged in to Franciscan."
        : pageResult.reason === "unsupported"
          ? "Your Class Royale Sync extension is out of date. Reload it at opera://extensions (the ↻ on its card), then reload this page."
          : pageResult.reason === "timeout"
            ? "The extension didn't respond. If you just updated it, reload it at opera://extensions and reload this page."
            : `Couldn't open the registration page (${pageResult.message ?? pageResult.reason}).`;
    return { ok: false, ...empty, needsLogin: pageResult.reason === "auth", error: message };
  }

  const doc = screenDoc(t, pageResult.html);
  const endpoint = findSectionSearchUrl(doc);
  if (!endpoint) {
    return {
      ok: false,
      ...empty,
      error:
        "Found the registration page but not its search endpoint — Franciscan may have changed that page's markup.",
    };
  }

  // Everything about terms comes off the page: which ones exist, what they're
  // called, and which one is currently selected. Nothing is computed from
  // today's date and nothing is hardcoded.
  const allTerms = parseTermOptions(doc);
  const currentValue = termOfUrl(endpoint.url);
  const wanted = mostRecentTerms(allTerms, TERMS_TO_FETCH);
  const termFormUrl = findTermFormUrl(doc);

  // No dropdown on the page (or an unreadable one) is not a failure — it just
  // means we can only speak for the term the portal already had selected.
  const targets: TermOption[] =
    wanted.length > 0
      ? wanted
      : currentValue
        ? [
            {
              value: currentValue,
              yearCode: currentValue.split(";")[0],
              termCode: currentValue.split(";")[1],
              label: currentValue,
              season: null,
              selected: true,
            },
          ]
        : [];

  if (targets.length === 0) {
    return {
      ok: false,
      ...empty,
      allTerms,
      error:
        "Couldn't tell which term the registration page is showing — Franciscan may have changed that page's markup.",
    };
  }

  const sections: Section[] = [];
  const perTerm: TermSyncResult[] = [];
  let truncated = false;
  let loaded = 0;

  // One post per term, and only to change term. There is no "run the search"
  // request: the criteria travel in the paging body's advancedFilters — see
  // sections.ts — which is what two earlier versions of this got wrong.
  const filters = advancedFilters(doc);
  let selectedNow = currentValue;

  for (const term of targets) {
    let url: string | null = null;
    let via: TermSyncResult["via"] = term.value === currentValue ? "current" : "rewritten";

    if (termFormUrl && term.value !== selectedNow) {
      const switched = await t.fetchTermPage(termFormUrl, termFormFields(doc, term.value));
      if (switched.ok) {
        selectedNow = term.value;
        const switchedEndpoint = findSectionSearchUrl(screenDoc(t, switched.html));
        // Only take it if the portal actually moved to the term we asked for.
        // A URL still pointing at the old term would quietly hand back that
        // term's rows under this term's name. The HAR confirms it does move:
        // the switch returns a different portlet Id (312 -> 308) alongside the
        // new YearCode/TermCode.
        if (switchedEndpoint && termOfUrl(switchedEndpoint.url) === term.value) {
          url = switchedEndpoint.url;
          via = "page";
        }
      }
    }

    // Fallback: re-point the current term's URL. Safe to attempt only because
    // every row states its own term and mismatches are dropped below.
    if (!url) url = term.value === currentValue ? endpoint.url : withTerm(endpoint.url, term);

    const result = await fetchTermSections(t, url, endpoint.pageSize, filters, (found, total) =>
      onProgress?.(loaded + found.length, total, term.label)
    );

    // The decisive check. Every row states its own term, so whatever route the
    // URL took, only rows that actually belong to this term are kept. That is
    // what makes the rewrite fallback safe to have at all: if the portlet id
    // turns out to be bound to one term and ignores the rewrite, the rows it
    // returns are simply dropped here rather than mislabeled.
    const belonging = result.sections.filter((s) => !s.yearTerm || s.yearTerm === term.value);
    const foreign = result.sections.length - belonging.length;

    sections.push(...belonging);
    loaded += belonging.length;
    truncated ||= result.truncated;
    perTerm.push({
      term,
      sections: belonging.length,
      filteredRows: result.filteredRows,
      truncated: result.truncated,
      via,
      error:
        result.error ??
        (foreign > 0
          ? `${foreign} rows came back tagged as a different term and were ignored`
          : belonging.length === 0
            ? `Franciscan reported ${result.filteredRows} courses for this term (via ${via})`
            : undefined),
    });
  }

  // Put the portal back the way we found it. Best effort — a student who
  // opens registration next should see the term they left it on.
  if (termFormUrl && currentValue && selectedNow !== currentValue) {
    await t.fetchTermPage(termFormUrl, termFormFields(doc, currentValue)).catch(() => {});
  }

  const covered = perTerm.filter((t) => t.sections > 0).map((t) => t.term);
  return {
    ok: sections.length > 0,
    sections,
    terms: covered,
    allTerms,
    perTerm,
    truncated,
    // Always carry the per-term reason. "No sections came back" on its own
    // sends you looking at the wrong thing; "Fall 2026: blocked" doesn't.
    error: perTerm.some((t) => t.error)
      ? perTerm
          .filter((t) => t.error)
          .map((t) => `${t.term.label}: ${t.error}`)
          .join(" · ")
      : undefined,
  };
}

/**
 * Which of the covered terms each course appears in, in the order the terms
 * run — the answer the "Fall / Spring" label is built from.
 *
 * Derived from each section's own `yearTerm`, never from which request it came
 * back on, so a course can only be labeled with a term the portal itself put
 * it in.
 */
export function offeringsByCode(result: SectionSyncResult | null): Map<string, TermOption[]> {
  const map = new Map<string, TermOption[]>();
  if (!result) return map;
  const byValue = new Map(result.allTerms.map((t) => [t.value, t]));
  const order = new Map(result.terms.map((t, i) => [t.value, i]));

  for (const s of result.sections) {
    const term = s.yearTerm ? byValue.get(s.yearTerm) : null;
    if (!term) continue;
    const list = map.get(s.code) ?? [];
    if (!list.some((t) => t.value === term.value)) list.push(term);
    map.set(s.code, list);
  }
  for (const list of map.values()) {
    // result.terms is newest-first, so ascending index keeps that order.
    list.sort((a, b) => (order.get(a.value) ?? 0) - (order.get(b.value) ?? 0));
  }
  return map;
}

/**
 * "Fall", "Spring", "Fall · Spring" — the portal's own season words, in the
 * order the terms run. Duplicates collapse, so covering two Falls reads
 * "Fall" rather than "Fall · Fall".
 */
export function seasonLabel(terms: TermOption[], separator = " · "): string {
  const seasons: string[] = [];
  for (const t of terms) {
    const word = t.season ?? t.label;
    if (!seasons.includes(word)) seasons.push(word);
  }
  return seasons.join(separator);
}
