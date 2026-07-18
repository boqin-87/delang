import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DelangResult } from "../worker";
import worker, {
  extractChatCompletionText,
  extractArticleUrl,
  injectResultIntoShell,
  isHnItem,
  llmGenerate,
  parseRoute,
  resolveChatCompletionsEndpoint,
  splitHnContent,
} from "../worker";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A stub for the ASSETS binding, used for the SPA-delegation test. The
// integration render/api paths are verified separately via `wrangler dev`
// (they exercise defuddle + the configured LLM, which don't load cleanly in the
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

describe("OpenAI-compatible chat completions", () => {
  const providers = [
    {
      provider: "grok2api",
      baseUrl: "https://grok.6661993.xyz/v1",
      model: "grok-4.5",
    },
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    },
    {
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-3",
    },
  ] as const;

  it.each(providers)(
    "resolves the $provider chat-completions endpoint",
    ({ baseUrl }) => {
      expect(resolveChatCompletionsEndpoint(baseUrl)).toBe(
        `${baseUrl}/chat/completions`,
      );
    },
  );

  it("does not append chat/completions to a complete endpoint", () => {
    expect(
      resolveChatCompletionsEndpoint(
        "https://api.openai.com/v1/chat/completions",
      ),
    ).toBe("https://api.openai.com/v1/chat/completions");
  });

  it.each(providers)(
    "sends the $provider OpenAI-compatible request contract",
    async ({ baseUrl, model }) => {
      const apiKey = "test-api-key";
      const prompt = "Translate this text";
      let requestUrl = "";
      let requestInit: RequestInit | undefined;
      const mockFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({
          choices: [{ message: { content: "translated" } }],
        });
      };

      await expect(
        llmGenerate(
          prompt,
          { baseUrl, model, apiKey },
          mockFetch as typeof fetch,
        ),
      ).resolves.toBe("translated");

      expect(requestUrl).toBe(`${baseUrl}/chat/completions`);
      expect(requestInit?.method).toBe("POST");
      const headers = new Headers(requestInit?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(requestInit?.body))).toEqual({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      });
    },
  );

  it("extracts text from string and array content responses", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: " translated text " } }],
      }),
    ).toBe("translated text");
    expect(
      extractChatCompletionText({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "part one " },
                { type: "text", text: "part two" },
              ],
            },
          },
        ],
      }),
    ).toBe("part one part two");
  });

  it("rejects a response with no assistant text", () => {
    expect(() => extractChatCompletionText({ choices: [] })).toThrow(
      "LLM returned no text",
    );
  });

  it("includes the upstream status in non-2xx errors", async () => {
    const mockFetch = async (): Promise<Response> =>
      new Response("provider unavailable", { status: 503 });

    await expect(
      llmGenerate(
        "Translate this text",
        {
          baseUrl: providers[0].baseUrl,
          model: providers[0].model,
          apiKey: "test-api-key",
        },
        mockFetch as typeof fetch,
      ),
    ).rejects.toThrow("LLM 503");
  });
});

describe("injectResultIntoShell", () => {
  // A shell shaped like the real built index.html: <html>/<title> up front,
  // the root mount point, then a non-empty tail after it. That tail is exactly
  // what `$'` would splice into the JSON under the bug.
  const shell =
    "<!doctype html><html><head><title>delang</title></head><body>" +
    '<div id="root"></div>\n  </body>\n</html>\n';

  function makeResult(over: Partial<DelangResult> = {}): DelangResult {
    return {
      title: "t",
      markdown: "body",
      lang: null,
      url: "https://example.com/x",
      meta: { domain: "example.com", published: "", author: "", wordCount: 0 },
      ...over,
    };
  }

  function extractResultJson(html: string): DelangResult {
    const m = html.match(
      /<script id="delang-result"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) throw new Error("delang-result script not found");
    return JSON.parse(m[1]) as DelangResult;
  }

  it("keeps $' / $` / $& / $n in the markdown out of the replacement string", () => {
    // The Manticore auto-embeddings page has `--data-raw $'{"insert":…}` in a
    // bash block. With a string replacement, `$'` expands to the shell tail
    // after the root div and splices `</body></html>` into the middle of the
    // JSON, so JSON.parse threw and the SPA fell back to <Home>.
    const tricky =
      '--data-raw $\'{"insert":1}\nprices $5 and $150, match $& and $` and $1';
    const html = injectResultIntoShell(
      shell,
      makeResult({ markdown: tricky }),
      null,
    );
    expect(extractResultJson(html).markdown).toBe(tricky);
  });

  it("keeps $' in the title out of the replacement string", () => {
    const title = "Title with $' and $& and $1 splice";
    const html = injectResultIntoShell(shell, makeResult({ title }), null);
    expect(html).toContain(`<title>${title}</title>`);
    expect(() => extractResultJson(html)).not.toThrow();
  });

  it("keeps $' in the language tag out of the replacement string", () => {
    const html = injectResultIntoShell(shell, makeResult(), "$'");
    expect(html).toContain('<html lang="$\'">');
  });

  it("injects before </body> and still escapes $' when there is no root div", () => {
    const noRoot =
      "<!doctype html><html><head><title>delang</title></head><body>hi</body></html>";
    const tricky = '--data-raw $\'{"x":1}';
    const html = injectResultIntoShell(
      noRoot,
      makeResult({ markdown: tricky }),
      null,
    );
    expect(extractResultJson(html).markdown).toBe(tricky);
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
    // Translating a page needs the LLM; a missing key should hard-fail before
    // we attempt any extraction. (No-translation renders never need a key, so
    // they're covered separately below.)
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "LLM_API_KEY") return undefined;
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
    expect(await response.text()).toBe("LLM_API_KEY not configured");
  });

  it("does not require an API key for a no-translation render route", async () => {
    // A bare-URL render skips translation entirely, so a missing key must not
    // produce the "LLM_API_KEY not configured" 500. The request will still
    // attempt an upstream fetch here (and 502 in the test sandbox, which has
    // no real network); the point is only that it's NOT the key-missing 500.
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "LLM_API_KEY") return undefined;
        return Reflect.get(t, p);
      },
    }) as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new IncomingRequest("https://delang.test/https://example.com/a"),
      keylessEnv,
    );
    await waitOnExecutionContext(ctx);
    expect(await response.text()).not.toBe("LLM_API_KEY not configured");
    expect(response.status).not.toBe(500);
  });

  it("requires the API key for an HN render even without a language", async () => {
    // An HN thread always needs the LLM for the comment summary, so a missing
    // key hard-fails before any extraction — even with no language set. The
    // target's `?id=` must survive routing (verified by the parseRoute tests).
    const keylessEnv = new Proxy(env as Env, {
      get(t, p) {
        if (p === "LLM_API_KEY") return undefined;
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
    expect(await response.text()).toBe("LLM_API_KEY not configured");
  });
});
