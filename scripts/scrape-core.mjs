#!/usr/bin/env node
// Scrapes Franciscan's university-wide Core Curriculum — the ~42-45 credits
// every undergraduate takes regardless of major.
//
//   node scripts/scrape-core.mjs
//
// Output: data/catalog/<catalog-year>/_core-curriculum.json
//
// Why this is a separate script from scrape-catalog.mjs: the Core lives
// outside /academic-programs/ entirely (it's under
// degree-requirements-and-graduation/), it's the same for every student, and
// it has a different shape — ten "pick N from this list" category pools
// rather than a list of specific required courses. Per-program pages don't
// contain it; they only show it incidentally, mixed into an illustrative
// year-by-year schedule that would double-count if parsed.
//
// NOTHING here is hardcoded from a one-time reading of the page: the catalog
// year, the category list, the eligible courses, and the per-degree rules
// (how many courses from which categories) are all parsed live on every run.
// The rule sentences are prose, so they get a self-check — see
// parseDegreeRule below.

import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchHtml, resolveCatalog } from "./lib/catalog.mjs";

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** "American Founding Principles Core (AFP):" -> { code: "AFP", label: "American Founding Principles" } */
function parseCategoryHeading(text) {
  const clean = text.trim().replace(/:\s*$/, "");
  const m = clean.match(/^(.*?)\s*Core\s*\(([A-Z]{2,4})\)$/);
  if (!m) return { code: null, label: clean };
  return { code: m[2], label: m[1].trim() };
}

/**
 * Reads the ten Core category tables. Each category is a pool of eligible
 * courses ("pick N of these"), not a list of required ones.
 */
function parseCategories($) {
  const categories = [];
  $("#degreeRequirements h3.sc-RequiredCoursesHeading1").each((_, el) => {
    const heading = $(el);
    const { code, label } = parseCategoryHeading(heading.text());
    const options = [];
    const notes = [];

    heading.nextUntil("h3.sc-RequiredCoursesHeading1").each((__, node) => {
      const n = $(node);
      if (!n.is("table")) {
        // loose <div>s between tables carry eligibility caveats, e.g.
        // "HCC 404: HCC majors only." / "BIO 150: EDU, HDFS, & SWK majors only"
        const t = n.text().replace(/\s+/g, " ").trim();
        if (t) notes.push(t);
        return;
      }
      n.find("tr").each((___, tr) => {
        const row = $(tr);
        const codes = row
          .find("td.sc-coursenumber a.sc-courselink")
          .map((____, a) => $(a).text().trim().replace(/\s+/g, " "))
          .get();
        if (codes.length === 0) return;
        const title = row.find("td.sc-coursetitle").text().trim().replace(/\s+/g, " ");
        const creditsText = row.find("td.sc-credits p.credits").text().trim();
        options.push({
          codes, // >1 means cross-listed, e.g. ["MTH 204", "PSY 204"] — either satisfies it
          title,
          credits: creditsText ? parseFloat(creditsText) : null,
        });
      });
    });

    if (!code) {
      throw new Error(
        `Core category heading didn't match the expected "<Name> Core (<CODE>):" form: ${JSON.stringify(
          heading.text().trim()
        )} — the page's markup may have changed.`
      );
    }
    categories.push({ code, label, options, notes });
  });
  return categories;
}

/**
 * Turns one prose rule sentence into structured requirements.
 *
 * The per-degree rules are only ever stated as English on this page, e.g.:
 *
 *   "Bachelor of Arts students are required to complete one American
 *    founding principles course, one Catholic traditions in fine arts
 *    course, one history course, two literature courses, either one math or
 *    one economics course, two natural science courses, three philosophy
 *    courses, one social science course, and three theology courses for a
 *    total of 45 core curriculum credits plus complete the intermediate
 *    foreign language requirement."
 *
 * Note what that sentence does that a flat per-category count can't express:
 * "either one math OR one economics course" spans two categories, and the BS
 * rule has "five philosophy AND theology courses" — one pool drawn from two
 * categories. So each parsed rule carries a list of category codes rather
 * than a single one.
 *
 * Parsing English is inherently fragile, so this does NOT trust itself: it
 * cross-checks the course count it derived against the credit total stated
 * in the same sentence (every Core course is 3 credits). If the catalog
 * rewrites these sentences, the check fails loudly at scrape time instead of
 * silently producing a wrong degree audit.
 */
