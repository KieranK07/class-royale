#!/usr/bin/env node
// Scrapes every course description in the catalog — title, credits,
// prerequisites, cross-listings — from the /courses section.
//
//   node scripts/scrape-courses.mjs
//
// Output: data/catalog/<year>/_courses.json
//
// Why this is separate from scrape-catalog.mjs: that one reads PROGRAMS and
// only ever learns about courses that happen to appear in a requirement
// table. This reads the course catalogue itself, so it also covers courses no
// program lists, and it's the only place prerequisites exist.
//
// One request per subject (50), not per course (~1000) — each subject page
// carries every course in that subject in full.

import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BASE, REQUEST_DELAY_MS, fetchHtml, resolveCatalog, sleep } from "./lib/catalog.mjs";

const CODE = /^([A-Z]{2,4})\s+(\d{3}[A-Z]?)\b\s*(.*)$/;
// One subject writes its heading backwards — "435 HDF Seminar" rather than
// "HDF 435 Seminar". Left unhandled, that whole subject scraped as zero
// courses and nothing said so.
const CODE_REVERSED = /^(\d{3}[A-Z]?)\s+([A-Z]{2,4})\b\s*(.*)$/;

async function listSubjects(catalog) {
  const html = await fetchHtml(`${catalog.catalogUrl}/courses`);
  const $ = cheerio.load(html);
  const subjects = new Map();
  $("a[href*='/courses/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const rest = (href.split("/courses/")[1] || "").replace(/\/$/, "");
    if (!rest || rest.includes("/")) return; // a specific course, not a subject
    subjects.set(rest, { slug: rest, name: $(el).text().trim(), url: `${BASE}${href}` });
  });
  return [...subjects.values()];
}

/**
 * Each course on a subject page is an <h2.course-name> followed by sibling
 * blocks until the next one: a .desc with the description, a
 * .sc-credithours, and optionally further .desc blocks whose
 * h3.courseListHeader says what they are ("Prerequisites", "Cross Listed
 * Courses", "Corequisites").
 */
function parseSubjectPage(html, subject, skipped) {
  const $ = cheerio.load(html);
  const main = $("#main");
  main.find(".sc-childlinks, .sc-parentlink, .combinedChild").remove();

  const courses = [];
  main.children("h2.course-name").each((_, el) => {
    const heading = $(el);
    const raw = heading.text().replace(/\s+/g, " ").trim();
    const forward = raw.match(CODE);
    const reversed = forward ? null : raw.match(CODE_REVERSED);
    if (!forward && !reversed) {
      skipped.push(`${subject.slug}: ${raw}`);
      return;
    }
    const m = forward ?? [null, reversed[2], reversed[1], reversed[3]];

    const course = {
      code: `${m[1]} ${m[2]}`,
      title: m[3].trim(),
      credits: null,
      description: "",
      prerequisites: [],
      prerequisiteText: "",
      corequisites: [],
      crossListed: [],
      subject: subject.slug,
    };

    for (let node = heading.next(); node.length && !node.is("h2.course-name"); node = node.next()) {
      if (node.is(".sc-credithours")) {
        const t = node.text().trim();
        // "3", "1-3", "4" — take the first number, keep the raw text when it's a range
        const n = parseFloat(t);
        if (Number.isFinite(n)) course.credits = n;
        if (/[-–]/.test(t)) course.creditsText = t.replace(/\s+/g, " ");
        continue;
      }
      if (!node.is(".desc")) continue;

      const header = node.find("h3.courseListHeader").first().text().trim().toLowerCase();
      const codes = node
        .find("a.sc-courselink")
        .map((__, a) => $(a).text().trim().replace(/\s+/g, " "))
        .get();
      const text = node.text().replace(/\s+/g, " ").trim();

      if (!header) {
        if (!course.description && text) course.description = text;
        continue;
      }
      if (header.startsWith("prereq")) {
        course.prerequisites = codes;
        // The connective words matter: "CSC 141, CSC 171 or CSC 144" is not
        // the same requirement as "CSC 141 and CSC 171". Keep the sentence.
        course.prerequisiteText = text.replace(/^prerequisites?\s*/i, "").trim();
      } else if (header.startsWith("coreq")) {
        course.corequisites = codes;
      } else if (header.includes("cross")) {
        course.crossListed = codes;
      }
    }

    courses.push(course);
  });

  return courses;
}

async function main() {
  const catalog = await resolveCatalog();
  const year = catalog.year;
  console.log(`Catalog resolved live: ${catalog.year} (${catalog.slug})`);
  const subjects = await listSubjects(catalog);
  console.log(`Found ${subjects.length} subject sections\n`);

  const all = [];
  const empty = [];
  const skipped = []; // headings that matched no course-code pattern
  for (const subject of subjects) {
    await sleep(REQUEST_DELAY_MS);
    try {
      const courses = parseSubjectPage(await fetchHtml(subject.url), subject, skipped);
      if (courses.length === 0) empty.push(subject.name);
      all.push(...courses);
      const withPre = courses.filter((c) => c.prerequisites.length > 0).length;
      console.log(`  ${courses.length ? "✓" : "⚠"} ${subject.name.padEnd(46)} ${String(courses.length).padStart(3)} courses, ${withPre} with prerequisites`);
    } catch (err) {
      console.error(`  ✗ ${subject.name}: ${err.message}`);
    }
  }

  // Cross-listed courses are one course under two codes — register both so a
  // transcript showing either matches.
  const byCode = new Map();
  for (const c of all) byCode.set(c.code, c);

  const outDir = path.join("data", "catalog", year);
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "_courses.json");
  await writeFile(
    outFile,
    JSON.stringify(
      { catalogYear: year, count: all.length, courses: all.sort((a, b) => a.code.localeCompare(b.code)) },
      null,
      2
    )
  );

  const withPre = all.filter((c) => c.prerequisites.length > 0).length;
  const withCredits = all.filter((c) => c.credits != null).length;
  console.log(`\n${all.length} courses -> ${outFile}`);
  console.log(`  ${withCredits} have credits, ${withPre} have prerequisites, ${byCode.size} distinct codes`);
  if (empty.length) console.log(`  ${empty.length} subject page(s) yielded nothing: ${empty.join(", ")}`);
  if (skipped.length) {
    console.log(`  ${skipped.length} heading(s) matched no course-code pattern — REVIEW THESE:`);
    for (const s of skipped.slice(0, 20)) console.log(`      ${s}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
