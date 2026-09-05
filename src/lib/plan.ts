// Builds a semester-by-semester degree plan.
//
// The shape of the answer matters as much as the answer. A plan is:
//
//   [ terms the student actually took ] [ terms they haven't yet ]
//        from the transcript — fact          laid out from here
//
// The left half is never generated. The transcript already groups courses by
// term, so a student sees their own history, not a reconstruction of it. That
// is most of what makes the right half believable.
//
// The right half starts from the DEPARTMENT'S OWN four-year schedule rather
// than from constraints. Generating a layout from scratch produces something
// technically valid that no advisor recognises; starting from their published
// sequence inherits every judgement already baked into it — the credit
// rhythm, which core course lands where, which "prerequisite" they in fact
// expect you to take alongside. What's left for this code to do is the part
// that's actually about one student: drop what they've already done, and
// slide the rest earlier to fill the gap.

import type { Course } from "./types";
import type { TranscriptTerm } from "./transcript";
import type { ScheduleTemplate, TemplateEntry } from "./schedules";
import { checkPrerequisites } from "./prereq";

export type Season = "Fall" | "Spring" | "Summer" | "Winter";

export interface PlanEntry {
  /** Stable within a plan, for React keys and pinning */
  id: string;
  kind: "course" | "slot" | "wildcard";
  /** For a course: every code that satisfies it (cross-listings) */
  codes: string[];
  /** For a slot: what the schedule called it, e.g. "Theology Core" */
  label: string;
  title: string;
  credits: number | null;
  /** Which template term this came from, 1-based */
  templateIndex: number | null;
  /** The season the template puts it in — a hint, not a fact */
  season: Season | null;
  /** Why it landed in this term. Shown on demand, never invented. */
  reason?: string;
}

export interface PlanTerm {
  key: string;
  label: string;
  season: Season | null;
  /** Terms already taken are history; the rest are a proposal */
  kind: "past" | "future";
  entries: PlanEntry[];
  credits: number;
  /** Only for past terms, straight off the transcript */
  gpa?: number | null;
}

export interface UnplacedEntry extends PlanEntry {
  /** Why it couldn't be scheduled. Never dropped silently. */
  blockedBy: string;
}

export interface Plan {
  terms: PlanTerm[];
  /**
   * Everything the template asks for that wouldn't fit. A plan that quietly
   * omits a requirement to look complete is worse than one that says it ran
   * out of room.
   */
  unplaced: UnplacedEntry[];
  /** Credits already earned, from the transcript */
  earnedCredits: number;
  /** Credits in the proposed terms */
  plannedCredits: number;
  templateName: string | null;
  warnings: string[];
}

export interface PlanOptions {
  /** Credits to aim for in a term. The schedules run 13-17. */
  targetCredits?: number;
  /** Hard ceiling — above this needs an overload petition at most schools. */
  maxCredits?: number;
  /** How many future terms to lay out before giving up. */
  maxTerms?: number;
  /** course code or slot id -> term key. A pin is a hard constraint. */
  pins?: Record<string, string>;
}

const DEFAULTS = { targetCredits: 15, maxCredits: 18, maxTerms: 12 };

/* ------------------------------------------------------------------ terms */

/** "Fall 2026" / "Spring 2027" -> a comparable number, and back. */
export function parseTermLabel(label: string): { season: Season; year: number } | null {
  const m = label.match(/\b(Fall|Spring|Summer|Winter)\s+(\d{4})\b/i);
  if (!m) return null;
  const season = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as Season;
  return { season, year: Number(m[2]) };
}

/**
 * The term after this one.
 *
 * Only Fall and Spring are generated: summer and winter terms exist but a
 * student doesn't take one by default, and putting a required course in one
 * without being asked would be a plan they can't follow.
 */
export function nextTerm(t: { season: Season; year: number }): { season: Season; year: number } {
  return t.season === "Fall"
    ? { season: "Spring", year: t.year + 1 }
    : { season: "Fall", year: t.year };
}

export function termLabel(t: { season: Season; year: number }): string {
  return `${t.season} ${t.year}`;
}

/**
 * Chronological rank for a dated term.
 *
 * Needed because the transcript lists terms NEWEST FIRST, so "the last term
 * they took" is not the last one in the array — reading it that way started a
 * student's plan a year in their own past.
 */
export function termRank(t: { season: Season; year: number }): number {
  const within = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 }[t.season];
  return t.year * 10 + within;
}

/* ------------------------------------------------------- what's been done */

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * A template entry counts as done if the student has ANY of its codes.
 *
 * Cross-listed entries are one course under two numbers, so matching any of
 * them is right — and matching all of them would tell a student they still
 * owe a course they've already passed.
 */
