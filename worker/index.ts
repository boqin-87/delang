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

export function parseRoute(pathAndQuery: string): Route {
  // A target URL encoded in the path may itself contain a query string; the
  // browser moves that '?' into *this* page's query. Split it back off so the
  // path/asset/lang detection uses the path while the target keeps its query
  // (Hacker News threads are `/item?id=…`, so this matters).
  const qIdx = pathAndQuery.indexOf("?");
  const pathname = qIdx === -1 ? pathAndQuery : pathAndQuery.slice(0, qIdx);
  const query = qIdx === -1 ? "" : pathAndQuery.slice(qIdx);

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
    const target = normalizeTarget(trimmed + query);
    if (target) {
      return { kind: "render", lang: null, target };
    }
  }

  // Attempt 2: leading segment is a language tag, the rest is the URL.
  if (trimmed.includes("/")) {
    const slash = trimmed.indexOf("/");
    const firstSeg = trimmed.slice(0, slash);
    const urlPart = trimmed.slice(slash + 1);
    const target = normalizeTarget(urlPart + query);
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

// Shared Gemini text-completion call. Both translation and the HN comment
// summarization route through this so the request/response shape lives in one
// place.
async function geminiGenerate(prompt: string, apiKey: string): Promise<string> {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
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

async function geminiTranslate(
  text: string,
  language: string,
  apiKey: string,
): Promise<string> {
  const prompt =
    `Translate the following text into language code "${language}". ` +
    "Return only the translation with no preamble, no explanation, and no surrounding quotes. " +
    "Preserve paragraph breaks and any markdown formatting.\n\n---\n\n" +
    text;
  return geminiGenerate(prompt, apiKey);
}

// Summarize and categorize an HN comment section. The output is self-contained
// Markdown that begins with its own (localized, when `language` is set) level-2
// heading, so the caller can drop it straight into the assembled page. With no
// language we deliberately omit any language instruction per the feature spec.
async function geminiSummarize(
  commentsMarkdown: string,
  language: string | null,
  apiKey: string,
): Promise<string> {
  const langLine = language
    ? `Write the entire response (including the heading) in language code "${language}". `
    : "";
  const prompt =
    "You are analyzing the comment section of a Hacker News thread. The comments are Markdown: " +
    'each comment begins with "**author** · [date](permalink)" and replies are nested as blockquotes.\n\n' +
    "Do two things:\n" +
    "1. Summarize the overall discussion.\n" +
    "2. Categorize the viewpoints expressed by commenters: group related opinions or stances into named categories, " +
    "and for each category give a concise description and list the key commenters (by username) who expressed it.\n\n" +
    "Begin your response with a single level-2 Markdown heading (##) that titles this section as a summary and " +
    `categorization of the discussion. Use ## / ### headings and bullet points. ${langLine}` +
    "Return only the Markdown analysis, no preamble.\n\n---\n\n" +
    commentsMarkdown;
  return geminiGenerate(prompt, apiKey);
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

// --- Hacker News thread handling -----------------------------------------
//
// defuddle run on an HN `item?id=` page returns Markdown shaped like:
//
//   [https://example.com/article](https://example.com/article)
//
//   ---
//
//   ## Comments
//
//   > **author** · [date](permalink)
//   > comment text
//   > > **replyer** · ...
//
// For a text post (Ask/Show HN) the top link is the HN self-link and a post
// body follows it; there is no external article. We split that into the
// pre-comments part (article link / post body) and the comment blockquotes,
// then assemble a three-part page: the delang-ed article, a Gemini summary
// & categorization of the comments, and the delang-ed comments themselves.

export function isHnItem(target: string): boolean {
  try {
    const u = new URL(target);
    return u.hostname === "news.ycombinator.com" && u.pathname === "/item";
  } catch {
    return false;
  }
}

// Split defuddle's HN output at the "## Comments" heading.
export function splitHnContent(content: string): {
  beforeComments: string;
  commentsMarkdown: string;
} {
  const idx = content.indexOf("## Comments");
  if (idx === -1) {
    return { beforeComments: content.trim(), commentsMarkdown: "" };
  }
  const beforeComments = content
    .slice(0, idx)
    .replace(/\n*---\s*$/, "")
    .trim();
  const commentsMarkdown = content
    .slice(idx)
    .replace(/^##\s+Comments\s*\n?/, "")
    .trim();
  return { beforeComments, commentsMarkdown };
}

// First markdown-link href in the pre-comments text. Returns null when the
// page is a text post (the only leading link is the HN self-link) or when
// there is no link at all. Only the *first* link is considered — that is the
// story title link; body footnotes must not be mistaken for the article.
export function extractArticleUrl(beforeComments: string): string | null {
  const m = beforeComments.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    if (u.hostname === "news.ycombinator.com") return null;
    return m[1];
  } catch {
    return null;
  }
}

// Drop the leading HN self-link from a text post's pre-comments text, leaving
// just the post body.
function stripSelfLink(md: string): string {
  return md
    .replace(
      /^\s*\[[^\]]*\]\(https?:\/\/news\.ycombinator\.com[^)]*\)\s*\n*/,
      "",
    )
    .trim();
}

interface Part1 {
  markdown: string;
  title: string;
}

// Delang the linked article (extract + optional translate). Mirrors the plain
// render path: the article's own title becomes the page's H1.
async function delangArticle(
  articleUrl: string,
  lang: string | null,
  apiKey: string,
): Promise<Part1> {
  const art = await extract(articleUrl);
  const contentWithTitle = `# ${art.title}\n\n${art.content}`;
  const markdown = lang
    ? await geminiTranslate(contentWithTitle, lang, apiKey)
    : contentWithTitle;
  return { markdown, title: art.title };
}

// Delang a text post's body. The HN submission title becomes the H1; the
// self-link is stripped. Translation failure degrades to the untranslated body.
async function delangTextPost(
  hnTitle: string,
  beforeComments: string,
  lang: string | null,
  apiKey: string,
): Promise<Part1> {
  const body = stripSelfLink(beforeComments);
  if (!body) return { markdown: "", title: hnTitle };
  const contentWithTitle = `# ${hnTitle}\n\n${body}`;
  if (!lang) return { markdown: contentWithTitle, title: hnTitle };
  try {
    const markdown = await geminiTranslate(contentWithTitle, lang, apiKey);
    return { markdown, title: hnTitle };
  } catch {
    return { markdown: contentWithTitle, title: hnTitle };
  }
}

// Delang the comment blockquotes. The "## Comments" heading is included in the
// translated text so it is localized along with the body. Without a language
// the comments (and heading) pass through untouched.
async function delangComments(
  commentsMarkdown: string,
  lang: string | null,
  apiKey: string,
): Promise<string> {
  const withHeading = `## Comments\n\n${commentsMarkdown}`;
  if (!lang) return withHeading;
  try {
    return await geminiTranslate(withHeading, lang, apiKey);
  } catch {
    return withHeading;
  }
}

function fallbackArticleNote(articleUrl: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `## Linked article\n\nCould not extract the linked article ([${articleUrl}](${articleUrl})): ${msg}`;
}

async function renderHnResult(
  route: { kind: "render"; lang: string | null; target: string },
  apiKey: string,
): Promise<DelangResult> {
  const hn = await extract(route.target);
  const { beforeComments, commentsMarkdown } = splitHnContent(hn.content);
  const articleUrl = extractArticleUrl(beforeComments);

  // Three independent branches; each degrades on its own error so a paywalled
  // article or a Gemini hiccup still yields the rest of the page.
  const part1: Promise<Part1> = articleUrl
    ? delangArticle(articleUrl, route.lang, apiKey).catch((err) => ({
        markdown: fallbackArticleNote(articleUrl, err),
        title: hn.title,
      }))
    : delangTextPost(hn.title, beforeComments, route.lang, apiKey);

  const part2: Promise<string> = commentsMarkdown
    ? geminiSummarize(commentsMarkdown, route.lang, apiKey).catch(
        () => "## Discussion summary\n\n_Summary unavailable._",
      )
    : Promise.resolve("");

  const part3: Promise<string> = commentsMarkdown
    ? delangComments(commentsMarkdown, route.lang, apiKey)
    : Promise.resolve("");

  const [p1, p2, p3] = await Promise.all([part1, part2, part3]);
  const markdown = [p1.markdown, p2, p3]
    .filter((s) => s?.trim())
    .join("\n\n---\n\n");

  return {
    title: p1.title || hn.title,
    markdown,
    lang: route.lang,
    url: route.target,
    meta: {
      domain: hn.domain,
      published: hn.published,
      author: hn.author,
      wordCount: hn.wordCount,
    },
  };
}

export async function renderResult(
  route: { kind: "render"; lang: string | null; target: string },
  apiKey: string,
): Promise<DelangResult> {
  // HN threads render as article + comment summary + comments.
  if (isHnItem(route.target)) return renderHnResult(route, apiKey);

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
export function injectResultIntoShell(
  shellHtml: string,
  result: DelangResult,
  language: string | null,
): string {
  const json = escapeJsonForScript(result);
  const block = `\n    <script id="delang-result" type="application/json">${json}</script>`;
  let html = shellHtml;
  // Inject the result block right after the root mount point. Use FUNCTION
  // replacements, not string replacements: a string replacement interprets
  // $' / $` / $& / $n inside the replacement, and `block` embeds the page
  // markdown verbatim. A page whose bash example has `--data-raw $'{"insert":…}`
  // (bash ANSI-C quoting) made `$'` expand to the shell's own tail after the
  // root div, splicing raw `</body></html>` into the middle of the result JSON,
  // breaking JSON.parse in the browser so the SPA fell back to <Home>. A
  // function returns its value literally, with no `$` interpretation.
  if (/<div id="root"[^>]*><\/div>/i.test(html)) {
    html = html.replace(
      /(<div id="root"[^>]*><\/div>)/i,
      (_m, g1) => `${g1}${block}`,
    );
  } else {
    html = html.replace(/<\/body>/i, () => `${block}\n  </body>`);
  }
  // Bind the <html lang=...> and <title> to the (possibly translated) result
  // so the bookmarked page has a meaningful title without waiting for hydration.
  // Function replacements again — `language` is an arbitrary user-supplied tag
  // and `result.title` is upstream-controlled, so either could contain `$'`.
  if (/<html\b[^>]*>/i.test(html) && language) {
    html = html.replace(/<html\b[^>]*>/i, () => `<html lang="${language}">`);
  }
  if (result.title && /<title>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(
      /<title>[\s\S]*?<\/title>/i,
      () => `<title>${result.title}</title>`,
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
    // Pass the query too: a target URL with its own `?` (e.g. HN `?id=`) has
    // that query relocated to this page's search, and parseRoute re-attaches it.
    const route = parseRoute(url.pathname + url.search);

    if (route.kind === "spa") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("assets binding not configured", { status: 500 });
    }

    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    // HN threads always need Gemini (the comment summary), even with no
    // language; plain renders only need it for translation.
    const needsKey = route.lang !== null || isHnItem(route.target);
    if (!env.GEMINI_API_KEY && needsKey) {
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
