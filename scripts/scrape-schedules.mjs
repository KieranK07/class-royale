#!/usr/bin/env node
// Recovers the catalog's own semester-by-semester schedules.
//
//   node scripts/scrape-schedules.mjs [--limit N] [--only <slug>]
//
// Output: data/derived/program-schedules.json
//
// Every program page carries a suggested four-year layout —
//
//   <h3>Freshman Year</h3>
//     <h4>First Semester</h4>  <table> CSC 142 … CSC 144 … MTH 161 … </table>
//     <h4>Second Semester</h4> <table> … </table>
//
// — and scrape-catalog.mjs deliberately throws all ~229 of them away, because
// re-reading those tables would double-count requirements that the page has
// already listed properly elsewhere. That's the right call for a degree audit
// and the wrong one for a planner: the schedule is the only place the catalog
// says WHEN, and when is the entire question a student asks about scheduling.
//
// So this reads the same pages for the opposite half. Requirements come from
// scrape-catalog; sequence comes from here; nothing is counted twice because
// the two outputs are never merged — a plan is laid out from this and then
// checked against the requirements from there.
//
// What comes out is a template, not a claim: the department's intended path
// through the degree. A student's real plan is this, minus what they've
// already done, shifted to fit.

import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REQUEST_DELAY_MS,
  fetchHtml,
  listDepartments,
  listPrograms,
  resolveCatalog,
  sleep,
} from "./lib/catalog.mjs";
import {
  classifyEntry,
  creditProblems,
  orderTerms,
  termVariant,
  termWithinYear,
  yearNumber,
} from "./lib/plan.mjs";

/** Reads the course rows under one semester heading. */
function parseTermTables($, heading) {
  const entries = [];
  let statedCredits = null;

  heading.nextUntil("h3, h4").each((_, node) => {
    const el = $(node);
    const tables = el.is("table") ? [el] : el.find("table").toArray().map((t) => $(t));
    for (const table of tables) {
      table.find("tr").each((__, tr) => {
        const row = $(tr);
        const numberCell = row.find("td.sc-coursenumber");
        const titleCell = row.find("td.sc-coursetitle");
        const creditText = row.find("td.sc-credits p.credits").text().trim();

        // Cross-listed rows put the second code in a <span class="crossListed">,
        // so collecting every link in the cell keeps them together as one course.
        const codes = numberCell
          .find("a.sc-courselink")
          .map((___, a) => $(a).text().trim().replace(/\s+/g, " "))
          .get()
          .filter(Boolean);

        const rawCode = numberCell.text().trim().replace(/\s+/g, " ");
        const rawTitle = titleCell.text().trim().replace(/\s+/g, " ");
        if (!rawCode && !rawTitle && !codes.length) return;

        // A credits-only row is the term's own total, not a course.
        if (!rawCode && !rawTitle && creditText) {
          statedCredits = parseFloat(creditText);
          return;
        }

        // "OR" / "and" separator rows sit between alternatives and are not
        // requirements themselves — the same trap scrape-catalog.mjs hit.
        if (!codes.length && /^(or|and)$/i.test(rawTitle || rawCode)) return;

        const entry = classifyEntry(rawCode, rawTitle, codes);
        if (!entry) return;
        const credits = creditText ? parseFloat(creditText) : null;
        entries.push({
          ...entry,
          // A credits cell that isn't a number ("TBD", "3-4") must not become
          // NaN and poison every total downstream.
          credits: Number.isFinite(credits) ? credits : null,
          creditsText: credits != null && !Number.isFinite(credits) ? creditText : undefined,
        });
      });
    }
  });

  return { entries, statedCredits };
}

/**
 * Pulls every year/semester block off a program page.
 *
 * Year headings are h3 and semester headings h4, but not every page nests
 * them that way — some list a year with a single unlabeled table. Anything
 * that doesn't resolve to a year is skipped rather than guessed at.
 */
