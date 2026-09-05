// Shared model for semester-by-semester degree plans.
//
// Two sources produce these and they have to agree on a shape:
//
//   scrape-schedules.mjs      the catalog's own "Freshman Year / First
//                             Semester" tables — public, live, 200+ of them
//   parse-program-guides.mjs  the department .xlsx handouts — fewer, but they
//                             carry concentration variants and footnotes the
//                             catalog doesn't
//
// A plan is a list of terms in order. Each term holds entries, and an entry is
// either a named COURSE or an unfilled SLOT ("American Founding Principles
// Core", "THE/PHL 3", "General Elective"). Keeping slots as slots is the whole
// trick: the guides never claim to know which theology course you'll take in
// your sixth semester, and neither should we.

/** Year headings, in the order they run. */
const YEAR_ORDER = ["freshman", "sophomore", "junior", "senior", "fifth"];

const ORDINALS = [
  "first", "second", "third", "fourth",
  "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth",
];

/**
 * Headings are not consistently spaced: the same catalog writes "Freshman
 * Year" on one page and "Freshman-Year" / "Second-Semester" on another. A
 * matcher that only knows spaces drops the hyphenated ones — and because a
 * dropped semester heading takes its whole term with it, that reads as a
 * program with a shorter degree rather than as a parse failure.
 */
