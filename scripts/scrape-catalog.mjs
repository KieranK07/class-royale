#!/usr/bin/env node
// Scrapes Franciscan's public course catalog (franciscan.smartcatalogiq.com)
// into structured Program/RequirementGroup JSON (see src/lib/types.ts).
//
// No login needed — this is the public catalog:
//
//   npm install
//   node scripts/scrape-catalog.mjs
//
// Output goes to data/catalog/<catalog-year>/*.json, written incrementally
// as it goes (one file per department) so a crashed/interrupted run can
// just be re-run — already-scraped departments are skipped unless you pass
// --force. A full crawl is ~180 requests at 400ms apart, so about 2 minutes.
//
// This covers major/minor/concentration requirements only. The university-
// wide Core Curriculum lives outside /academic-programs/ and has its own
// script: scripts/scrape-core.mjs.
//
// Ground truth for the parsing logic below is the committed real HTML in
// scripts/__fixtures__/ — one page of each shape the catalog uses, plus the
// two regression cases that caught earlier parser bugs. See
// docs/scraping-notes.md.

import * as cheerio from "cheerio";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import {
  REQUEST_DELAY_MS,
  sleep,
  fetchHtml,
  listDepartments,
  listPrograms,
  resolveCatalog,
} from "./lib/catalog.mjs";

const FORCE = process.argv.includes("--force");

/** Normalizes a requirement/note label for matching: "Marketing Electives (2)" -> "marketingelective" */
function normalizeLabel(text) {
  return text
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\boptions?\b/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/s$/, "");
}

/**
 * Does this note actually enumerate the options for a requirement, as
 * opposed to just mentioning a course in passing?
 *
 * Being strict matters in the wrong direction here: binding a note that
 * merely says "Elective: BUS 400 Internship may be applied for here" would
 * narrow a free elective down to exactly one course. So a note only counts
 * as an option list if it says so AND names more than one course.
 */
function isOptionList(note) {
  return (
    note.codes.length >= 2 &&
    /options?:|one of the following|any of the following|complete one of|choose|select/i.test(note.text)
  );
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * "Freshman Year", "Sophomore Year", "Summer Session",
 * "Second-Year-Varies-by-Discipline" — the suggested schedule, which
 * re-lists courses required elsewhere. Never parsed as requirements.
 */
function isYearScheduleHeading(heading) {
  return (
    /^(freshman|sophomore|junior|senior|first|second|third|fourth)[\s-]*(year|semester)/i.test(heading) ||
    /^summer session/i.test(heading)
  );
}

const CHOICE_MARKER = /of the following|from the following|from the (?:essential )?list|from:|\bfrom\b|of these|elective/i;

/**
 * Reads a count out of a section heading that states a choice.
 * Verified against every distinct heading in the catalog:
 *
 *   "One of the following:"                              -> 1 course
 *   "Any three of the following courses:"                -> 3 courses
 *   "Plus one of the following not used above:"          -> 1 course
 *   "Choose one of the following Psychology electives:"  -> 1 course
 *   "Three additional upper level film courses from:"    -> 3 courses
 *   "Six additional credits ... from the following ..."  -> 6 credits
 *   "(18 credit hours):"                                 -> 18 credits
 *
 * Returns null when the heading states no count — the caller then treats
 * every row as required, which is the safe reading.
 */
function parseChoiceHeading(heading) {
  if (!heading) return null;
  const NUM = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
  const numbers = [...heading.matchAll(NUM)];
  if (numbers.length === 0) return null;

  const first = numbers[0];
  const count = /^\d+$/.test(first[1]) ? parseInt(first[1], 10) : NUMBER_WORDS[first[1].toLowerCase()];
  if (!count) return null;

  // The unit belongs to the number it's ATTACHED to, not to the heading as a
  // whole. "3 of these 4 required and 9 credits in other anthropology
  // courses" means three COURSES — reading the stray "credits" as this
  // number's unit turns a 3-course requirement into a 3-credit one.
  const after = heading.slice(first.index + first[0].length, first.index + first[0].length + 24);
  const isCredits = /^\s+(?:additional\s+)?credit/i.test(after);

  if (isCredits) return { count, unit: "credits" };
  if (CHOICE_MARKER.test(heading)) return { count, unit: "courses" };
  return null;
}

/** A heading stating more than one number can't be captured by one group. */
function headingHasExtraRequirement(heading) {
  const NUM = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
  return [...heading.matchAll(NUM)].length > 1;
}

/**
 * A heading that reads like it states a choice but didn't yield a count.
 * Guessing here would be worse than not guessing — a wrong count silently
 * changes a degree audit — so these get reported for review instead.
 */
function looksLikeChoiceButUnparsed(heading) {
  return /elective|choose|select|following|additional|\bfrom\b/i.test(heading);
}

/**
 * Pulls the readable prose out of a page region, one block element per
 * entry, in document order. Used for the catalog's narrative-format pages
 * (see `kind` on the parser's return value) where there's no table to read.
 * Only leaf-level block elements are collected, so a <p> nested inside a
 * <div> isn't counted twice.
 */
function collectNarrative($, root) {
  const blocks = [];
  root.find("p, li, h2, h3, h4, h5, td").each((_, el) => {
    const node = $(el);
    // skip containers whose text is really their children's text
    if (node.find("p, li, h2, h3, h4, h5, td").length > 0) return;
    const text = node.text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (blocks[blocks.length - 1] === text) return; // collapse exact repeats
    blocks.push(text);
  });
  return blocks;
}

/**
 * Finds course codes written inline in prose ("SPN 201 and SPN 202", "BIO
 * 106 is excluded"). `knownPrefixes` is a Set of real subject prefixes
 * gathered from the table-based programs in this same run — passed in
 * rather than hardcoded, so this stays correct if the university adds or
 * retires a subject. Without it the bare regex happily matches things like
 * "GPA 300" or a street address.
 */
function findCodesInText(text, knownPrefixes) {
  const found = new Set();
  const re = /\b([A-Z]{2,4})\s?(\d{3})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (knownPrefixes.has(m[1])) found.add(`${m[1]} ${m[2]}`);
  }
  return [...found];
}

