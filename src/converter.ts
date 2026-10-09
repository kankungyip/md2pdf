import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import markdownItHighlightjs from "markdown-it-highlightjs";
import puppeteer, { Browser } from "puppeteer-core";
import { readFileSync, existsSync } from "fs";
import { dirname, isAbsolute, resolve as pathResolve, extname } from "path";
import { mkdir } from "fs/promises";
import { buildHtml, getCustomFontFamilies } from "./template";
import { ConvertOptions } from "./types";
import { resolveExecutablePath } from "./browser";
import { formatError } from "./format-error";

export interface RenderResult {
  customFonts: string[];
  loadedFonts: string[];
  failedFonts: string[];
}

const SET_CONTENT_TIMEOUT_MS = 90_000;

/** 图片扩展名 → MIME 类型 */
const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把图片引用解析成最终 src。
 * - http(s)、data URI：原样返回
 * - file:// 或相对/绝对路径：读文件转 base64 data URI 内嵌
 * - 找不到的路径：返回原值并打警告
 */
function resolveImageSrc(href: string, mdDir: string): string {
  if (!href) return href;
  if (/^(https?:|data:)/i.test(href)) return href;

  let localPath = href;
  if (localPath.startsWith("file://")) {
    localPath = localPath.slice("file://".length);
  }

  localPath = localPath.split(/[?#]/)[0];

  try {
    localPath = decodeURIComponent(localPath);
  } catch {
    // 忽略非法百分号编码
  }

  const abs = isAbsolute(localPath) ? localPath : pathResolve(mdDir, localPath);

  if (!existsSync(abs)) {
    console.warn(`⚠️  图片未找到: ${href}\n     尝试路径: ${abs}`);
    return href;
  }

  const ext = extname(abs).slice(1).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";

  try {
    const data = readFileSync(abs);
    if (data.byteLength > 10 * 1024 * 1024) {
      console.warn(
        `⚠️  图片较大 (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)，` +
          `内嵌可能导致转换变慢: ${abs}`,
      );
    }
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch (err) {
    console.warn(`⚠️  读取图片失败: ${abs}`, err);
    return href;
  }
}

/**
 * 对 HTML 字符串里所有 <img> 标签做本地路径内嵌处理。
 * 覆盖 Markdown 里直接写的原始 HTML。
 * markdown-it 默认会将 HTML 原样输出，因此需要这一步。
 */
function inlineHtmlImages(html: string, mdDir: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (match, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!srcMatch) return match;

    const originalSrc = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";

    if (/^(https?:|data:)/i.test(originalSrc)) return match;

    const resolved = resolveImageSrc(originalSrc, mdDir);
    if (resolved === originalSrc) return match;

    const newAttrs = attrs.replace(
      /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
      `src="${resolved}"`,
    );
    return `<img${newAttrs}>`;
  });
}

/**
 * 创建配置好的 markdown-it 实例。
 *
 * 1. 注册 cjk-friendly 插件，解决中文加粗问题。
 * 2. 注册 highlightjs 插件，处理代码高亮。
 * 3. 覆盖 code 渲染规则，将 ```mermaid 转为占位 div。
 * 4. 覆盖 image 渲染规则，将本地图片路径转为 base64。
 */
function createMarkdownIt(mdDir: string): MarkdownIt {
  const md = new MarkdownIt({
    html: true, // 允许 HTML 标签
    linkify: true, // 自动转换 URL
    breaks: false, // 不将换行转为 <br>
  });

  // 1. 注册 CJK 友好插件，修复中文加粗
  md.use(markdownItCjkFriendly);

  // 2. 注册代码高亮插件
  md.use(markdownItHighlightjs, {
    auto: true,
    code: true,
  });

  // 3. 自定义 code 渲染：拦截 mermaid 代码块
  const defaultCodeRender =
    md.renderer.rules.code_block ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().toLowerCase();

    if (lang === "mermaid") {
      const b64 = Buffer.from(token.content, "utf-8").toString("base64");
      return `<div class="mermaid-diagram" data-mermaid="${b64}"></div>\n`;
    }

    return defaultCodeRender(tokens, idx, options, env, self);
  };

  // 同样处理围栏代码块（fence）
  const defaultFenceRender =
    md.renderer.rules.fence ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().toLowerCase();

    if (lang === "mermaid") {
      const b64 = Buffer.from(token.content, "utf-8").toString("base64");
      return `<div class="mermaid-diagram" data-mermaid="${b64}"></div>\n`;
    }

    // 非 mermaid 代码块交给 highlightjs 处理
    return defaultFenceRender(tokens, idx, options, env, self);
  };

  // 4. 自定义 image 渲染：本地图片转 base64
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") || "";
    const alt = token.content || "";
    const title = token.attrGet("title") || "";

    const resolvedSrc = resolveImageSrc(src, mdDir);
    const safeSrc = resolvedSrc.startsWith("data:") ? resolvedSrc : escapeHtml(resolvedSrc);

    let html = `<img src="${safeSrc}" alt="${escapeHtml(alt)}"`;
    if (title) html += ` title="${escapeHtml(title)}"`;
    html += ">";
    return html;
  };

  return md;
}

