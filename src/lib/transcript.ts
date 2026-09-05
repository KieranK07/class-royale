// Parses Franciscan's unofficial-transcript page into the StudentRecord
// shape in ./types.
//
// Source (requires the student's own logged-in Jenzabar session):
//
//   GET https://myfranciscan.franciscan.edu/ICS/Registration/New_Undergraduate.jnz
//         ?portlet=My_Unofficial_Transcript&hideUI=1
//
// There is no JSON API behind this — Jenzabar renders the transcript
// server-side as HTML, so parsing the page IS the interface. See
// docs/scraping-notes.md for why that pushes the whole login-gated side of
// this app into a browser extension rather than a server fetch.
//
// This takes a `Document` rather than an HTML string so it can run directly
// against a live page in the extension (`document`), against a fetched
// string (`new DOMParser().parseFromString(html, "text/html")`), and against
// a fixture in tests — without ever needing a server-side HTML parser.

import type { CompletedCourse } from "./types";

export interface TranscriptTotals {
  attemptedCredits: number;
  earnedCredits: number;
  gpaCredits: number;
  qualityPoints: number;
  gpa: number | null;
}

export interface TranscriptTerm {
  /** As printed, e.g. "Fall 2025" or "Transfer Year/Term" */
  label: string;
  /** Term-level honors printed alongside the term, e.g. ["DEAN'S LIST"] */
  honors: string[];
  courses: CompletedCourse[];
  termTotals: TranscriptTotals | null;
}

export interface TranscriptData {
  terms: TranscriptTerm[];
  /** The summary table at the top: totals by Transfer / Local / Career. */
  summary: Record<string, TranscriptTotals>;
  /** Every course from every term, flattened — the usual thing to work with. */
  courses: CompletedCourse[];
  /**
   * Anything the parser saw but didn't understand. Never silently dropped:
   * an unrecognized grade code or a row shape that doesn't match lands here
   * so it shows up instead of quietly changing someone's degree audit.
   */
  warnings: string[];
}

/**
 * Grade codes seen on real transcripts. Anything not listed is treated as a
 * completed letter grade but recorded in `warnings`, because guessing wrong
 * about whether a course counts is exactly the kind of error that would make
 * this app worse than the system it replaces.
 */
const GRADE_IN_PROGRESS = new Set(["WIP"]);
const GRADE_TRANSFER = new Set(["TR#", "TR"]);
/** Earned credit but deliberately excluded from GPA. */
const GRADE_NON_LETTER = new Set(["P", "S", "CR", "AU", "W", "WD", "I", "NG"]);
const LETTER_GRADE = /^[A-F][+-]?$/;

const TERM_LABEL = /^(Fall|Spring|Summer|Winter|Transfer)\b/i;
const TOTALS_ROW = /Totals:\s*$/i;

/**
 * "CSC 145 A" -> { code: "CSC 145", section: "A" }
 * "ECO 201 HY B" -> { code: "ECO 201", section: "HY B" }  (HY = hybrid)
 * "CHM 116 M L" -> { code: "CHM 116", section: "M L" }
 * "CSC 141"     -> { code: "CSC 141", section: null }     (transfer credit)
 *
 * Everything after the three-digit number is section/delivery-mode noise
 * that must come off before matching against catalog course codes.
 */
export function parseCourseCell(raw: string): { code: string; section: string | null } | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const m = text.match(/^([A-Z]{2,4})\s+(\d{3}[A-Z]?)\b\s*(.*)$/);
  if (!m) return null;
  return { code: `${m[1]} ${m[2]}`, section: m[3].trim() || null };
}