function normalizeHeading(text) {
  return String(text)
    .replace(/[\u00a0]/g, " ")
    .replace(/[-_\u2010-\u2015]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** "Sophomore Year" -> 2 (1-based). null if it isn't a year heading. */
export function yearNumber(text) {
  const t = normalizeHeading(text);
  const named = YEAR_ORDER.findIndex((y) => t.startsWith(y));
  if (named !== -1) return named + 1;
  // "Second-Year-Varies-by-Discipline" and similar
  const ord = t.match(/^(\w+)\s+year/);
  if (ord) {
    const i = ORDINALS.indexOf(ord[1]);
    if (i !== -1) return i + 1;
  }
  return null;
}

/**
 * "First Semester" -> 1, "Second Semester" -> 2, "Summer Session" -> "summer".
 *
 * The catalog numbers semesters WITHIN a year; the .xlsx guides number them
 * across the whole degree ("Fifth Semester"). Both funnel through here and
 * the caller supplies the year, so the two end up on the same footing.
 */
// "First Semesster" is a real heading in this catalog (Biology Pre-Medicine).
// Matching the ordinal plus a token containing "sem" tolerates that without
// pretending to be a spell-checker — and a dropped semester heading costs a
// whole term, which is worse than a slightly loose match.
const ORDINAL_SEMESTER = new RegExp(`\\b(${ORDINALS.join("|")})\\s+\\S*sem\\S*`);

export function termWithinYear(text) {
  const t = normalizeHeading(text);
  if (/summer/.test(t)) return "summer";
  if (/(winter|intersession|j ?term)/.test(t)) return "winter";
  const m = t.match(ORDINAL_SEMESTER);
  if (!m) return null;
  return ORDINALS.indexOf(m[1]) + 1;
}

/**
 * Some years branch: the Gannon 2+2 page splits its second year into six
 * discipline tracks, each with its own two semesters ("Biomedical Engineering
 * First Semester"). The ordinal is the same; what changes is which track it
 * belongs to.
 *
 * Matching the ordinal anywhere in the heading rather than at the start is
 * what keeps those twelve terms from vanishing — and returning the prefix
 * separately is what lets a planner offer them as alternatives instead of
 * stacking six tracks' worth of courses into one year.
 */
export function termVariant(text) {
  const t = normalizeHeading(text);
  const m = t.match(ORDINAL_SEMESTER);
  if (!m || m.index === 0) return null;
  const prefix = t.slice(0, m.index).trim();
  return prefix || null;
}

/**
 * Which season a term falls in.
 *
 * Falls are odd, springs even — the convention of any plan that starts in the
 * fall and runs consecutive terms. It's an inference, not a statement, which
 * is why every consumer gets `seasonSource` alongside it and live section data
 * is allowed to override it.
 */
export function seasonOf(index, kind) {
  if (kind === "summer") return "Summer";
  if (kind === "winter") return "Winter";
  return index % 2 === 1 ? "Fall" : "Spring";
}

/** A real course code: "CSC 144", "MTH/CSC 330", "BIO 133L". */
const COURSE_CODE = /^([A-Z]{2,4})(?:\s*\/\s*([A-Z]{2,4}))?\s*(\d{3}[A-Z]?)$/;

/** A slot the plan leaves open by number range: "CSC 39x", "SFE 36x". */
const WILDCARD = /^([A-Z]{2,4})\s*(\d{1,2})x{1,2}$/i;

/**
 * Turns one row into an entry.
 *
 * `codes` is a list because a cross-listed row ("MTH/CSC 330", or the
 * catalog's `<span class="crossListed">`) is ONE course wearing two numbers —
 * either satisfies it, and treating them as two courses would double a
 * student's workload on paper.
 */
export function classifyEntry(rawCode, rawTitle, explicitCodes) {
  const code = String(rawCode ?? "").replace(/\s+/g, " ").trim();
  const title = String(rawTitle ?? "").replace(/\s+/g, " ").trim();

  const footnotes = [...title.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const cleanTitle = title.replace(/\s*\[\d+\]/g, "").trim();

  // The catalog gives us the codes as links, so trust those over the text.
  if (explicitCodes && explicitCodes.length > 0) {
    return { kind: "course", codes: explicitCodes, title: cleanTitle, footnotes };
  }
  if (!code) {
    // No code and no link: an unfilled requirement, named in the title cell.
    return cleanTitle ? { kind: "slot", label: cleanTitle, title: cleanTitle, footnotes } : null;
  }

  const exact = code.match(COURSE_CODE);
  if (exact) {
    const codes = exact[2]
      ? [`${exact[1]} ${exact[3]}`, `${exact[2]} ${exact[3]}`]
      : [`${exact[1]} ${exact[3]}`];
    return { kind: "course", codes, title: cleanTitle, footnotes };
  }

  const wild = code.match(WILDCARD);
  if (wild) {
    return {
      kind: "wildcard",
      subject: wild[1].toUpperCase(),
      prefix: wild[2],
      title: cleanTitle,
      footnotes,
    };
  }

  return { kind: "slot", label: code, title: cleanTitle, footnotes };
}

/**
 * Puts terms in order and stamps each with its position and season.
 *
 * Summer and winter terms sit between the semesters that bracket them and do
 * NOT consume a parity slot — a summer course doesn't make the next fall a
 * spring.
 */
export function orderTerms(terms) {
  const sorted = [...terms].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const rank = (t) => (t.kind === "winter" ? 0 : t.kind === "summer" ? 3 : t.within);
    return rank(a) - rank(b);
  });

  let index = 0;
  return sorted.map((t) => {
    const isSemester = t.kind === "semester";
    if (isSemester) index += 1;
    return {
      ...t,
      index: isSemester ? index : null,
      season: seasonOf(isSemester ? index : 0, t.kind),
      seasonSource: "position",
    };
  });
}

/**
 * A plan has to add up.
 *
 * Both sources state their own credit totals — the .xlsx per semester, the
 * catalog per program — so a dropped row or a misread column is catchable at
 * scrape time instead of turning into a plan that's quietly a course short.
 */
export function creditProblems(terms) {
  const problems = [];
  for (const t of terms) {
    const summed = t.entries.reduce((n, e) => n + (e.credits ?? 0), 0);
    if (t.statedCredits != null && Math.abs(summed - t.statedCredits) > 0.001) {
      problems.push(
        `${t.label}: entries add to ${summed} but the source says ${t.statedCredits}`
      );
    }
  }
  return problems;
}