/**
 * Parses one program page. Franciscan's catalog uses three different page
 * shapes, and the parser reports which one it hit as `kind` so downstream
 * code never has to guess why a program has no structured requirements:
 *
 *  - `"tables"` — the normal case (~121 of 129 programs). A
 *    #degreeRequirements block with course tables. Produces `slots` and
 *    `requirements` (below).
 *
 *  - `"narrative"` — a real degree program whose requirements are written
 *    as prose with no table at all (Biology Minor: "18 credit hours with
 *    minimum of 9 credit hours in 200-400 level biology courses. BIO 106 is
 *    excluded."; also Spanish Minor, the Bioinformatics Certificate, the
 *    high-school teaching licensure track, and the engineering Honors
 *    Program). These pages have div.programTables but nothing inside it
 *    except <p>. The rules are genuinely unstructured on the university's
 *    end — there is no table being missed — so we keep the prose verbatim
 *    in `narrative` and pull out any inline course codes.
 *
 *  - `"informational"` — not a degree program at all: partner-institution
 *    pathway/admission pages (the two PharmD agreements) and the MA
 *    Theology 4+1. No div.programTables; just prose about admission
 *    criteria. Captured for completeness, should not be offered as a
 *    "free minor" candidate.
 *
 * For the `"tables"` case:
 *  - `slots` is a faithful, unprocessed row-by-row reading of the tables
 *    (nothing thrown away — use this if the derived `requirements` gets
 *    something wrong for a particular program)
 *  - `requirements` is a best-effort grouping into RequirementGroup shape
 *    (src/lib/types.ts), collapsing "X OR Y" pairs into one
 *    choose-one-of-two group and treating no-code rows (e.g. "CSC or SFE
 *    Elective", "Statistics Elective") as unresolved elective slots —
 *    there's no course code to point at for those, just a label and a
 *    credit count.
 *
 * IMPORTANT: this only captures the program's OWN required courses (the
 * tables under the *first* h3.sc-RequiredCoursesHeading1). The later h3
 * sections on a page — "Freshman Year", "Sophomore Year", etc. — are a
 * suggested four-year sequence that re-lists the same courses mixed in with
 * Core Curriculum, so parsing them too would double-count. Franciscan's
 * university-wide Core Curriculum (Theology, Philosophy, Literature, etc.)
 * therefore isn't captured here at all — it's the same for every student
 * regardless of major and gets scraped once by scripts/scrape-core.mjs.
 */
