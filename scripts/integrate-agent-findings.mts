// Validates agent-extracted catalog data against the source text and writes
// only what survives to data/derived/.
//
//   tsx scripts/integrate-agent-findings.mts
//
// The agents that produced this data are cheap models, and the adversarial
// verifiers found 2 fabrications, 9 wrong scopings and 18 questionable calls
// among them. So NOTHING here is taken on trust: every claim is re-checked
// mechanically against the source file it came from. An `evidence` quote that
// isn't verbatim in the source, or a course code that doesn't appear on the
// page, is dropped — not flagged, dropped.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const TEXT = "/tmp/agent-input/text";
const RAW = "/tmp/agent-out/raw.json";
const OUT = "data/derived";

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[""]/g, '"').replace(/['']/g, "'").trim();

interface Dropped { what: string; why: string }
const dropped: Dropped[] = [];

async function loadSources(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of await readdir(TEXT)) {
    map.set(f.replace(/\.txt$/, ""), norm(await readFile(path.join(TEXT, f), "utf8")));
  }
  return map;
}

/** An evidence quote must appear verbatim in its source, else the rule goes. */
function evidenceHolds(evidence: string, source: string | undefined): boolean {
  if (!source || !evidence) return false;
  return source.includes(norm(evidence));
}

/**
 * Derive `appliesTo` from the evidence itself rather than trusting the
 * agent's label — that field was wrong on 9 of the extracted rules, including
 * five GRADUATE program rules tagged as undergraduate "BS".
 */
function scopeFromEvidence(evidence: string): string {
  const e = evidence.toLowerCase();
  if (/\bgraduate\b/.test(e) && !/undergraduate/.test(e)) return "graduate (not undergrad)";
  if (/\bassociate degree\b/.test(e) && /baccalaureate/.test(e)) return "all";
  if (/\bassociate degree\b/.test(e)) return "AA/AS";
  if (/bachelor of arts/.test(e)) return "BA";
  if (/bachelor of science/.test(e)) return "BS";
  if (/baccalaureate/.test(e)) return "bachelor's";
  if (/\bminor\b/.test(e)) return "minors";
  if (/undergraduate/.test(e)) return "undergraduate";
  return "all";
}