function parseDegreeRule(sentence, categories) {
  const matchCategory = (phrase) => {
    const p = phrase.toLowerCase().trim();
    const hit = categories.find((c) => {
      const label = c.label.toLowerCase();
      return label === p || label.startsWith(p) || p.startsWith(label) || c.code.toLowerCase() === p;
    });
    if (!hit) {
      throw new Error(
        `Couldn't match "${phrase}" to any Core category (have: ${categories
          .map((c) => c.label)
          .join(", ")}) — the rule sentence or the category list has changed.`
      );
    }
    return hit.code;
  };

  // Everything between "complete" and either "for a total of" or the end.
  const listMatch = sentence.match(/complete\s+(?:\d+\s+credits[^:]*:\s*)?(.*?)(?:\s+for a total of|\.$|$)/i);
  if (!listMatch) throw new Error(`Couldn't find a requirement list in: ${sentence}`);

  const rules = [];
  for (let chunk of listMatch[1].split(",")) {
    chunk = chunk.trim().replace(/^and\s+/i, "").replace(/^either\s+/i, "").replace(/\.$/, "");
    if (!chunk) continue;

    // "one literature course (ENG 211)" — the parenthetical names the only
    // course that satisfies it, which is real information and also breaks a
    // match anchored on the sentence ending in "course". Take it out, keep it.
    const only = [...chunk.matchAll(/\(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/[A-Z]{2,4}\s?\d{3}[A-Z]?/g)].map((c) => c[0].replace(/\s+/g, " ")));
    chunk = chunk.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    // "two literature courses" / "one math or one economics course" /
    // "five philosophy and theology courses" / "one theology core"
    const m = chunk.match(/^(\w+)\s+(.*?)\s*(?:courses?|core)$/i);
    if (!m) continue; // trailing prose like "plus complete the intermediate foreign language requirement"
    const count = NUMBER_WORDS[m[1].toLowerCase()];
    if (!count) continue;

    // "math or one economics" -> ["math", "economics"]; "philosophy and theology" -> both
    const phrases = m[2]
      .split(/\s+(?:or|and)\s+/i)
      .map((p) => p.replace(/^\w+\s+(?=\w)/, (lead) => (NUMBER_WORDS[lead.trim().toLowerCase()] ? "" : lead)))
      .map((p) => p.trim())
      .filter(Boolean);

    rules.push({
      count,
      unit: "courses",
      categories: phrases.map(matchCategory),
      // Named outright by the sentence — "one literature course (ENG 211)"
      // is not a free choice from the Literature category.
      ...(only.length ? { onlyCourses: only } : {}),
      text: chunk,
    });
  }

  const statedCredits = sentence.match(/(\d+)\s+(?:core curriculum\s+)?credits/i);
  const totalCredits = statedCredits ? parseInt(statedCredits[1], 10) : null;
  const derivedCourses = rules.reduce((n, r) => n + r.count, 0);

  // Self-check: every Core course on this page is 3 credits.
  if (totalCredits !== null && derivedCourses * 3 !== totalCredits) {
    throw new Error(
      `Rule parse failed its own sanity check: parsed ${derivedCourses} courses (= ${
        derivedCourses * 3
      } credits) but the sentence says ${totalCredits} credits.\n  Sentence: ${sentence}\n  Parsed: ${JSON.stringify(
        rules.map((r) => r.text)
      )}\nThe catalog's wording has probably changed — fix parseDegreeRule rather than trusting this output.`
    );
  }

  const extras = [];
  if (/foreign language/i.test(sentence)) extras.push("intermediate foreign language requirement");

  return { totalCredits, rules, alsoRequires: extras, sourceSentence: sentence };
}

function degreeTypeOf(sentence) {
  if (/^Bachelor of Arts/i.test(sentence)) return "BA";
  if (/^Bachelor of Science/i.test(sentence)) return "BS";
  if (/^Associate of Arts and Associate of Science/i.test(sentence)) return "AA/AS";
  return null;
}