function renderMarkdown(md: string, mdDir: string): string {
  const parser = createMarkdownIt(mdDir);
  const html = parser.render(md);
  // markdown-it 不处理原始 HTML 中的 <img>，这里补一次
  return inlineHtmlImages(html, mdDir);
}

export async function launchBrowser(executablePath?: string): Promise<Browser> {
  const path = await resolveExecutablePath(executablePath);
  return puppeteer.launch({
    executablePath: path,
    headless: "shell",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

export async function renderPdf(browser: Browser, options: ConvertOptions): Promise<RenderResult> {
  const mdContent = readFileSync(options.input, "utf-8");
  const mdDir = dirname(pathResolve(options.input));
  const bodyHtml = renderMarkdown(mdContent, mdDir);

  const highlightTheme = options.highlightTheme || "github";
  const cssPath = Bun.resolveSync(`highlight.js/styles/${highlightTheme}.css`, process.cwd());
  const highlightCss = readFileSync(cssPath, "utf-8");

  const html = buildHtml(bodyHtml, highlightCss, options);

  const customFonts = getCustomFontFamilies(options);
  let loadedFonts: string[] = [];
  let failedFonts: string[] = [];

  const page = await browser.newPage();
  try {
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: SET_CONTENT_TIMEOUT_MS,
    });

    if (customFonts.length > 0) {
      const status = await page.evaluate(async (families: string[]) => {
        const results: { family: string; loaded: boolean }[] = [];
        for (const f of families) {
          try {
            await document.fonts.load(`16px "${f}"`);
            const loaded = document.fonts.check(`16px "${f}"`);
            results.push({ family: f, loaded });
          } catch {
            results.push({ family: f, loaded: false });
          }
        }
        return results;
      }, customFonts);

      loadedFonts = status.filter((s) => s.loaded).map((s) => s.family);
      failedFonts = status.filter((s) => !s.loaded).map((s) => s.family);
    }

    await page.evaluate(() => document.fonts.ready);

    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
        ),
      );
    });

    if (bodyHtml.includes("data-mermaid=")) {
      const mermaidPath = Bun.resolveSync("mermaid/dist/mermaid.min.js", process.cwd());
      await page.addScriptTag({ path: mermaidPath });

      const mermaidErrors = await page.evaluate(async (theme: string) => {
        const m = (window as any).mermaid;
        m.initialize({ startOnLoad: false, theme });
        const errors: string[] = [];

        const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-mermaid]"));

        for (const node of nodes) {
          const b64 = node.getAttribute("data-mermaid") || "";
          let code: string;
          try {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            code = new TextDecoder("utf-8").decode(bytes);
          } catch (e) {
            errors.push(`无法解码 Mermaid 源码: ${String(e)}`);
            continue;
          }

          const id = "mmd-" + Math.random().toString(36).slice(2, 10);
          try {
            const { svg } = await m.render(id, code);
            const wrapper = document.createElement("div");
            wrapper.className = "mermaid-container";
            wrapper.innerHTML = svg;
            node.replaceWith(wrapper);
          } catch (e) {
            const msg =
              e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
            errors.push(`Mermaid 渲染失败: ${msg}\n源码片段:\n${code.slice(0, 300)}`);
          }
        }
        return errors;
      }, options.mermaidTheme || "default");

      if (mermaidErrors.length > 0) {
        throw new Error(
          `Mermaid 图表渲染失败（${mermaidErrors.length} 处）:\n` +
            mermaidErrors.map((e, i) => `  [${i + 1}] ${e}`).join("\n"),
        );
      }
    }

    const pdfBuffer = await page.pdf({
      format: options.pageSize || "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
      displayHeaderFooter: false,
    });

    const outDir = dirname(pathResolve(options.output));
    try {
      await mkdir(outDir, { recursive: true });
    } catch {
      // 目录已存在
    }

    const written = await Bun.write(options.output, pdfBuffer);
    if (written <= 0) {
      throw new Error(`写入 PDF 失败: 返回字节数为 ${written}，路径 ${options.output}`);
    }

    return { customFonts, loadedFonts, failedFonts };
  } catch (err) {
    throw new Error(`转换失败 [${options.input}]: ${formatError(err)}`, { cause: err });
  } finally {
    await page.close();
  }
}

function printFontStatus(result: RenderResult): void {
  if (result.customFonts.length === 0) return;

  for (const f of result.loadedFonts) {
    console.log(`  ✓ 字体已加载: ${f}`);
  }
  for (const f of result.failedFonts) {
    console.warn(`  ⚠️  字体加载失败: ${f}`);
  }
}

export async function convertToPdf(options: ConvertOptions): Promise<void> {
  const browser = await launchBrowser(options.executablePath);
  try {
    const result = await renderPdf(browser, options);
    printFontStatus(result);
  } finally {
    await browser.close();
  }
}
