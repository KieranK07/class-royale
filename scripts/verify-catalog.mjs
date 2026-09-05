#!/usr/bin/env node
// Independent cross-check of the scraped catalog against the live pages.
//
//   node scripts/verify-catalog.mjs
//
// This deliberately does NOT reuse scrape-catalog.mjs's parsing. It re-reads
// every program page with a separate, much dumber implementation — "collect
// every course link in every section that isn't a year schedule" — and
// compares that set against what actually landed in data/catalog/. Reusing
// the scraper's own logic would just reproduce its bugs and agree with
// itself.
//
// What it catches: courses on the page that never made it into any
// requirement, and courses in the data that aren't on the page.

import * as cheerio from "cheerio";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fetchHtml, REQUEST_DELAY_MS, sleep } from "./lib/catalog.mjs";

function isYearSchedule(heading) {
  return (
    /^(freshman|sophomore|junior|senior|first|second|third|fourth)[\s-]*(year|semester)/i.test(heading) ||
    /^summer session/i.test(heading)
  );
}

/**
 * Every course code on the page, split by whether it sits in a year-schedule
 * section. Scoped to .programTables (the whole requirements area) rather than
 * #degreeRequirements, because several pages put option-list notes OUTSIDE
 * the requirements block. Site navigation chrome is stripped first so
 * "related programs" links don't count as requirements.
 */
function codesOnPage($) {
  const area = $(".programTables");
  if (area.length === 0) return { required: new Set(), schedule: new Set() };
  area.find(".sc-childlinks, .sc-parentlink, .combinedChild").remove();

  const required = new Set();
  const schedule = new Set();

  // Codes inside #degreeRequirements are attributed to their h3 section.
  const container = area.find("#degreeRequirements");
  let heading = "";
  container.children().each((_, n) => {
    const el = $(n);
    if (el.is("h3.sc-RequiredCoursesHeading1")) {
      heading = el.text().trim().replace(/\s+/g, " ");
      return;
    }
    const target = isYearSchedule(heading) ? schedule : required;
    el.find("a.sc-courselink").each((__, a) => {
      const code = $(a).text().trim().replace(/\s+/g, " ");
      if (code) target.add(code);
    });
  });

  // Anything else in .programTables is a note beside the requirements.
  area.find("a.sc-courselink").each((_, a) => {
    const link = $(a);
    if (link.closest("#degreeRequirements").length > 0) return;
    const code = link.text().trim().replace(/\s+/g, " ");
    if (code) required.add(code);
  });

  return { required, schedule };
}

/** Every course code the scraper actually stored for a program. */
function codesInData(program) {
  const out = new Set();
  for (const r of program.requirements) for (const c of r.options) out.add(c);
  for (const s of program.slots) for (const c of s.codes) out.add(c);
  // Codes captured from prose notes count as captured — they're stored and
  // shown, just not as structured requirement options.
  for (const n of program.notes || []) for (const c of n.codes) out.add(c);
  return out;
}

async function main() {
  const root = path.join("data", "catalog");
  const years = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const year = years.at(-1);
  const dir = path.join(root, year);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));

  const programs = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    for (const p of d.programs) programs.push({ ...p, department: d.department });
  }

  console.log(`Cross-checking ${programs.length} programs against ${year} live pages...\n`);

  const problems = [];
  let checked = 0;

  for (const program of programs) {
    if (program.kind !== "tables") continue; // prose pages have no table to reconcile
    await sleep(REQUEST_DELAY_MS);
    let $;
    try {
      $ = cheerio.load(await fetchHtml(program.sourceUrl));
    } catch (err) {
      problems.push({ program, kind: "fetch-failed", detail: err.message });
      continue;
    }
    checked++;

    const onPage = codesOnPage($);
    const inData = codesInData(program);

    // Programs read off the schedule legitimately include schedule courses.
    const expected = program.requirementsFromSchedule
      ? new Set([...onPage.required, ...onPage.schedule])
      : onPage.required;

    const missing = [...expected].filter((c) => !inData.has(c));
    const extra = [...inData].filter((c) => !expected.has(c));

    if (missing.length || extra.length) {
      problems.push({ program, kind: "mismatch", missing, extra });
    }
    if (checked % 25 === 0) process.stdout.write(`${checked} `);
  }

  console.log(`\n\nChecked ${checked} table-based programs.`);
  if (problems.length === 0) {
    console.log("No discrepancies. Every course link on every page is accounted for.");
    return;
  }

  console.log(`${problems.length} program(s) with discrepancies:\n`);
  for (const p of problems) {
    console.log(`  ${p.program.department} / ${p.program.name}`);
    if (p.kind === "fetch-failed") {
      console.log(`    fetch failed: ${p.detail}`);
      continue;
    }
    if (p.missing.length) console.log(`    ON PAGE BUT NOT CAPTURED (${p.missing.length}): ${p.missing.join(", ")}`);
    if (p.extra.length) console.log(`    IN DATA BUT NOT ON PAGE (${p.extra.length}): ${p.extra.join(", ")}`);
    console.log(`    ${p.program.sourceUrl}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