function num(text: string): number {
  const n = parseFloat(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cellsOf(row: Element): string[] {
  return Array.from(row.querySelectorAll("td, th")).map((c) =>
    (c.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim()
  );
}

/** Maps header text -> column index, so column order changes don't break us. */
function headerIndex(cells: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  cells.forEach((c, i) => {
    idx[c.toLowerCase()] = i;
  });
  return idx;
}

function totalsFrom(cells: string[], offset: number): TranscriptTotals {
  const gpaText = cells[offset + 4];
  return {
    attemptedCredits: num(cells[offset]),
    earnedCredits: num(cells[offset + 1]),
    gpaCredits: num(cells[offset + 2]),
    qualityPoints: num(cells[offset + 3]),
    gpa: gpaText ? num(gpaText) : null,
  };
}

export function parseTranscript(doc: Document): TranscriptData {
  const warnings: string[] = [];
  const terms: TranscriptTerm[] = [];
  const summary: Record<string, TranscriptTotals> = {};

  const tables = Array.from(doc.querySelectorAll("table.GroupedGrid"));
  if (tables.length === 0) {
    warnings.push(
      "No table.GroupedGrid found — either this isn't the transcript page, or the session expired and this is a login page."
    );
    return { terms, summary, courses: [], warnings };
  }

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) continue;
    const header = cellsOf(rows[0]);
    const cols = headerIndex(header);

    // The summary table at the top has a "Type" column instead of "Course".
    if (cols["type"] !== undefined) {
      for (const row of rows.slice(1)) {
        const cells = cellsOf(row);
        if (cells.length < 6) continue;
        summary[cells[0]] = totalsFrom(cells, 1);
      }
      continue;
    }

    if (cols["course"] === undefined) {
      warnings.push(`Skipped a GroupedGrid table with unrecognized headers: ${header.join(" | ")}`);
      continue;
    }

    // The term label and any honors sit in <div>s between the previous
    // table and this one. Bounded by prevUntil-style walking so honors from
    // an earlier term can't leak forward.
    let label: string | null = null;
    const honors: string[] = [];
    for (let node = table.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.tagName === "TABLE") break;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (TERM_LABEL.test(text) && !label) label = text;
      else honors.push(text);
    }
    if (!label) {
      warnings.push("Found a course table with no term label before it — term will show as 'Unknown'.");
    }

    const term: TranscriptTerm = {
      label: label || "Unknown",
      honors: honors.reverse(),
      courses: [],
      termTotals: null,
    };

    for (const row of rows.slice(1)) {
      const cells = cellsOf(row);
      if (cells.length === 0) continue;

      // "Term Totals:" / "Career Totals:" rows — real data, but not courses.
      if (TOTALS_ROW.test(cells[0])) {
        if (/^Term/i.test(cells[0])) term.termTotals = totalsFrom(cells, 1);
        continue;
      }

      const parsed = parseCourseCell(cells[cols["course"]] ?? "");
      if (!parsed) {
        warnings.push(`Unparseable course cell in ${term.label}: ${JSON.stringify(cells[0])}`);
        continue;
      }

      const grade = cells[cols["grade"]] ?? "";
      const isInProgress = GRADE_IN_PROGRESS.has(grade);
      const isTransfer = GRADE_TRANSFER.has(grade);
      if (
        !isInProgress &&
        !isTransfer &&
        !GRADE_NON_LETTER.has(grade) &&
        !LETTER_GRADE.test(grade)
      ) {
        warnings.push(
          `Unrecognized grade "${grade}" for ${parsed.code} in ${term.label} — treated as completed. Check what it means before trusting the audit.`
        );
      }

      term.courses.push({
        code: parsed.code,
        term: term.label,
        grade: grade || undefined,
        creditsEarned: num(cells[cols["earned credits"]] ?? "0"),
        inProgress: isInProgress || undefined,
        section: parsed.section || undefined,
        title: cells[cols["title"]] || undefined,
        attemptedCredits: num(cells[cols["attempted credits"]] ?? "0"),
        isTransfer: isTransfer || undefined,
      });
    }

    terms.push(term);
  }

  return {
    terms,
    summary,
    courses: terms.flatMap((t) => t.courses),
    warnings,
  };
}

/**
 * The courses that should count toward requirements: everything completed or
 * transferred in, but NOT what's currently being taken. In-progress courses
 * matter for planning ("don't tell me to take CSC 261, I'm in it") but
 * counting them as done would overstate progress.
 */
export function earnedCourses(data: TranscriptData): CompletedCourse[] {
  return data.courses.filter((c) => !c.inProgress);
}

export function inProgressCourses(data: TranscriptData): CompletedCourse[] {
  return data.courses.filter((c) => c.inProgress);
}
