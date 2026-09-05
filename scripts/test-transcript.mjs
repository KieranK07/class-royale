import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { parseTranscript, earnedCourses, inProgressCourses, parseCourseCell } from "../src/lib/transcript.ts";

const html = readFileSync(new URL("../src/lib/__fixtures__/transcript.html", import.meta.url), "utf8");
const { document } = parseHTML(html);
const data = parseTranscript(document);

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
};

console.log("--- course cell parsing ---");
check("plain section", parseCourseCell("CSC 145 A"), { code: "CSC 145", section: "A" });
check("hybrid mode", parseCourseCell("ECO 201 HY B"), { code: "ECO 201", section: "HY B" });
check("multi-token section", parseCourseCell("CHM 116 M L"), { code: "CHM 116", section: "M L" });
check("no section (transfer)", parseCourseCell("CSC 141"), { code: "CSC 141", section: null });
check("garbage", parseCourseCell("Term Totals:"), null);

console.log("\n--- terms ---");
check("term count", data.terms.length, 4);
check("term labels", data.terms.map(t => t.label), ["Fall 2026", "Spring 2026", "Fall 2025", "Transfer Year/Term"]);
check("honors bounded to own term", data.terms.map(t => t.honors.length), [0, 1, 1, 0]);
check("spring honors", data.terms[1].honors, ["DEAN'S LIST"]);

console.log("\n--- courses ---");
check("total courses (totals rows excluded)", data.courses.length, 12);
check("no totals rows leaked", data.courses.filter(c => /Totals/.test(c.code)).length, 0);
check("earned excludes WIP", earnedCourses(data).length, 9);
check("in-progress count", inProgressCourses(data).length, 3);
check("transfer flagged", data.courses.filter(c => c.isTransfer).map(c => c.code), ["CSC 141", "MTH 160"]);
check("codes normalized", data.courses.slice(0, 3).map(c => c.code), ["CSC 261", "CHM 116", "SFE 240"]);
check("section preserved", data.courses[1].section, "M L");
check("credits earned read", data.courses.find(c => c.code === "MTH 172").creditsEarned, 4);
check("W grade earns nothing", data.courses.find(c => c.code === "HST 105").creditsEarned, 0);
check("P grade counts as earned", earnedCourses(data).some(c => c.code === "PHL 113"), true);

console.log("\n--- totals ---");
check("summary keys", Object.keys(data.summary), ["Transfer", "Local", "Career"]);
check("career gpa", data.summary.Career.gpa, 3.8);
check("transfer earned", data.summary.Transfer.earnedCredits, 6);
check("term totals parsed", data.terms[1].termTotals.earnedCredits, 10);

console.log("\n--- warnings ---");
check("unknown grade warns", data.warnings.filter(w => w.includes("ZZ")).length, 1);
check("no other warnings", data.warnings.length, 1);
if (data.warnings.length) console.log("        " + data.warnings.join("\n        "));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