async function main() {
  const sources = await loadSources();
  const raw = JSON.parse(await readFile(RAW, "utf8"));

  // ---------- graduation rules ----------
  const graduation: unknown[] = [];
  for (const page of raw.graduation ?? []) {
    const src = sources.get(page.page);
    for (const r of page.rules ?? []) {
      if (!evidenceHolds(r.evidence, src)) {
        dropped.push({ what: `grad: ${r.rule}`, why: "evidence not verbatim in source" });
        continue;
      }
      graduation.push({
        rule: r.rule,
        number: r.number ?? null,
        unit: r.unit ?? null,
        appliesTo: scopeFromEvidence(r.evidence), // recomputed, not trusted
        evidence: norm(r.evidence),
        source: page.page,
      });
    }
  }

  // ---------- prose-only programs ----------
  const programs: unknown[] = [];
  for (const p of raw.programs ?? []) {
    const slugCandidates = [...sources.keys()].filter((k) => k.startsWith("prog-"));
    const src = slugCandidates
      .map((k) => sources.get(k)!)
      .find((text) => text.toLowerCase().includes(p.program.toLowerCase().slice(0, 18)));
    if (!src) {
      dropped.push({ what: `program: ${p.program}`, why: "could not locate its source text" });
      continue;
    }
    const reqs = [];
    for (const r of p.requirements ?? []) {
      if (!evidenceHolds(r.evidence, src)) {
        dropped.push({ what: `${p.program} / ${r.label}`, why: "evidence not verbatim" });
        continue;
      }
      const bad = (r.options ?? []).filter((c: string) => !src.includes(c));
      if (bad.length > 0) {
        dropped.push({ what: `${p.program} / ${r.label}`, why: `course codes not on page: ${bad.join(", ")}` });
        continue;
      }
      reqs.push({
        label: r.label,
        count: r.count,
        unit: r.unit,
        options: r.options ?? [],
        subjectRule: r.subjectRule ?? null,
        evidence: norm(r.evidence),
      });
    }
    if (reqs.length > 0) {
      programs.push({ program: p.program, totalCredits: p.totalCredits ?? null, requirements: reqs });
    } else {
      dropped.push({ what: `program: ${p.program}`, why: "no requirement survived validation" });
    }
  }

  // ---------- elective rules ----------
  // Build subject -> department names from the scraped catalog, so we can
  // check that a claimed prefix is actually implied by the label rather than
  // guessed. This is what caught "Theatre Elective" -> THE (THE is THEOLOGY
  // here; Theatre is THR).
  const catalogDir = path.join("data", "catalog");
  const year = (await readdir(catalogDir)).sort().at(-1)!;
  const subjectDepts = new Map<string, Set<string>>();
  for (const f of (await readdir(path.join(catalogDir, year))).filter((x) => !x.startsWith("_"))) {
    const d = JSON.parse(await readFile(path.join(catalogDir, year, f), "utf8"));
    for (const prog of d.programs) {
      for (const slot of prog.slots ?? []) {
        for (const code of slot.codes) {
          const m = code.match(/^([A-Z]{2,4})\s/);
          if (!m) continue;
          if (!subjectDepts.has(m[1])) subjectDepts.set(m[1], new Set());
          subjectDepts.get(m[1])!.add(d.department.toLowerCase());
        }
      }
    }
  }

  // label -> the programs it appears in, from the same input the agents got
  const labelPrograms = new Map<string, string[]>();
  try {
    const src = JSON.parse(await readFile("/tmp/agent-input/elective-labels.json", "utf8"));
    for (const l of src.labels ?? []) labelPrograms.set(l.label, l.programs ?? []);
  } catch {
    // context unavailable — the check just gets stricter, which is the safe direction
  }

  const electives: unknown[] = [];
  for (const batch of raw.electives ?? []) {
    for (const r of batch.resolved ?? []) {
      if (!r.confident) continue;
      const subjects: string[] = r.subjects ?? [];
      if (subjects.length === 0) continue;
      const label = r.label.toLowerCase();

      // A claimed subject is supported when the label names it, OR when the
      // programs the label appears in are taught by a department that owns
      // that prefix. Context matters: "Courts and the Judiciary Elective"
      // never says "criminal justice", but it only appears in Criminal
      // Justice degrees, so CRJ is sound. Matching on a 6-char stem so
      // "mathematics" in a label matches the "Mathematical Science"
      // department.
      const context = (labelPrograms.get(r.label) ?? []).join(" ").toLowerCase();
      const stem = (text: string) => text.split("(")[0].trim().slice(0, 6).toLowerCase();

      const unsupported = subjects.filter((s) => {
        if (label.includes(s.toLowerCase())) return false; // prefix named outright
        const depts = subjectDepts.get(s);
        if (!depts) return true; // not a real subject at this university
        for (const d of depts) {
          const st = stem(d);
          if (st.length < 4) continue;
          if (label.includes(st)) return false; // department named in the label
          if (context.includes(st)) return false; // implied by the programs it appears in
        }
        return true;
      });

      if (unsupported.length > 0) {
        dropped.push({
          what: `elective: ${r.label}`,
          why: `subject ${unsupported.join(", ")} not implied by the label`,
        });
        continue;
      }
      electives.push({
        label: r.label,
        subjects,
        minLevel: r.minLevel ?? null,
        maxLevel: r.maxLevel ?? null,
        reasoning: r.reasoning,
      });
    }
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(
    path.join(OUT, "graduation-requirements.json"),
    JSON.stringify({ catalogYear: year, rules: graduation }, null, 2)
  );
  await writeFile(
    path.join(OUT, "prose-programs.json"),
    JSON.stringify({ catalogYear: year, programs }, null, 2)
  );
  await writeFile(
    path.join(OUT, "elective-rules.json"),
    JSON.stringify({ catalogYear: year, rules: electives }, null, 2)
  );
  await writeFile(path.join(OUT, "_dropped.json"), JSON.stringify(dropped, null, 2));

  console.log(`graduation rules kept   ${graduation.length}`);
  console.log(`prose programs kept     ${programs.length}`);
  console.log(`elective rules kept     ${electives.length}`);
  console.log(`DROPPED                 ${dropped.length}  (see ${OUT}/_dropped.json)`);
  console.log();
  for (const d of dropped.slice(0, 14)) console.log(`  - ${d.what}: ${d.why}`);
}

main();
