import { loadCatalog } from "@/lib/catalog-server";
import { Explorer } from "@/components/Explorer";
import type { Course, Program, RequirementGroup } from "@/lib/types";

/**
 * Trim the catalogue before it crosses to the browser.
 *
 * Two things were making the page 1.4MB:
 *
 * 1. Full course descriptions (~450KB) that nothing in the UI renders. They
 *    stay server-side for future search.
 * 2. Massive duplication in requirement options. 61% of all option entries
 *    belong to rows that were EXPANDED from a rule — the same 21 Natural
 *    Science course codes repeated across 187 different "Theology Core"-style
 *    rows, and 3,034 more entries expanded from subject/level rules. Sending
 *    the rule and expanding in the browser costs a few bytes instead.
 */
function forClient(c: Course): Course {
  return {
    code: c.code,
    title: c.title,
    credits: c.credits,
    prerequisites: c.prerequisites,
    prerequisiteText: c.prerequisiteText,
    crossListed: c.crossListed,
    tags: c.tags,
    level: c.level,
  };
}

function trimGroup(g: RequirementGroup): RequirementGroup {
  const out: RequirementGroup = { ...g };
  // Derivable from coreCategories or subjectRule — don't ship the expansion.
  if (g.optionsFromCore || g.subjectRule) out.options = [];
  if (g.subgroups) out.subgroups = g.subgroups.map(trimGroup);
  return out;
}

function trimProgram(p: Program): Program {
  return { ...p, requirements: p.requirements.map(trimGroup) };
}

export default async function Home() {
  const {
    programs,
    corePrograms,
    courses,
    catalogYear,
    graduationRules,
    coreCategoryCourses,
    scheduleTemplates,
  } = await loadCatalog();

  return (
    <main className="flex-1">
      <Explorer
        programs={programs.map(trimProgram)}
        corePrograms={corePrograms}
        courses={courses.map(forClient)}
        catalogYear={catalogYear}
        graduationRules={graduationRules}
        coreCategoryCourses={coreCategoryCourses}
        scheduleTemplates={scheduleTemplates}
      />
    </main>
  );
}