function entryIsDone(entry: TemplateEntry, taken: Set<string>): string | null {
  for (const code of entry.codes ?? []) {
    if (taken.has(normalizeCode(code))) return code;
  }
  return null;
}

/* ------------------------------------------------------------ the layout */

let idCounter = 0;
function toPlanEntry(entry: TemplateEntry, templateIndex: number, season: Season | null): PlanEntry {
  const codes = (entry.codes ?? []).map(normalizeCode);
  return {
    id: `${codes[0] ?? entry.label ?? "slot"}#${templateIndex}#${idCounter++}`,
    kind: entry.kind,
    codes,
    label: entry.label ?? codes.join(" / "),
    title: entry.title ?? "",
    credits: entry.credits ?? null,
    templateIndex,
    season,
  };
}

/**
 * Can this entry go in a term, given what's been taken by then?
 *
 * Delegates the sentence to prereq.ts. The three-valued answer matters here:
 * a course gated on "permission of instructor" comes back unknown, and a
 * planner that refuses to schedule those pushes a student's graduation out
 * over a conversation they could have in a week.
 */
export function prerequisitesSatisfied(
  course: Course | undefined,
  satisfied: Set<string>,
  earnedCredits?: number
): { ok: boolean; missing: string[]; notes: string[] } {
  if (!course) return { ok: true, missing: [], notes: [] };
  const r = checkPrerequisites(course.prerequisiteText, course.prerequisites, {
    completed: satisfied,
    earnedCredits,
  });
  return { ok: r.met !== false, missing: r.missing, notes: r.notes };
}

export interface BuildPlanInput {
  transcriptTerms: TranscriptTerm[];
  template: ScheduleTemplate | null;
  courses: Map<string, Course>;
  options?: PlanOptions;
}

