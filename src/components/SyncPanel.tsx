"use client";

import { useEffect, useState } from "react";
import { parseTranscript, type TranscriptData } from "@/lib/transcript";
import {
  detectExtension,
  syncTranscript,
  openLogin,
  uninstallExtension,
  type SyncResult,
} from "@/lib/extension-bridge";

const TRANSCRIPT_URL =
  "https://myfranciscan.franciscan.edu/ICS/Registration/New_Undergraduate.jnz?portlet=My_Unofficial_Transcript&hideUI=1";

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.07] text-[11px] font-semibold tabular-nums dark:bg-white/10">
        {n}
      </span>
      <span className="text-black/70 dark:text-white/70">{children}</span>
    </li>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-black/15 bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] dark:border-white/20 dark:bg-white/10">
      {children}
    </kbd>
  );
}

export function SyncPanel({
  onLoad,
  hasTranscript,
  onClear,
  isSample,
  onSample,
}: {
  onLoad: (data: TranscriptData) => void;
  hasTranscript: boolean;
  onClear: () => void;
  isSample: boolean;
  onSample: () => void;
}) {
  const [hasExtension, setHasExtension] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [html, setHtml] = useState("");

  useEffect(() => {
    detectExtension().then(setHasExtension);
  }, []);

  function ingest(rawHtml: string): boolean {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    const data = parseTranscript(doc);
    if (data.courses.length === 0) {
      setStatus(
        data.warnings[0] ??
          "No courses found in that page. Make sure it's the transcript itself, not the portal page around it."
      );
      return false;
    }
    onLoad(data);
    setStatus(`Synced ${data.courses.length} courses.`);
    setShowManual(false); // collapse the paste steps once they've worked
    setHtml("");
    return true;
  }

  async function handleSync() {
    setBusy(true);
    setStatus(null);
    const result: SyncResult = await syncTranscript();
    setBusy(false);

    if (result.ok) {
      ingest(result.html);
      return;
    }
    if (result.reason === "auth") {
      setStatus("You're not logged in to Franciscan. Opening the login page — log in, then hit Sync again.");
      openLogin();
      return;
    }
    setStatus(
      result.reason === "timeout"
        ? "The extension didn't respond. Try reloading this page."
        : `Couldn't reach Franciscan (${result.message ?? result.reason}).`
    );
  }

  // ---- sample loaded ----
  if (hasTranscript && isSample) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-black/55 dark:text-white/55">
          Showing a sample transcript (synthetic data).
        </span>
        <button onClick={onClear} className="text-emerald-700 hover:underline dark:text-emerald-400">
          Exit sample
        </button>
      </div>
    );
  }

  // ---- already have data ----
  if (hasTranscript) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {hasExtension ? (
          <button
            onClick={handleSync}
            disabled={busy}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy ? "Syncing…" : "Re-sync"}
          </button>
        ) : (
          <button
            onClick={() => setShowManual((v) => !v)}
            className="text-emerald-700 hover:underline dark:text-emerald-400"
          >
            Update transcript
          </button>
        )}
        <button onClick={onClear} className="text-black/45 hover:underline dark:text-white/45">
          Clear my data
        </button>
        {status && <span className="text-black/50 dark:text-white/50">{status}</span>}
        {showManual && !hasExtension && (
          <div className="w-full">
            <ManualPaste html={html} setHtml={setHtml} onSubmit={ingest} />
          </div>
        )}
      </div>
    );
  }

  // ---- extension installed, nothing loaded yet ----
  if (hasExtension) {
    return (
      <div className="rounded-xl border border-emerald-600/30 bg-emerald-50/50 p-5 dark:border-emerald-500/25 dark:bg-emerald-950/20">
        <h2 className="font-semibold">See your own progress</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Class Royale Sync is installed. One click reads your transcript from your own
          Franciscan session — nothing is uploaded anywhere.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={handleSync}
            disabled={busy}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy ? "Syncing…" : "Sync my transcript"}
          </button>
          <SampleButton onSample={onSample} />
          <button
            onClick={() => uninstallExtension()}
            className="text-xs text-black/40 hover:underline dark:text-white/40"
          >
            Remove the extension
          </button>
        </div>
        {status && <p className="mt-3 text-sm text-black/60 dark:text-white/60">{status}</p>}
      </div>
    );
  }

  // ---- no extension ----
  return (
    <div className="rounded-xl border border-black/10 bg-white/60 p-5 dark:border-white/10 dark:bg-white/5">
      <h2 className="font-semibold">See your own progress</h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Everything above works without this. To fill in what <em>you&apos;ve</em> taken,
        Class Royale needs your transcript — which lives behind your Franciscan login,
        where a website can&apos;t reach it. Two ways round that, or{" "}
        <SampleButton onSample={onSample} lower />.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h3 className="text-sm font-semibold">One-time setup, then one click</h3>
          <p className="mt-1 text-xs text-black/55 dark:text-white/55">
            Install the sync extension once. After that, syncing is a single button and
            nothing opens or closes.
          </p>
          <button
            onClick={() => setShowInstall((v) => !v)}
            className="mt-3 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
          >
            {showInstall ? "Hide steps" : "Show me how"}
          </button>
        </div>

        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h3 className="text-sm font-semibold">No install, paste each time</h3>
          <p className="mt-1 text-xs text-black/55 dark:text-white/55">
            Copy the transcript page&apos;s source and paste it in. Works right now, nothing
            to install.
          </p>
          <button
            onClick={() => setShowManual((v) => !v)}
            className="mt-3 rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/5"
          >
            {showManual ? "Hide" : "Paste transcript"}
          </button>
        </div>
      </div>

      {showInstall && (
        <div className="mt-5 rounded-lg bg-black/[0.03] p-4 dark:bg-white/5">
          <h3 className="text-sm font-semibold">Installing the extension in Opera GX</h3>
          <p className="mt-1 text-xs text-black/55 dark:text-white/55">
            Roughly 30 seconds, once. Same steps in Chrome or Edge.
          </p>
          <ol className="mt-3 space-y-2 text-sm">
            <Step n={1}>
              In this project, find the <code className="font-mono text-xs">extension</code> folder.
              That&apos;s the whole thing — three small files you can read.
            </Step>
            <Step n={2}>
              Open a new tab and go to <code className="font-mono text-xs">opera://extensions</code>{" "}
              <span className="text-black/40 dark:text-white/40">
                (Chrome: <code className="font-mono text-xs">chrome://extensions</code>)
              </span>
            </Step>
            <Step n={3}>
              Turn on <strong>Developer mode</strong> — top-right toggle.
            </Step>
            <Step n={4}>
              Click <strong>Load unpacked</strong> and select that{" "}
              <code className="font-mono text-xs">extension</code> folder.
            </Step>
            <Step n={5}>
              Come back here and reload the page. This box turns into a{" "}
              <strong>Sync</strong> button.
            </Step>
          </ol>
          <p className="mt-3 text-xs text-black/50 dark:text-white/50">
            It can only touch <code className="font-mono">myfranciscan.franciscan.edu</code> — that&apos;s
            the one host in its manifest, and it has no other permissions. It reads the
            transcript page and hands it to this tab. It never sees your password (that
            stays on Microsoft&apos;s login page) and never sends anything to a server. You
            can remove it any time, from here or from the extensions page.
          </p>
        </div>
      )}

      {showManual && <ManualPaste html={html} setHtml={setHtml} onSubmit={ingest} />}
      {status && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {status}
        </p>
      )}
    </div>
  );
}

