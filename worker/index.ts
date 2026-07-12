import { env } from "cloudflare:workers";
import "./polyfill";
import { parseHTML } from "linkedom";

// defuddle pulls in turndown, which the vitest pool-workers runner cannot
// load directly (CJS/ESM-shell shim quirk). Importing it lazily keeps
// `parseRoute`/`languageForTag` testable in isolation and defers the
// heavy defuddle bundle until a real extraction is needed.
async function loadDefuddle() {
  const mod = await import("defuddle/node");
  return mod.Defuddle;
}

const GEMINI_MODEL = env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type Route =
  | { kind: "spa" }
  | { kind: "render"; lang: string | null; target: string };

// File extensions that should always be served as static assets, not parsed
// as URL-bearing routes.
const ASSET_EXT = [
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".svg",
  ".png",
  ".ico",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".html",
  ".json",
];

// Known short SPA/root paths that must fall through to the SPA, never the
// page renderer.
const SPA_ROOTS = new Set(["", "/", "/index.html"]);

function normalizeTarget(raw: string): string | null {
  if (!raw) return null;
  let v = raw;
  // Repair "https:/example.com" -> "https://example.com".
  v = v.replace(/^(https?:)\/(?!\/)/i, "$1//");
  if (!/^https?:\/\//i.test(v)) {
    // Require a URL-ish host: at least one "." before the first "/" so that a
    // bare language tag like "zh" or "meow" is NOT mistaken for a hostname.
    const host = v.split("/", 1)[0];
    if (host.includes(".")) {
      v = `https://${v}`;
    } else {
      return null;
    }
  }
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  // Root and known SPA entry paths serve the SPA.
  if (SPA_ROOTS.has(pathname)) return { kind: "spa" };

  // Anything with a static-asset file extension is served as a file.
  const lastSlash = pathname.lastIndexOf("/");
  const dotInLast = pathname.indexOf(".", lastSlash);
  if (dotInLast !== -1) {
    const ext = pathname.slice(dotInLast).toLowerCase();
    if (ASSET_EXT.includes(ext)) return { kind: "spa" };
  }

  const rest = pathname;

  // rest still has a leading slash (or is ""). The first segment is the
  // candidate language tag; everything after it is the target URL.
  const trimmed = rest.startsWith("/") ? rest.slice(1) : rest;

  // Attempt 1: the whole remainder is a URL (no language, no translation). This takes
  // precedence so that delang/https://example.com resolves to a no-translation
  // render rather than a (bogus) lang tag of "https:".
  if (trimmed) {
    const target = normalizeTarget(trimmed);
    if (target) {
      return { kind: "render", lang: null, target };
    }
  }

  // Attempt 2: leading segment is a language tag, the rest is the URL.
  if (trimmed.includes("/")) {
    const slash = trimmed.indexOf("/");
    const firstSeg = trimmed.slice(0, slash);
    const urlPart = trimmed.slice(slash + 1);
    const target = normalizeTarget(urlPart);
    if (target && firstSeg) {
      return {
        kind: "render",
        lang: decodeSeg(firstSeg),
        target,
      };
    }
  }

  return { kind: "spa" };
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export interface Extracted {
  title: string;
  content: string;
  domain: string;
  published: string;
  author: string;
  wordCount: number;
}

const upstreamFetch: typeof fetch = fetch;

async function fetchHtml(target: string): Promise<string> {
  const res = await upstreamFetch(target, {
    headers: {
      accept: "text/html, */*",
      "user-agent": "Mozilla/5.0 (compatible; delang/1.0;)",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

export async function extract(target: string): Promise<Extracted> {
  const html = await fetchHtml(target);
  const { document } = parseHTML(html);

  // linkedom compat: defuddle internals expect APIs linkedom doesn't ship.
  // Mirrors src/utils/linkedom-compat.ts in kepano/defuddle.
  if (!document.styleSheets) document.styleSheets = [];
  if (document.defaultView && !document.defaultView.getComputedStyle) {
    document.defaultView.getComputedStyle = () => ({ display: "" });
  }
  document.URL = target;

  const result = await (await loadDefuddle())(document, target, {
    markdown: true,
  });
  const content = (result?.content ?? "").trim();
  if (!content) throw new Error("defuddle returned empty content");
  return {
    title: (result?.title ?? "").trim(),
    content,
    domain: (result?.domain ?? "").trim(),
    published: (result?.published ?? "").trim(),
    author: (result?.author ?? "").trim(),
    wordCount: result?.wordCount ?? 0,
  };
}

async function geminiTranslate(
  text: string,
  language: string,
  apiKey: string,
): Promise<string> {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Translate the following text into language code "${language}". ` +
              "Return only the translation with no preamble, no explanation, and no surrounding quotes. " +
              "Preserve paragraph breaks and any markdown formatting.\n\n---\n\n" +
              text,
          },
        ],
      },
    ],
  };

  const res = await upstreamFetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const out =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  if (!out) throw new Error(`gemini returned no text: ${JSON.stringify(data)}`);
  return out.trim();
}

export interface DelangResult {
  title: string;
  markdown: string;
  lang: string | null;
  url: string;
  meta: {
    domain: string;
    published: string;
    author: string;
    wordCount: number;
  };
}

export async function renderResult(
  route: { kind: "render"; lang: string | null; target: string },
  apiKey: string,
): Promise<DelangResult> {
  const extracted = await extract(route.target);
  const contentWithTitle = `# ${extracted.title}\n\n${extracted.content}`;
  const markdown = route.lang
    ? await geminiTranslate(contentWithTitle, route.lang, apiKey)
    : contentWithTitle;

  return {
    title: extracted.title,
    markdown,
    lang: route.lang,
    url: route.target,
    meta: {
      domain: extracted.domain,
      published: extracted.published,
      author: extracted.author,
      wordCount: extracted.wordCount,
    },
  };
}

function escapeJsonForScript(value: unknown): string {
  const LS = "\u2028";
  const PS = "\u2029";
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(`[${LS}${PS}]`, "g"), (c) =>
      c === LS ? "\\u2028" : "\\u2029",
    );
}

// Take the SPA's built index.html (which already references the hashed
// Vite assets) and inject the result JSON so the page renders directly for
// a bookmarked GET while still hydrating with the SPA bundle.
function injectResultIntoShell(
  shellHtml: string,
  result: DelangResult,
  language: string | null,
): string {
  const json = escapeJsonForScript(result);
  const block = `\n    <script id="delang-result" type="application/json">${json}</script>`;
  let html = shellHtml;
  // Inject the result block right after the root mount point.
  if (/<div id="root"[^>]*><\/div>/i.test(html)) {
    html = html.replace(/(<div id="root"[^>]*><\/div>)/i, `$1${block}`);
  } else {
    html = html.replace(/<\/body>/i, `${block}\n  </body>`);
  }
  // Bind the <html lang=...> and <title> to the (possibly translated) result
  // so the bookmarked page has a meaningful title without waiting for hydration.
  if (/<html\b[^>]*>/i.test(html) && language) {
    html = html.replace(/<html\b[^>]*>/i, `<html lang="${language}">`);
  }
  if (result.title && /<title>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(
      /<title>[\s\S]*?<\/title>/i,
      `<title>${result.title}</title>`,
    );
  }
  return html;
}

async function serveShellWithResult(
  request: Request,
  env: Env,
  result: DelangResult,
  language: string | null,
): Promise<Response> {
  if (!env.ASSETS) {
    return new Response("assets binding not configured", { status: 500 });
  }
  // Fetch the SPA shell from the same origin so the built index.html (with
  // its hashed asset references) is reused.
  const shellReq = new Request(new URL("/", request.url));
  const shellRes = await env.ASSETS.fetch(shellReq);
  const shellHtml = await shellRes.text();
  const html = injectResultIntoShell(shellHtml, result, language);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    if (route.kind === "spa") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("assets binding not configured", { status: 500 });
    }

    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    if (!env.GEMINI_API_KEY && route.lang) {
      return new Response("GEMINI_API_KEY not configured", { status: 500 });
    }

    try {
      const result = await renderResult(route, env.GEMINI_API_KEY);
      return await serveShellWithResult(request, env, result, route.lang);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(msg, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
