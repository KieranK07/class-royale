"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  Course,
  GraduationRule,
  Program,
  ProgramProgress,
  RequirementGroup,
  StudentRecord,
} from "@/lib/types";
import { parseTranscript, type TranscriptData } from "@/lib/transcript";
import { computeProgress, allocateCourses } from "@/lib/progress";
import { rankByFreeness, flattenGroups } from "@/lib/overlap";
import { nextSteps, type Candidate } from "@/lib/planner";
import {
  offeringsByCode,
  seasonLabel,
  syncSections,
  type SectionSyncResult,
} from "@/lib/section-sync";
import type { Section, TermOption } from "@/lib/sections";
import { detectExtensionInfo, type ExtensionInfo } from "@/lib/extension-bridge";
import { sameAcademicArea } from "@/lib/catalog-data";
import { APP_BUILD, EXPECTED_EXTENSION } from "@/lib/build";
import { Planner } from "./Planner";
import type { ScheduleTemplate } from "@/lib/schedules";
import { SyncPanel } from "./SyncPanel";

const STORAGE_KEY = "class-royale:transcript";
const MAJOR_KEY = "class-royale:major";
const MINORS_KEY = "class-royale:minors";
/** The sample transcript is a CS student's; show it against that major. */
const SAMPLE_MAJOR = "Computer Science, Bachelor of Science";

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border border-black/10 bg-white/60 p-5 dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * Read a value saved in this browser. Storage can be unavailable (private
 * mode, blocked site data) or hold something corrupt — either way the app
 * must start clean rather than throw on load.
 */
const noopSubscribe = () => () => {};

/**
 * False during server render and the first client render, true afterwards.
 *
 * The saved transcript exists only in this browser, so the server can't render
 * it — showing it on the first client render would be a hydration mismatch.
 * useSyncExternalStore expresses "this value differs between server and
 * client" directly, rather than the setState-in-an-effect version, which
 * triggers a cascading re-render of the whole page.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

function readStored<T>(key: string, fallback: T, json = true): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return json ? (JSON.parse(raw) as T) : (raw as unknown as T);
  } catch {
    return fallback;
  }
}

/** A checked/unchecked graduation rule. Module scope so it isn't recreated each render. */
function RuleRow({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span
        className={
          ok === null
            ? "text-black/30 dark:text-white/30"
            : ok
              ? "text-emerald-600"
              : "text-amber-600"
        }
      >
        {ok === null ? "·" : ok ? "✓" : "○"}
      </span>
      <span className={ok ? "text-black/50 dark:text-white/50" : ""}>{label}</span>
    </li>
  );
}

/** One outstanding requirement in the "What's left" lists. */
function LeftItem({
  label,
  need,
  unit,
  options,
}: {
  label: string;
  need: number;
  unit: string;
  options: string[];
}) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/5 py-1.5 text-sm last:border-0 dark:border-white/5">
      <span>{label}</span>
      <span className="text-right font-mono text-xs text-black/50 dark:text-white/50">
        {options.length > 0
          ? options.slice(0, 4).join(" / ") + (options.length > 4 ? ` +${options.length - 4}` : "")
          : `${need} ${unit}`}
      </span>
    </li>
  );
}