async function main() {
  const catalog = await resolveCatalog();
  const catalogYear = catalog.year;
  console.log(`Catalog resolved live: ${catalog.year} (${catalog.slug})`);

  const url = `${catalog.catalogUrl}/degree-requirements-and-graduation/core-curriculum-requirements`;
  console.log(`Fetching ${url}`);
  const $ = cheerio.load(await fetchHtml(url));

  const categories = parseCategories($);
  if (categories.length === 0) {
    throw new Error("No Core categories found — the page structure has changed.");
  }
  console.log(`Found ${categories.length} Core categories:`);
  for (const c of categories) {
    console.log(`  ${c.code.padEnd(4)} ${c.label.padEnd(36)} ${String(c.options.length).padStart(2)} eligible courses`);
  }

  // The per-degree rules are <p> blocks inside the requirements container.
  //
  // They used to carry class="sc-BodyText" and the 2026-2027 page dropped it,
  // which made a selector keyed to the class find nothing — the sentences were
  // there, unchanged, wearing different markup. Selecting every paragraph and
  // classifying by what it SAYS keeps the parse tied to the content instead of
  // to a stylesheet.
  const byDegree = {};
  const unmatchedProse = [];

  // Several paragraphs open with "Bachelor of Arts…" and only one of them is
  // the degree rule. The others are category notes ("Bachelor of Arts majors
  // are required to complete ENG 210 and ENG 211"), and because they start
  // the same way, taking the last match silently replaced the real rule with
  // an empty parse — three degrees reporting `null credits` and no rules,
  // which the credit self-check cannot catch because there is no total left
  // to check against.
  //
  // So every candidate is parsed and the best one wins: a sentence that
  // states its own credit total and yields the most requirements is the rule;
  // anything less is prose that happens to start with a degree name.
  const candidates = {};
  $(".programTables p").each((_, el) => {
    const sentence = $(el).text().replace(/\s+/g, " ").trim();
    if (!sentence) return;
    const type = degreeTypeOf(sentence);
    if (!type) {
      unmatchedProse.push(sentence);
      return;
    }
    let parsed;
    try {
      parsed = parseDegreeRule(sentence, categories);
    } catch (err) {
      // A candidate that fails its own sanity check is not the rule — but if
      // NOTHING better turns up, the error must still surface, so keep it.
      (candidates[type] ??= []).push({ error: err, score: -1, sentence });
      return;
    }
    const score = (parsed.totalCredits != null ? 1000 : 0) + parsed.rules.length;
    (candidates[type] ??= []).push({ parsed, score, sentence });
  });

  for (const [type, list] of Object.entries(candidates)) {
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.error) throw best.error;
    if (best.score < 1000) {
      throw new Error(
        `The ${type} rule sentence no longer states a credit total, so it can't be checked:\n  ${best.sentence}`
      );
    }
    byDegree[type] = best.parsed;
    // Anything else that looked like a rule is a note; keep it visible rather
    // than discarding it silently.
    for (const other of list) {
      if (other !== best && other.sentence) unmatchedProse.push(other.sentence);
    }
  }

  for (const expected of ["BA", "BS", "AA/AS"]) {
    if (!byDegree[expected]) {
      throw new Error(
        `No Core rule sentence found for ${expected} — the page normally states one for each of BA, BS and AA/AS. Structure has changed.`
      );
    }
  }

  console.log(`\nPer-degree rules (each verified against its own stated credit total):`);
  for (const [type, rule] of Object.entries(byDegree)) {
    const summary = rule.rules.map((r) => `${r.count}×${r.categories.join("/")}`).join(" ");
    console.log(`  ${type.padEnd(6)} ${String(rule.totalCredits).padStart(2)} credits  ${summary}`);
    if (rule.alsoRequires.length) console.log(`         plus: ${rule.alsoRequires.join("; ")}`);
  }

  const outDir = path.join("data", "catalog", catalogYear);
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "_core-curriculum.json");
  await writeFile(
    outFile,
    JSON.stringify({ catalogYear, sourceUrl: url, categories, degreeRules: byDegree, unmatchedProse }, null, 2)
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
