import { readdir } from "fs/promises";
import { join, dirname, basename, extname, resolve, relative } from "path";
import { launchBrowser, renderPdf, type RenderResult } from "./converter";
import { BatchOptions } from "./types";
import { formatError } from "./format-error";

/**
 * 字体状态是否已打印过。
 * 批量转换时字体只加载一次（模板层有缓存），提示也只应出现一次，
 * 避免每个文件的日志里都堆一行重复的字体信息。
 */
let fontStatusPrinted = false;

async function collectMarkdown(dir: string, ignore: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(full, ignore)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        await worker(items[i], i);
      }
    }),
  );
}

/** 首次调用时打印字体加载状态，之后静默跳过 */
function printFontStatusOnce(result: RenderResult): void {
  if (fontStatusPrinted) return;
  if (result.customFonts.length === 0) {
    // 未配置自定义字体，也标记为已处理，不再重复检查
    fontStatusPrinted = true;
    return;
  }

  const parts: string[] = [];
  for (const f of result.loadedFonts) parts.push(`${f} ✓`);
  for (const f of result.failedFonts) parts.push(`${f} ✗`);

  console.log(`🔤 字体状态: ${parts.join("  ")}\n`);

  fontStatusPrinted = true;
}

export async function convertDirectory(opts: BatchOptions): Promise<void> {
  const rootDir = resolve(opts.dir);
  const ignore = new Set(opts.ignore);
  const files = await collectMarkdown(rootDir, ignore);

  if (files.length === 0) {
    console.log(`未在 ${rootDir} 下找到 Markdown 文件`);
    return;
  }

  console.log(`📂 根目录: ${rootDir}`);
  console.log(`📝 找到 ${files.length} 个 Markdown 文件`);
  console.log(
    `⚙️  并发数: ${opts.concurrency}  后缀: "${opts.suffix}"  跳过已存在: ${opts.skipExisting}\n`,
  );

  const browser = await launchBrowser(opts.convert.executablePath);

  let success = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;
  const total = files.length;

  const failures: { file: string; reason: string }[] = [];

  try {
    await pool(files, opts.concurrency, async (input) => {
      const dir = dirname(input);
      const name = basename(input, extname(input));
      const output = join(dir, `${name}${opts.suffix}.pdf`);
      const rel = relative(rootDir, input);
      const label = `[${++done}/${total}]`;

      if (opts.skipExisting && (await Bun.file(output).exists())) {
        console.log(`${label} ⏭  跳过 ${rel}`);
        skipped++;
        return;
      }

      const t0 = Date.now();
      try {
        const result = await renderPdf(browser, {
          ...opts.convert,
          input,
          output,
        });
        printFontStatusOnce(result);
        console.log(`${label} ✓ ${rel}  → ${output}  (${Date.now() - t0}ms)`);
        success++;
      } catch (err) {
        const reason = formatError(err);
        const indented = reason
          .split("\n")
          .map((line, i) => (i === 0 ? line : `        ${line}`))
          .join("\n");
        console.error(`${label} ✗ ${rel}\n      → ${indented}`);
        failures.push({ file: rel, reason });
        failed++;
      }
    });
  } finally {
    await browser.close();
  }

  console.log(`\n完成: ${success} 成功 / ${skipped} 跳过 / ${failed} 失败 (共 ${total})`);

  if (failures.length > 0) {
    console.log(`\n失败清单：`);
    for (const f of failures) {
      const firstLine = f.reason.split("\n")[0];
      console.log(`  ✗ ${f.file}\n      ${firstLine}`);
    }
  }
}
