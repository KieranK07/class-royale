import type { Course, Program, StudentRecord, OverlapAnalysis, RequirementGroup } from "./types";

/** Flatten a program's requirement tree into a list of groups. */
export function flattenGroups(program: Program): RequirementGroup[] {
  const out: RequirementGroup[] = [];
  const walk = (groups: RequirementGroup[]) => {
    for (const g of groups) {
      out.push(g);
      if (g.subgroups) walk(g.subgroups);
    }
  };
  walk(program.requirements);
  return out;
}

/**
 * The courses a program *forces* you to take — only groups where there is
 * no choice (every option must be taken to reach `count`).
 *
 * This distinction is the whole ballgame. A group's `options` are
 * ALTERNATIVES, not a checklist: "2 courses from these 21" is not the same
 * as "these 21 courses." Treating options as required is what makes a
 * degree audit claim you need 21 natural science courses for a 2-course
 * Core requirement.
 */
export function forcedCourses(program: Program): Set<string> {
  const forced = new Set<string>();
  for (const g of flattenGroups(program)) {
    if (g.unit !== "courses") continue;
    if (g.options.length > 0 && g.options.length <= g.count) {
      // No choice available — all of them are required.
      g.options.forEach((c) => forced.add(c));
    }
  }
  return forced;
}

/** Average credits across a group's options, for estimating unknown picks. */
function estimateCredits(
  group: RequirementGroup,
  catalog: Map<string, Course>,
  fallback = 3
): number {
  const known = group.options
    .map((c) => catalog.get(c)?.credits)
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (known.length === 0) return fallback;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

/**
 * How much of one requirement group a set of courses satisfies, capped at
 * what the group actually asks for. Taking three courses from a
 * "choose two" pool satisfies two, not three.
 */
function satisfiedBy(
  group: RequirementGroup,
  have: Set<string>,
  catalog: Map<string, Course>,
  consumed?: Set<string>
): { amount: number; used: string[] } {
  // A course can only be spent once. The Cybersecurity Minor has THREE
  // separate "3 credits of upper-level CSC/SFE" slots drawing on the same
  // 22-course pool — without tracking consumption, one CSC 310 satisfied all
  // three and the minor looked one course away instead of three.
  const pool = group.freeElective ? [...have] : group.options;
  const matches = pool.filter((c) => have.has(c) && !consumed?.has(c));
  if (group.unit === "credits") {
    let total = 0;
    const used: string[] = [];
    for (const code of matches) {
      if (total >= group.count) break;
      total += catalog.get(code)?.credits ?? 0;
      used.push(code);
    }
    used.forEach((c) => consumed?.add(c));
    return { amount: Math.min(total, group.count), used };
  }
  const used = matches.slice(0, group.count);
  used.forEach((c) => consumed?.add(c));
  return { amount: used.length, used };
}

/**
 * Allocate scarce courses to the requirements that need them most.
 * A group with one acceptable course must claim it before a broad elective
 * pool does, or the elective eats the only course that could satisfy the
 * specific requirement.
 */
function byScarcity(groups: RequirementGroup[]): RequirementGroup[] {
  return [...groups].sort((a, b) => (a.options.length || 1e9) - (b.options.length || 1e9));
}

/**
 * "Free major" analysis: for a candidate program the student hasn't
 * declared, how much of it is already covered by (a) courses they've
 * completed, and (b) courses their declared programs force them to take
 * anyway (so those courses "buy" progress on the candidate for free).
 *
 * Only *forced* courses from declared programs count toward (b) — where a
 * declared program leaves a choice, we can't assume the student will pick
 * the one that happens to also serve the candidate.
 */
export function computeOverlap(
  candidate: Program,
  record: StudentRecord,
  declaredPrograms: Program[],
  catalog: Map<string, Course>
): OverlapAnalysis {
  const completed = new Set(
    record.completedCourses.filter((c) => !c.inProgress).map((c) => c.code)
  );
  const planned = new Set<string>();
  for (const p of declaredPrograms) {
    for (const code of forcedCourses(p)) {
      if (!completed.has(code)) planned.add(code);
    }
  }

  const overlappingCompleted: string[] = [];
  const overlappingWithDeclared: string[] = [];
  let netNewCoursesNeeded = 0;
  let netNewCreditsNeeded = 0;

  // Each course may be spent on at most one requirement of this program.
  const spent = new Set<string>();

  for (const group of byScarcity(flattenGroups(candidate))) {
    const fromCompleted = satisfiedBy(group, completed, catalog, spent);
    overlappingCompleted.push(...fromCompleted.used);

    let remaining = group.count - fromCompleted.amount;
    if (remaining <= 0) continue;

    // What's left of this group that the declared programs already cover.
    const stillOpen: RequirementGroup = {
      ...group,
      count: remaining,
      options: group.options.filter((c) => !completed.has(c)),
    };
    const fromPlanned = satisfiedBy(stillOpen, planned, catalog, spent);
    overlappingWithDeclared.push(...fromPlanned.used);
    remaining -= fromPlanned.amount;
    if (remaining <= 0) continue;

    if (group.unit === "credits") {
      netNewCreditsNeeded += remaining;
      netNewCoursesNeeded += Math.ceil(remaining / estimateCredits(group, catalog));
    } else {
      netNewCoursesNeeded += remaining;
      netNewCreditsNeeded += remaining * estimateCredits(group, catalog);
    }
  }

  return {
    program: candidate,
    overlappingCompleted: [...new Set(overlappingCompleted)],
    overlappingWithDeclared: [...new Set(overlappingWithDeclared)],
    netNewCoursesNeeded,
    netNewCreditsNeeded: Math.round(netNewCreditsNeeded * 10) / 10,
  };
}

/** Rank candidate programs by how "free" they are, cheapest add-on first. */
export function rankByFreeness(
  candidates: Program[],
  record: StudentRecord,
  declaredPrograms: Program[],
  catalog: Map<string, Course>
): OverlapAnalysis[] {
  return candidates
    .map((c) => computeOverlap(c, record, declaredPrograms, catalog))
    .sort(
      (a, b) =>
        a.netNewCreditsNeeded - b.netNewCreditsNeeded ||
        a.netNewCoursesNeeded - b.netNewCoursesNeeded
    );
}