function parseProgramRequirements(html, programUrl) {
  const $ = cheerio.load(html);
  const title = $("h1.degreeTitle").first().text().trim();
  const container = $("#degreeRequirements");

  if (container.length === 0) {
    // No requirements block. Either a prose-only degree program
    // (div.programTables present) or a non-program informational page.
    const programTables = $(".programTables");
    const isProgram = programTables.length > 0;
    const root = isProgram ? programTables : $("#main");
    // strip the site's own navigation chrome before reading the prose
    root.find(".combinedChild, .sc-parentlink, .sc-childlinks, #csNewRelicPageTypeDiv").remove();
    const narrative = collectNarrative($, root).filter((t) => t !== title);
    return {
      name: title || $("#main h1").first().text().trim(),
      sourceUrl: programUrl,
      kind: isProgram ? "narrative" : "informational",
      narrative,
      mentionedCodes: [], // filled in by a second pass in main(), once the
      // run has seen enough real course codes to know
      // which subject prefixes actually exist
      slots: [],
      requirements: [],
    };
  }

  // ---- how the h3 sections work ----
  //
  // A program page's #degreeRequirements is divided by
  // h3.sc-RequiredCoursesHeading1 into sections. Surveying all 130
  // table-based pages (375 sections) shows three kinds:
  //
  //  - 229 are a suggested year-by-year schedule ("Freshman Year",
  //    "Sophomore Year", "Summer Session"). These RE-LIST courses already
  //    required elsewhere, mixed in with Core Curriculum, so parsing them
  //    would double-count. Skipped.
  //
  //  - 76 are the main requirement list ("Bachelor of Science Degree
  //    Requirements for ... Major:", or an empty heading). Every row is
  //    required.
  //
  //  - the rest state a CHOICE in the heading — "One of the following:",
  //    "Any three of the following courses:", "Six additional credits will
  //    be fulfilled from the following electives:". The heading carries the
  //    count; the rows beneath are the options.
  //
  // An earlier version of this parser took only the FIRST section, which was
  // right for majors (where everything after it is the year schedule) and
  // badly wrong for minors: the British and American Literature Minor is
  // "ENG 325, plus one of these 4, plus one of these 7, plus three of these
  // 20" spread over four sections — and it scraped as a one-course minor.
  const sections = [];
  let current = null;
  let currentSubLabel = null;

  container.children().each((_, el) => {
    const node = $(el);
    if (node.is("h3.sc-RequiredCoursesHeading1")) {
      current = { heading: node.text().trim().replace(/\s+/g, " "), slots: [], notes: [] };
      sections.push(current);
      currentSubLabel = null;
    } else if (node.is("h4.sc-RequiredCoursesHeading2")) {
      currentSubLabel = node.text().trim().replace(/:\s*$/, "");
    } else if (node.is("table")) {
      if (!current) {
        current = { heading: "", slots: [], notes: [] };
        sections.push(current);
      }
      parseTable(node, current.slots, currentSubLabel);
    } else {
      if (!current) {
        current = { heading: "", slots: [], notes: [] };
        sections.push(current);
      }
      const tables = node.find("table");
      if (tables.length > 0) {
        // tables can sit inside wrapper divs
        tables.each((__, t) => parseTable($(t), current.slots, currentSubLabel));
      }

      // A note can sit inside the SAME wrapper as a table — returning after
      // parsing tables dropped it. Management Minor's "(MTH 156 suggested)"
      // and Catechetics' thesis options were lost exactly this way.
      // A requirements-note may BE this node or sit inside it. `find` only
      // searches descendants, so checking one and not the other silently
      // skipped every note that is a direct child of #degreeRequirements —
      // which is where most of them live.
      const noteEls = node.is(".sc-requirementsNote")
        ? [node]
        : node.find(".sc-requirementsNote").toArray().map((n) => $(n));

      if (noteEls.length > 0) {
        for (const noteEl of noteEls) {
          // ONE note block can hold SEVERAL requirements, each in its own
          // paragraph:
          //   "Statistics Elective: Choose one from ECO 212, MTH 204, MTH 401."
          //   "Web Development Elective: Choose one from CSC 391 or CSC 392."
          //   "Cybersecurity Electives: Choose two from SFE 364, SFE 365, SFE 366."
          // Taking the block whole and splitting on its first colon labels all
          // of it "Statistics Elective" and hands it all nine codes — so
          // Statistics wrongly accepts SFE 364 and Cybersecurity gets nothing.
          const allCodes = noteEl
            .find("a.sc-courselink")
            .map((__, a) => $(a).text().trim())
            .get();

          // Splitting must never LOSE anything. One Biology note is
          // <p></p><ul>…7 course links…</ul><p></p> — splitting on p/div/li
          // alone kept the two empty paragraphs and dropped the list. So a
          // split is only accepted when the parts still account for every
          // course link in the block; otherwise the note is taken whole.
          const candidates = noteEl.children().toArray().map((x) => $(x));
          const covered = candidates.reduce(
            (n, c) => n + c.find("a.sc-courselink").length,
            0
          );
          const meaningful = candidates.filter(
            (c) => c.text().trim() || c.find("a.sc-courselink").length
          );
          const blocks =
            meaningful.length > 1 && covered === allCodes.length ? meaningful : [noteEl];
          for (const block of blocks) {
            const noteText = block.text().replace(/\s+/g, " ").trim();
            const noteCodes = block
              .find("a.sc-courselink")
              .map((__, a) => $(a).text().trim().replace(/\s+/g, " "))
              .get()
              // An empty <a class="sc-courselink"> appears on some 2026-2027
              // pages. An empty string in a code list is invisible everywhere
              // it is displayed and shows up only as a phantom extra course
              // when the data is cross-checked against the page.
              .filter(Boolean);
            if (noteText || noteCodes.length) {
              current.notes.push({ text: noteText, codes: noteCodes, subLabel: currentSubLabel });
            }
          }
        }
        return;
      }
      if (tables.length > 0) return;
      // Not a table — but course requirements also live in prose here, and
      // ignoring it silently dropped course codes from 46 of 121 programs:
      //   - div.sc-requirementsNote holds the option list that RESOLVES an
      //     unresolved elective row ("Social Work Elective Options: SWK 316,
      //     SWK 317, …" for the table's bare "Social Work Elective")
      //   - plain <p> holds substitution rules ("Students may substitute a
      //     maximum of two non-FRN-coded courses …" naming ten specific ones)
      const text = node.text().replace(/\s+/g, " ").trim();
      const codes = node
        .find("a.sc-courselink")
        .map((__, a) => $(a).text().trim().replace(/\s+/g, " "))
        .get().filter(Boolean);
      if (text || codes.length) current.notes.push({ text, codes, subLabel: currentSubLabel });
    }
  });

  function parseTable(table, into, subLabel) {
    table.find("> tbody > tr, > tr").each((_, tr) => {
      const row = $(tr);
      const codeCell = row.find("td.sc-coursenumber");
      const titleCell = row.find("td.sc-coursetitle");
      const creditsText = row.find("td.sc-credits p.credits").text().trim();

      const codeLinks = codeCell.find("a.sc-courselink");
      const codes = codeLinks
        .map((_, a) => $(a).text().trim().replace(/\s+/g, " "))
        .get().filter(Boolean);
      const rowTitle = titleCell.text().trim().replace(/\s+/g, " ");
      const credits = creditsText ? parseFloat(creditsText) : null;

      if (codes.length === 0 && !rowTitle) return; // pure spacer row, skip

      into.push({
        codes, // [] if this row has no linked course code
        title: rowTitle, // course title, "OR", or a generic elective label
        credits, // null if blank
        subLabel,
      });
    });
  }

  let kept = sections.filter((s) => !isYearScheduleHeading(s.heading));

  // 15 programs — mostly Education licensure tracks and the 2+2 engineering
  // pathways — have NO separate requirements section at all: the four-year
  // schedule is the only listing on the page. Skipping year sections leaves
  // those with nothing, so fall back to them rather than reporting the
  // program as empty.
  //
  // Caveat that has to travel with the data: a year schedule mixes in Core
  // Curriculum courses, so these programs' requirements overlap the Core and
  // will double-count against it. Flagged rather than silently blended.
  // The test is whether any non-schedule section has actual course ROWS —
  // not whether any section exists. A stray <h2> or a note block opens a
  // section with no slots, which would otherwise look like real content and
  // suppress this fallback.
  const requirementsFromSchedule =
    !kept.some((s) => s.slots.length > 0) && sections.some((s) => s.slots.length > 0);
  if (requirementsFromSchedule) kept = sections;

  const slots = kept.flatMap((s) => s.slots);

  // Best-effort grouping into RequirementGroup shape, per section.
  const requirements = [];
  const programNotes = [];
  const pendingNotes = [];
  let groupIdx = 0;
  const uncertainHeadings = [];

  /**
   * Attach a note to the requirement it describes, if it clearly enumerates
   * that requirement's options. Otherwise keep it verbatim — substitution
   * rules and caveats are real information and must not vanish.
   */
  function bindNote(note, sectionHeading) {
    const label = normalizeLabel((note.text || "").split(":")[0] || "");
    if (isOptionList(note) && label) {
      const target = requirements.find(
        (r) =>
          r.unresolved &&
          r.options.length === 0 &&
          r.label &&
          (normalizeLabel(r.label) === label || label.startsWith(normalizeLabel(r.label)))
      );
      if (target) {
        // Every row sharing that label gets the same option list — the
        // catalog lists "Marketing Elective" four times against one note.
        const key = normalizeLabel(target.label);
        for (const r of requirements) {
          if (r.unresolved && r.options.length === 0 && normalizeLabel(r.label) === key) {
            r.options = [...new Set(note.codes)];
            r.optionsFromNote = true;
            delete r.unresolved;
          }
        }
        return;
      }
    }
    if (note.text) {
      programNotes.push({ section: sectionHeading, text: note.text, codes: note.codes });
    }
  }

  for (const section of kept) {
    for (const note of section.notes || []) {
      pendingNotes.push({ note, heading: section.heading || null });
    }
    if (section.slots.length === 0) continue;
    const choice = parseChoiceHeading(section.heading);

    if (choice) {
      // The heading states the count; the rows are the options.
      const options = [...new Set(section.slots.flatMap((s) => s.codes))];
      if (options.length > 0) {
        requirements.push({
          id: `grp-${groupIdx++}`,
          label: section.heading || `Choose ${choice.count}`,
          subgroup: null,
          count: choice.count,
          unit: choice.unit,
          options,
          fromHeading: true,
        });
        // e.g. "3 of these 4 required and 9 credits in other anthropology
        // courses" — the second clause is a real requirement this group
        // can't hold. Report it rather than dropping it.
        if (headingHasExtraRequirement(section.heading)) {
          uncertainHeadings.push(section.heading);
        }
        continue;
      }
    }

    if (section.heading && looksLikeChoiceButUnparsed(section.heading)) {
      // Don't guess a count. Treat the rows as required (the safe reading)
      // but flag it so a wrong assumption shows up instead of hiding.
      uncertainHeadings.push(section.heading);
    }

    // Every row required.
    let i = 0;
    const slotsHere = section.slots;
    while (i < slotsHere.length) {
      const slot = slotsHere[i];
      const next = slotsHere[i + 1];
      // A separator row carries no course code and sits between two real
      // rows in the same sub-section.
      const separator = (s) =>
        s && s.codes.length === 0 && s.subLabel === slot.subLabel
          ? s.title.trim().toLowerCase()
          : null;
      const sep = separator(next);
      const after = slotsHere[i + 2];

      // "A" / "and" / "B" is a CONJUNCTION — take both. The row is pure
      // punctuation, so drop it and let A and B stand as their own
      // requirements. Left in, it became a requirement literally named "and".
      if (sep === "and" && after) {
        slotsHere.splice(i + 1, 1);
        continue;
      }

      // "A" / "OR" / "B" is a choice. This has to handle the case where
      // neither side has a course code — "Philosophy Core" OR "Theology
      // Core" — which an earlier version skipped, leaving 26 programs with a
      // requirement literally named "OR" and both real alternatives split
      // into separate mandatory rows.
      if (sep === "or" && after) {
        // ORs CHAIN: the Theology Minor has
        //   THE 110 / OR / CAT 302 / OR / HON 201
        // — one three-way choice, not a pair plus a stray. Consuming only
        // the first pair left the second "OR" as the current row, which then
        // became a requirement literally named "OR".
        const parts = [slot];
        let j = i + 1;
        while (j + 1 < slotsHere.length) {
          const marker = slotsHere[j];
          const isOr =
            marker.codes.length === 0 &&
            marker.title.trim().toLowerCase() === "or" &&
            marker.subLabel === slot.subLabel;
          if (!isOr) break;
          parts.push(slotsHere[j + 1]);
          j += 2;
        }

        const options = parts.flatMap((x) => x.codes);
        const credits = parts.map((x) => x.credits).find((c) => c != null) ?? null;
        const anyUnresolved = parts.some((x) => x.codes.length === 0);
        requirements.push({
          id: `grp-${groupIdx++}`,
          label: parts.map((x) => x.title).join(" OR "),
          subgroup: slot.subLabel,
          count: options.length > 0 ? 1 : credits ? credits : 1,
          unit: options.length > 0 ? "courses" : credits ? "credits" : "courses",
          options,
          // An alternative with no course code can't be auto-checked against
          // a transcript.
          ...(anyUnresolved ? { unresolved: true, creditsIfKnown: credits } : {}),
        });
        i = j;
        continue;
      }

      if (slot.codes.length > 0) {
        requirements.push({
          id: `grp-${groupIdx++}`,
          label: slot.title,
          subgroup: slot.subLabel,
          count: 1,
          unit: "courses",
          options: slot.codes,
        });
        i += 1;
        continue;
      }

      // No course code at all — a generic elective/core slot we can't
      // resolve to specific course options from this page alone.
      // `count` has to agree with `unit`: a 3-credit elective slot is
      // count:3/unit:"credits", NOT count:1, or every downstream credit
      // total silently comes out ~3x too low.
      requirements.push({
        id: `grp-${groupIdx++}`,
        label: slot.title,
        subgroup: slot.subLabel,
        count: slot.credits ? slot.credits : 1,
        unit: slot.credits ? "credits" : "courses",
        options: [],
        unresolved: true,
        creditsIfKnown: slot.credits,
      });
      i += 1;
    }

  }

  // Notes don't always live inside #degreeRequirements — on several pages
  // (Management Minor, Narrative Arts Minor, the History AYA licensure track)
  // a div.sc-requirementsNote sits OUTSIDE it, as a sibling within
  // .programTables. Same content, different place, and missing them dropped
  // real course options.
  $(".programTables")
    .find(".sc-requirementsNote, > div, > p")
    .each((_, el) => {
      const node = $(el);
      if (node.closest("#degreeRequirements").length > 0) return; // already handled
      if (node.parents(".sc-requirementsNote").length > 0) return; // nested inside one we'll take
      const text = node.text().replace(/\s+/g, " ").trim();
      const codes = node
        .find("a.sc-courselink")
        .map((__, a) => $(a).text().trim().replace(/\s+/g, " "))
        .get().filter(Boolean);
      if (!text && codes.length === 0) return;
      if (pendingNotes.some((n) => n.note.text === text)) return; // de-dupe overlapping selectors
      pendingNotes.push({ note: { text, codes }, heading: null });
    });

  // Bind every note only once ALL of them are collected — from inside the
  // sections and from outside the requirements block. Binding inside the
  // section loop missed any note in a choose-N section, because that branch
  // ends in `continue`.
  for (const { note, heading } of pendingNotes) bindNote(note, heading);

  return {
    name: title,
    sourceUrl: programUrl,
    kind: "tables",
    narrative: [],
    mentionedCodes: [],
    slots,
    requirements,
    notes: programNotes,
    uncertainHeadings,
    requirementsFromSchedule,
  };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const catalog = await resolveCatalog();
  const catalogYear = catalog.year;
  console.log(
    `Catalog resolved live: ${catalog.year} (${catalog.slug}) — programs under /${catalog.programsPath}`
  );

  const outDir = path.join("data", "catalog", catalogYear);
  await mkdir(outDir, { recursive: true });

  const departments = await listDepartments(catalog);
  console.log(`Found ${departments.length} departments`);

  // Tracked across the whole run (even skipped/cached departments get
  // re-read from disk below) so the end-of-run summary and _report.json
  // are accurate on a partial/resumed run too, not just a fresh one.
  const narrativePrograms = [];
  const informationalPrograms = [];
  const departmentPages = []; // departments with no child programs — review these
  const uncertainSections = []; // headings that read like a choice but stated no count
  const scheduleDerived = []; // programs whose only listing is the year-by-year schedule
  const unparsedPrograms = []; // the real problem case: looked like a table page, parsed to nothing
  let totalPrograms = 0;

  function tally(deptName, p) {
    totalPrograms++;
    const entry = { department: deptName, name: p.name, url: p.sourceUrl };
    if (p.kind === "narrative") narrativePrograms.push(entry);
    else if (p.kind === "informational") informationalPrograms.push(entry);
    else if (p.kind === "department-page") departmentPages.push(entry);
    else if (!p.slots || p.slots.length === 0) unparsedPrograms.push(entry);
    if (p.requirementsFromSchedule) scheduleDerived.push(entry);
    for (const h of p.uncertainHeadings || []) {
      uncertainSections.push({ ...entry, heading: h });
    }
  }

  for (const dept of departments) {
    const outFile = path.join(outDir, `${dept.slug}.json`);
    if (!FORCE && (await fileExists(outFile))) {
      console.log(`skip (already scraped): ${dept.name}`);
      try {
        const cached = JSON.parse(await readFile(outFile, "utf8"));
        for (const p of cached.programs) tally(dept.name, p);
      } catch {
        // cached file unreadable/corrupt — not fatal, just skip it in the summary
      }
      continue;
    }

    await sleep(REQUEST_DELAY_MS);
    let programs;
    try {
      programs = await listPrograms(catalog, dept);
    } catch (err) {
      console.error(`FAILED listing programs for ${dept.name}: ${err.message}`);
      continue;
    }

    // Four departments (Physics, Military Science/ROTC, Modern Languages,
    // Honors Program) have no child program pages at all — the department
    // page IS the whole entry. Mostly those are service/umbrella
    // departments with nothing to require, but not always: the Honors
    // Program page states a real rule in prose ("32 credit hours of honors
    // work… Thirty hours of honors seminar credits apply to the core
    // curriculum, satisfying the American founding principles, economics,
    // history, literature, math, philosophy, social science, and THE 110
    // core requirements") which matters a lot to the free-major math.
    // So: parse the department page itself rather than writing an empty
    // file, and flag it for review instead of guessing which case it is.
    if (programs.length === 0) {
      console.log(`  (no child programs) parsing department page itself: ${dept.name}`);
      try {
        const html = await fetchHtml(dept.url);
        const parsed = parseProgramRequirements(html, dept.url);
        parsed.name = parsed.name || dept.name;
        parsed.kind = "department-page";
        const results = [parsed];
        tally(dept.name, parsed);
        await writeFile(
          outFile,
          JSON.stringify({ department: dept.name, catalogYear, programs: results }, null, 2)
        );
      } catch (err) {
        console.error(`  ✗ FAILED department page ${dept.name}: ${err.message}`);
      }
      continue;
    }

    const results = [];
    for (const program of programs) {
      await sleep(REQUEST_DELAY_MS);
      try {
        const html = await fetchHtml(program.url);
        const parsed = parseProgramRequirements(html, program.url);
        // fall back to the index link's text when the page's own title didn't parse
        parsed.name = parsed.name || program.name;
        results.push(parsed);
        tally(dept.name, parsed);
        const label = parsed.name;
        if (parsed.kind === "narrative") {
          console.log(`  ~ ${dept.name} / ${label} (prose requirements, no table on the page)`);
        } else if (parsed.kind === "informational") {
          console.log(`  – ${dept.name} / ${label} (informational page, not a degree program)`);
        } else if (parsed.slots.length === 0) {
          console.log(`  ⚠ UNPARSED — has a requirements block but no rows read: ${dept.name} / ${label}`);
        } else {
          console.log(`  ✓ ${dept.name} / ${label}`);
        }
      } catch (err) {
        console.error(`  ✗ FAILED ${dept.name} / ${program.name}: ${err.message}`);
      }
    }

    await writeFile(
      outFile,
      JSON.stringify({ department: dept.name, catalogYear, programs: results }, null, 2)
    );
  }

  // ---- second pass: resolve course codes mentioned in prose ----
  // Which subject prefixes are real (CSC, SPN, THE, ...) is only knowable
  // once the whole catalog has been read, so this can't happen inline
  // above. Deliberately derived from this run's own data rather than
  // hardcoded, so it stays correct when the university adds or retires a
  // subject. Cheap — it's all local disk, no refetching.
  const deptFiles = departments.map((d) => path.join(outDir, `${d.slug}.json`));
  const knownPrefixes = new Set();
  for (const file of deptFiles) {
    if (!(await fileExists(file))) continue;
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const program of data.programs) {
      for (const slot of program.slots || []) {
        for (const code of slot.codes) {
          const m = code.match(/^([A-Z]{2,4})\s*\d/);
          if (m) knownPrefixes.add(m[1]);
        }
      }
    }
  }

  let codesResolved = 0;
  for (const file of deptFiles) {
    if (!(await fileExists(file))) continue;
    const data = JSON.parse(await readFile(file, "utf8"));
    let touched = false;
    for (const program of data.programs) {
      if (!program.narrative || program.narrative.length === 0) continue;
      const codes = findCodesInText(program.narrative.join(" "), knownPrefixes);
      program.mentionedCodes = codes;
      codesResolved += codes.length;
      touched = true;
    }
    if (touched) await writeFile(file, JSON.stringify(data, null, 2));
  }

  const reportFile = path.join(outDir, "_report.json");
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        catalogYear,
        totalPrograms,
        tableBased:
          totalPrograms -
          narrativePrograms.length -
          informationalPrograms.length -
          departmentPages.length -
          unparsedPrograms.length,
        subjectPrefixes: [...knownPrefixes].sort(),
        narrativeCount: narrativePrograms.length,
        narrativePrograms,
        informationalCount: informationalPrograms.length,
        informationalPrograms,
        departmentPageCount: departmentPages.length,
        departmentPages,
        unparsedCount: unparsedPrograms.length,
        unparsedPrograms,
        uncertainSectionCount: uncertainSections.length,
        uncertainSections,
        scheduleDerivedCount: scheduleDerived.length,
        scheduleDerived,
      },
      null,
      2
    )
  );

  console.log(`\nDone. Output in ${outDir}/`);
  console.log(`${totalPrograms} programs total:`);
  console.log(
    `  ${
      totalPrograms -
      narrativePrograms.length -
      informationalPrograms.length -
      departmentPages.length -
      unparsedPrograms.length
    } parsed from requirement tables`
  );
  console.log(
    `  ${narrativePrograms.length} are prose-only degree programs (requirements kept verbatim in \`narrative\`, ${codesResolved} inline course codes resolved)`
  );
  console.log(`  ${informationalPrograms.length} are informational pages, not degree programs`);
  console.log(
    `  ${departmentPages.length} are departments with no child program pages (prose captured — check these for rules stated inline)`
  );
  console.log(
    `  ${unparsedPrograms.length} UNPARSED — a requirements block was present but no rows came out${
      unparsedPrograms.length ? " (this is a bug, see the report)" : ""
    }`
  );
  if (scheduleDerived.length) {
    console.log(
      `  ${scheduleDerived.length} program(s) have no requirements section — read from the year-by-year schedule instead (these include Core Curriculum courses)`
    );
  }
  if (uncertainSections.length) {
    console.log(
      `  ${uncertainSections.length} section heading(s) read like a choice but stated no count — treated as all-required, listed in the report for review`
    );
  }
  console.log(`Full breakdown in ${reportFile}.`);
  console.log(`Re-run any time — already-scraped departments are skipped. Use --force to redo everything.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
