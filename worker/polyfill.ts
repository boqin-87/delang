import { DOMParser, parseHTML } from "linkedom";

// turndown (used by defuddle for markdown conversion) is bundled in
// browser mode. At module init it captures `window.DOMParser` and decides
// whether `canParseHTMLNatively()` succeeds. We must polyfill BEFORE
// defuddle/turndown are evaluated, hence this is a separate module that
// the worker imports before defuddle.
// biome-ignore lint/suspicious/noExplicitAny: required by polyfill.
const g = globalThis as any;
if (!g.window) g.window = g;
if (!g.DOMParser) g.DOMParser = DOMParser;
if (!g.window.DOMParser) g.window.DOMParser = DOMParser;
if (!g.document) {
  g.document = parseHTML("<!doctype html><html><body></body></html>").document;
}
