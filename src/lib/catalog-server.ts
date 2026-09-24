// Server-only: reads the scraped catalog off disk and assembles it.
//
// This runs at build/request time in a React Server Component, so the 47
// department JSON files never have to be imported one-by-one or shipped to
// the browser wholesale.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Course, GraduationRule, Program, RequirementGroup } from "./types";
import type { ScheduleTemplate } from "./schedules";
import {
  applyElectiveRules,
  applyProsePrograms,
  buildCourseCatalog,
  coreToProgram,
  linkCoreCategories,
  markFreeElectives,
  markGraduateCourses,
  toProgram,
  type CoreCurriculum,
  type ScrapedDepartment,
} from "./catalog-data";

const DATA_ROOT = path.join(process.cwd(), "data", "catalog");

export interface CatalogBundle {
  catalogYear: string;
  programs: Program[];
  /** Core Curriculum keyed by degree type: "BA", "BS", "AA/AS" */
  corePrograms: Program[];
  courses: Course[];
  /** Pages the scraper captured that aren't declarable programs */
  informationalCount: number;
  /** Department overviews and course listings — kept, never offered as majors */
  referenceCount: number;
  /** Program names that appeared under more than one department */
  duplicates: string[];
  /** Requirement rows resolved by pointing at a Core Curriculum category */
  coreLinked: number;
  /** Courses excluded as graduate-level — see markGraduateCourses */
  graduateCourses: number;
  /**
   * The catalog's own four-year schedules, one per program that publishes
   * one. The planner lays a student's remaining terms out from these rather
   * than generating a sequence from constraints.
   */
  scheduleTemplates: ScheduleTemplate[];
  /**
   * Core category code -> its eligible courses, sent once instead of being
   * repeated inside all 187 requirement rows that point at one.
   */
  coreCategoryCourses: Record<string, string[]>;
  /** University-wide rules that must hold at graduation */
  graduationRules: GraduationRule[];
  /** Prose-only programs given structured requirements */
  proseFilled: number;
  /** Unresolved elective rows given a subject/level rule */
  electiveRulesApplied: number;
  /** Rows recognised as genuinely unconstrained free electives */
  freeElectives: number;
}

/**
 * Which catalog year to use is resolved from what's actually on disk, not
 * hardcoded — same principle as the scrapers. Highest year wins.
 */
async function resolveYear(): Promise<string> {
  const entries = await readdir(DATA_ROOT, { withFileTypes: true });
  const years = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (years.length === 0) {
    throw new Error(
      `No scraped catalog found in ${DATA_ROOT}. Run \`npm run scrape:catalog\` and \`npm run scrape:core\` first.`
    );
  }
  return years[years.length - 1];
}

