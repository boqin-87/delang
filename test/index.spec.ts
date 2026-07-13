import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, {
  extractArticleUrl,
  isHnItem,
  parseRoute,
  splitHnContent,
} from "../worker";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A stub for the ASSETS binding, used for the SPA-delegation test. The
// integration render/api paths are verified separately via `wrangler dev`
// (they exercise defuddle + Gemini, which don't load cleanly in the
// pool-workers test runtime).
function stubAssets(): { fetch: (req: RequestInfo | URL) => Response } {
  return {
    fetch: () =>
      new Response('<!doctype html><div id="root"></div>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  };
}

function envWithAssets(): Env {
  return new Proxy(env as Env, {
    get(t, p) {
      if (p === "ASSETS") return stubAssets();
      return Reflect.get(t, p);
    },
  }) as Env;
}

describe("parseRoute", () => {
  it("root and assets are SPA", () => {
    expect(parseRoute("/")).toEqual({ kind: "spa" });
    expect(parseRoute("/index.html")).toEqual({ kind: "spa" });
    expect(parseRoute("/assets/index-abc.js")).toEqual({ kind: "spa" });
    expect(parseRoute("/favicon.ico")).toEqual({ kind: "spa" });
  });

  it("bare URL is a no-translation render", () => {
    expect(parseRoute("/https://example.com/a")).toEqual({
      kind: "render",
      lang: null,
      target: "https://example.com/a",
    });
  });

  it("leading tag is a language only when the remainder is a URL", () => {
    expect(parseRoute("/en/https://example.com/a")).toEqual({
      kind: "render",
      lang: "en",
      target: "https://example.com/a",
    });
    expect(parseRoute("/meow/https://example.com/a")).toEqual({
      kind: "render",
      lang: "meow",
      target: "https://example.com/a",
    });
  });

  it("a bare tag with no URL is SPA", () => {
    expect(parseRoute("/zh")).toEqual({ kind: "spa" });
    expect(parseRoute("/meow")).toEqual({ kind: "spa" });
  });

  it("repairs a dropped slash in the target scheme", () => {
    expect(parseRoute("/https:/example.com/a")).toEqual({
      kind: "render",
      lang: null,
      target: "https://example.com/a",
    });
  });

  it("preserves a query string on the target URL (HN `?id=`)", () => {
    // The browser moves the target's `?` into this page's search; parseRoute
    // must re-attach it so the item id survives.
    expect(
      parseRoute("/https://news.ycombinator.com/item?id=48854168"),
    ).toEqual({
      kind: "render",
      lang: null,
      target: "https://news.ycombinator.com/item?id=48854168",
    });
    expect(
      parseRoute("/zh/https://news.ycombinator.com/item?id=48854168"),
    ).toEqual({
      kind: "render",
      lang: "zh",
      target: "https://news.ycombinator.com/item?id=48854168",
    });
  });

  it("does not treat a query on a bare tag as a target", () => {
    expect(parseRoute("/zh?x=1")).toEqual({ kind: "spa" });
  });
});

describe("isHnItem", () => {
  it("matches an HN thread page", () => {
    expect(isHnItem("https://news.ycombinator.com/item?id=48854168")).toBe(
      true,
    );
    expect(isHnItem("http://news.ycombinator.com/item?id=1")).toBe(true);
  });
  it("rejects non-item HN pages and other sites", () => {
    expect(isHnItem("https://news.ycombinator.com/")).toBe(false);
    expect(isHnItem("https://news.ycombinator.com/news")).toBe(false);
    expect(isHnItem("https://news.ycombinator.com/user?id=x")).toBe(false);
    expect(isHnItem("https://techcrunch.com/2026/06/30/x")).toBe(false);
    expect(isHnItem("https://hn.algolia.com/")).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(isHnItem("not a url")).toBe(false);
    expect(isHnItem("")).toBe(false);
  });
});

describe("splitHnContent", () => {
  it("splits a linked-article HN page at ## Comments", () => {
    const content =
      "[https://example.com/a](https://example.com/a)\n\n---\n\n## Comments\n\n> **bob** · [d](u)\n> hi";
    const { beforeComments, commentsMarkdown } = splitHnContent(content);
    expect(beforeComments).toBe(
      "[https://example.com/a](https://example.com/a)",
    );
    expect(commentsMarkdown).toBe("> **bob** · [d](u)\n> hi");
  });
  it("keeps the post body for a text post and strips the trailing rule", () => {
    const content =
      "[item?id=1](https://news.ycombinator.com/item?id=1)\n\nBody text here.\n\n---\n\n## Comments\n\n> **a** · [d](u)\n> reply";
    const { beforeComments, commentsMarkdown } = splitHnContent(content);
    expect(beforeComments).toBe(
      "[item?id=1](https://news.ycombinator.com/item?id=1)\n\nBody text here.",
    );
    expect(commentsMarkdown).toBe("> **a** · [d](u)\n> reply");
  });
  it("treats content with no comments heading as all before-comments", () => {
    expect(splitHnContent("just text").beforeComments).toBe("just text");
    expect(splitHnContent("just text").commentsMarkdown).toBe("");
  });
});

describe("extractArticleUrl", () => {
  it("returns the first external link for a linked article", () => {
    expect(
      extractArticleUrl("[https://example.com/a](https://example.com/a)"),
    ).toBe("https://example.com/a");
  });
  it("returns null for a text post whose leading link is the HN self-link", () => {
    // A footnote link later in the body must NOT be mistaken for the article.
    expect(
      extractArticleUrl(
        "[item?id=1](https://news.ycombinator.com/item?id=1)\n\nBody with a footnote [https://fcc.gov/x](https://fcc.gov/x).",
      ),
    ).toBe(null);
  });
  it("returns null when there is no link", () => {
    expect(extractArticleUrl("just text, no link")).toBe(null);
    expect(extractArticleUrl("")).toBe(null);
  });
});

describe("worker fetch handler", () => {
  it("serves the SPA at / via the ASSETS binding", async () => {
    const request = new IncomingRequest("https://delang.test/");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, envWithAssets());
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it("rejects non-GET on a render route with 405", async () => {
    const response = await SELF.fetch(
      new Request("https://delang.test/https://example.com/a", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(405);
  });

  it("returns 500 when the API key is missing for a translating render route", async () => {
    // Translating a page needs Gemini; a missing key should hard-fail before
    // we attempt any extraction. (No-translation renders never need a key, so
    // they're covered separately below.)
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "GEMINI_API_KEY") return undefined;
        return Reflect.get(t, p);
      },
    }) as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest("https://delang.test/zh/https://example.com/a"),
      keylessEnv,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("GEMINI_API_KEY not configured");
  });

  it("does not require an API key for a no-translation render route", async () => {
    // A bare-URL render skips translation entirely, so a missing key must not
    // produce the "GEMINI_API_KEY not configured" 500. The request will still
    // attempt an upstream fetch here (and 502 in the test sandbox, which has
    // no real network); the point is only that it's NOT the key-missing 500.
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "GEMINI_API_KEY") return undefined;
        return Reflect.get(t, p);
      },
    }) as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest("https://delang.test/https://example.com/a"),
      keylessEnv,
    );
    await waitOnExecutionContext(ctx);
    expect(await response.text()).not.toBe("GEMINI_API_KEY not configured");
    expect(response.status).not.toBe(500);
  });

  it("requires the API key for an HN render even without a language", async () => {
    // An HN thread always needs Gemini for the comment summary, so a missing
    // key hard-fails before any extraction — even with no language set. The
    // target's `?id=` must survive routing (verified by the parseRoute tests).
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "GEMINI_API_KEY") return undefined;
        return Reflect.get(t, p);
      },
    }) as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest(
        "https://delang.test/https://news.ycombinator.com/item?id=48854168",
      ),
      keylessEnv,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("GEMINI_API_KEY not configured");
  });
});