function parseSchedule(html) {
  const $ = cheerio.load(html);
  const terms = [];

  $("h3").each((_, el) => {
    const yearHeading = $(el);
    const year = yearNumber(yearHeading.text());
    if (year == null) return;

    // Semester sub-headings between this year and the next.
    const semesterHeadings = yearHeading.nextUntil("h3", "h4").toArray();

    if (semesterHeadings.length === 0) {
      // A year with no semester split: take it whole rather than inventing
      // a division the page doesn't state.
      const { entries, statedCredits } = parseTermTables($, yearHeading);
      if (entries.length) {
        terms.push({
          year,
          within: 1,
          kind: "year",
          label: yearHeading.text().trim().replace(/\s+/g, " "),
          entries,
          statedCredits,
        });
      }
      return;
    }

    for (const h of semesterHeadings) {
      const heading = $(h);
      const label = heading.text().trim().replace(/\s+/g, " ");
      const within = termWithinYear(label);
      if (within == null) continue;

      const { entries, statedCredits } = parseTermTables($, heading);
      if (entries.length === 0) continue;

      terms.push({
        year,
        within: typeof within === "number" ? within : 1,
        kind: typeof within === "number" ? "semester" : within,
        label,
        // Set when the year branches into named tracks — these terms are
        // alternatives to each other, not a longer year.
        variant: termVariant(label),
        entries,
        statedCredits,
      });
    }
  });

  // How many term headings the page actually shows, so the caller can tell
  // "this program has no schedule" apart from "we failed to read one".
  let headingsSeen = 0;
  $("h3").each((_, el) => {
    if (yearNumber($(el).text()) == null) return;
    const subs = $(el).nextUntil("h3", "h4").toArray();
    if (subs.length) {
      headingsSeen += subs.length;
      return;
    }
    // A bare year heading only counts if it actually has a table under it —
    // some pages repeat a year heading with nothing beneath, and counting
    // those would report loss where there's nothing to lose.
    const hasTable = $(el)
      .nextUntil("h3, h4")
      .toArray()
      .some((n) => $(n).is("table") || $(n).find("table").length > 0);
    if (hasTable) headingsSeen += 1;
  });

  return { terms: orderTerms(terms), headingsSeen };
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  const catalog = await resolveCatalog();
  const catalogYear = catalog.year;
  console.log(
    `Catalog resolved live: ${catalog.year} (${catalog.slug}) — programs under /${catalog.programsPath}`
  );

  const departments = await listDepartments(catalog);
  console.log(`${departments.length} departments`);

  const schedules = [];
  const withoutSchedule = [];
  const problems = [];
  let fetched = 0;

  for (const dept of departments) {
    await sleep(REQUEST_DELAY_MS);
    let programs;
    try {
      programs = await listPrograms(catalog, dept);
    } catch (err) {
      console.log(`  ${dept.name}: couldn't list programs (${err.message})`);
      continue;
    }

    for (const program of programs) {
      if (only && program.slug !== only) continue;
      if (fetched >= limit) break;
      await sleep(REQUEST_DELAY_MS);
      fetched++;

      let html;
      try {
        html = await fetchHtml(program.url);
      } catch (err) {
        console.log(`  ${program.name}: fetch failed (${err.message})`);
        continue;
      }

      const { terms, headingsSeen } = parseSchedule(html);
      if (terms.length < headingsSeen) {
        problems.push(
          `${program.name}: page shows ${headingsSeen} term headings but only ${terms.length} parsed`
        );
      }
      if (terms.length === 0) {
        withoutSchedule.push({ department: dept.name, name: program.name, slug: program.slug });
        continue;
      }

      const bad = creditProblems(terms);
      problems.push(...bad.map((b) => `${program.name}: ${b}`));

      const courses = terms.flatMap((t) => t.entries.filter((e) => e.kind === "course"));
      const slots = terms.flatMap((t) => t.entries.filter((e) => e.kind !== "course"));
      const credits = terms.reduce(
        (n, t) => n + t.entries.reduce((m, e) => m + (e.credits ?? 0), 0),
        0
      );

      schedules.push({
        department: dept.name,
        departmentSlug: dept.slug,
        name: program.name,
        slug: program.slug,
        sourceUrl: program.url,
        catalogYear,
        terms,
        totals: { terms: terms.length, courses: courses.length, slots: slots.length, credits },
      });

      console.log(
        `  ${program.name.slice(0, 52).padEnd(52)} ${String(terms.length).padStart(2)} terms  ` +
          `${String(courses.length).padStart(3)} courses  ${String(slots.length).padStart(2)} slots  ${credits} cr`
      );
    }
    if (fetched >= limit) break;
  }

  const outDir = path.join("data", "derived");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "program-schedules.json");
  await writeFile(
    outFile,
    JSON.stringify(
      {
        catalogYear,
        note:
          "The catalog's suggested year-by-year schedule per program. A template for planning — " +
          "the department's intended path, not a statement of what will be offered.",
        schedules,
        withoutSchedule,
      },
      null,
      2
    )
  );

  console.log(
    `\n${schedules.length} programs with a schedule, ${withoutSchedule.length} without.\nWrote ${outFile}`
  );
  if (problems.length) {
    console.log(`\n${problems.length} credit mismatches:`);
    for (const p of problems.slice(0, 20)) console.log(`  ! ${p}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
