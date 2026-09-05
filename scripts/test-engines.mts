// Tests for the requirement engines. Run: npm run test:engines
//
// These exist because the two worst bugs in this project so far were both in
// here and both silent: options treated as a checklist rather than
// alternatives (claiming you need 21 Natural Science courses for a 2-course
// requirement), and one course satisfying several requirements at once
// (making a minor look one course away when it was three). Neither showed up
// as an error — they showed up as plausible wrong numbers.

import { computeProgress } from "../src/lib/progress";
import { computeOverlap, rankByFreeness, forcedCourses } from "../src/lib/overlap";
import { nextSteps, prerequisitesMet } from "../src/lib/planner";
import { sameAcademicArea } from "../src/lib/catalog-data";
import type { Course, Program, RequirementGroup, StudentRecord } from "../src/lib/types";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
};

const course = (code: string, credits = 3, extra: Partial<Course> = {}): Course => ({
  code,
  title: code,
  credits,
  ...extra,
});

const catalog = new Map<string, Course>(
  [
    course("CSC 141"), course("CSC 142"), course("CSC 310"), course("CSC 344"),
    course("CSC 400"), course("SFE 330"), course("SFE 364"), course("SFE 365"),
    course("BIO 101", 4), course("BIO 102", 4), course("THE 101"), course("THE 110"),
    course("MTH 161", 4),
  ].map((c) => [c.code, c])
);

const group = (g: Partial<RequirementGroup> & { id: string }): RequirementGroup => ({
  label: g.id,
  count: 1,
  unit: "courses",
  options: [],
  ...g,
});

const program = (id: string, requirements: RequirementGroup[]): Program => ({
  id,
  name: id,
  type: "major",
  requirements,
});

const record = (codes: string[], inProgress: string[] = []): StudentRecord => ({
  completedCourses: [
    ...codes.map((code) => ({ code, term: "x", creditsEarned: catalog.get(code)?.credits ?? 3 })),
    ...inProgress.map((code) => ({ code, term: "x", creditsEarned: 0, inProgress: true })),
  ],
});

console.log("--- options are ALTERNATIVES, not a checklist ---");
{
  // "pick 1 of these 3" is one requirement, not three.
  const p = program("p", [group({ id: "g", count: 1, options: ["THE 101", "THE 110", "CSC 141"] })]);
  const done = computeProgress(p, record(["THE 101"]), catalog);
  check("one of three satisfies it", done.remainingGroups.length, 0);
  check("taking two doesn't over-satisfy", computeProgress(p, record(["THE 101", "THE 110"]), catalog).satisfiedGroups[0].satisfiedBy.length, 1);
}

console.log("\n--- a course is spent once ---");
{
  // Three separate 3-credit electives drawing on the same pool.
  const p = program("p", [
    group({ id: "e1", count: 3, unit: "credits", options: ["CSC 310", "CSC 344", "CSC 400"] }),
    group({ id: "e2", count: 3, unit: "credits", options: ["CSC 310", "CSC 344", "CSC 400"] }),
    group({ id: "e3", count: 3, unit: "credits", options: ["CSC 310", "CSC 344", "CSC 400"] }),
  ]);
  check("one course satisfies exactly one slot", computeProgress(p, record(["CSC 310"]), catalog).remainingGroups.length, 2);
  check("three courses satisfy all three", computeProgress(p, record(["CSC 310", "CSC 344", "CSC 400"]), catalog).remainingGroups.length, 0);
}

console.log("\n--- scarce requirements claim their course first ---");
{
  // CSC 310 is the ONLY thing that satisfies "specific"; the elective pool
  // must not absorb it and leave "specific" unsatisfiable.
  const p = program("p", [
    group({ id: "elective", count: 3, unit: "credits", options: ["CSC 310", "CSC 344", "CSC 400"] }),
    group({ id: "specific", count: 1, options: ["CSC 310"] }),
  ]);
  const r = computeProgress(p, record(["CSC 310"]), catalog);
  check("specific requirement is the one satisfied", r.remainingGroups.map((g) => g.groupId), ["elective"]);
}