function SampleButton({ onSample, lower = false }: { onSample: () => void; lower?: boolean }) {
  return (
    <button
      onClick={onSample}
      className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800 dark:text-emerald-400"
    >
      {lower ? "try" : "Try"} a sample transcript
    </button>
  );
}

function ManualPaste({
  html,
  setHtml,
  onSubmit,
}: {
  html: string;
  setHtml: (v: string) => void;
  onSubmit: (html: string) => boolean;
}) {
  return (
    <div className="mt-5 rounded-lg bg-black/[0.03] p-4 dark:bg-white/5">
      <ol className="space-y-2 text-sm">
        <Step n={1}>
          Open{" "}
          <a
            href={TRANSCRIPT_URL}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-700 underline underline-offset-2 dark:text-emerald-400"
          >
            your unofficial transcript
          </a>{" "}
          and log in if it asks.
        </Step>
        <Step n={2}>
          Right-click the page → <strong>View Page Source</strong> <Key>⌥⌘U</Key>
        </Step>
        <Step n={3}>
          Select all <Key>⌘A</Key>, copy <Key>⌘C</Key>, and paste below.
        </Step>
      </ol>
      <textarea
        value={html}
        onChange={(e) => setHtml(e.target.value)}
        placeholder="Paste the page source here…"
        spellCheck={false}
        className="mt-3 h-28 w-full resize-y rounded-lg border border-black/10 bg-white p-3 font-mono text-xs outline-none focus:border-emerald-500 dark:border-white/15 dark:bg-black/30"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => {
            if (onSubmit(html)) setHtml("");
          }}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Load transcript
        </button>
        <span className="text-xs text-black/45 dark:text-white/45">
          Stays in this browser. Never uploaded.
        </span>
      </div>
    </div>
  );
}
