import { ConvertOptions } from "./types";
import { readFileSync, existsSync, readdirSync } from "fs";
import { extname, resolve as pathResolve } from "path";

/** 字体扩展名 → MIME 类型 */
const FONT_MIME: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

/** CSS format() 值 */
const FORMAT_MAP: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
  eot: "embedded-opentype",
};

/** 支持的扩展名，按优先级排列 */
const FONT_EXTS = ["woff2", "woff", "otf", "ttf", "eot"];

// ────────────────────────────────────────────────────────────
// 字体缓存
// ────────────────────────────────────────────────────────────

const FONT_DATA_URI_CACHE = new Map<string, string>();

interface FontEmbedResult {
  families: string[];
  css: string;
}
const FONT_EMBED_CACHE = new Map<string, FontEmbedResult>();

function embedCacheKey(options: ConvertOptions): string {
  return [options.fontDir ?? "", options.documentFont ?? "", options.codeFont ?? ""].join("\u0000");
}

interface FontFile {
  baseName: string;
  file: string;
}

interface FontToEmbed {
  family: string;
  file: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

function scanFontDir(fontDir: string): FontFile[] {
  const abs = pathResolve(fontDir);
  if (!existsSync(abs)) return [];

  let items: string[];
  try {
    items = readdirSync(abs);
  } catch {
    return [];
  }

  const byBase = new Map<string, string>();
  for (const name of items) {
    const ext = extname(name).slice(1).toLowerCase();
    if (!FONT_EXTS.includes(ext)) continue;

    const base = name.slice(0, -extname(name).length);
    const key = normalize(base);
    const existing = byBase.get(key);

    if (!existing) {
      byBase.set(key, name);
    } else {
      const existExt = extname(existing).slice(1).toLowerCase();
      if (FONT_EXTS.indexOf(ext) < FONT_EXTS.indexOf(existExt)) {
        byBase.set(key, name);
      }
    }
  }

  return [...byBase.values()].map((name) => ({
    baseName: name.slice(0, -extname(name).length),
    file: pathResolve(abs, name),
  }));
}

function findFontFile(entries: FontFile[], query: string): FontFile | null {
  const norm = normalize(query);
  return entries.find((e) => normalize(e.baseName) === norm) ?? null;
}

function fontToDataUri(filePath: string): string | null {
  const cached = FONT_DATA_URI_CACHE.get(filePath);
  if (cached !== undefined) return cached;

  const ext = extname(filePath).slice(1).toLowerCase();
  const mime = FONT_MIME[ext];
  if (!mime) {
    console.warn(`⚠️  不支持的字体格式: .${ext} (${filePath})`);
    return null;
  }

  try {
    const data = readFileSync(filePath);
    const uri = `data:${mime};base64,${data.toString("base64")}`;
    FONT_DATA_URI_CACHE.set(filePath, uri);
    return uri;
  } catch (err) {
    console.warn(`⚠️  读取字体失败: ${filePath}`, err);
    return null;
  }
}

function buildFontFace(family: string, file: string): string {
  const uri = fontToDataUri(file);
  if (!uri) return "";

  const ext = extname(file).slice(1).toLowerCase();
  const format = FORMAT_MAP[ext] || ext;
  const safeFamily = family.replace(/'/g, "\\'");

  return `@font-face {
  font-family: '${safeFamily}';
  src: url('${uri}') format('${format}');
  font-display: block;
}`;
}

function parseFontFamilies(fontSpec: string): string[] {
  return fontSpec
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

function collectFontsToEmbed(options: ConvertOptions): FontToEmbed[] {
  if (!options.fontDir) return [];

  const entries = scanFontDir(options.fontDir);
  if (entries.length === 0) return [];

  const families = [
    ...(options.documentFont ? parseFontFamilies(options.documentFont) : []),
    ...(options.codeFont ? parseFontFamilies(options.codeFont) : []),
  ];

  const seen = new Set<string>();
  const result: FontToEmbed[] = [];

  for (const family of families) {
    if (seen.has(family)) continue;
    seen.add(family);

    const found = findFontFile(entries, family);
    if (found) {
      result.push({ family, file: found.file });
    }
  }

  return result;
}

function getFontEmbed(options: ConvertOptions): FontEmbedResult {
  const key = embedCacheKey(options);
  const cached = FONT_EMBED_CACHE.get(key);
  if (cached) return cached;

  const fonts = collectFontsToEmbed(options);
  const faces: string[] = [];

  for (const { family, file } of fonts) {
    const face = buildFontFace(family, file);
    if (face) faces.push(face);
  }

  const result: FontEmbedResult = {
    families: fonts.map((f) => f.family),
    css: faces.join("\n\n"),
  };

  FONT_EMBED_CACHE.set(key, result);
  return result;
}

export function getCustomFontFamilies(options: ConvertOptions): string[] {
  return getFontEmbed(options).families;
}

function buildFontFaces(options: ConvertOptions): string {
  return getFontEmbed(options).css;
}

// ────────────────────────────────────────────────────────────
// 水印
// ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 生成水印层。
 *
 * 水印层用 position: fixed 覆盖整页；Chromium 打印为 PDF 时会为每一页
 * 重复渲染 fixed 元素，因此无需为分页做任何额外处理。
 *
 * 三种布局共用 .watermark-layer 容器和 .wm-item 文字元素，
 * 通过附加的布局类决定具体排列方式。
 */
function buildWatermarkLayer(options: ConvertOptions): string {
  const wm = options.watermark;
  if (!wm || !wm.text.trim()) return "";

  const opacity = wm.opacity ?? 0.15;
  const fontSize = wm.fontSize ?? 36;
  const color = wm.color ?? "#999999";
  const angle = wm.angle ?? -30;
  const borderRadius = wm.borderRadius ?? 12;
  const borderWidth = wm.borderWidth ?? 4;
  const text = escapeHtml(wm.text);

  const styleVars =
    `--wm-font-size:${fontSize}pt;` +
    `--wm-color:${color};` +
    `--wm-opacity:${opacity};` +
    `--wm-angle:${angle}deg;` +
    `--wm-radius:${borderRadius}px;` +
    `--wm-border-width:${borderWidth}px;`;

  if (wm.layout === "diagonal") {
    return `<div class="watermark-layer watermark-diagonal" style="${styleVars}" aria-hidden="true">
  <div class="wm-item">${text}</div>
</div>`;
  }

  if (wm.layout === "stamp") {
    return `<div class="watermark-layer watermark-stamp" style="${styleVars}" aria-hidden="true">
  <div class="wm-item">${text}</div>
</div>`;
  }

  // tile：多行交错
  const ROWS = 5;
  const COLS = 4;
  const cells: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const odd = r % 2 === 1 ? " wm-odd" : "";
    for (let c = 0; c < COLS; c++) {
      cells.push(`<div class="wm-item${odd}">${text}</div>`);
    }
  }
  return `<div class="watermark-layer watermark-tile" style="${styleVars}" aria-hidden="true">
  ${cells.join("\n  ")}
</div>`;
}

// ────────────────────────────────────────────────────────────
// 主模板
// ────────────────────────────────────────────────────────────

export function buildHtml(bodyHtml: string, highlightCss: string, options: ConvertOptions): string {
  const docFont = options.documentFont || "'Helvetica Neue', Arial, sans-serif";
  const codeFont = options.codeFont || "'JetBrains Mono', 'Fira Code', monospace";
  const baseSize = options.fontSize || 11;
  const fontFaces = buildFontFaces(options);
  const watermarkLayer = buildWatermarkLayer(options);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
${fontFaces}

${highlightCss}

:root {
  --doc-font: ${docFont};
  --code-font: ${codeFont};
  --base-size: ${baseSize}pt;
}

* { box-sizing: border-box; }

body {
  font-family: var(--doc-font);
  font-size: var(--base-size);
  line-height: 1.75;
  color: #1a1a1a;
  max-width: 100%;
  padding: 0;
  margin: 0;
  position: relative;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--doc-font);
  font-weight: 700;
  margin-top: 1.5em;
  margin-bottom: 0.6em;
  page-break-after: avoid;
}

h1 { font-size: 1.8em; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.3em; }
h2 { font-size: 1.45em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
h3 { font-size: 1.2em; }

p { margin: 0.6em 0; }

pre {
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  page-break-inside: avoid;
  font-size: 0.9em;
}

code {
  font-family: var(--code-font);
  font-size: 0.92em;
}

p code, li code, td code {
  background: #f0f2f5;
  padding: 0.15em 0.4em;
  border-radius: 3px;
  color: #c7254e;
}

.mermaid-diagram {
  text-align: center;
  margin: 1.2em 0;
  page-break-inside: avoid;
}
.mermaid-diagram svg {
  max-width: 100%;
  height: auto;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  page-break-inside: avoid;
}
th, td {
  border: 1px solid #d0d7de;
  padding: 6px 12px;
  text-align: left;
}
th { background: #f6f8fa; font-weight: 600; }

blockquote {
  border-left: 4px solid #d0d7de;
  margin: 0.8em 0;
  padding: 0.4em 1em;
  color: #555;
  background: #fafbfc;
}

img { max-width: 100%; height: auto; }

.page-break { page-break-before: always; }

/* ─────────────────────────────────────────────
   水印
   ───────────────────────────────────────────── */

.watermark-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  user-select: none;
  z-index: 9999;
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.watermark-layer .wm-item {
  font-family: var(--doc-font);
  font-weight: 700;
  white-space: nowrap;
  color: var(--wm-color);
  opacity: var(--wm-opacity);
  font-size: var(--wm-font-size);
  letter-spacing: 0.15em;
  line-height: 1;
  padding: 4px 10px;
}

/* ── 居中斜线一行 ── */
.watermark-diagonal {
  display: flex;
  align-items: center;
  justify-content: center;
}
.watermark-diagonal .wm-item {
  transform: rotate(var(--wm-angle));
}

/* ── 居中印章（带边框） ── */
.watermark-stamp {
  display: flex;
  align-items: center;
  justify-content: center;
}
.watermark-stamp .wm-item {
  border: var(--wm-border-width) solid var(--wm-color);
  border-radius: var(--wm-radius);
  padding: 0.35em 0.9em;
  letter-spacing: 0.25em;
  /* 让边框也使用 opacity，与文字保持一致 */
  transform: rotate(var(--wm-angle));
  /* 印章通常角度小、甚至为 0，用 inset 让边框紧贴文字 */
  box-shadow: inset 0 0 0 0 var(--wm-color);
}

/* ── 多行交错 ── */
.watermark-tile {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(5, 1fr);
  place-items: center;
  gap: 8px;
}
.watermark-tile .wm-item {
  transform: rotate(var(--wm-angle));
}
.watermark-tile .wm-item.wm-odd {
  transform: translateX(22%) rotate(var(--wm-angle));
}
</style>
</head>
<body>
${bodyHtml}
${watermarkLayer}
</body>
</html>`;
}
