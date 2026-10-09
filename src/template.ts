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

/** 支持的扩展名，按优先级排列（woff2 体积最小） */
const FONT_EXTS = ["woff2", "woff", "otf", "ttf", "eot"];

// ────────────────────────────────────────────────────────────
// 模块级缓存：同一个进程内只做一次磁盘读取 + base64 编码
// ────────────────────────────────────────────────────────────

/** 字体文件路径 → base64 data URI */
const FONT_DATA_URI_CACHE = new Map<string, string>();

/** options 关键字段 → 内嵌结果（族名列表 + 拼接好的 CSS） */
interface FontEmbedResult {
  families: string[];
  css: string;
}
const FONT_EMBED_CACHE = new Map<string, FontEmbedResult>();

/** 用 options 中影响字体选择的字段构成缓存 key */
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

/** 归一化：小写、去空格、去连字符、去下划线，用于宽松比较 */
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

/**
 * 字体文件 → base64 data URI（带缓存）。
 *
 * 缓存粒度为文件路径。同一进程内同一路径只读取/编码一次，
 * 批量转换时后续文件直接命中缓存。
 */
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

/**
 * 收集本次要内嵌到 CSS 的字体（实际在 fontDir 中匹配到的）。
 */
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

/**
 * 计算并缓存字体内嵌结果。
 *
 * 同一批批量转换里 options 的字体字段都一样，因此只计算一次：
 *   1. 一次目录扫描
 *   2. 一次文件读取 + base64 编码
 *   3. 一次 @font-face CSS 字符串拼接
 * 后续所有文件直接复用 cache 中的 css / families。
 */
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

/** 对外：本次会在 HTML 中内嵌的自定义字体族名列表 */
export function getCustomFontFamilies(options: ConvertOptions): string[] {
  return getFontEmbed(options).families;
}

/** 生成 @font-face CSS（带缓存） */
function buildFontFaces(options: ConvertOptions): string {
  return getFontEmbed(options).css;
}

export function buildHtml(bodyHtml: string, highlightCss: string, options: ConvertOptions): string {
  const docFont = options.documentFont || "'Helvetica Neue', Arial, sans-serif";
  const codeFont = options.codeFont || "'JetBrains Mono', 'Fira Code', monospace";
  const baseSize = options.fontSize || 11;
  const fontFaces = buildFontFaces(options);

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
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