export function buildPlan(input: BuildPlanInput): Plan {
  const { transcriptTerms, template, courses } = input;
  const opts = { ...DEFAULTS, ...(input.options ?? {}) };
  const warnings: string[] = [];

  // ---- the past, as the transcript states it -------------------------------
  const pastTerms: PlanTerm[] = [];
  const taken = new Set<string>();
  let earnedCredits = 0;

  for (const t of transcriptTerms) {
    const parsed = parseTermLabel(t.label);
    const entries: PlanEntry[] = t.courses.map((c) => ({
      id: `past:${t.label}:${c.code}`,
      kind: "course" as const,
      codes: [normalizeCode(c.code)],
      label: normalizeCode(c.code),
      title: c.title ?? "",
      // An in-progress course has attempted credits but no earned ones yet;
      // showing 0 for a class they're sitting in would misread as "dropped".
      credits: (c.inProgress ? c.attemptedCredits : c.creditsEarned) ?? c.attemptedCredits ?? null,
      templateIndex: null,
      season: parsed?.season ?? null,
    }));
    for (const c of t.courses) {
      // In-progress courses count as taken for planning — you don't schedule
      // a course you're sitting in — but not as earned credit.
      taken.add(normalizeCode(c.code));
      if (!c.inProgress) earnedCredits += c.creditsEarned ?? 0;
    }
    pastTerms.push({
      key: `past:${t.label}`,
      label: t.label,
      season: parsed?.season ?? null,
      kind: "past",
      entries,
      credits: entries.reduce((n, e) => n + (e.credits ?? 0), 0),
      gpa: t.termTotals?.gpa ?? null,
    });
  }

  // Show history oldest-first, whatever order the transcript printed it in.
  pastTerms.sort((a, b) => {
    const pa = parseTermLabel(a.label);
    const pb = parseTermLabel(b.label);
    if (!pa || !pb) return pa ? 1 : pb ? -1 : 0; // undated (transfer) first
    return termRank(pa) - termRank(pb);
  });

  if (!template) {
    return {
      terms: pastTerms,
      unplaced: [],
      earnedCredits,
      plannedCredits: 0,
      templateName: null,
      warnings: [
        "No published four-year schedule for this program, so there's nothing to lay the rest of the degree out from yet.",
      ],
    };
  }

  // ---- what's left of the template ----------------------------------------
  const remaining: PlanEntry[] = [];
  for (const term of template.terms) {
    for (const entry of term.entries) {
      if (entry.kind === "course" && entryIsDone(entry, taken)) continue;
      remaining.push(toPlanEntry(entry, term.index ?? 0, term.season ?? null));
    }
  }

  // ---- where the future starts --------------------------------------------
  const dated = pastTerms
    .map((t) => parseTermLabel(t.label))
    .filter((t): t is { season: Season; year: number } => t !== null);
  const lastReal = dated.length
    ? dated.reduce((a, b) => (termRank(b) > termRank(a) ? b : a))
    : null;
  let cursor = lastReal
    ? nextTerm(lastReal)
    : // No dated terms at all (a transcript of transfer credit only). Start
      // from a Fall, and say so rather than inventing a year silently.
      null;

  if (!cursor) {
    warnings.push(
      "No dated terms on the transcript, so the plan below is numbered rather than dated."
    );
  }

  // ---- lay it out ----------------------------------------------------------
  const futureTerms: PlanTerm[] = [];
  const satisfied = new Set(taken);
  const pool = [...remaining];
  const pins = input.options?.pins ?? {};

  for (let i = 0; i < opts.maxTerms && pool.length > 0; i++) {
    // Spread the remaining work evenly over the terms it needs, rather than
    // filling each to the target and leaving a 6-credit dribble at the end.
    // Same number of terms either way; one of them looks like a schedule a
    // person would register for and the other looks like a bug.
    const poolCredits = pool.reduce((n, e) => n + (e.credits ?? 0), 0);
    const termsNeeded = Math.max(1, Math.ceil(poolCredits / opts.targetCredits));
    const termTarget = Math.min(
      opts.maxCredits,
      Math.max(opts.targetCredits - 3, Math.ceil(poolCredits / termsNeeded))
    );
    const dated = cursor ? { ...cursor } : null;
    const label = dated ? termLabel(dated) : `Term ${i + 1}`;
    const season: Season | null = dated ? dated.season : i % 2 === 0 ? "Fall" : "Spring";
    const key = `future:${label}`;

    const entries: PlanEntry[] = [];
    let credits = 0;

    // Pins first: they're constraints, not preferences.
    for (let j = pool.length - 1; j >= 0; j--) {
      const e = pool[j];
      if (pins[e.id] !== key && pins[e.codes[0]] !== key) continue;
      entries.push({ ...e, reason: "you pinned it here" });
      credits += e.credits ?? 0;
      pool.splice(j, 1);
    }

    for (let j = 0; j < pool.length; ) {
      const e = pool[j];
      if (credits >= termTarget) break;

      // Pinned elsewhere — leave it for its own term.
      if (pins[e.id] || pins[e.codes[0]]) {
        j++;
        continue;
      }

      // Season constrains named COURSES only. Where the schedule puts a
      // course is evidence about when it's taught; where it puts a slot
      // ("Elective", "Theology Core") is just where that year had room, and
      // treating that as a rule strands electives in single seasons and
      // stretches a plan by years.
      if (e.kind === "course" && e.season && season && e.season !== season) {
        j++;
        continue;
      }

      if ((e.credits ?? 0) + credits > opts.maxCredits) {
        j++;
        continue;
      }

      const course = e.codes.length ? courses.get(e.codes[0]) : undefined;
      const prereq = prerequisitesSatisfied(course, satisfied);
      if (!prereq.ok) {
        j++;
        continue;
      }

      const reasons: string[] = [];
      if (e.kind === "course" && e.season) {
        reasons.push(`${e.season}, per the department's schedule`);
      }
      if (course?.prerequisites?.length) reasons.push("prerequisites cleared");
      if (prereq.notes.length) reasons.push(prereq.notes.join("; "));
      entries.push({ ...e, reason: reasons.join(" · ") || undefined });
      credits += e.credits ?? 0;
      pool.splice(j, 1);
    }

    // Everything placed this term becomes a prerequisite for later ones.
    for (const e of entries) for (const c of e.codes) satisfied.add(c);

    futureTerms.push({ key, label, season, kind: "future", entries, credits });
    if (dated) cursor = nextTerm(dated);
  }

  // A run of empty terms at the end isn't a plan, it's padding. Trim them —
  // but only from the end, since an empty term in the MIDDLE is real
  // information (nothing you're eligible for is offered that season).
  while (futureTerms.length && futureTerms[futureTerms.length - 1].entries.length === 0) {
    futureTerms.pop();
  }

  // ---- whatever didn't fit ------------------------------------------------
  const unplaced: UnplacedEntry[] = pool.map((e) => {
    const course = e.codes.length ? courses.get(e.codes[0]) : undefined;
    const prereq = prerequisitesSatisfied(course, satisfied);
    const blockedBy = !prereq.ok
      ? `needs ${prereq.missing.join(", ")}`
      : e.season
        ? `no ${e.season} left in the plan`
        : "ran out of terms";
    return { ...e, blockedBy };
  });

  return {
    terms: [...pastTerms, ...futureTerms],
    unplaced,
    earnedCredits,
    plannedCredits: futureTerms.reduce((n, t) => n + t.credits, 0),
    templateName: template.name,
    warnings,
  };
}
