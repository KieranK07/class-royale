#!/usr/bin/env node
// Parses the department program guides — the advisor handouts that lay a
// degree out semester by semester.
//
//   node scripts/parse-program-guides.mjs [file.xlsx ...]
//
// Default input: every .xlsx in data/program-guides/
// Output:        data/derived/program-guides.json
//
// Why these matter more than they look. The catalog says WHAT a degree
// requires; it never says WHEN. These guides say when, and that carries three
// things nothing else we scrape has:
//
//   1. Which season a course is expected in. Semesters run First..Eighth, so
//      odd ones are Falls and even ones are Springs. That's a Fall/Spring
//      answer available with no login, no extension and no live portal — the
//      thing the section sync goes to great lengths to get.
//   2. A canonical ORDER. Prerequisites give a partial order; the guide
//      commits to a total one, including for courses with no prerequisite
//      relationship at all.
//   3. A credit rhythm — 13 to 17 a term — which is what makes a generated
//      plan look like something an advisor would sign.
//
// What it is NOT: a statement of fact about offerings. It's the department's
// plan. A course in an odd semester is one they INTEND to teach in the fall.
// Live section data outranks it, so everything here is emitted as a hint with
// its source attached rather than as a claim.
//
// Nothing about the layout is hardcoded to these two files: the semester
// columns, the year blocks and the footnotes are all located by what they say.

import ExcelJS from "exceljs";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ORDINALS = [
  "first", "second", "third", "fourth",
  "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth",
];

/** "Fifth Semester [3]" -> 5 */
function semesterNumber(text) {
  const m = String(text).toLowerCase().match(/^\s*(\w+)\s+semester/);
  if (!m) return null;
  const i = ORDINALS.indexOf(m[1]);
  return i === -1 ? null : i + 1;
}

/**
 * Odd semesters are falls, even ones springs.
 *
 * This is the one inference in the file, and it's the guide's own convention
 * rather than ours: a plan that starts in the fall and runs eight consecutive
 * terms can't mean anything else. It's recorded as `seasonSource: "position"`
 * so a consumer can tell it apart from something stated outright.
 */
function seasonOf(semester) {
  return semester % 2 === 1 ? "Fall" : "Spring";
}

/** A real course code, e.g. "CSC 144", "MTH/CSC 330", "PHY 225". */
const COURSE_CODE = /^([A-Z]{2,4})(?:\s*\/\s*([A-Z]{2,4}))?\s*(\d{3}[A-Z]?)$/;

/** How far below the last course a block's credit total may sit. */
const MAX_BLANK_ROWS = 4;

/** A wildcard slot the guide leaves open, e.g. "CSC 39x", "SFE 36x". */
const WILDCARD = /^([A-Z]{2,4})\s*(\d{1,2})x{1,2}$/i;

function classifyEntry(rawCode, rawTitle) {
  const code = String(rawCode ?? "").replace(/\s+/g, " ").trim();
  const title = String(rawTitle ?? "").replace(/\s+/g, " ").trim();
  if (!code) return null;

  const footnotes = [...title.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const cleanTitle = title.replace(/\s*\[\d+\]/g, "").trim();

  const exact = code.match(COURSE_CODE);
  if (exact) {
    // "MTH/CSC 330" is one course under two codes — either satisfies it.
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

  // Everything else is a requirement slot the student fills: "THE/PHL 3",
  // "Nat Sc Core 1", "Elective 2", "Stats Elective", "ART core".
  return { kind: "slot", label: code, title: cleanTitle, footnotes };
}

/** Reads a sheet into rows of trimmed strings, 1-indexed by column. */
function sheetGrid(ws) {
  const grid = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const v = cell.value;
      const text =
        v == null ? "" : typeof v === "object" && v.richText
          ? v.richText.map((r) => r.text).join("")
          : typeof v === "object" && "result" in v
            ? String(v.result ?? "")
            : String(v);
      cells[colNumber] = text.replace(/\s+/g, " ").trim();
    });
    grid[rowNumber] = cells;
  });
  return grid;
}