export async function loadCatalog(): Promise<CatalogBundle> {
  const catalogYear = await resolveYear();
  const dir = path.join(DATA_ROOT, catalogYear);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));

  const departments: ScrapedDepartment[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8")))
  );

  let core: CoreCurriculum | null = null;
  try {
    core = JSON.parse(await readFile(path.join(dir, "_core-curriculum.json"), "utf8"));
  } catch {
    // Core scrape hasn't been run — the app still works, it just can't show
    // Core progress. Better than failing to render at all.
  }

  const programs: Program[] = [];
  let informationalCount = 0;
  for (const dept of departments) {
    for (const scraped of dept.programs) {
      const program = toProgram(scraped, dept.department, catalogYear);
      if (program) programs.push(program);
      else informationalCount++;
    }
  }
  programs.sort((a, b) => a.name.localeCompare(b.name));

  // Two programs are listed under two departments each — "Honors Program"
  // (Engineering + its own department) and "Bioinformatics Certificate
  // Program" (Biology + Computer Science). They're genuinely separate pages
  // with different content, but showing the same name twice in a picker is
  // just confusing. Keep the richer one: real requirements beat prose, and
  // more prose beats less.
  const byName = new Map<string, Program>();
  const duplicates: string[] = [];
  for (const p of programs) {
    const existing = byName.get(p.name);
    if (!existing) {
      byName.set(p.name, p);
      continue;
    }
    duplicates.push(p.name);
    const score = (x: Program) =>
      x.requirements.length * 1000 + (x.narrative?.length ?? 0);
    if (score(p) > score(existing)) byName.set(p.name, p);
  }
  const deduped = [...byName.values()];

  const coreLinked = linkCoreCategories(deduped, core);

  // Derived data: requirements recovered from catalog prose that no table
  // states. Everything here was validated against the source text before it
  // was written — anything whose
  // evidence quote wasn't verbatim, or whose course codes weren't on the
  // page, was dropped rather than kept with a caveat.
  const derivedDir = path.join(process.cwd(), "data", "derived");
  const readDerived = async <T,>(file: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(path.join(derivedDir, file), "utf8"));
    } catch {
      return fallback; // derived data is optional — the app works without it
    }
  };

  let scrapedCourses: Parameters<typeof buildCourseCatalog>[2] = [];
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "_courses.json"), "utf8"));
    scrapedCourses = parsed.courses ?? [];
  } catch {
    // course catalogue not scraped yet — titles/credits fall back to whatever
    // the requirement tables carried, and prerequisites are simply absent
  }

  const courseMap = buildCourseCatalog(departments, core, scrapedCourses);

  const coreCategoryCoursesDraft: Record<string, string[]> = {};
  for (const c of core?.categories ?? []) {
    coreCategoryCoursesDraft[c.code] = [...new Set(c.options.flatMap((o) => o.codes))];
  }

  const prose = await readDerived<{ programs: Parameters<typeof applyProsePrograms>[1] }>(
    "prose-programs.json",
    { programs: [] }
  );
  const proseFilled = applyProsePrograms(deduped, prose.programs ?? [], courseMap);

  const electiveRules = await readDerived<{ rules: Parameters<typeof applyElectiveRules>[1] }>(
    "elective-rules.json",
    { rules: [] }
  );
  const electiveRulesApplied = applyElectiveRules(deduped, electiveRules.rules ?? [], courseMap);

  const grad = await readDerived<{ rules: GraduationRule[] }>("graduation-requirements.json", {
    rules: [],
  });
  // Graduate-program rules are in the same catalog section but are not
  // undergraduate graduation requirements — don't show them to an undergrad.
  const graduationRules = (grad.rules ?? []).filter((r) => !r.appliesTo.startsWith("graduate"));

  // Trimmed hard: the scraped file is ~800KB, of which the planner reads
  // codes, labels, credits and term position. Everything else stays here.
  const scheduleFile = await readDerived<{
    schedules: {
      name: string;
      slug: string;
      sourceUrl: string;
      totals?: { credits?: number };
      terms: {
        index: number | null;
        label: string;
        season: ScheduleTemplate["terms"][number]["season"];
        variant?: string | null;
        entries: {
          kind: string;
          codes?: string[];
          label?: string;
          title?: string;
          credits?: number | null;
        }[];
      }[];
    }[];
  }>("program-schedules.json", { schedules: [] });

  const scheduleTemplates: ScheduleTemplate[] = (scheduleFile.schedules ?? []).map((s) => ({
    name: s.name,
    slug: s.slug,
    sourceUrl: s.sourceUrl,
    credits: s.totals?.credits ?? 0,
    terms: s.terms.map((t) => ({
      index: t.index,
      label: t.label,
      season: t.season,
      variant: t.variant ?? null,
      entries: t.entries.map((e) => ({
        kind: (e.kind === "course" || e.kind === "wildcard" ? e.kind : "slot") as
          | "course"
          | "slot"
          | "wildcard",
        codes: e.codes,
        label: e.label,
        title: e.title,
        credits: e.credits ?? null,
      })),
    })),
  }));

  // Which courses the undergraduate half of the catalog actually references —
  // requirement options, codes mentioned in prose, and the four-year
  // schedules. Anything at 500 level outside this set is graduate.
  const referencedByUndergrad = new Set<string>();
  for (const p of deduped) {
    const walk = (groups: RequirementGroup[]) => {
      for (const g of groups) {
        for (const code of g.options) referencedByUndergrad.add(code);
        if (g.subgroups) walk(g.subgroups);
      }
    };
    walk(p.requirements);
    // Deliberately NOT p.mentionedCodes: the accelerated master's pages ("MA
    // Theology 4+1") live under undergraduate programs and name graduate
    // courses in prose, which let 200 of them back in. A requirement OPTION is
    // a claim that an undergraduate can take the course; a prose mention isn't.
  }
  for (const t of scheduleTemplates) {
    for (const term of t.terms) {
      for (const e of term.entries) for (const c of e.codes ?? []) referencedByUndergrad.add(c);
    }
  }
  for (const codes of Object.values(coreCategoryCoursesDraft)) {
    for (const c of codes) referencedByUndergrad.add(c);
  }
  const graduateCourses = markGraduateCourses(courseMap, referencedByUndergrad);

  const freeElectives = markFreeElectives(deduped);
  const coreCategoryCourses = coreCategoryCoursesDraft;

  const referenceCount = deduped.filter((p) => p.type === "reference").length;

  const corePrograms = core
    ? Object.keys(core.degreeRules)
        .map((degreeType) => coreToProgram(core!, degreeType))
        .filter((p): p is Program => p !== null)
    : [];

  const courses = [...courseMap.values()].sort((a, b) => a.code.localeCompare(b.code));

  return {
    catalogYear,
    programs: deduped,
    corePrograms,
    courses,
    informationalCount,
    referenceCount,
    duplicates,
    coreLinked,
    graduateCourses,
    scheduleTemplates,
    coreCategoryCourses,
    graduationRules,
    proseFilled,
    electiveRulesApplied,
    freeElectives,
  };
}