/** One suggested course in "Ready to take". */
function CandidateRow({
  c,
  dim,
  sections,
  offeredIn,
  coveredTerms,
  sectionsLoaded,
}: {
  c: Candidate;
  dim?: boolean;
  sections?: Section[];
  /** Which of the covered terms this course actually appears in */
  offeredIn?: TermOption[];
  /** The terms we looked at, newest first — what "not offered" is scoped to */
  coveredTerms: TermOption[];
  /**
   * Whether live offerings were actually fetched. Without this, "no sections
   * for this course" is indistinguishable from "we never looked" — and
   * telling a student a course isn't offered when we simply didn't check is
   * the kind of wrong that makes them plan around a course that exists.
   */
  sectionsLoaded: boolean;
}) {
  const currentTerm = coveredTerms[0] ?? null;
  // Seat counts only mean something for the term you can still register for.
  // Last spring's "3 seats open" is a fact about a closed term.
  const open = (sections ?? []).filter(
    (s) => (s.seatsOpen ?? 0) > 0 && (!currentTerm || s.yearTerm === currentTerm.value)
  );
  const offeredLabel = offeredIn && offeredIn.length > 0 ? seasonLabel(offeredIn) : null;
  return (
    <li className="border-b border-black/5 py-2 text-sm last:border-0 dark:border-white/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={dim ? "text-black/50 dark:text-white/50" : ""}>
          <span className="font-mono text-xs">{c.code}</span>{" "}
          <span className="text-black/70 dark:text-white/70">{c.title}</span>
        </span>
        <span className="flex items-center gap-2">
          {c.satisfies.length > 1 && <Pill tone="free">covers {c.satisfies.length}</Pill>}
          {sectionsLoaded &&
            (offeredLabel ? (
              <Pill tone="muted">{offeredLabel}</Pill>
            ) : (
              <Pill tone="muted">
                {coveredTerms.length > 0
                  ? `not in ${seasonLabel(coveredTerms, " or ")}`
                  : "not offered"}
              </Pill>
            ))}
          {sectionsLoaded && open.length > 0 && (
            <Pill tone="done">
              {open.length} open{currentTerm?.season ? ` in ${currentTerm.season}` : ""}
            </Pill>
          )}
          <span className="tabular-nums text-black/45 dark:text-white/45">{c.credits} cr</span>
        </span>
      </div>
      <div className="mt-0.5 text-xs text-black/45 dark:text-white/45">
        {c.satisfies.slice(0, 2).join(" · ")}
        {c.satisfies.length > 2 && ` · +${c.satisfies.length - 2} more`}
        {dim && c.missingPrereqs.length > 0 && (
          <span className="ml-2 text-amber-700 dark:text-amber-500">
            needs {c.missingPrereqs.join(", ")}
          </span>
        )}
      </div>

      {open.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {open.slice(0, 3).map((s) => (
            <li key={s.sectionId ?? s.sectionCode} className="text-xs text-black/55 dark:text-white/55">
              <span className="font-mono">{s.sectionCode}</span>
              {s.days && s.time ? ` · ${s.days} ${s.time}` : " · time TBA"}
              {s.faculty ? ` · ${s.faculty}` : ""}
              <span className="ml-1 text-emerald-700 dark:text-emerald-400">
                {s.seatsOpen}/{s.capacity} seats
              </span>
              {s.location ? <span className="ml-1 text-black/40 dark:text-white/40">{s.location}</span> : null}
            </li>
          ))}
          {open.length > 3 && (
            <li className="text-xs text-black/40 dark:text-white/40">
              +{open.length - 3} more section{open.length - 3 === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
      <div
        className="h-full rounded-full bg-emerald-600 transition-all dark:bg-emerald-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Pill({ tone, children }: { tone: "done" | "free" | "muted"; children: React.ReactNode }) {
  const tones = {
    done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    free: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    muted: "bg-black/[0.06] text-black/60 dark:bg-white/10 dark:text-white/60",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Explorer({
  programs,
  corePrograms,
  courses,
  catalogYear,
  graduationRules,
  coreCategoryCourses,
  scheduleTemplates,
}: {
  programs: Program[];
  corePrograms: Program[];
  courses: Course[];
  catalogYear: string;
  graduationRules: GraduationRule[];
  coreCategoryCourses: Record<string, string[]>;
  /** The catalog's four-year schedules, one per program that publishes one */
  scheduleTemplates: ScheduleTemplate[];
}) {
  // Everything the student has chosen lives in this browser and nowhere else,
  // so it has to be read on the client. Reading it in an effect and calling
  // four setStates causes a cascade of renders; reading it once here, after
  // the first paint flips `hydrated`, does not.
  const hydrated = useHydrated();
  const [transcript, setTranscript] = useState<TranscriptData | null>(() => readStored(STORAGE_KEY, null));
  const [majorId, setMajorId] = useState<string>(() => readStored(MAJOR_KEY, "", false));
  const [minorIds, setMinorIds] = useState<string[]>(() => readStored(MINORS_KEY, []));

  // The sample transcript is shown but never saved, so a reload or "Exit
  // sample" leaves the browser exactly as it was.
  const [isSample, setIsSample] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  function saveTranscript(data: TranscriptData) {
    setTranscript(data);
    setIsSample(false);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }
  function chooseMajor(id: string) {
    setMajorId(id);
    try {
      localStorage.setItem(MAJOR_KEY, id);
    } catch {}
  }
  function toggleMinor(id: string) {
    setMinorIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(MINORS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function clearAll() {
    if (isSample) {
      // Put back whatever was there before the sample, if anything.
      setIsSample(false);
      setTranscript(readStored(STORAGE_KEY, null));
      setMajorId(readStored(MAJOR_KEY, "", false));
      return;
    }
    setTranscript(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  async function loadSample() {
    setSampleError(null);
    try {
      const res = await fetch("sample-transcript");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      setTranscript(parseTranscript(doc));
      setIsSample(true);
      if (!majorId) {
        const cs = programs.find((p) => p.name === SAMPLE_MAJOR);
        if (cs) setMajorId(cs.id); // shown, not saved, like the transcript
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setSampleError(`Couldn't load the sample (${e instanceof Error ? e.message : e}).`);
    }
  }

  const catalog = useMemo(() => new Map(courses.map((c) => [c.code, c])), [courses]);

  /**
   * Rebuild the option lists the server deliberately left out. Rows that
   * point at a Core category, or carry a subject/level rule, ship without
   * their expansion — 61% of all option entries were duplicated copies of
   * the same handful of lists.
   */
  const expanded = useMemo(() => {
    const codes = courses.map((c) => c.code);
    const matches = (code: string, r: NonNullable<RequirementGroup["subjectRule"]>) => {
      const m = code.match(/^([A-Z]{2,4})\s*(\d{3})/);
      if (!m || !r.subjects.includes(m[1])) return false;
      if (r.excludes?.includes(code)) return false;
      const lvl = parseInt(m[2], 10);
      if (r.minLevel != null && lvl < r.minLevel) return false;
      if (r.maxLevel != null && lvl > r.maxLevel) return false;
      return true;
    };
    const fill = (g: RequirementGroup): RequirementGroup => {
      const out: RequirementGroup = { ...g };
      if (g.subgroups) out.subgroups = g.subgroups.map(fill);
      if (g.options.length === 0) {
        if (g.coreCategories?.length) {
          out.options = [
            ...new Set(g.coreCategories.flatMap((c) => coreCategoryCourses[c] ?? [])),
          ];
        } else if (g.subjectRule) {
          out.options = codes.filter((c) => matches(c, g.subjectRule!));
        }
      }
      return out;
    };
    return programs.map((p) => ({ ...p, requirements: p.requirements.map(fill) }));
  }, [programs, courses, coreCategoryCourses]);
  // Concentrations belong here, not in the add-on list. "Computer Science
  // (Cybersecurity Concentration), BS" IS the degree a student declares —
  // nobody declares plain CS and bolts a concentration on. Filtering the
  // picker to type === "major" hid all 14 of them.
  const declarable = useMemo(
    () =>
      expanded
        .filter((p) => p.type === "major" || p.type === "concentration")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [expanded]
  );
  const major = expanded.find((p) => p.id === majorId) ?? null;

  const core = useMemo(
    () =>
      corePrograms.find((p) => p.degree === (major?.degree ?? "BA")) ??
      corePrograms.find((p) => p.degree === "BA") ??
      null,
    [major, corePrograms]
  );

  // An empty record is a valid state: with no transcript the engines answer
  // the catalog-only question — "given this major, what's cheapest to add?"
  const record: StudentRecord = useMemo(
    () => ({ completedCourses: transcript?.courses ?? [] }),
    [transcript]
  );
  const personalized = transcript !== null;

  const majorProgress = useMemo(
    () => (major ? computeProgress(major, record, catalog) : null),
    [major, record, catalog]
  );
  const coreProgress = useMemo(
    () => (core ? computeProgress(core, record, catalog) : null),
    [core, record, catalog]
  );

  const declaredMinors = useMemo(
    () => minorIds.map((id) => expanded.find((p) => p.id === id)).filter(Boolean) as Program[],
    [minorIds, expanded]
  );

  const minorProgress = useMemo(
    () => declaredMinors.map((m) => computeProgress(m, record, catalog)),
    [declaredMinors, record, catalog]
  );

  const unscorableMinors = useMemo(
    () => expanded.filter((p) => p.type === "minor" && !p.scorable),
    [expanded]
  );

  const rankings = useMemo(() => {
    const declared = [major, core, ...declaredMinors].filter(Boolean) as Program[];
    // Only minors are genuine add-ons. A concentration is a variant of a
    // major, so "add the Theatre Performance Concentration to your CS
    // degree" is not a thing that exists.
    //
    // And a minor has to be in a SECOND academic area — the catalog is
    // explicit about it — so a Computer Science major can't add a Computer
    // Science minor. Left in, it sorts to the top every time, because a
    // major covers its own minor almost entirely. The single most prominent
    // recommendation would be the one thing the student can't do.
    const candidates = expanded.filter(
      (p) =>
        p.id !== majorId &&
        !minorIds.includes(p.id) &&
        p.type === "minor" &&
        p.scorable &&
        !(major && sameAcademicArea(major.name, p.name))
    );
    return rankByFreeness(candidates, record, declared, catalog).slice(0, 12);
  }, [record, expanded, majorId, minorIds, major, core, declaredMinors, catalog]);

  // What the engine ACTUALLY allocated to each requirement. Rows must show
  // this rather than recomputing, or two requirements drawing on the same
  // pool each claim the same course and the display contradicts the maths.
  const majorAllocation = useMemo(() => {
    const empty = { satisfied: new Map<string, string[]>(), inProgress: new Map<string, string[]>() };
    if (!major) return empty;
    const doneSet = new Set(
      record.completedCourses.filter((c) => !c.inProgress).map((c) => c.code)
    );
    const doingSet = new Set(
      record.completedCourses.filter((c) => c.inProgress).map((c) => c.code)
    );
    return allocateCourses(major, doneSet, doingSet, catalog);
  }, [major, record, catalog]);

  /**
   * course code -> the requirement labels it would satisfy, across whatever
   * the student has declared. Built once so search can answer "does this
   * course count for anything?" without rescanning every program.
   */
  const requirementIndex = useMemo(() => {
    const index = new Map<string, string[]>();
    const add = (p: Program | null) => {
      if (!p) return;
      for (const g of flattenGroups(p)) {
        if (g.freeElective) continue;
        for (const code of g.options) {
          const list = index.get(code) ?? [];
          if (!list.includes(g.label)) list.push(g.label);
          index.set(code, list);
        }
      }
    };
    add(major);
    add(core);
    declaredMinors.forEach(add);
    return index;
  }, [major, core, declaredMinors]);

  // Live offerings, when the extension is present and the student asks for
  // them. Kept out of localStorage: seat counts go stale in minutes, and a
  // cached "4 seats left" is worse than no number at all.
  const [sections, setSections] = useState<SectionSyncResult | null>(null);

  const sectionsByCode = useMemo(() => {
    const map = new Map<string, Section[]>();
    for (const s of sections?.sections ?? []) {
      const list = map.get(s.code) ?? [];
      list.push(s);
      map.set(s.code, list);
    }
    return map;
  }, [sections]);

  // Which terms each course actually runs in — the "Fall / Spring" label.
  const termsByCode = useMemo(() => offeringsByCode(sections), [sections]);

  const plan = useMemo(() => {
    if (!personalized || !major || !majorProgress || !coreProgress) return null;
    const done = new Set(
      record.completedCourses.filter((c) => !c.inProgress).map((c) => c.code)
    );
    const doing = new Set(
      record.completedCourses.filter((c) => c.inProgress).map((c) => c.code)
    );
    const groupsById = new Map(
      [
        ...flattenGroups(major),
        ...(core ? flattenGroups(core) : []),
        ...declaredMinors.flatMap(flattenGroups),
      ].map((g) => [g.id, g])
    );
    return nextSteps(
      [majorProgress, coreProgress, ...minorProgress],
      groupsById,
      done,
      doing,
      catalog
    );
  }, [personalized, major, core, majorProgress, coreProgress, minorProgress, declaredMinors, record, catalog]);

  if (!hydrated) return null;

  const done = new Set(record.completedCourses.filter((c) => !c.inProgress).map((c) => c.code));
  const doing = new Set(record.completedCourses.filter((c) => c.inProgress).map((c) => c.code));

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Class Royale</h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          Every Franciscan program, what it actually requires, and which ones you could add
          almost for free. {programs.length} programs · {courses.length} courses ·{" "}
          {catalogYear} catalog.
        </p>
      </header>

      <div className="space-y-6">
        <Card>
          <label htmlFor="major" className="block text-sm font-medium">
            Pick your program
          </label>
          <select
            id="major"
            value={majorId}
            onChange={(e) => chooseMajor(e.target.value)}
            className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-black/30"
          >
            <option value="">Select a program…</option>
            {declarable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!personalized && (
            <p className="mt-2 text-xs text-black/45 dark:text-white/45">
              No login needed — this is the public catalog. Add your transcript below to see
              what you&apos;ve already knocked out, or{" "}
              <button
                onClick={loadSample}
                className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800 dark:text-emerald-400"
              >
                try a sample transcript
              </button>
              .
            </p>
          )}
          {sampleError && <p className="mt-2 text-xs text-amber-700">{sampleError}</p>}
          {isSample && (
            <p className="mt-2 text-xs text-black/45 dark:text-white/45">
              Showing a sample transcript with synthetic data. Nothing is saved.{" "}
              <button onClick={clearAll} className="text-emerald-700 hover:underline dark:text-emerald-400">
                Exit sample
              </button>
            </p>
          )}

          {declaredMinors.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-black/55 dark:text-white/55">Minors:</span>
              {declaredMinors.map((m) => (
                <button
                  key={m.id}
                  onClick={() => toggleMinor(m.id)}
                  title="Remove"
                  className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
                >
                  {m.name} ×
                </button>
              ))}
            </div>
          )}
        </Card>

        {personalized && transcript && (
          <div className="grid gap-6 sm:grid-cols-2">
            <Card>
              <h2 className="text-sm font-medium text-black/60 dark:text-white/60">Completed</h2>
              <p className="mt-1 text-3xl font-semibold">
                {transcript.summary.Career?.earnedCredits ?? 0}
                <span className="ml-1 text-base font-normal text-black/45 dark:text-white/45">
                  credits
                </span>
              </p>
              <p className="mt-1 text-sm text-black/50 dark:text-white/50">
                {done.size} courses · {doing.size} in progress
                {transcript.summary.Career?.gpa
                  ? ` · ${transcript.summary.Career.gpa.toFixed(2)} GPA`
                  : ""}
              </p>
            </Card>
            {coreProgress && core && (
              <Card>
                <h2 className="text-sm font-medium text-black/60 dark:text-white/60">{core.name}</h2>
                <p className="mt-1 text-3xl font-semibold">
                  {coreProgress.percentComplete}
                  <span className="ml-0.5 text-base font-normal text-black/45 dark:text-white/45">
                    %
                  </span>
                </p>
                <div className="mt-3">
                  <Bar pct={coreProgress.percentComplete} />
                </div>
                <p className="mt-2 text-sm text-black/50 dark:text-white/50">
                  {coreProgress.remainingGroups.length} requirement
                  {coreProgress.remainingGroups.length === 1 ? "" : "s"} left
                </p>
              </Card>
            )}
          </div>
        )}

        {major && majorProgress && (
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{major.name}</h2>
              {personalized ? (
                <span className="text-sm text-black/50 dark:text-white/50">
                  {majorProgress.percentComplete}% complete
                </span>
              ) : (
                <span className="text-sm text-black/45 dark:text-white/45">
                  {majorProgress.remainingGroups.length} requirements
                </span>
              )}
            </div>
            {personalized && (
              <div className="mt-3">
                <Bar pct={majorProgress.percentComplete} />
              </div>
            )}

            {major.requirementsFromSchedule && (
              <p className="mt-3 rounded-lg bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200/90">
                The catalog gives no requirements list for this program — only a suggested
                four-year schedule. These are read off that, so they include Core Curriculum
                courses and overlap the Core above.
              </p>
            )}

            {major.kind === "narrative" ? (
              <div className="mt-4 rounded-lg bg-black/[0.03] p-4 text-sm dark:bg-white/5">
                <p className="mb-2 font-medium">
                  The catalog states this program&apos;s requirements as prose, not a course
                  table — here it is verbatim:
                </p>
                {major.narrative?.map((n, i) => (
                  <p key={i} className="mt-2 text-black/70 dark:text-white/70">
                    {n}
                  </p>
                ))}
              </div>
            ) : (
              <RequirementList
                groups={major.requirements}
                catalog={catalog}
                personalized={personalized}
                allocation={majorAllocation.satisfied}
                inProgressAllocation={majorAllocation.inProgress}
              />
            )}
            {major.notes && major.notes.length > 0 && (
              <div className="mt-4 rounded-lg bg-black/[0.03] p-4 dark:bg-white/5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                  From the catalog page
                </h3>
                <ul className="mt-2 space-y-1.5 text-sm text-black/70 dark:text-white/70">
                  {major.notes.map((n, i) => (
                    <li key={i}>{n.text}</li>
                  ))}
                </ul>
              </div>
            )}

            {major.sourceUrl && (
              <a
                href={major.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block text-xs text-black/40 hover:underline dark:text-white/40"
              >
                Source: {major.department} catalog page ↗
              </a>
            )}
          </Card>
        )}

        {personalized && transcript && (
          <Planner
            transcript={transcript}
            program={major}
            templates={scheduleTemplates}
            courses={catalog}
          />
        )}

        {personalized && major && majorProgress && coreProgress && core && plan && (
          <NextUp
            ready={plan.ready}
            blocked={plan.blocked}
            sectionsByCode={sectionsByCode}
            termsByCode={termsByCode}
            sections={sections}
            onSync={setSections}
          />
        )}

        {personalized && major && majorProgress && coreProgress && core && (
          <WhatsLeft
            major={major}
            majorProgress={majorProgress}
            coreProgress={coreProgress}
            minors={declaredMinors}
            minorProgress={minorProgress}
            creditsEarned={transcript?.summary.Career?.earnedCredits ?? 0}
            creditsForDegree={
              graduationRules.find((r) => /minimum credit hours required for bacc/i.test(r.rule))
                ?.number ?? null
            }
          />
        )}

        {rankings.length > 0 && (
          <Card>
            <h2 className="font-semibold">
              {personalized ? "Cheapest minors to add" : "Cheapest minors to pair with this"}
            </h2>
            <p className="mt-1 text-sm text-black/55 dark:text-white/55">
              {personalized
                ? "Ranked by what you'd still have to take, counting courses you've finished and courses your major already forces on you."
                : major
                  ? "Ranked by how much your major already covers. Add your transcript below to factor in what you've actually taken."
                  : "Pick a major above to see which minors it nearly covers on its own."}
            </p>
            <ul className="mt-4 space-y-1">
              {rankings.map((r) => (
                <li
                  key={r.program.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/5 py-1.5 text-sm last:border-0 dark:border-white/5"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {r.program.name}
                    {r.overlappingCompleted.length > 0 && (
                      <Pill tone="done">{r.overlappingCompleted.length} already done</Pill>
                    )}
                    {r.overlappingWithDeclared.length > 0 && (
                      <Pill tone="free">{r.overlappingWithDeclared.length} free from major</Pill>
                    )}
                  </span>
                  <span className="flex items-center gap-3 whitespace-nowrap text-black/55 dark:text-white/55">
                    <button
                      onClick={() => toggleMinor(r.program.id)}
                      className="text-xs text-emerald-700 hover:underline dark:text-emerald-400"
                    >
                      + declare
                    </button>
                    {r.netNewCoursesNeeded} more course
                    {r.netNewCoursesNeeded === 1 ? "" : "s"}
                    {r.netNewCreditsNeeded > 0 && (
                      <span className="ml-1 text-black/40 dark:text-white/40">
                        · {r.netNewCreditsNeeded} cr
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-xs text-black/45 dark:text-white/45">
              A minor must be in a second academic area — &ldquo;a minor in a second
              academic area is available to students who are earning an undergraduate
              degree in a primary area&rdquo; — so minors in your own subject aren&apos;t
              listed. Ones sharing your department are, since the catalog doesn&apos;t
              define how far &ldquo;area&rdquo; reaches; check those with your advisor.
              A minor needs 18 credits, at least 6 earned at Franciscan in upper-level
              classes, and the catalog states no limit on a course counting toward both
              your major and a minor, so this assumes it can.
            </p>

            {unscorableMinors.length > 0 && (
              <div className="mt-5 border-t border-black/5 pt-4 dark:border-white/5">
                <p className="text-sm text-black/55 dark:text-white/55">
                  Not ranked — the catalog writes these as a paragraph instead of a course
                  list, so there&apos;s nothing to check against:
                </p>
                <ul className="mt-2 space-y-2 text-sm">
                  {unscorableMinors.map((p) => (
                    <li key={p.id}>
                      <a
                        href={p.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {p.name} ↗
                      </a>
                      {p.narrative?.[0] && (
                        <span className="ml-2 text-black/50 dark:text-white/50">
                          {p.narrative[0].slice(0, 110)}
                          {p.narrative[0].length > 110 ? "…" : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        <CourseSearch
          courses={courses}
          catalog={catalog}
          done={done}
          doing={doing}
          requirementIndex={requirementIndex}
        />

        <GraduationCard
          rules={graduationRules}
          degree={major?.degree}
          credits={transcript?.summary.Career?.earnedCredits ?? null}
          gpa={transcript?.summary.Career?.gpa ?? null}
          personalized={personalized}
        />

        <SyncPanel
          onLoad={saveTranscript}
          hasTranscript={personalized}
          onClear={clearAll}
          isSample={isSample}
          onSample={loadSample}
        />

        {personalized && transcript && transcript.warnings.length > 0 && (
          <Card className="border-amber-300/60 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-950/20">
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Worth checking
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-amber-900/80 dark:text-amber-200/80">
              {transcript.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Card>
        )}

        {personalized && transcript && (
          <Card>
            <h2 className="font-semibold">Classes taken</h2>
            <div className="mt-4 space-y-5">
              {transcript.terms.map((term) => (
                <div key={term.label}>
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-medium">{term.label}</h3>
                    {term.honors.map((h) => (
                      <Pill key={h} tone="done">
                        {h}
                      </Pill>
                    ))}
                  </div>
                  <table className="mt-2 w-full text-sm">
                    <tbody>
                      {term.courses.map((c, i) => (
                        <tr
                          key={`${c.code}-${i}`}
                          className="border-b border-black/5 dark:border-white/5"
                        >
                          <td className="py-1.5 pr-3 font-mono text-xs">{c.code}</td>
                          <td className="py-1.5 pr-3 text-black/70 dark:text-white/70">{c.title}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-black/50 dark:text-white/50">
                            {c.creditsEarned || c.attemptedCredits || 0}
                          </td>
                          <td className="w-16 py-1.5 text-right">
                            {c.inProgress ? (
                              <span className="text-black/40 dark:text-white/40">in progress</span>
                            ) : c.isTransfer ? (
                              <span className="text-sky-700 dark:text-sky-400">transfer</span>
                            ) : (
                              <span className="font-medium">{c.grade}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * One requirement row. When a student has a transcript loaded this has to
 * answer "am I done, and if so what did it" — a bare checkmark leaves them
 * guessing which of five alternatives counted.
 */
function RequirementRow({
  group,
  catalog,
  satisfiedBy,
  inProgressBy,
}: {
  group: RequirementGroup;
  catalog: Map<string, Course>;
  /** What the engine allocated here — not recomputed, so display and maths agree */
  satisfiedBy: string[];
  inProgressBy: string[];
}) {
  const [open, setOpen] = useState(false);
  const satisfied =
    group.unit === "credits"
      ? satisfiedBy.reduce((s, c) => s + (catalog.get(c)?.credits ?? 0), 0) >= group.count
      : satisfiedBy.length >= group.count;

  const expandable = group.options.length > 3;
  const shown = open ? group.options : group.options.slice(0, 3);

  return (
    <li className="border-b border-black/5 py-1.5 text-sm last:border-0 dark:border-white/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={satisfied ? "text-black/40 line-through decoration-black/20 dark:text-white/40" : ""}>
          {satisfied && <span className="mr-1.5 no-underline text-emerald-600">✓</span>}
          {group.label}
        </span>
        <span className="flex flex-wrap items-center justify-end gap-2 text-black/50 dark:text-white/50">
          {group.optionsFromCore && <Pill tone="muted">Core {group.coreCategories?.join("/")}</Pill>}
          {group.optionsFromNote && <Pill tone="muted">from catalog note</Pill>}
          {group.count > 1 && <Pill tone="muted">{group.count} {group.unit}</Pill>}
          {group.freeElective ? (
            <span>{group.count} {group.unit} — any course</span>
          ) : group.options.length === 0 ? (
            <span>{group.count} {group.unit} — no course list in the catalog</span>
          ) : (
            <span className="font-mono text-xs">
              {shown.join(" / ")}
              {expandable && !open && ` +${group.options.length - 3}`}
            </span>
          )}
          {expandable && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-emerald-700 hover:underline dark:text-emerald-400"
            >
              {open ? "less" : "all"}
            </button>
          )}
        </span>
      </div>

      {/* Which course actually counted — a checkmark alone isn't an answer. */}
      {(satisfiedBy.length > 0 || inProgressBy.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          {satisfiedBy.map((c) => (
            <span key={c} className="text-emerald-700 dark:text-emerald-400">
              ✓ {c}
              {catalog.get(c)?.title ? ` · ${catalog.get(c)!.title}` : ""}
            </span>
          ))}
          {inProgressBy.map((c) => (
            <span key={c} className="text-black/45 dark:text-white/45">
              ◷ {c} in progress
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * University-wide graduation requirements — the rules that hold regardless of
 * program, which the old system buried in a PDF. The two numeric ones can be
 * checked directly against a transcript; the rest are shown with the exact
 * catalog sentence they came from, because paraphrasing a graduation rule is
 * how you get someone to miss one.
 */
function GraduationCard({
  rules,
  degree,
  credits,
  gpa,
  personalized,
}: {
  rules: GraduationRule[];
  degree?: string;
  credits: number | null;
  gpa: number | null;
  personalized: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (rules.length === 0) return null;

  const relevant = rules.filter(
    (r) => r.appliesTo === "all" || !degree || r.appliesTo.includes(degree) || r.appliesTo === "undergraduate" || r.appliesTo === "bachelor's"
  );

  const creditRule = relevant.find((r) => /minimum credit hours required for bacc/i.test(r.rule));
  const gpaRule = relevant.find((r) => /minimum gpa in major and overall/i.test(r.rule));

  const check = (have: number | null, need: number | null) =>
    have == null || need == null ? null : have >= need;

  const creditsOk = check(credits, creditRule?.number ?? null);
  const gpaOk = check(gpa, gpaRule?.number ?? null);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">To graduate</h2>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-sm text-emerald-700 hover:underline dark:text-emerald-400"
        >
          {open ? "Show less" : `All ${relevant.length} rules`}
        </button>
      </div>

      <ul className="mt-3 space-y-1.5">
        {creditRule && (
          <RuleRow
            ok={creditsOk}
            label={
              personalized && credits != null
                ? `${credits} of ${creditRule.number} credits`
                : `${creditRule.number} credits total`
            }
          />
        )}
        {gpaRule && (
          <RuleRow
            ok={gpaOk}
            label={
              personalized && gpa != null
                ? `${gpa.toFixed(2)} GPA — ${gpaRule.number} required, in the major and overall`
                : `${gpaRule.number} GPA minimum, in the major and overall`
            }
          />
        )}
        {!open &&
          relevant
            .filter((r) => r !== creditRule && r !== gpaRule)
            .slice(0, 3)
            .map((r, i) => <RuleRow key={i} ok={null} label={r.rule} />)}
      </ul>

      {open && (
        <div className="mt-4 space-y-3 border-t border-black/5 pt-4 dark:border-white/5">
          {relevant
            .filter((r) => r !== creditRule && r !== gpaRule)
            .map((r, i) => (
              <div key={i} className="text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>{r.rule}</span>
                  <span className="text-xs text-black/40 dark:text-white/40">
                    {r.appliesTo !== "all" ? r.appliesTo : ""}
                  </span>
                </div>
                <p className="mt-0.5 text-xs italic text-black/45 dark:text-white/45">
                  &ldquo;{r.evidence}&rdquo;
                </p>
              </div>
            ))}
        </div>
      )}
      {!personalized && (
        <p className="mt-3 text-xs text-black/45 dark:text-white/45">
          Add your transcript below to check these against your own record.
        </p>
      )}
    </Card>
  );
}

/**
 * The one screen the old system doesn't give you: everything still standing
 * between you and a degree, in one list.
 *
 * Major rows that merely point at a Core category are dropped here — the Core
 * card already lists those, and showing "Theology Core" twice makes a student
 * think they owe it twice.
 */
function WhatsLeft({
  major,
  majorProgress,
  coreProgress,
  minors,
  minorProgress,
  creditsEarned,
  creditsForDegree,
}: {
  major: Program;
  majorProgress: ProgramProgress;
  coreProgress: ProgramProgress;
  minors: Program[];
  minorProgress: ProgramProgress[];
  creditsEarned: number;
  creditsForDegree: number | null;
}) {
  const byId = new Map(major.requirements.map((g) => [g.id, g]));
  const majorLeft = majorProgress.remainingGroups.filter((g) => {
    const src = byId.get(g.groupId);
    // Skip rows that are just a pointer at the Core Curriculum — the Core
    // section below already accounts for them.
    return !src?.optionsFromCore;
  });
  const coreLeft = coreProgress.remainingGroups;

  const creditsLeft =
    creditsForDegree != null ? Math.max(0, creditsForDegree - creditsEarned) : null;

  return (
    <Card className="border-emerald-600/25 bg-emerald-50/40 dark:border-emerald-500/20 dark:bg-emerald-950/15">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">What&apos;s left</h2>
        {creditsLeft != null && (
          <span className="text-sm text-black/55 dark:text-white/55">
            {creditsLeft} credits to {creditsForDegree}
          </span>
        )}
      </div>

      {majorLeft.length === 0 && coreLeft.length === 0 ? (
        <p className="mt-3 text-sm text-emerald-800 dark:text-emerald-300">
          Every requirement in your major and the Core Curriculum is satisfied.
          {creditsLeft ? ` You still need ${creditsLeft} credits to reach ${creditsForDegree}.` : ""}
        </p>
      ) : (
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              {major.name.split(",")[0]} · {majorLeft.length} left
            </h3>
            <ul className="mt-2">
              {majorLeft.map((g) => (
                <LeftItem
                  key={g.groupId}
                  label={g.label}
                  need={g.stillNeeded}
                  unit={g.unit}
                  options={g.eligibleOptions}
                />
              ))}
              {majorLeft.length === 0 && (
                <li className="py-1.5 text-sm text-emerald-700 dark:text-emerald-400">All done.</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              Core Curriculum · {coreLeft.length} left
            </h3>
            <ul className="mt-2">
              {coreLeft.map((g) => (
                <LeftItem
                  key={g.groupId}
                  label={g.label}
                  need={g.stillNeeded}
                  unit={g.unit}
                  options={g.eligibleOptions}
                />
              ))}
              {coreLeft.length === 0 && (
                <li className="py-1.5 text-sm text-emerald-700 dark:text-emerald-400">All done.</li>
              )}
            </ul>
          </div>
        </div>
      )}

      {minors.length > 0 && (
        <div className="mt-6 border-t border-black/5 pt-4 dark:border-white/5">
          <div className="grid gap-6 sm:grid-cols-2">
            {minors.map((m, i) => (
              <div key={m.id}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
                  {m.name} · {minorProgress[i]?.remainingGroups.length ?? 0} left
                </h3>
                <ul className="mt-2">
                  {(minorProgress[i]?.remainingGroups ?? []).map((g) => (
                    <LeftItem
                      key={g.groupId}
                      label={g.label}
                      need={g.stillNeeded}
                      unit={g.unit}
                      options={g.eligibleOptions}
                    />
                  ))}
                  {(minorProgress[i]?.remainingGroups.length ?? 0) === 0 && (
                    <li className="py-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                      All done.
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * What to actually register for. Everything here satisfies something still
 * outstanding AND has no unmet prerequisite, so it's a list you can act on
 * rather than a list of gaps.
 */
function NextUp({
  ready,
  blocked,
  sectionsByCode,
  termsByCode,
  sections,
  onSync,
}: {
  ready: Candidate[];
  blocked: Candidate[];
  sectionsByCode: Map<string, Section[]>;
  termsByCode: Map<string, TermOption[]>;
  sections: SectionSyncResult | null;
  onSync: (r: SectionSyncResult) => void;
}) {
  const [showBlocked, setShowBlocked] = useState(false);
  const [ext, setExt] = useState<ExtensionInfo>({ present: false, supports: [] });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    detectExtensionInfo().then(setExt);
  }, []);

  const canLoadSections = ext.present && ext.supports.includes("SECTION_PAGE");
  // Reading a second term needs the term-switch message. Without it the sync
  // still works, it just can only speak for the term the portal has selected —
  // which is exactly the "not this term" answer this replaced.
  const canReadOtherTerms = ext.present && ext.supports.includes("TERM_PAGE");

  async function loadSections() {
    setLoading(true);
    setProgress("Reading the registration page…");
    const result = await syncSections((loaded, total, termLabel) =>
      setProgress(
        `${termLabel ? `${termLabel}: ` : ""}${loaded}${total ? ` of ${total}` : ""} sections…`
      )
    );
    setLoading(false);
    setProgress(null);
    onSync(result);
  }

  if (ready.length === 0 && blocked.length === 0) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Ready to take</h2>
        <span className="text-sm text-black/50 dark:text-white/50">
          {ready.length} course{ready.length === 1 ? "" : "s"} you&apos;re eligible for
        </span>
      </div>
      <p className="mt-1 text-sm text-black/55 dark:text-white/55">
        Each of these clears something you still need, and you&apos;ve met its
        prerequisites.
        {!sections &&
          " Which terms each one actually runs in is a separate question — load live offerings to answer it."}
      </p>

      {canLoadSections && !canReadOtherTerms && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Your Sync extension ({ext.version ?? "0.2.x"}) is older than {EXPECTED_EXTENSION} and can only read the term
          Franciscan currently has selected, so courses that run in the other
          semester will look like they aren&apos;t offered. Reload it at{" "}
          <code className="font-mono text-xs">opera://extensions</code> — the ↻ on its card —
          then reload this page to see both.
        </p>
      )}

      {ext.present && !canLoadSections && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Your Class Royale Sync extension is version {ext.version ?? "0.1.x"} and doesn&apos;t
          know how to read offerings yet. Reload it at{" "}
          <code className="font-mono text-xs">opera://extensions</code> — the ↻ on its card —
          then reload this page.
        </p>
      )}

      {canLoadSections && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={loadSections}
            disabled={loading}
            className="rounded-lg border border-emerald-700/40 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
          >
            {loading ? "Loading…" : sections ? "Refresh offerings" : "Load what's offered now"}
          </button>
          {progress && <span className="text-xs text-black/50 dark:text-white/50">{progress}</span>}
          <span
            className="font-mono text-[10px] text-black/30 dark:text-white/30"
            title="App build · extension version. If these look old, the update didn't land."
          >
            {APP_BUILD} · ext {ext.version ?? "none"}
            {ext.present && ext.version !== EXPECTED_EXTENSION ? " (old)" : ""}
          </span>
          {sections && !loading && (
            <span className="text-xs text-black/50 dark:text-white/50">
              {sections.sections.length} sections
              {sections.terms.length > 0
                ? ` · ${sections.terms.map((t) => t.label).join(" + ")}`
                : sections.allTerms.length > 0
                  ? // Nothing came back, so say what the portal actually
                    // offered — otherwise "which terms did it even try?" is
                    // another round trip.
                    ` · portal lists ${sections.allTerms.map((t) => t.label).join(", ")}`
                  : ""}
              {sections.truncated && " · partial"}
            </span>
          )}
        </div>
      )}
      {sections?.error && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {sections.error}
        </p>
      )}

      <ul className="mt-3">
        {ready.map((c) => (
          <CandidateRow
            key={c.code}
            c={c}
            sections={sectionsByCode.get(c.code)}
            offeredIn={termsByCode.get(c.code)}
            coveredTerms={sections?.terms ?? []}
            sectionsLoaded={!!sections?.ok}
          />
        ))}
      </ul>

      {blocked.length > 0 && (
        <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/5">
          <button
            onClick={() => setShowBlocked((v) => !v)}
            className="text-sm text-emerald-700 hover:underline dark:text-emerald-400"
          >
            {showBlocked ? "Hide" : `${blocked.length} more, once you've cleared prerequisites`}
          </button>
          {showBlocked && (
            <ul className="mt-2">
              {blocked.map((c) => (
                <CandidateRow
                  key={c.code}
                  c={c}
                  dim
                  sections={sectionsByCode.get(c.code)}
                  offeredIn={termsByCode.get(c.code)}
                  coveredTerms={sections?.terms ?? []}
                  sectionsLoaded={!!sections?.ok}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * A program's requirements, with finished ones folded away by default.
 *
 * Listing all thirty rows flat buries the handful that still matter — and
 * "What's left" already restates the outstanding ones, so an uncollapsed list
 * shows a student the same work twice.
 */
function RequirementList({
  groups,
  catalog,
  personalized,
  allocation,
  inProgressAllocation,
}: {
  groups: RequirementGroup[];
  catalog: Map<string, Course>;
  personalized: boolean;
  allocation: Map<string, string[]>;
  inProgressAllocation: Map<string, string[]>;
}) {
  const [showDone, setShowDone] = useState(false);

  const isSatisfied = (g: RequirementGroup) => {
    if (!personalized) return false;
    const hits = allocation.get(g.id) ?? [];
    if (hits.length === 0) return false;
    if (g.unit === "credits") {
      return hits.reduce((s, c) => s + (catalog.get(c)?.credits ?? 0), 0) >= g.count;
    }
    return hits.length >= g.count;
  };

  const satisfied = groups.filter(isSatisfied);
  const outstanding = groups.filter((g) => !isSatisfied(g));

  // Preserve the catalog's own sub-headings ("Language-Skills Courses",
  // "Content Courses") rather than flattening everything into one list.
  const bySubgroup = (list: RequirementGroup[]) => {
    const out = new Map<string, RequirementGroup[]>();
    for (const g of list) {
      const key = g.subgroups ? g.label : "";
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(g);
    }
    return out;
  };

  const render = (list: RequirementGroup[]) =>
    [...bySubgroup(list)].map(([heading, items]) => (
      <div key={heading || "_"} className={heading ? "mt-4 first:mt-0" : ""}>
        {heading && (
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
            {heading}
          </h3>
        )}
        <ul>
          {items.flatMap((g) =>
            g.subgroups
              ? g.subgroups.map((sub) => (
                  <RequirementRow
                    key={sub.id}
                    group={sub}
                    catalog={catalog}
                    satisfiedBy={allocation.get(sub.id) ?? []}
                    inProgressBy={inProgressAllocation.get(sub.id) ?? []}
                  />
                ))
              : [
                  <RequirementRow
                    key={g.id}
                    group={g}
                    catalog={catalog}
                    satisfiedBy={allocation.get(g.id) ?? []}
                    inProgressBy={inProgressAllocation.get(g.id) ?? []}
                  />,
                ]
          )}
        </ul>
      </div>
    ));

  return (
    <div className="mt-4">
      {render(outstanding)}
      {outstanding.length === 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          Every requirement satisfied.
        </p>
      )}

      {satisfied.length > 0 && (
        <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/5">
          <button
            onClick={() => setShowDone((v) => !v)}
            className="text-sm text-emerald-700 hover:underline dark:text-emerald-400"
          >
            {showDone ? "Hide" : `${satisfied.length} already satisfied`}
          </button>
          {showDone && <div className="mt-2">{render(satisfied)}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Look up any course in the catalogue. The useful part isn't the search — it's
 * that each result says whether the course counts toward anything you're
 * actually doing, and whether you can take it yet.
 */
/** Marks a course an undergraduate can't register for. */
function LevelNote({ course }: { course: Course }) {
  if (course.level !== "graduate") return null;
  // Shown rather than hidden: the 2026-2027 catalog merged the graduate book
  // in, and a search that silently drops results teaches a student the course
  // doesn't exist. What matters is that these never reach a requirement's
  // options — see matchesSubjectRule.
  return <Pill tone="muted">graduate</Pill>;
}

function CourseSearch({
  courses,
  catalog,
  done,
  doing,
  requirementIndex,
}: {
  courses: Course[];
  catalog: Map<string, Course>;
  done: Set<string>;
  doing: Set<string>;
  requirementIndex: Map<string, string[]>;
}) {
  const [query, setQuery] = useState("");
  const [onlyCounts, setOnlyCounts] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits = courses.filter((c) => {
      if (onlyCounts && !requirementIndex.has(c.code)) return false;
      return (
        c.code.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q)
      );
    });
    // Courses that count toward something you're doing come first.
    return hits
      .sort((a, b) => {
        const ca = requirementIndex.get(a.code)?.length ?? 0;
        const cb = requirementIndex.get(b.code)?.length ?? 0;
        return cb - ca || a.code.localeCompare(b.code);
      })
      .slice(0, 30);
  }, [query, courses, onlyCounts, requirementIndex]);

  return (
    <Card>
      <h2 className="font-semibold">Find a course</h2>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Course code or title — try 'cyber' or 'MTH 3'"
          className="min-w-[16rem] flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-black/30"
        />
        <label className="flex items-center gap-2 text-sm text-black/60 dark:text-white/60">
          <input
            type="checkbox"
            checked={onlyCounts}
            onChange={(e) => setOnlyCounts(e.target.checked)}
            className="accent-emerald-700"
          />
          Only ones that count for me
        </label>
      </div>

      {query.trim().length >= 2 && (
        <ul className="mt-3">
          {results.map((c) => {
            const satisfies = requirementIndex.get(c.code) ?? [];
            const taken = done.has(c.code);
            const enrolled = doing.has(c.code);
            const missing = (c.prerequisites ?? []).filter((p) => !done.has(p));
            const blocked =
              missing.length > 0 && !/ or /i.test(c.prerequisiteText ?? "")
                ? missing
                : missing.length === (c.prerequisites ?? []).length && missing.length > 0
                  ? missing
                  : [];

            return (
              <li
                key={c.code}
                className="border-b border-black/5 py-2 text-sm last:border-0 dark:border-white/5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-mono text-xs">{c.code}</span>{" "}
                    <span className="text-black/70 dark:text-white/70">{c.title}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <LevelNote course={c} />
                    {taken && <Pill tone="done">taken</Pill>}
                    {enrolled && <Pill tone="muted">in progress</Pill>}
                    {satisfies.length > 0 && !taken && <Pill tone="free">counts</Pill>}
                    <span className="tabular-nums text-black/45 dark:text-white/45">
                      {c.credits} cr
                    </span>
                  </span>
                </div>
                {(satisfies.length > 0 || blocked.length > 0 || c.crossListed?.length) && (
                  <div className="mt-0.5 text-xs text-black/45 dark:text-white/45">
                    {satisfies.length > 0 && (
                      <span>
                        {satisfies.slice(0, 2).join(" · ")}
                        {satisfies.length > 2 && ` · +${satisfies.length - 2}`}
                      </span>
                    )}
                    {c.crossListed?.length ? (
                      <span className="ml-2">· also {c.crossListed.join(", ")}</span>
                    ) : null}
                    {blocked.length > 0 && (
                      <span className="ml-2 text-amber-700 dark:text-amber-500">
                        needs {blocked.join(", ")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="py-2 text-sm text-black/50 dark:text-white/50">
              Nothing matching {onlyCounts ? " that counts toward what you're doing" : ""}.
            </li>
          )}
        </ul>
      )}
      {catalog.size > 0 && query.trim().length < 2 && (
        <p className="mt-2 text-xs text-black/45 dark:text-white/45">
          {catalog.size} courses. Results show what each one would count toward and whether
          you&apos;ve met its prerequisites.
        </p>
      )}
    </Card>
  );
}