function parseSheet(ws) {
  const grid = sheetGrid(ws);
  const name = ws.name.trim();

  // The title is the first non-empty cell that isn't structural.
  let title = "";
  for (const row of grid) {
    if (!row) continue;
    const first = row.find((c) => c);
    if (!first) continue;
    if (/year$/i.test(first) || semesterNumber(first)) break;
    title = first;
    break;
  }

  const semesters = [];
  const footnotes = {};
  let currentYear = null;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];

    for (let c = 1; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;

      const yearMatch = cell.match(/^(Freshman|Sophomore|Junior|Senior|Fifth)\s+Year$/i);
      if (yearMatch) {
        currentYear = yearMatch[1];
        continue;
      }

      const num = semesterNumber(cell);
      if (num == null) continue;
      // Semester headers are merged cells ("C8:E8"), and a merged value can be
      // reported once per covered column. One block per semester.
      if (semesters.some((s) => s.semester === num)) continue;

      // The header sits above its own three columns — code, title, credits —
      // and two of these blocks sit side by side across the sheet.
      const entries = [];
      let stated = null;
      let blankRun = 0;
      for (let rr = r + 1; rr < grid.length; rr++) {
        const line = grid[rr] ?? [];
        const code = line[c] ?? "";
        const titleCell = line[c + 1] ?? "";
        const credit = line[c + 2] ?? "";

        // The block ends with its own credit total: a number alone in the
        // credits column, with no course beside it.
        if (!code && !titleCell && /^\d+(\.\d+)?$/.test(credit)) {
          stated = Number(credit);
          break;
        }
        // Or with the next structural heading, if a total is ever missing.
        if (semesterNumber(code) != null || /year$/i.test(code)) break;

        if (!code && !titleCell) {
          // Blocks are ragged and the total can sit two or three rows below
          // the last course, so a run of blanks is normal. Give up only after
          // enough of them that we're clearly past the block.
          if (++blankRun > MAX_BLANK_ROWS) break;
          continue;
        }
        blankRun = 0;

        const entry = classifyEntry(code, titleCell);
        if (!entry) continue;
        const credits = /^\d+(\.\d+)?$/.test(credit) ? Number(credit) : null;
        entries.push({ ...entry, credits });
      }

      if (entries.length === 0) continue;
      semesters.push({
        semester: num,
        year: currentYear,
        season: seasonOf(num),
        seasonSource: "position",
        entries,
        statedCredits: stated,
        credits: entries.reduce((n, e) => n + (e.credits ?? 0), 0),
      });
    }

    // Footnotes: "[1] CSC/SFE Elective: Any CSC/SFE 2x or above course ..."
    for (const cell of row) {
      if (!cell) continue;
      const fn = cell.match(/^\[(\d+)\]\s*(.+)$/);
      if (fn) footnotes[fn[1]] = fn[2].trim();
    }
  }

  semesters.sort((a, b) => a.semester - b.semester);
  const totalCredits = semesters.reduce((n, s) => n + (s.statedCredits ?? s.credits), 0);

  return { sheet: name, title, semesters, footnotes, totalCredits };
}

/**
 * Self-check, in the same spirit as the Core scraper: the guide states its own
 * per-semester totals, so the entries we parsed have to add up to them. If a
 * row is dropped or a credit column is misread, this catches it here rather
 * than producing a plan that's quietly a course short.
 */
function checkPlan(plan) {
  const problems = [];
  for (const s of plan.semesters) {
    if (s.statedCredits == null) {
      problems.push(`semester ${s.semester}: no stated credit total to check against`);
      continue;
    }
    if (Math.abs(s.credits - s.statedCredits) > 0.001) {
      problems.push(
        `semester ${s.semester}: entries add to ${s.credits} but the guide says ${s.statedCredits}`
      );
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = path.join("data", "program-guides");
  const files = args.length
    ? args
    : (await readdir(dir))
        .filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$"))
        .map((f) => path.join(dir, f));

  if (files.length === 0) {
    throw new Error(
      `No program guides found. Put the department .xlsx guides in ${dir}/ or pass paths as arguments.`
    );
  }

  const plans = [];
  let problemCount = 0;

  for (const file of files) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    console.log(`\n${path.basename(file)}`);

    for (const ws of wb.worksheets) {
      const plan = parseSheet(ws);
      if (plan.semesters.length === 0) {
        console.log(`  ${ws.name.padEnd(18)} no semester blocks found — skipped`);
        continue;
      }
      const problems = checkPlan(plan);
      problemCount += problems.length;

      const courses = plan.semesters.flatMap((s) => s.entries.filter((e) => e.kind === "course"));
      const slots = plan.semesters.flatMap((s) => s.entries.filter((e) => e.kind !== "course"));
      console.log(
        `  ${ws.name.padEnd(18)} ${String(plan.semesters.length).padStart(2)} semesters  ` +
          `${String(courses.length).padStart(3)} named courses  ${String(slots.length).padStart(2)} open slots  ` +
          `${plan.totalCredits} credits`
      );
      for (const p of problems) console.log(`      ! ${p}`);

      plans.push({ ...plan, sourceFile: path.basename(file) });
    }
  }

  // Which season each named course sits in, across every plan. A course in
  // both is taught both; a course in only one is the interesting case.
  const seasons = {};
  for (const plan of plans) {
    for (const s of plan.semesters) {
      for (const e of s.entries) {
        if (e.kind !== "course") continue;
        for (const code of e.codes) {
          const rec = (seasons[code] ??= { seasons: [], plans: [] });
          if (!rec.seasons.includes(s.season)) rec.seasons.push(s.season);
          const where = `${plan.sheet} sem ${s.semester}`;
          if (!rec.plans.includes(where)) rec.plans.push(where);
        }
      }
    }
  }
  for (const rec of Object.values(seasons)) rec.seasons.sort().reverse(); // Fall before Spring

  const fallOnly = Object.entries(seasons).filter(([, v]) => v.seasons.join() === "Fall");
  const springOnly = Object.entries(seasons).filter(([, v]) => v.seasons.join() === "Spring");
  const both = Object.entries(seasons).filter(([, v]) => v.seasons.length === 2);

  console.log(
    `\n${Object.keys(seasons).length} distinct courses across ${plans.length} plans:  ` +
      `${fallOnly.length} fall-only  ${springOnly.length} spring-only  ${both.length} both`
  );

  const outDir = path.join("data", "derived");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "program-guides.json");
  await writeFile(
    outFile,
    JSON.stringify(
      {
        generatedFrom: files.map((f) => path.basename(f)),
        note:
          "Department program guides — the intended sequence, not a statement of what is offered. " +
          "Live section data outranks these hints.",
        plans,
        seasonHints: seasons,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${outFile}`);

  if (problemCount > 0) {
    console.error(
      `\n${problemCount} semester(s) didn't match the guide's own credit totals. ` +
        `Fix the parser rather than trusting this output.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
