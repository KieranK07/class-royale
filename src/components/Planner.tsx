"use client";

// The degree plan, term by term.
//
// Left of the divider is the student's own transcript — real terms, real
// grades. Right of it is a proposal built from the department's published
// four-year schedule. Keeping those visually distinct is most of what makes
// the proposal believable: nobody has to wonder which part is a claim.

import { useMemo, useState } from "react";
import type { Course, Program } from "@/lib/types";
import type { TranscriptData } from "@/lib/transcript";
import type { ScheduleTemplate } from "@/lib/schedules";
import { buildPlan, type PlanEntry, type PlanTerm } from "@/lib/plan";

function Pill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "done" | "warn" | "slot";
}) {
  const tones = {
    muted: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
    done: "bg-emerald-600/10 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300",
    warn: "bg-amber-500/10 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300",
    slot: "bg-sky-500/10 text-sky-800 dark:bg-sky-400/10 dark:text-sky-300",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** One course or unfilled slot inside a term column. */
function EntryRow({ entry, past }: { entry: PlanEntry; past: boolean }) {
  const [open, setOpen] = useState(false);
  const isSlot = entry.kind !== "course";
  const name = isSlot ? entry.label : entry.codes.join(" / ");

  return (
    <li className="border-b border-black/5 py-1 last:border-0 dark:border-white/5">
      <button
        onClick={() => entry.reason && setOpen((v) => !v)}
        className={`flex w-full items-baseline justify-between gap-2 text-left ${
          entry.reason ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="min-w-0">
          <span
            className={`font-mono text-xs ${
              isSlot
                ? "italic text-sky-800 dark:text-sky-300"
                : past
                  ? "text-black/60 dark:text-white/55"
                  : ""
            }`}
          >
            {name}
          </span>
          {entry.title && !isSlot && (
            <span className="ml-1 text-[11px] text-black/45 dark:text-white/45">{entry.title}</span>
          )}
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-black/40 dark:text-white/40">
          {entry.credits ?? "—"}
        </span>
      </button>
      {open && entry.reason && (
        <p className="pb-1 text-[11px] text-black/50 dark:text-white/50">{entry.reason}</p>
      )}
    </li>
  );
}

function TermColumn({ term }: { term: PlanTerm }) {
  const past = term.kind === "past";
  const heavy = term.credits > 17;
  return (
    <div
      className={`w-56 shrink-0 rounded-lg border p-3 ${
        past
          ? "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.02]"
          : "border-emerald-700/25 bg-emerald-50/40 dark:border-emerald-400/20 dark:bg-emerald-950/10"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{term.label}</span>
        <span
          className={`tabular-nums text-xs ${
            heavy ? "text-amber-700 dark:text-amber-400" : "text-black/45 dark:text-white/45"
          }`}
        >
          {term.credits} cr
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-black/40 dark:text-white/40">
        {past ? (
          <>taken{term.gpa != null ? ` · ${term.gpa.toFixed(2)} GPA` : ""}</>
        ) : (
          "planned"
        )}
      </div>
      {term.entries.length === 0 ? (
        <p className="mt-2 text-[11px] italic text-black/35 dark:text-white/35">
          nothing you&apos;re eligible for is offered
        </p>
      ) : (
        <ul className="mt-2">
          {term.entries.map((e) => (
            <EntryRow key={e.id} entry={e} past={past} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function Planner({
  transcript,
  program,
  templates,
  courses,
}: {
  transcript: TranscriptData | null;
  program: Program | null;
  templates: ScheduleTemplate[];
  courses: Map<string, Course>;
}) {
  const template = useMemo(
    () => templates.find((t) => t.name === program?.name) ?? null,
    [templates, program]
  );

  const plan = useMemo(
    () =>
      transcript
        ? buildPlan({ transcriptTerms: transcript.terms, template, courses })
        : null,
    [transcript, template, courses]
  );

  const [showPast, setShowPast] = useState(false);

  if (!transcript) return null;
  if (!plan) return null;

  const pastTerms = plan.terms.filter((t) => t.kind === "past");
  const futureTerms = plan.terms.filter((t) => t.kind === "future");
  const shown = showPast ? plan.terms : futureTerms;

  return (
    <section className="rounded-xl border border-black/10 bg-white/60 p-5 dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Your degree, term by term</h2>
        <span className="text-sm text-black/50 dark:text-white/50">
          {plan.earnedCredits} earned · {plan.plannedCredits} planned ·{" "}
          {plan.earnedCredits + plan.plannedCredits} total
        </span>
      </div>

      {template ? (
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          Laid out from the catalog&apos;s own four-year schedule for{" "}
          <span className="font-medium">{template.name}</span>, with everything
          you&apos;ve already taken removed. It&apos;s the department&apos;s intended path —
          not a promise about what will be offered four years from now.
        </p>
      ) : (
        <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {program
            ? `The catalog doesn't publish a four-year schedule for ${program.name}, so there's nothing to lay the rest of the degree out from.`
            : "Pick a program to plan the rest of your degree."}
        </p>
      )}

      {plan.warnings.map((w) => (
        <p
          key={w}
          className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {w}
        </p>
      ))}

      {pastTerms.length > 0 && (
        <button
          onClick={() => setShowPast((v) => !v)}
          className="mt-3 text-sm text-emerald-700 hover:underline dark:text-emerald-400"
        >
          {showPast
            ? "Hide the terms you've finished"
            : `Show the ${pastTerms.length} term${pastTerms.length === 1 ? "" : "s"} you've finished`}
        </button>
      )}

      {shown.length > 0 && (
        <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
          {shown.map((t) => (
            <TermColumn key={t.key} term={t} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-black/45 dark:text-white/45">
        <span className="flex items-center gap-1">
          <Pill tone="slot">italic</Pill> a requirement you choose a course for
        </span>
        <span>· click any course with a note to see why it&apos;s there</span>
      </div>

      {plan.unplaced.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-50/60 p-3 dark:border-amber-400/20 dark:bg-amber-950/20">
          <h3 className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {plan.unplaced.length} thing{plan.unplaced.length === 1 ? "" : "s"} couldn&apos;t be
            scheduled
          </h3>
          <p className="mt-0.5 text-[11px] text-amber-900/70 dark:text-amber-200/70">
            Listed rather than dropped — a plan that hides a requirement to look
            finished is worse than one that admits it ran out of room.
          </p>
          <ul className="mt-2 space-y-1">
            {plan.unplaced.map((u) => (
              <li key={u.id} className="text-xs text-amber-900 dark:text-amber-200">
                <span className="font-mono">{u.codes[0] ?? u.label}</span>
                <span className="ml-2 text-amber-900/70 dark:text-amber-200/70">{u.blockedBy}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
