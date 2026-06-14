import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromHtml } from "./extract";

test("extracts <title> and drops script/style content", () => {
  const html = `<html><head><title>Hello World</title><style>.a{color:red}</style></head>
    <body><script>doEvil()</script><p>First paragraph</p><p>Second paragraph</p></body></html>`;
  const { title, text } = extractFromHtml(html);

  assert.equal(title, "Hello World");
  assert.ok(text.includes("First paragraph"));
  assert.ok(text.includes("Second paragraph"));
  assert.ok(!text.includes("doEvil"), "script content removed");
  assert.ok(!text.includes("color:red"), "style content removed");
});

test("removes nav / header / footer chrome", () => {
  const html = "<body><header>logo</header><nav>menu links</nav><p>real content</p><footer>copyright</footer></body>";
  const { text } = extractFromHtml(html);

  assert.ok(text.includes("real content"));
  assert.ok(!text.includes("menu links"));
  assert.ok(!text.includes("copyright"));
  assert.ok(!text.includes("logo"));
});

test("block elements become newlines, inline text is concatenated", () => {
  const { text } = extractFromHtml("<body><p>alpha</p><p>beta</p></body>");
  assert.match(text, /alpha\nbeta/);

  const inline = extractFromHtml("<body><p>see <a href='#'>this</a> link</p></body>");
  assert.ok(inline.text.includes("see this link"));
});

test("collapses excessive whitespace", () => {
  const { text } = extractFromHtml("<body><p>a      b\n\n\n\n   c</p></body>");
  assert.ok(!/ {3,}/.test(text), "no runs of 3+ spaces");
  assert.ok(!/\n{3,}/.test(text), "no runs of 3+ newlines");
});

test("empty / chrome-only body yields empty text without throwing", () => {
  const { text, title } = extractFromHtml("<html><head><title>T</title></head><body><nav>x</nav></body></html>");
  assert.equal(title, "T");
  assert.equal(text.trim(), "");
});
