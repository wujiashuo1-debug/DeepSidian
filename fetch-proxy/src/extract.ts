import { load } from "cheerio";

/** domhandler 节点的最小结构，避免依赖 cheerio 具体版本的类型导出。 */
interface DomNode {
  type: string;
  data?: string;
  name?: string;
  children?: DomNode[];
}

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "aside", "header", "footer", "nav",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "figure", "figcaption", "form", "br", "hr"
]);

export function extractFromHtml(html: string): { title: string; text: string } {
  const $ = load(html);

  // 移除非正文标签。
  $("script, style, noscript, svg, nav, footer, header").remove();

  const title = $("title").first().text().trim();

  const parts: string[] = [];

  const visit = (node: DomNode): void => {
    if (node.type === "text") {
      if (node.data) {
        parts.push(node.data); // 内联文本直接取 textContent
      }
      return;
    }

    for (const child of node.children ?? []) {
      visit(child);
    }

    // 块级元素后补一个换行。
    if (node.name && BLOCK_TAGS.has(node.name.toLowerCase())) {
      parts.push("\n");
    }
  };

  const root = ($("body")[0] ?? $.root()[0]) as unknown as DomNode | undefined;

  if (root) {
    for (const child of root.children ?? []) {
      visit(child);
    }
  }

  return {
    title,
    text: collapseWhitespace(parts.join(""))
  };
}

/** 合并多余空白：水平空白压成单空格，规整换行，最多保留两个连续换行。 */
function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
