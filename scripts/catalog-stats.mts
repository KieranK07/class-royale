// Prints a health summary of the loaded catalog. Run: npm run stats
import { loadCatalog } from "../src/lib/catalog-server";
import type { RequirementGroup } from "../src/lib/types";

const b = await loadCatalog();
let total = 0,
  unresolved = 0,
  fromNote = 0,
  fromCore = 0,
  withOptions = 0;
const walk = (gs: RequirementGroup[]) => {
  for (const g of gs) {
    total++;
    if (g.unresolved) unresolved++;
    if (g.optionsFromNote) fromNote++;
    if (g.optionsFromCore) fromCore++;
    if (g.options.length > 0) withOptions++;
    if (g.subgroups) walk(g.subgroups);
  }
};
b.programs.forEach((p) => walk(p.requirements));

const byType: Record<string, number> = {};
for (const p of b.programs) byType[p.type] = (byType[p.type] ?? 0) + 1;

console.log(`catalog year        ${b.catalogYear}`);
console.log(`programs            ${b.programs.length}  ${JSON.stringify(byType)}`);
console.log(`courses             ${b.courses.length}`);
console.log(`core variants       ${b.corePrograms.length}`);
console.log(`requirement rows    ${total}`);
console.log(`  with options      ${withOptions}  (${Math.round((withOptions / total) * 100)}%)`);
console.log(`    from Core       ${fromCore}`);
console.log(`    from a note     ${fromNote}`);
console.log(`  UNRESOLVED        ${unresolved}  (${Math.round((unresolved / total) * 100)}%)`);
console.log(`derived data`);
console.log(`  graduation rules  ${b.graduationRules.length}`);
console.log(`  prose programs    ${b.proseFilled} given structured requirements`);
console.log(`  elective rules    ${b.electiveRulesApplied} rows resolved by subject/level rule`);
console.log(`  free electives    ${b.freeElectives} rows (any course counts)`);
console.log(`not-a-program pages ${b.referenceCount} reference, ${b.informationalCount} informational`);
if (b.duplicates.length) console.log(`deduped names       ${b.duplicates.join(", ")}`);
