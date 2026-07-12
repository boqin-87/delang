import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { parseRoute } from "../worker";

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

  it("/api paths are no longer a thing and fall through to the SPA", () => {
    expect(parseRoute("/api")).toEqual({ kind: "spa" });
    expect(parseRoute("/api/https://example.com/a")).toEqual({ kind: "spa" });
    expect(parseRoute("/api/zh/https://example.com/a")).toEqual({
      kind: "spa",
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
});
