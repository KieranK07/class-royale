// Turns the scraper's output (data/catalog/<year>/) into the Course /
// Program shapes the rest of the app works with.
//
// Nothing here re-derives requirements — the scrapers already did that and
// their output is the source of truth. This is purely a mapping layer.

import type { Course, Program, ProgramType, RequirementGroup } from "./types";

// ---- shapes as they come out of the scrapers ----

interface ScrapedSlot {
  codes: string[];
  title: string;
  credits: number | null;
  subLabel: string | null;
}

interface ScrapedRequirement {
  id: string;
  label: string;
  subgroup: string | null;
  count: number;
  unit: "courses" | "credits";
  options: string[];
  unresolved?: boolean;
  creditsIfKnown?: number | null;
  optionsFromNote?: boolean;
}

export interface ScrapedProgram {
  name: string;
  sourceUrl: string;
  kind: "tables" | "narrative" | "informational" | "department-page";
  narrative: string[];
  mentionedCodes: string[];
  slots: ScrapedSlot[];
  requirements: ScrapedRequirement[];
  uncertainHeadings?: string[];
  requirementsFromSchedule?: boolean;
  notes?: { section: string | null; text: string; codes: string[] }[];
}

export interface ScrapedDepartment {
  department: string;
  catalogYear: string;
  programs: ScrapedProgram[];
}

interface CoreCategory {
  code: string;
  label: string;
  options: { codes: string[]; title: string; credits: number | null }[];
  notes: string[];
}

interface CoreRule {
  count: number;
  unit: "courses";
  categories: string[];
  text: string;
}

export interface CoreCurriculum {
  catalogYear: string;
  sourceUrl: string;
  categories: CoreCategory[];
  degreeRules: Record<
    string,
    { totalCredits: number | null; rules: CoreRule[]; alsoRequires: string[]; sourceSentence: string }
  >;
}

// ---- classification ----

/**
 * The catalog encodes program type in the page title, not a field:
 * "Spanish Minor", "Theatre (Performance Concentration), Bachelor of Arts".
 * Order matters — a concentration page also says "Bachelor of Arts".
 */
/**
 * A catalog page that exists but isn't a program anyone declares.
 * Deliberately narrow: a keyword test on the name would be wrong, because
 * plenty of real programs carry no degree word at all ("Software
 * Engineering", "Greek Language and Civilization", "Nursing RN to BSN").
 * Only a title that announces itself as a course listing qualifies.
 */
const REFERENCE_LISTING = /^courses\b/i;

/**
 * A narrative page that names no requirement, no course and no slot isn't a
 * program — it's a signpost. "High School Teaching (Adolescent/Young Adult
 * Licensure)" is one: its whole content is "major in English, History, or
 * Math and work toward licensure with the prescribed programs of study
 * located in each of the previous areas." Offering it in the major picker
 * gives a student a degree with zero requirements, which reads as "you're
 * already done" — the same class of thing as the "Courses Grouped By Field"
 * page that used to be offered as a major.
 */
function isSignpost(scraped: ScrapedProgram): boolean {
  return (
    scraped.kind === "narrative" &&
    (scraped.requirements?.length ?? 0) === 0 &&
    (scraped.mentionedCodes?.length ?? 0) === 0 &&
    (scraped.slots?.length ?? 0) === 0
  );
}

export function inferProgramType(name: string, kind: ScrapedProgram["kind"]): ProgramType | null {
  if (kind === "informational") return null; // partner-school pathway, not a program you can declare
  // A department overview page is not a major. Physics, Modern Languages and
  // Military Science were all showing up in the "pick a major" list.
  if (kind === "department-page") return "reference";
  if (REFERENCE_LISTING.test(name)) return "reference";
  if (/\bconcentration\b/i.test(name)) return "concentration";
  if (/\bminor\b/i.test(name)) return "minor";
  return "major";
}