console.log("\n--- in-progress courses don't count as done ---");
{
  const p = program("p", [group({ id: "g", options: ["CSC 141"] })]);
  check("enrolled is not earned", computeProgress(p, record([], ["CSC 141"]), catalog).remainingGroups.length, 1);
}

console.log("\n--- free electives ---");
{
  const p = program("p", [group({ id: "free", count: 3, unit: "credits", options: [], freeElective: true })]);
  check("any course satisfies a free elective", computeProgress(p, record(["BIO 101"]), catalog).remainingGroups.length, 0);
  check("unsatisfied with nothing taken", computeProgress(p, record([]), catalog).remainingGroups.length, 1);
}

console.log("\n--- overlap: only FORCED courses count as free ---");
{
  const major = program("major", [
    group({ id: "m1", options: ["CSC 310"] }),                       // forced
    group({ id: "m2", count: 1, options: ["THE 101", "THE 110"] }),  // a choice
  ]);
  check("forced excludes choices", [...forcedCourses(major)].sort(), ["CSC 310"]);

  const minor = program("minor", [
    group({ id: "x", options: ["CSC 310"] }),
    group({ id: "y", options: ["THE 101"] }),
  ]);
  const o = computeOverlap(minor, record([]), [major], catalog);
  check("forced major course is free", o.overlappingWithDeclared, ["CSC 310"]);
  check("the THE 101 choice is NOT assumed", o.netNewCoursesNeeded, 1);
}

console.log("\n--- overlap: a 21-option pool needs 2, not 21 ---");
{
  const pool = ["BIO 101", "BIO 102", "CSC 141", "CSC 142", "MTH 161"];
  const minor = program("minor", [group({ id: "nsc", count: 2, options: pool })]);
  const o = computeOverlap(minor, record([]), [], catalog);
  check("needs its count, not its options", o.netNewCoursesNeeded, 2);
}

console.log("\n--- ranking ---");
{
  const cheap = program("cheap", [group({ id: "a", options: ["CSC 141"] })]);
  const dear = program("dear", [
    group({ id: "b", options: ["CSC 310"] }),
    group({ id: "c", options: ["CSC 344"] }),
    group({ id: "d", options: ["CSC 400"] }),
  ]);
  const ranked = rankByFreeness([dear, cheap], record([]), [], catalog);
  check("cheapest first", ranked.map((r) => r.program.id), ["cheap", "dear"]);
}

console.log("\n--- prerequisites read the sentence, not the list ---");
{
  const anyOf = course("X", 3, { prerequisites: ["CSC 141", "CSC 142"], prerequisiteText: "CSC 141 or CSC 142" });
  const allOf = course("Y", 3, { prerequisites: ["CSC 141", "CSC 142"], prerequisiteText: "CSC 141 and CSC 142" });
  check("'or' is satisfied by one", prerequisitesMet(anyOf, new Set(["CSC 141"])).met, true);
  check("'and' is not satisfied by one", prerequisitesMet(allOf, new Set(["CSC 141"])).met, false);
  check("'and' is satisfied by both", prerequisitesMet(allOf, new Set(["CSC 141", "CSC 142"])).met, true);
  check("no prerequisites is null, not true", prerequisitesMet(course("Z"), new Set()).met, null);
  check("missing are reported", prerequisitesMet(allOf, new Set(["CSC 141"])).missing, ["CSC 142"]);
}

console.log("\n--- planner ---");
{
  const blocked = course("CSC 400", 3, { prerequisites: ["CSC 344"], prerequisiteText: "CSC 344" });
  const cat = new Map(catalog);
  cat.set("CSC 400", blocked);

  const p = program("p", [
    group({ id: "specific", count: 1, options: ["CSC 400"] }),
    group({ id: "broad", count: 1, options: ["BIO 101", "BIO 102", "CSC 141", "CSC 142", "MTH 161"] }),
  ]);
  const prog = computeProgress(p, record([]), cat);
  const groups = new Map(p.requirements.map((g) => [g.id, g]));
  const { ready, blocked: blockedList } = nextSteps([prog], groups, new Set(), new Set(), cat);

  check("unmet prerequisite is blocked, not ready", ready.some((c) => c.code === "CSC 400"), false);
  check("and is listed as blocked", blockedList.some((c) => c.code === "CSC 400"), true);
  check("scarce requirement outranks a broad pool", ready[0].satisfies[0], "broad");
  check("broad pool is capped, not dumped", ready.length <= 3, true);
}

