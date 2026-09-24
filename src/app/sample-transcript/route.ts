import { readFile } from "node:fs/promises";
import path from "node:path";

// The synthetic transcript the tests run against, served so anyone without a
// Franciscan login can try the audit. Rendered once at build time.
export const dynamic = "force-static";

export async function GET() {
  const html = await readFile(
    path.join(process.cwd(), "src", "lib", "__fixtures__", "transcript.html"),
    "utf8"
  );
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