export function inferDegree(name: string): string | undefined {
  if (/Bachelor of Science/i.test(name)) return "BS";
  if (/Bachelor of Arts/i.test(name)) return "BA";
  if (/Associate of Arts/i.test(name)) return "AA";
  if (/Associate of Science/i.test(name)) return "AS";
  return undefined;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---- mapping ----

function toRequirementGroups(reqs: ScrapedRequirement[]): RequirementGroup[] {
  // Group by the h4 sub-heading the scraper recorded, so the UI can show
  // "Language-Skills Courses" / "Content Courses" the way the catalog does.
  const bySubgroup = new Map<string, ScrapedRequirement[]>();
  for (const r of reqs) {
    const key = r.subgroup ?? "";
    if (!bySubgroup.has(key)) bySubgroup.set(key, []);
    bySubgroup.get(key)!.push(r);
  }

  const map = (r: ScrapedRequirement): RequirementGroup => ({
    id: r.id,
    label: r.label || "(unnamed requirement)",
    count: r.count,
    unit: r.unit,
    options: r.options,
    unresolved: r.unresolved,
    optionsFromNote: r.optionsFromNote,
  });

  // No sub-headings at all — flat list.
  if (bySubgroup.size === 1 && bySubgroup.has("")) {
    return reqs.map(map);
  }

  const out: RequirementGroup[] = [];
  for (const [label, items] of bySubgroup) {
    if (!label) {
      out.push(...items.map(map));
      continue;
    }
    out.push({
      id: `sub-${slugify(label)}`,
      label,
      count: items.length,
      unit: "courses",
      options: [],
      subgroups: items.map(map),
    });
  }
  return out;
}

export function toProgram(scraped: ScrapedProgram, department: string, catalogYear: string): Program | null {
  // The catalog has stray double spaces in some titles
  // ("Pre-Engineering:  2+2 Program with ...").
  const name = scraped.name.replace(/\s+/g, " ").trim();
  const type = isSignpost(scraped) ? "reference" : inferProgramType(name, scraped.kind);
  if (!type) return null;

  return {
    // Department-qualified, because program names are NOT unique across the
    // catalog: "Honors Program" exists under both Engineering and its own
    // department, and "Bioinformatics Certificate Program" under both
    // Biology and Computer Science.
    id: `${slugify(department)}--${slugify(name)}`,
    name,
    type,
    degree: inferDegree(scraped.name),
    requirements: toRequirementGroups(scraped.requirements),
    sourceUrl: scraped.sourceUrl,
    department,
    catalogYear,
    kind: scraped.kind,
    narrative: scraped.narrative,
    mentionedCodes: scraped.mentionedCodes,
    // A program with no machine-readable requirements can NEVER be scored.
    // This flag exists because the failure is silent and dangerous in the
    // other direction: an empty requirement list reads as "nothing needed",
    // so an unscorable minor sorts to the top of the "cheapest to add" list
    // and tells the student they've already earned it.
    scorable: scraped.requirements.length > 0,
    requirementsFromSchedule: scraped.requirementsFromSchedule,
    notes: scraped.notes ?? [],
  };
}

/**
 * The Core Curriculum as a Program. Each prose rule ("two literature
 * courses", "either one math or one economics course") becomes one group
 * whose options are the union of the named categories' eligible courses —
 * which is exactly what `count` + `options` means: pick N from this pool.
 */
export function coreToProgram(core: CoreCurriculum, degreeType: string): Program | null {
  const rule = core.degreeRules[degreeType];
  if (!rule) return null;

  const byCode = new Map(core.categories.map((c) => [c.code, c]));

  const requirements: RequirementGroup[] = rule.rules.map((r, i) => {
    const cats = r.categories.map((c) => byCode.get(c)).filter(Boolean) as CoreCategory[];
    const options = [...new Set(cats.flatMap((c) => c.options.flatMap((o) => o.codes)))];
    return {
      id: `core-${i}`,
      label: `${r.count} × ${cats.map((c) => c.label).join(" or ")}`,
      count: r.count,
      unit: "courses",
      options,
    };
  });

  return {
    id: `core-curriculum-${degreeType.toLowerCase().replace(/\W+/g, "-")}`,
    name: `Core Curriculum (${degreeType})`,
    type: "core",
    degree: degreeType,
    totalCreditsRequired: rule.totalCredits ?? undefined,
    requirements,
    sourceUrl: core.sourceUrl,
    catalogYear: core.catalogYear,
    kind: "tables",
    narrative: rule.alsoRequires,
    mentionedCodes: [],
    scorable: requirements.length > 0,
  };
}

/**
 * Every course the catalog mentions anywhere, with title and credits.
 * Built from the raw `slots` (which keep title/credits per row) plus the
 * Core category tables. Cross-listed rows register under every code.
 */
export interface ScrapedCourse {
  code: string;
  title: string;
  credits: number | null;
  description: string;
  prerequisites: string[];
  prerequisiteText: string;
  corequisites: string[];
  crossListed: string[];
  subject: string;
}

export function buildCourseCatalog(
  departments: ScrapedDepartment[],
  core: CoreCurriculum | null,
  /**
   * The real course catalogue (scripts/scrape-courses.mjs). Program tables
   * only ever mention courses some program requires; this covers every course
   * the university offers, and is the only source of prerequisites.
   */
  courseDescriptions: ScrapedCourse[] = []
): Map<string, Course> {
  const catalog = new Map<string, Course>();

  // Seed from the course catalogue first, so its titles and credits win over
  // whatever a requirement table happened to abbreviate.
  for (const c of courseDescriptions) {
    catalog.set(c.code, {
      code: c.code,
      title: c.title || c.code,
      credits: c.credits ?? 0,
      description: c.description || undefined,
      prerequisites: c.prerequisites?.length ? c.prerequisites : undefined,
      prerequisiteText: c.prerequisiteText || undefined,
      corequisites: c.corequisites?.length ? c.corequisites : undefined,
      crossListed: c.crossListed?.length ? c.crossListed : undefined,
      subject: c.subject,
    });
  }

  const add = (code: string, title: string, credits: number | null) => {
    const existing = catalog.get(code);
    if (existing) {
      // Prefer an entry that actually knows its credits.
      if (!existing.credits && credits) existing.credits = credits;
      if (!existing.title && title) existing.title = title;
      return;
    }
    catalog.set(code, { code, title: title || code, credits: credits ?? 0 });
  };

  for (const dept of departments) {
    for (const program of dept.programs) {
      for (const slot of program.slots) {
        for (const code of slot.codes) add(code, slot.title, slot.credits);
      }
    }
  }

  if (core) {
    for (const category of core.categories) {
      for (const option of category.options) {
        for (const code of option.codes) {
          add(code, option.title, option.credits);
          const entry = catalog.get(code)!;
          entry.tags = [...new Set([...(entry.tags ?? []), `core:${category.code}`])];
        }
      }
    }
  }

  return catalog;
}

/**
 * Many programs list a bare "Theology Core" or "Literature OR Catholic
 * Traditions in Fine Arts Core" row with no course codes — because the
 * courses live in the Core Curriculum section, not on the program page.
 * 187 requirement groups across the catalog are of this kind.
 *
 * Linking them means a student's THE 101 correctly satisfies both the Core
 * requirement AND the major row that points at it, which is how the degree
 * actually works. Without the link those rows can never be satisfied by
 * anything and permanently show as outstanding.
 *
 * Matching is on the category NAME, and multi-category rows ("Theology OR
 * Philosophy Core") resolve to the union of both pools.
 */
export function linkCoreCategories(programs: Program[], core: CoreCurriculum | null): number {
  if (!core) return 0;

  const byName = core.categories.map((c) => ({
    code: c.code,
    // "Catholic Traditions in Fine Arts" -> matched against the row label
    needle: c.label.toLowerCase(),
    codes: [...new Set(c.options.flatMap((o) => o.codes))],
  }));
  // Longest first, so "Social Science" wins over "Science" on the same label.
  byName.sort((a, b) => b.needle.length - a.needle.length);

  let linked = 0;
  for (const program of programs) {
    const walk = (groups: RequirementGroup[]) => {
      for (const g of groups) {
        if (g.subgroups) walk(g.subgroups);
        if (!g.unresolved || g.options.length > 0) continue;

        const label = g.label.toLowerCase();
        // Only rows that actually say "core" — a plain "Elective" must not
        // get silently narrowed to a Core pool.
        if (!/\bcore\b/.test(label)) continue;

        const hits = byName.filter((c) => label.includes(c.needle));
        if (hits.length === 0) continue;

        g.options = [...new Set(hits.flatMap((h) => h.codes))];
        g.coreCategories = hits.map((h) => h.code);
        g.optionsFromCore = true;
        delete g.unresolved;
        linked++;
      }
    };
    walk(program.requirements);
  }
  return linked;
}

/**
 * The level at which courses stop being undergraduate.
 *
 * Applied as an implicit ceiling on rules that state a floor and no top —
 * "BUS elective, 300 level or above". Before the 2026-2027 catalog merged the
 * graduate book in, an open-ended rule swept up nothing worse than a 400-level
 * course; afterwards the same rule expanded "BUS 300+" to include BUS 601
 * through BUS 900, and the app offered a doctoral seminar as an undergraduate
 * elective. The rule was always open-ended; only the catalog changed under it.
 */
const GRADUATE_LEVEL = 500;

/** Does a course code satisfy a level-range rule? */
export function matchesSubjectRule(
  code: string,
  rule: NonNullable<RequirementGroup["subjectRule"]>
): boolean {
  const m = code.match(/^([A-Z]{2,4})\s*(\d{3})/);
  if (!m) return false;
  if (!rule.subjects.includes(m[1])) return false;
  if (rule.excludes?.some((x) => x.replace(/\s+/g, " ") === code.replace(/\s+/g, " "))) return false;
  const level = parseInt(m[2], 10);
  if (rule.minLevel != null && level < rule.minLevel) return false;
  if (rule.maxLevel != null && level > rule.maxLevel) return false;
  // An unbounded rule is an undergraduate rule: these come off undergraduate
  // program pages, and none of them means "or a master's course".
  if (rule.maxLevel == null && level >= GRADUATE_LEVEL) return false;
  return true;
}

/**
 * Applies the level-range rules derived for unresolved elective labels
 * ("CHM upper-level elective" -> CHM 300+). Expands each into the concrete
 * courses we know about so the UI can list them, while keeping the rule
 * itself so a transcript course missing from our catalog still matches.
 */
export function applyElectiveRules(
  programs: Program[],
  rules: { label: string; subjects: string[]; minLevel: number | null; maxLevel: number | null }[],
  catalog: Map<string, Course>
): number {
  const byLabel = new Map(rules.map((r) => [r.label.trim().toLowerCase(), r]));
  let applied = 0;

  for (const program of programs) {
    const walk = (groups: RequirementGroup[]) => {
      for (const g of groups) {
        if (g.subgroups) walk(g.subgroups);
        if (!g.unresolved || g.options.length > 0) continue;
        const rule = byLabel.get(g.label.trim().toLowerCase());
        if (!rule) continue;

        const subjectRule = {
          subjects: rule.subjects,
          minLevel: rule.minLevel,
          maxLevel: rule.maxLevel,
          excludes: [] as string[],
        };
        g.subjectRule = subjectRule;
        g.options = [...catalog.keys()].filter((c) => matchesSubjectRule(c, subjectRule)).sort();
        g.ruleSource = "derived";
        delete g.unresolved;
        applied++;
      }
    };
    walk(program.requirements);
  }
  return applied;
}

/**
 * Replaces a prose-only program's empty requirements with the structured ones
 * extracted from its catalog text. Only programs whose extraction survived
 * verbatim-evidence validation reach here (data/derived/_dropped.json lists
 * what didn't).
 */
export function applyProsePrograms(
  programs: Program[],
  extracted: {
    program: string;
    totalCredits: number | null;
    requirements: {
      label: string;
      count: number;
      unit: "courses" | "credits";
      options: string[];
      subjectRule: RequirementGroup["subjectRule"] | null;
      evidence: string;
    }[];
  }[],
  catalog: Map<string, Course>
): number {
  const byName = new Map(extracted.map((e) => [e.program.trim().toLowerCase(), e]));
  let filled = 0;

  for (const program of programs) {
    if (program.requirements.length > 0) continue;
    const e = byName.get(program.name.trim().toLowerCase());
    if (!e) continue;

    program.requirements = e.requirements.map((r, i) => {
      const options = r.options.length
        ? r.options
        : r.subjectRule
          ? [...catalog.keys()].filter((c) => matchesSubjectRule(c, r.subjectRule!)).sort()
          : [];
      return {
        id: `prose-${i}`,
        label: r.label,
        count: r.count,
        unit: r.unit,
        options,
        subjectRule: r.subjectRule ?? undefined,
        ruleSource: "catalog-prose" as const,
        unresolved: options.length === 0 ? true : undefined,
      };
    });
    program.totalCreditsRequired = e.totalCredits ?? program.totalCreditsRequired;
    program.scorable = program.requirements.length > 0;
    filled++;
  }
  return filled;
}

/**
 * A row labelled just "Elective" (50 of them across the catalog) is a FREE
 * elective: the catalog names no courses because any course counts toward it.
 * Left as `unresolved` it reads as missing data and can never be satisfied,
 * which understates every affected student's progress.
 */
export function markFreeElectives(programs: Program[]): number {
  const FREE = /^(free\s+)?electives?$/i;
  let marked = 0;
  for (const program of programs) {
    const walk = (groups: RequirementGroup[]) => {
      for (const g of groups) {
        if (g.subgroups) walk(g.subgroups);
        if (!g.unresolved || g.options.length > 0) continue;
        if (!FREE.test(g.label.trim())) continue;
        g.freeElective = true;
        delete g.unresolved;
        marked++;
      }
    };
    walk(program.requirements);
  }
  return marked;
}

/**
 * Words that carry no academic meaning — degree wrappers and connectives.
 */
const AREA_NOISE = /\b(Minor|Concentration|Program|Licensure|Track|Pre|and|the|of|in|for|with)\b/gi;

/** "mathematics"/"mathematical" -> "mathematic", "arts" -> "art" */
function stemWord(w: string): string {
  return w.replace(/(ics|ical|ies)$/, "ic").replace(/s$/, "");
}

/**
 * The set of words describing a program's academic area.
 *
 *   "Computer Science (Cybersecurity Concentration), Bachelor of Science"
 *     -> {computer, science, cybersecurity}
 *   "Cybersecurity Minor"  -> {cybersecurity}
 *
 * Crucially the PARENTHETICAL is kept. A concentration names a sub-area, and
 * dropping it is what let a Cybersecurity-concentration student be offered a
 * Cybersecurity minor — the concentration reduced to just "computer science"
 * and never matched.
 */
export function areaWords(name: string): Set<string> {
  const parenthetical = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(" ");
  let base = name.replace(/\([^)]*\)/g, " ");

  // "Associate of Arts Degree in Philosophy" -> "Philosophy"
  const degreeIn = base.match(/\b(?:Bachelor|Associate) of (?:Arts|Science)\s+Degree\s+in\s+(.*)$/i);
  if (degreeIn) base = degreeIn[1];

  base = base
    .replace(/,?\s*(Bachelor|Associate) of (Arts|Science).*$/i, " ")
    .replace(/\bDegree\b/gi, " ")
    // Drop the licensure phrase only — cutting everything after "with" was
    // swallowing the concentration that follows it in
    // "English with AYA Licensure: (British and American Literature ...)".
    .replace(/\bwith\b[^,:(]*\bLicensure\b/gi, " ")
    .replace(/\bwith\b\s+[A-Z]{2,4}\b/g, " ");

  const cleaned = `${base} ${parenthetical}`
    .replace(AREA_NOISE, " ")
    .replace(/[^A-Za-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return new Set(cleaned.split(" ").filter(Boolean).map(stemWord));
}

/**
 * Pairs the word test can't reach.
 *
 * The catalog never defines how far "academic area" extends, so somewhere a
 * human has to decide. Better that it live here — visible, with its reasoning
 * and the evidence attached — than as a fudge inside a regex.
 *
 * Each entry states WHY, so a future reader can re-check it against the
 * catalog instead of trusting it.
 */
const SAME_AREA_EXCEPTIONS: { program: RegExp; minor: RegExp; why: string }[] = [
  {
    program: /catechetics.*youth ministry concentration/i,
    minor: /^catholic youth ministry minor$/i,
    why:
      "The minor's extra word 'Catholic' breaks word containment, but the " +
      "concentration FORCES 6 of the minor's 8 named requirements and both are " +
      "entirely CAT-coded. Confirmed by Kieran. Note this is scoped to the " +
      "concentration: plain 'Catechetics and Evangelization, BA' forces only " +
      "2 of 8, so for that major the minor is a genuine second area and stays " +
      "on offer.",
  },
];

/**
 * Would these two count as the same academic area?
 *
 * The catalog: "A minor in a SECOND academic area is available to students who
 * are earning an undergraduate degree in a primary area." So a Computer
 * Science major can't add a Computer Science minor — and offering it as the
 * cheapest one to add, which it always will be, is actively misleading.
 *
 * Containment either way, on stemmed words:
 *  - {cybersecurity} within {computer, science, cybersecurity} — the minor is
 *    the concentration's own subject.
 *  - {mathematic} within {mathematic, science} — "Mathematics with AYA
 *    Licensure" against "Mathematical Science Minor" is the same subject
 *    written two ways.
 *
 * NOT matched on department, which is far too coarse: Engineering holds nine
 * majors and three minors, and a Mechanical Engineering major has every right
 * to a Cybersecurity minor.
 */
export function sameAcademicArea(a: string, b: string): boolean {
  for (const e of SAME_AREA_EXCEPTIONS) {
    if ((e.program.test(a) && e.minor.test(b)) || (e.program.test(b) && e.minor.test(a))) {
      return true;
    }
  }

  const x = areaWords(a);
  const y = areaWords(b);
  if (x.size === 0 || y.size === 0) return false;
  const within = (inner: Set<string>, outer: Set<string>) => [...inner].every((w) => outer.has(w));
  return within(y, x) || within(x, y);
}

/**
 * Marks the courses an undergraduate can't take.
 *
 * Course NUMBER alone doesn't settle it: the undergraduate-only 2025-2026
 * catalog carried FRN/GRK/GRM/LAT 500 (language proficiency), so a flat
 * "500 and above is graduate" rule would hide four courses undergraduates
 * genuinely use.
 *
 * So the number only raises the question, and the undergraduate side of the
 * catalog answers it: a 500-level course that some undergraduate program
 * actually references stays undergraduate. Everything else at that level is
 * graduate. Both halves are read live from the same scrape, so this stays
 * right when the catalog changes again.
 */
export function markGraduateCourses(
  catalog: Map<string, Course>,
  referencedByUndergrad: Set<string>
): number {
  let marked = 0;
  for (const course of catalog.values()) {
    const m = course.code.match(/(\d{3})/);
    const number = m ? parseInt(m[1], 10) : 0;
    const graduate = number >= 500 && !referencedByUndergrad.has(course.code);
    course.level = graduate ? "graduate" : "undergraduate";
    if (graduate) marked++;
  }
  return marked;
}
