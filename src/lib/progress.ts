import type { Course, Program, RequirementGroup, StudentRecord, ProgramProgress } from "./types";
import { flattenGroups } from "./overlap";

/** Completed course codes -> credits earned. In-progress courses excluded. */
function completedMap(record: StudentRecord): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of record.completedCourses) {
    if (c.inProgress) continue; // only count finished courses toward progress
    map.set(c.code, c.creditsEarned);
  }
  return map;
}

function courseCredits(code: string, catalog: Map<string, Course>): number {
  return catalog.get(code)?.credits ?? 0;
}

/**
 * How much of one group the student has satisfied.
 *
 * Two things this has to get right:
 *  - `options` are ALTERNATIVES. Satisfaction is capped at `count`: taking
 *    three courses from a "choose two" pool satisfies two, not three.
 *  - Credit-unit groups (unresolved elective slots) count credits, not
 *    course rows.
 */
function evaluateGroup(
  group: RequirementGroup,
  completed: Map<string, number>,
  catalog: Map<string, Course>,
  consumed: Set<string>
): { satisfiedBy: string[]; satisfiedAmount: number; stillNeeded: number; eligibleOptions: string[] } {
  // A free elective is satisfied by ANY course the student hasn't already
  // spent on a specific requirement.
  const matchingOptions = group.freeElective
    ? [...completed.keys()]
    : group.options.length > 0
      ? group.options
      : Array.from(catalog.values())
          .filter((c) => group.tags?.some((t) => c.tags?.includes(t)))
          .map((c) => c.code);

  // A course can only be spent once across a program's requirements —
  // otherwise one upper-level elective satisfies every elective slot at once.
  const matches = matchingOptions.filter((code) => completed.has(code) && !consumed.has(code));

  let satisfiedBy: string[] = [];
  let satisfiedAmount = 0;
  if (group.unit === "credits") {
    for (const code of matches) {
      if (satisfiedAmount >= group.count) break;
      satisfiedAmount += completed.get(code) ?? courseCredits(code, catalog);
      satisfiedBy.push(code);
    }
    satisfiedAmount = Math.min(satisfiedAmount, group.count);
  } else {
    satisfiedBy = matches.slice(0, group.count);
    satisfiedAmount = satisfiedBy.length;
  }

  satisfiedBy.forEach((c) => consumed.add(c));

  return {
    satisfiedBy,
    satisfiedAmount,
    stillNeeded: Math.max(0, group.count - satisfiedAmount),
    eligibleOptions: matchingOptions.filter((code) => !completed.has(code)),
  };
}

export function computeProgress(
  program: Program,
  record: StudentRecord,
  catalog: Map<string, Course>
): ProgramProgress {
  const completed = completedMap(record);
  const satisfiedGroups: ProgramProgress["satisfiedGroups"] = [];
  const remainingGroups: ProgramProgress["remainingGroups"] = [];

  // Credits are counted against THIS program's requirements only — a
  // student's unrelated electives shouldn't inflate their major progress.
  let creditsCompleted = 0;
  let creditsRequired = 0;

  // Most-constrained first: a requirement with one acceptable course must
  // claim it before a broad elective pool absorbs it.
  const ordered = [...flattenGroups(program)].sort(
    (a, b) => (a.options.length || 1e9) - (b.options.length || 1e9)
  );
  const consumed = new Set<string>();

  for (const group of ordered) {
    const { satisfiedBy, satisfiedAmount, stillNeeded, eligibleOptions } = evaluateGroup(
      group,
      completed,
      catalog,
      consumed
    );
    satisfiedGroups.push({ groupId: group.id, satisfiedBy });
    if (stillNeeded > 0) {
      remainingGroups.push({
        groupId: group.id,
        label: group.label,
        stillNeeded,
        unit: group.unit,
        eligibleOptions,
      });
    }

    if (group.unit === "credits") {
      creditsRequired += group.count;
      creditsCompleted += satisfiedAmount;
    } else {
      // Estimate credits for course-count groups from what was actually
      // taken, falling back to the options' catalog credits.
      const per =
        satisfiedBy.length > 0
          ? satisfiedBy.reduce((s, c) => s + (completed.get(c) ?? 0), 0) / satisfiedBy.length
          : group.options.map((c) => courseCredits(c, catalog)).find((n) => n > 0) ?? 3;
      creditsRequired += group.count * per;
      creditsCompleted += satisfiedAmount * per;
    }
  }

  const totalCredits = program.totalCreditsRequired ?? Math.round(creditsRequired);
  const creditsRemaining = Math.max(0, totalCredits - creditsCompleted);
  const percentComplete =
    totalCredits > 0 ? Math.min(100, Math.round((creditsCompleted / totalCredits) * 100)) : 0;

  return {
    program,
    satisfiedGroups,
    remainingGroups,
    creditsCompleted: Math.round(creditsCompleted * 10) / 10,
    creditsRemaining: Math.round(creditsRemaining * 10) / 10,
    percentComplete,
  };
}

/**
 * Which specific courses each requirement claims — for display.
 *
 * The UI must not work this out per-row. Two "Natural Science Core" rows
 * drawing on the same 21-course pool would each independently claim the one
 * CHM 111 the student is taking, so the page shows a course being spent twice
 * while the maths correctly spends it once. Same allocation, one source.
 */
export function allocateCourses(
  program: Program,
  done: Set<string>,
  inProgress: Set<string>,
  catalog: Map<string, Course>
): { satisfied: Map<string, string[]>; inProgress: Map<string, string[]> } {
  const ordered = [...flattenGroups(program)].sort(
    (a, b) => (a.options.length || 1e9) - (b.options.length || 1e9)
  );

  const claim = (pool: Set<string>, spent: Set<string>) => {
    const out = new Map<string, string[]>();
    for (const g of ordered) {
      const options = g.freeElective ? [...pool] : g.options;
      const matches = options.filter((c) => pool.has(c) && !spent.has(c));
      let taken: string[];
      if (g.unit === "credits") {
        taken = [];
        let total = 0;
        for (const c of matches) {
          if (total >= g.count) break;
          total += catalog.get(c)?.credits ?? 0;
          taken.push(c);
        }
      } else {
        taken = matches.slice(0, g.count);
      }
      taken.forEach((c) => spent.add(c));
      out.set(g.id, taken);
    }
    return out;
  };

  const spent = new Set<string>();
  const satisfied = claim(done, spent);
  // In-progress courses are allocated against what's still outstanding, so a
  // requirement already met by a finished course doesn't also claim one
  // you're currently sitting in.
  const inProgressMap = claim(inProgress, spent);
  return { satisfied, inProgress: inProgressMap };
}
