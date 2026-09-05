import { checkPrerequisites } from "./prereq";
import type { Course, ProgramProgress, RequirementGroup } from "./types";

export interface Candidate {
  code: string;
  title: string;
  credits: number;
  /** Requirement labels this course would satisfy */
  satisfies: string[];
  /**
   * How hard the requirements it clears are to fill by other means. A course
   * that is the ONLY way to satisfy something scores far above one of 21
   * interchangeable Core options.
   */
  scarcity: number;
  prerequisiteText?: string;
  /** null when the course lists no prerequisites */
  prereqsMet: boolean | null;
  /** Prerequisite codes the student hasn't completed */
  missingPrereqs: string[];
}

/**
 * Are a course's prerequisites satisfied?
 *
 * The code list alone is ambiguous — "CSC 141, CSC 171 or CSC 144" and
 * "CSC 141 and CSC 171" scrape to similar lists but mean different things.
 * So the connective in the catalog's own sentence decides: an "or" anywhere
 * means any one of the listed courses suffices, otherwise all are required.
 * The raw sentence travels with the result so a student can check the call
 * rather than take our word for it.
 */
export function prerequisitesMet(
  course: Course,
  completed: Set<string>,
  earnedCredits?: number
): { met: boolean | null; missing: string[] } {
  if ((course.prerequisites ?? []).length === 0 && !course.prerequisiteText) {
    return { met: null, missing: [] };
  }
  // One reading of the sentence, shared with the degree planner — see
  // prereq.ts for why two different wrong readings used to live side by side.
  const result = checkPrerequisites(course.prerequisiteText, course.prerequisites, {
    completed,
    earnedCredits,
  });
  // "unknown" is a condition we can't check (permission of instructor, a
  // standing we don't know). Surfacing it as "not met" would hide courses a
  // student can in fact register for, so it reads as null: no verdict.
  if (result.met === "unknown") return { met: null, missing: result.missing };
  return { met: result.met, missing: result.missing };
}


/**
 * Courses that would move a student forward right now: they satisfy something
 * still outstanding, and nothing blocks enrolling in them.
 *
 * This is the question the old system answers worst — it can tell you what
 * you're missing, but not which of the 40 courses that could fill those gaps
 * you're actually eligible for this semester.
 */
export function nextSteps(
  progressList: ProgramProgress[],
  groupsById: Map<string, RequirementGroup>,
  completed: Set<string>,
  inProgress: Set<string>,
  catalog: Map<string, Course>,
  limit = 24
): { ready: Candidate[]; blocked: Candidate[] } {
  const byCode = new Map<string, Candidate>();

  for (const progress of progressList) {
    for (const remaining of progress.remainingGroups) {
      const group = groupsById.get(remaining.groupId);
      // A free elective is satisfied by anything, so it can't recommend
      // anything in particular — skip it rather than suggesting all 1005.
      if (group?.freeElective) continue;

      for (const code of remaining.eligibleOptions) {
        if (completed.has(code) || inProgress.has(code)) continue;
        const course = catalog.get(code);
        if (!course) continue;

        const alternatives = Math.max(1, remaining.eligibleOptions.length);
        const existing = byCode.get(code);
        if (existing) {
          if (!existing.satisfies.includes(remaining.label)) {
            existing.satisfies.push(remaining.label);
            existing.scarcity += 1 / alternatives;
          }
          continue;
        }
        const { met, missing } = prerequisitesMet(course, completed);
        byCode.set(code, {
          code,
          title: course.title,
          credits: course.credits,
          satisfies: [remaining.label],
          scarcity: 1 / alternatives,
          prerequisiteText: course.prerequisiteText,
          prereqsMet: met,
          missingPrereqs: missing,
        });
      }
    }
  }

  const all = [...byCode.values()];

  // Rank by how irreplaceable a course is, not by how many boxes it ticks.
  // Twenty-one Natural Science options all "cover 2 requirements" and would
  // otherwise bury CSC 265, the only course that satisfies its own
  // requirement — exactly the one a student needs to plan around.
  const rank = (a: Candidate, b: Candidate) =>
    b.scarcity - a.scarcity || b.satisfies.length - a.satisfies.length || a.code.localeCompare(b.code);

  /**
   * Show at most a few options per requirement. A student choosing a Natural
   * Science course needs to see that the requirement exists and a sample of
   * what fills it — not all twenty-one, which crowds out every other
   * requirement on the list.
   */
  const diversify = (list: Candidate[], perRequirement = 3) => {
    const shown = new Map<string, number>();
    const out: Candidate[] = [];
    for (const c of list) {
      const key = c.satisfies[0] ?? c.code;
      const n = shown.get(key) ?? 0;
      if (n >= perRequirement) continue;
      shown.set(key, n + 1);
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  };

  return {
    ready: diversify(all.filter((c) => c.prereqsMet !== false).sort(rank)),
    blocked: diversify(all.filter((c) => c.prereqsMet === false).sort(rank)),
  };
}