console.log("\n--- a minor must be a SECOND academic area ---");
{
  const same = (a: string, b: string) => sameAcademicArea(a, b);
  check("CS major blocks CS minor",
    same("Computer Science, Bachelor of Science", "Computer Science Minor"), true);
  check("CS concentration blocks CS minor",
    same("Computer Science (Cybersecurity Concentration), Bachelor of Science", "Computer Science Minor"), true);
  check("Biology concentration blocks Biology minor",
    same("Biology Pre-Health Concentration, Bachelor of Science", "Biology Minor"), true);
  check("Spanish major blocks Spanish minor",
    same("Spanish, Bachelor of Arts", "Spanish Minor"), true);
  // Department is too coarse to be the test: Engineering holds nine majors
  // and three minors, and these are genuinely different areas.
  check("Mechanical Engineering allows Cybersecurity minor",
    same("Mechanical Engineering, Bachelor of Science", "Cybersecurity Minor"), false);
  check("Theology allows Franciscan Studies minor",
    same("Theology, Bachelor of Arts", "Franciscan Studies Minor"), false);
  check("CS allows Mathematical Science minor",
    same("Computer Science, Bachelor of Science", "Mathematical Science Minor"), false);

  // A concentration names a sub-area. Dropping the parenthetical reduced this
  // to "computer science", so a Cybersecurity-concentration student was being
  // offered a Cybersecurity minor as their top recommendation.
  check("Cybersecurity concentration blocks Cybersecurity minor",
    same("Computer Science (Cybersecurity Concentration), Bachelor of Science", "Cybersecurity Minor"), true);
  check("plain CS still ALLOWS Cybersecurity minor",
    same("Computer Science, Bachelor of Science", "Cybersecurity Minor"), false);
  check("SFE cyber concentration blocks Cybersecurity minor",
    same("Software Engineering Cybersecurity Concentration, Bachelor of Science", "Cybersecurity Minor"), true);
  check("Film Studies concentration blocks Film Studies minor",
    same("Communication Arts (Film Studies), Bachelor of Arts", "Film Studies Minor"), true);
  check("licensure track still blocks its own subject",
    same("English with AYA Licensure: (British and American Literature Concentration), Bachelor of Arts", "British and American Literature Minor"), true);
  check("stemming matches Mathematics to Mathematical Science",
    same("Mathematics with AYA Math Licensure, Bachelor of Science", "Mathematical Science Minor"), true);
  check("Associate degree form parses",
    same("Associate of Arts Degree in Philosophy", "Philosophy Minor"), true);
  check("Theatre concentration allows Communication Arts minor",
    same("Theatre (Performance Concentration), Bachelor of Arts", "Communication Arts Minor"), false);

  // Explicit exception: the minor's extra word "Catholic" breaks containment,
  // but the concentration forces 6 of its 8 named requirements. Scoped to the
  // concentration only — the plain major forces just 2 of 8, so there the
  // minor is a real second area.
  check("Youth Ministry concentration blocks Catholic Youth Ministry minor",
    same("Catechetics and Evangelization with Youth Ministry Concentration, Bachelor of Arts",
         "Catholic Youth Ministry Minor"), true);
  check("plain Catechetics still ALLOWS Catholic Youth Ministry minor",
    same("Catechetics and Evangelization, Bachelor of Arts", "Catholic Youth Ministry Minor"), false);
  check("the exception doesn't leak to other Catechetics minors",
    same("Catechetics and Evangelization with Youth Ministry Concentration, Bachelor of Arts",
         "Evangelization Minor"), true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
