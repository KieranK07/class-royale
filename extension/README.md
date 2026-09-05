# Class Royale Sync

Reads your Franciscan unofficial transcript from **your own logged-in session**
and hands it to Class Royale.

## Why this exists

`myfranciscan.franciscan.edu` sends no CORS headers and restricts framing, so a
website at any other origin physically cannot read your transcript — the browser
blocks it. That's not a bug to work around; it's what stops any random site from
reading your logged-in sessions. The only alternative is a server that holds your
session, which is exactly what this project refuses to do.

An extension can read it because it runs with permission you granted, scoped to
one host.

**Status: working.** Verified end to end against a real Franciscan session —
the background fetch carries the login, so no content script on Franciscan's
own pages is needed.

## What it does and doesn't do

- **Does not** see your password. That's only ever typed on Microsoft's login page.
- **Does not** read, store or transmit your session cookie. It calls
  `fetch(..., {credentials: "include"})`, which asks *the browser* to attach the
  session it already has. This code never touches it.
- **Does not** send anything to any server. The HTML goes straight back to the
  Class Royale tab in your own browser.
- **Does not** parse anything. Parsing lives in the app
  (`src/lib/transcript.ts`, `src/lib/sections.ts`) so there's one parser to fix
  when Jenzabar changes their markup.
- **Does** two bounded POSTs on your behalf, both to URLs the app read off
  your own registration page and both re-checked here before use: the
  registration portlet's own form (picking a term and running its course
  search, exactly as clicking **Search Courses** does), and a page of the
  results. Both are pinned to one pathname with `portlet=Student_Registration`
  on `myfranciscan.franciscan.edu`; form fields are bounded by shape — at most
  60, plausible names, values under 1KB — because the field names are copied
  off your page rather than listed here. It puts the term selector back where
  it was afterwards. Nothing else can be posted through it.
- **Can only** reach `myfranciscan.franciscan.edu`. That's the single entry in
  `host_permissions`, and there are no other permissions at all.

Three files, ~250 lines total. Read them.

## Updating

Version is in `manifest.json`. After pulling a new one, go to
`opera://extensions` and hit the **↻** on its card, then reload the Class
Royale tab. The app checks what the loaded build can do and says plainly when
it's behind — an out-of-date extension gets a "reload it" note, not a
mysterious timeout or a wrong answer.

## Install (Opera GX, Chrome, or Edge)

1. Go to `opera://extensions` (Chrome/Edge: `chrome://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this `extension/` folder
4. Reload Class Royale — the setup box becomes a **Sync** button

## Uninstall

The "Remove the extension" link in Class Royale calls
`chrome.management.uninstallSelf()`. Your browser still shows its own
confirmation — that can't be skipped, and shouldn't be.

## Note on `content_scripts`

`manifest.json` matches `http://localhost:3000/*`. If you deploy Class Royale
somewhere else, add that origin there too, or the page won't find the extension.
