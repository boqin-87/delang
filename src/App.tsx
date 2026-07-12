import { useState } from "react";
import { ResultView } from "@/components/ResultView";
import type { DelangResult } from "../worker";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

function readEmbeddedResult(): DelangResult | null {
  const el = document.getElementById("delang-result");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as DelangResult;
  } catch {
    return null;
  }
}

function Home() {
  const [url, setUrl] = useState("");
  const [lang, setLang] = useState("");

  const submit = (e: React.SubmitEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    // Navigate to the corresponding render route. parseRoute/normalizeTarget
    // expect the raw target URL in the pathname (e.g. /https://example.com/a),
    // so segments are NOT percent-encoded — the browser URL-encodes unsafe
    // characters while preserving ":" and "/" that normalizeTarget relies on.
    const path = [lang.trim(), url.trim()].filter(Boolean).join("/");
    window.location.assign(`/${path}`);
  };

  return (
    <div className="typeset typeset-docs mx-auto mt-16 max-w-2xl px-6">
      <h1>delang</h1>
      <p>
        Paste a web page URL to extract it. Set a language to translate, or
        leave it blank for the defudged result as-is.
      </p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <Input
          className="px-3 py-2"
          type="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <Input
          className="px-3 py-2"
          type="text"
          placeholder="language code (zh, en, …) — leave blank to skip translation"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
        />
        <Button className="self-start px-4 py-2" type="submit">
          {lang.trim() ? "Translate" : "Extract"}
        </Button>
      </form>
      <p>
        Bookmark:{" "}
        <code className="select-all">
          {`javascript:void(location.href='${window.location.origin}/${lang.trim().length > 0 ? `${lang}/` : ""}'+location.href.replace(/^https?:\\/\\//,%27%27))`}
        </code>
      </p>
    </div>
  );
}

export function App() {
  const embedded = readEmbeddedResult();
  if (embedded) return <ResultView data={embedded} />;
  return <Home />;
}

export default App;
