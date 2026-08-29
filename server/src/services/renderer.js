const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

const HIGHLIGHT_CSS = fs.readFileSync(
  require.resolve('highlight.js/styles/github.css'),
  'utf8'
);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLanguageClass(language) {
  return String(language || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

function highlightCodeLine(line, language) {
  if (!line) return '';

  try {
    if (language) {
      return hljs.highlight(line, {
        language,
        ignoreIllegals: true
      }).value;
    }

    return hljs.highlightAuto(line).value;
  } catch {
    return escapeHtml(line);
  }
}

function renderCodeBlock(code, language) {
  const lang = language && hljs.getLanguage(language) ? language : '';
  const languageClass = normalizeLanguageClass(lang);
  const className = languageClass ? ` language-${languageClass}` : '';
  const normalizedCode = code.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = normalizedCode.length ? normalizedCode.split('\n') : [''];
  const rows = lines.map((line, index) => {
    const lineNumber = index + 1;
    return `<tr class="code-row"><td class="line-number">${lineNumber}</td><td class="line-code"><code class="hljs${className}">${highlightCodeLine(line, lang)}</code></td></tr>`;
  }).join('');

  return `<div class="typora-code"><table><tbody>${rows}</tbody></table></div>`;
}

function encodeMarkdownUrl(url) {
  if (!url || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) {
    return url;
  }

  try {
    return encodeURI(decodeURI(url));
  } catch {
    return encodeURI(url);
  }
}

// Typora 风格：图片路径含空格时自动做 URL 编码
function normalizeTyporaImagePaths(markdown) {
  return markdown.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (fullMatch, alt, rawUrl) => {
    const trimmedUrl = rawUrl.trim();
    if (!/\s/.test(trimmedUrl)) {
      return fullMatch;
    }

    return `![${alt}](${encodeMarkdownUrl(trimmedUrl)})`;
  });
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true
  });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const language = token.info ? token.info.trim().split(/\s+/)[0] : '';
    return `${renderCodeBlock(token.content, language)}\n`;
  };

  return md;
}

function buildPrintCss(options) {
  const pageSize = options.pageSize === 'Letter' ? 'Letter' : 'A4';
  const margin = `${options.marginMm}mm`;

  return `
${HIGHLIGHT_CSS}

@page {
  size: ${pageSize};
  margin: ${margin};
}

html {
  background: #fff;
}

body {
  font-family: "Open Sans", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: #333;
  background: #fff;
  margin: 0;
  overflow-wrap: break-word;
}

main {
  width: 100%;
  padding: 0 24px;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  color: #111;
  font-weight: 700;
  line-height: 1.2;
  margin: 1.1em 0 0.6em;
  page-break-after: avoid;
}

h1 {
  font-size: 2.25em;
  border-bottom: none;
  padding-bottom: 0;
}

h2 {
  font-size: 1.75em;
  border-bottom: none;
  padding-bottom: 0;
}

h3 {
  font-size: 1.5em;
}

h4 {
  font-size: 1.25em;
}

h5,
h6 {
  font-size: 1em;
}

p {
  margin: 0 0 1em;
}

a {
  color: #0b63b6;
  text-decoration: none;
  word-break: break-all;
}

code {
  font-family: "Lucida Console", Consolas, "Courier New", "NSimSun", "Noto Sans Mono CJK SC", monospace;
  font-size: 0.95em;
}

:not(pre) > code {
  background: #f3f4f4;
  border: 0;
  border-radius: 3px;
  padding: 1px 4px;
}

.typora-code {
  margin: 1em 0;
  background: #f8f8f8;
  border: 1px solid #e7eaed;
  page-break-inside: avoid;
  overflow: hidden;
}

.typora-code table {
  width: 100%;
  margin: 0;
  border-collapse: collapse;
  table-layout: fixed;
}

.typora-code td {
  border: 0;
  padding: 0;
  vertical-align: top;
}

.typora-code .line-number {
  width: 34px;
  padding: 0 8px 0 0;
  color: #999;
  text-align: right;
  user-select: none;
  background: #f8f8f8;
  font-family: "Lucida Console", Consolas, "Courier New", monospace;
  font-size: 0.9em;
  line-height: 1.45;
}

.typora-code .line-code {
  padding-left: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.typora-code code {
  display: block;
  padding: 0;
  background: transparent;
  font-size: 0.9em;
  line-height: 1.45;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  page-break-inside: auto;
}

table th,
table td {
  border: 1px solid #dfe2e5;
  padding: 6px 8px;
  vertical-align: top;
}

table th {
  background: #f6f8fa;
  font-weight: 700;
}

blockquote {
  border-left: 4px solid #dfe2e5;
  padding-left: 1em;
  margin-left: 0;
  color: #777;
}

img {
  max-width: 100%;
  height: auto;
  page-break-inside: avoid;
}

hr {
  border: 0;
  border-top: 1px solid #ddd;
  margin: 1.5em 0;
}

ul,
ol {
  padding-left: 1.8em;
}

li + li {
  margin-top: 0.25em;
}

@media screen {
  body {
    padding: ${margin};
  }
}

/* 纸张化预览（paperMode）追加样式见 buildPaperPreviewCss */
`;
}

/**
 * 将 Markdown 渲染为用于打印的完整 HTML。
 * @param {object} params
 * @param {string} params.markdown      原始 Markdown 文本
 * @param {string} params.title         文档标题（用于 <title>）
 * @param {string|null} params.baseUrl  相对资源（图片）解析基址；文本模式传 null
 * @param {object} params.options       { pageSize, marginMm, printBackground }
 * @param {boolean} [params.paperMode]  true 时以 A4/Letter 纸张宽度渲染（转换前排版预览）
 */
function renderMarkdownToHtml({ markdown, title, baseUrl, options, paperMode = false }) {
  const md = createMarkdownRenderer();
  const body = md.render(normalizeTyporaImagePaths(markdown));
  const css = buildPrintCss(options);
  const baseTag = baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : '';
  const paperCss = paperMode ? buildPaperPreviewCss(options) : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' http: https: data: blob:; img-src 'self' http: https: data: blob:; style-src 'unsafe-inline'; font-src 'self' http: https: data:;">
  ${baseTag}
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
  <style>${paperCss}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

// 纸张化预览：以真实纸张宽度（210mm/216mm）渲染，mm 单位保证与 PDF 排版一致。
// 预览视口比纸窄时整体等比缩放（transform 不改变内部 mm 排版）。
function buildPaperPreviewCss(options) {
  const width = options.pageSize === 'Letter' ? '216mm' : '210mm';

  return `
@media screen {
  html {
    background: #e8ebef;
  }

  body {
    width: ${width};
    min-height: 297mm;
    margin: 14mm auto 20mm;
    padding: ${options.marginMm}mm;
    background: #fff;
    box-shadow: 0 2px 6px rgba(15, 23, 42, 0.14), 0 12px 32px rgba(15, 23, 42, 0.1);
    box-sizing: border-box;
  }

  main {
    width: auto;
    padding: 0;
  }
}

@media screen and (max-width: 230mm) {
  html {
    --md2pdf-scale: calc(100vw / 240mm);
  }

  body {
    transform: scale(var(--md2pdf-scale));
    transform-origin: top center;
    margin-bottom: calc(20mm * var(--md2pdf-scale));
  }
}
`;
}

module.exports = {
  renderMarkdownToHtml
};
