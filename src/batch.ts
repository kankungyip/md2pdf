import { readdir, mkdir, copyFile, lstat } from "fs/promises";
import { join, dirname, basename, extname, resolve, relative } from "path";
import { launchBrowser, renderPdf, type RenderResult } from "./converter";
import { BatchOptions } from "./types";
import { formatError } from "./format-error";

/**
 * 字体状态是否已打印过。
 * 批量转换时字体只加载一次（模板层有缓存），提示也只应出现一次。
 */
let fontStatusPrinted = false;

/** 扫描结果 */
interface ScanResult {
  /** .md 文件绝对路径（需转换） */
  markdowns: string[];
  /** 需复制的文件绝对路径 */
  copyFiles: string[];
}

/**
 * 递归扫描输入目录。
 *
 * 分类规则：
 *   - 名字在 ignore 中         → 跳过
 *   - 绝对路径 == 输出根       → 跳过（避免 output 位于 input 内部时循环扫描）
 *   - .md 文件                 → markdowns（无论在哪）
 *   - 其他文件，在 copy-dir 内 → copyFiles（全部复制）
 *   - 其他文件，在 copy-dir 外 → 仅当扩展名匹配 copyExts 时进 copyFiles
 *   - 目录名在 copyDirs 中     → 递归时标记 insideCopyDir = true
 */
async function scanDirectory(
  dir: string,
  ignore: Set<string>,
  copyExts: Set<string>,
  copyDirs: Set<string>,
  outputDirAbs: string | null,
  results: ScanResult,
  insideCopyDir: boolean = false,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;

    const full = join(dir, entry.name);

    // 避免扫描到输出目录自身
    if (outputDirAbs && resolve(full) === outputDirAbs) continue;

    if (entry.isDirectory()) {
      const isCopyTarget = copyDirs.has(entry.name);
      await scanDirectory(
        full,
        ignore,
        copyExts,
        copyDirs,
        outputDirAbs,
        results,
        insideCopyDir || isCopyTarget,
      );
    } else if (entry.isFile()) {
      if (/\.md$/i.test(entry.name)) {
        // md 无论在哪都转 PDF，不复制
        results.markdowns.push(full);
      } else {
        const ext = extname(entry.name).slice(1).toLowerCase();
        // copy-dir 内部：所有非 md 文件都复制
        // 其他地方：仅匹配 --copy-ext 的文件复制
        if (insideCopyDir || copyExts.has(ext)) {
          results.copyFiles.push(full);
        }
      }
    }
    // 符号链接等其他类型忽略
  }
}

/** 复制单个文件，自动创建父目录 */
async function copyFileWithMkdir(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

/** 简单 Promise 并发池 */
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
    fontStatusPrinted = true;
    return;
  }

  const parts: string[] = [];
  for (const f of result.loadedFonts) parts.push(`${f} ✓`);
  for (const f of result.failedFonts) parts.push(`${f} ✗`);

  console.log(`\n🔤 字体状态: ${parts.join("  ")}\n`);

  fontStatusPrinted = true;
}

export async function convertDirectory(opts: BatchOptions): Promise<void> {
  const rootDir = resolve(opts.dir);
  const outRoot = opts.outputDir ? resolve(opts.outputDir) : null;
  const ignore = new Set(opts.ignore);
  const copyExts = new Set(opts.copyExts.map((e) => e.replace(/^\./, "").toLowerCase()));
  const copyDirs = new Set(opts.copyDirs);

  // 未指定 --output 时，没有复制目标，--copy-ext / --copy-dir 的复制语义失效
  const scanCopyExts = outRoot ? copyExts : new Set<string>();
  const scanCopyDirs = outRoot ? copyDirs : new Set<string>();

  // ── 扫描 ──
  const scan: ScanResult = { markdowns: [], copyFiles: [] };
  await scanDirectory(rootDir, ignore, scanCopyExts, scanCopyDirs, outRoot, scan);

  if (scan.markdowns.length === 0 && scan.copyFiles.length === 0) {
    console.log(`未在 ${rootDir} 下找到匹配的文件`);
    return;
  }

  console.log(`📂 根目录: ${rootDir}`);
  if (outRoot) console.log(`📤 输出根目录: ${outRoot}`);
  console.log(`📝 找到 ${scan.markdowns.length} 个 Markdown 文件`);
  if (outRoot && scan.copyFiles.length > 0) {
    console.log(`📋 待复制: ${scan.copyFiles.length} 个文件`);
  }
  console.log(
    `⚙️  并发数: ${opts.concurrency}  后缀: "${opts.suffix}"  跳过已存在: ${opts.skipExisting}\n`,
  );

  // ── 复制资源（仅当指定了 --output） ──
  if (outRoot && scan.copyFiles.length > 0) {
    let copied = 0;
    let copySkipped = 0;
    let copyFailed = 0;

    for (const src of scan.copyFiles) {
      const rel = relative(rootDir, src);
      const dest = join(outRoot, rel);

      if (opts.skipExisting) {
        try {
          await lstat(dest);
          console.log(`📄 ⏭  跳过已存在: ${rel}`);
          copySkipped++;
          continue;
        } catch {
          // 目标不存在，继续复制
        }
      }

      try {
        await copyFileWithMkdir(src, dest);
        console.log(`📄 复制 ${rel}`);
        copied++;
      } catch (err) {
        console.error(`📄 ✗ 复制失败 ${rel}\n      → ${formatError(err)}`);
        copyFailed++;
      }
    }

    const summary =
      `📋 复制完成: ${copied} 成功` +
      (copySkipped > 0 ? ` / ${copySkipped} 跳过` : "") +
      (copyFailed > 0 ? ` / ${copyFailed} 失败` : "");
    console.log(`\n${summary}\n`);
  }

  // 无 Markdown 需要转换时跳过浏览器启动
  if (scan.markdowns.length === 0) {
    console.log("完成: 无 Markdown 文件需要转换");
    return;
  }

  // ── 转换 Markdown ──
  const browser = await launchBrowser(opts.convert.executablePath);

  let success = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;
  const total = scan.markdowns.length;

  const failures: { file: string; reason: string }[] = [];

  try {
    await pool(scan.markdowns, opts.concurrency, async (input) => {
      const rel = relative(rootDir, input);
      const relDir = dirname(rel);
      const base = basename(input, extname(input));

      // 根据是否指定 outputDir 决定输出位置
      const output = outRoot
        ? join(outRoot, relDir, `${base}${opts.suffix}.pdf`)
        : join(dirname(input), `${base}${opts.suffix}.pdf`);

      const label = `[${++done}/${total}]`;

      if (opts.skipExisting) {
        try {
          await lstat(output);
          console.log(`${label} ⏭  跳过 ${rel}`);
          skipped++;
          return;
        } catch {
          // 输出不存在，继续转换
        }
      }

      const t0 = Date.now();
      try {
        const result = await renderPdf(browser, {
          ...opts.convert,
          input,
          output,
        });
        console.log(`${label} ✓ ${rel}  → ${output}  (${Date.now() - t0}ms)`);
        printFontStatusOnce(result);
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
