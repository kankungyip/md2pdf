#!/usr/bin/env bun
import { parseArgs } from "util";
import { statSync } from "fs";
import { convertToPdf } from "./converter";
import { convertDirectory } from "./batch";
import { formatError } from "./format-error";
import type { WatermarkLayout } from "./types";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o" },
    suffix: { type: "string", default: "" },
    ignore: {
      type: "string",
      default: "node_modules,.git,.obsidian,dist,build,.next",
    },
    concurrency: { type: "string", default: "2" },
    "skip-existing": { type: "boolean", default: false },
    "copy-ext": { type: "string", default: "" },
    "copy-dir": { type: "string", default: "" },

    "doc-font": { type: "string" },
    "code-font": { type: "string" },
    "font-size": { type: "string" },
    "font-dir": { type: "string" },
    "highlight-theme": { type: "string", default: "github" },
    "page-size": { type: "string", default: "A4" },
    "mermaid-theme": { type: "string", default: "default" },
    "executable-path": { type: "string" },

    watermark: { type: "string" },
    "watermark-layout": { type: "string", default: "tile" },
    "watermark-opacity": { type: "string", default: "0.15" },
    "watermark-font-size": { type: "string", default: "36" },
    "watermark-color": { type: "string", default: "#999999" },
    "watermark-angle": { type: "string", default: "-30" },
    "watermark-border-radius": { type: "string", default: "12" },
    "watermark-border-width": { type: "string", default: "4" },
  },
  allowPositionals: true,
});

const input = positionals[0];
if (!input) {
  console.error(`用法:
  bun run src/index.ts <file.md>                # 单文件转换
  bun run src/index.ts <dir>                    # 批量递归转换

单文件选项:
  -o, --output <path>     输出 PDF 路径

批量选项:
  -o, --output <dir>      输出根目录。指定后所有 PDF 输出到该目录下，
                          并保持与输入目录相同的相对路径结构。
                          不指定则 PDF 与源文件同目录。

  --suffix <s>            输出 PDF 文件名后缀 (默认 "", 例如 "-v2" → doc-v2.pdf)
  --ignore <a,b,c>        忽略的目录/文件名 (默认 node_modules,.git,...)
  --concurrency <n>       并发数 (默认 2)
  --skip-existing         跳过已存在的 PDF 和复制文件 (默认覆盖)

  --copy-ext <exts>       逗号分隔的文件扩展名（不含点）。在整个输入目录树中，
                          匹配这些扩展名的文件会被复制到 --output 下同相对路径位置。
                          例如: --copy-ext pdf,txt,json

  --copy-dir <dirs>       逗号分隔的目录名。匹配的目录会被递归扫描：
                            · 其中的 .md 文件转换为 PDF
                            · 其他文件全部复制到 --output 下同相对路径位置
                          例如: --copy-dir assets,images,c

通用选项:
  --font-dir <dir>        自定义字体目录 (.woff2/.woff/.otf/.ttf)
  --doc-font <family>     文档正文字体族，与字体文件名对应
  --code-font <family>    代码字体族，语义同 --doc-font
  --font-size <pt>        基础字号 (默认 11)
  --highlight-theme <t>   代码高亮主题 (默认 github)
  --page-size <size>      A4 | Letter | A3
  --mermaid-theme <t>     Mermaid 主题
  --executable-path <p>   chrome-headless-shell 可执行文件路径 (默认自动查找)

水印选项（不传 --watermark 则不生成水印）:
  --watermark <text>      水印文字
  --watermark-layout <l>  tile | diagonal | stamp (默认 tile)
  --watermark-opacity <n> 不透明度 0-1 (默认 0.15)
  --watermark-font-size <pt> 字号 (默认 36)
  --watermark-color <c>   颜色 (默认 #999999)
  --watermark-angle <deg> 旋转角度 (默认 -30)
  --watermark-border-radius <px> 边框圆角，仅 stamp 生效 (默认 12)
  --watermark-border-width <px>  边框宽度，仅 stamp 生效 (默认 4)

示例:
  # 单文件转换
  bun run src/index.ts doc.md -o out.pdf

  # 批量转换，PDF 与源文件同目录
  bun run src/index.ts ./docs

  # 批量转换，输出到 dist/ 并保持目录结构
  bun run src/index.ts ./docs -o dist

  # 转换 + 复制 PDF 和 assets 目录
  bun run src/index.ts ./docs -o dist \\
    --copy-ext pdf --copy-dir assets

  # 复杂场景：c 目录里的 md 转 PDF，其他文件复制
  #   docs/a/c/c1.md  → dist/a/c/c1.pdf
  #   docs/a/c/c2.txt → dist/a/c/c2.txt
  bun run src/index.ts ./docs -o dist --copy-dir c

  # 结合水印与字体
  bun run src/index.ts ./docs -o dist \\
    --copy-ext pdf --copy-dir assets \\
    --watermark "内部机密" --watermark-layout tile \\
    --font-dir ./fonts --doc-font "MapleMono-NF-CN-Regular" \\
    --concurrency 4`);
  process.exit(1);
}

// ── 水印配置 ──
const watermarkText = values.watermark?.trim();
const watermark = watermarkText
  ? {
      text: watermarkText,
      layout: (values["watermark-layout"] || "tile") as WatermarkLayout,
      opacity: values["watermark-opacity"] ? parseFloat(values["watermark-opacity"]) : undefined,
      fontSize: values["watermark-font-size"]
        ? parseFloat(values["watermark-font-size"])
        : undefined,
      color: values["watermark-color"],
      angle: values["watermark-angle"] ? parseFloat(values["watermark-angle"]) : undefined,
      borderRadius: values["watermark-border-radius"]
        ? parseFloat(values["watermark-border-radius"])
        : undefined,
      borderWidth: values["watermark-border-width"]
        ? parseFloat(values["watermark-border-width"])
        : undefined,
    }
  : undefined;

const convertOpts = {
  documentFont: values["doc-font"],
  codeFont: values["code-font"],
  fontSize: values["font-size"] ? parseFloat(values["font-size"]) : undefined,
  fontDir: values["font-dir"],
  highlightTheme: values["highlight-theme"],
  pageSize: values["page-size"] as "A4" | "Letter" | "A3",
  mermaidTheme: values["mermaid-theme"],
  executablePath: values["executable-path"],
  watermark,
};

// ── 输入路径检查 ──
let stat;
try {
  stat = statSync(input);
} catch {
  console.error(`路径不存在: ${input}`);
  process.exit(1);
}

try {
  if (stat.isDirectory()) {
    const copyExts = (values["copy-ext"] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
    const copyDirs = (values["copy-dir"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await convertDirectory({
      dir: input,
      outputDir: values.output,
      suffix: values.suffix ?? "",
      ignore: (values.ignore ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      concurrency: Math.max(1, parseInt(values.concurrency ?? "2")),
      skipExisting: !!values["skip-existing"],
      copyExts,
      copyDirs,
      convert: convertOpts,
    });
  } else {
    const output = values.output || input.replace(/\.md$/i, ".pdf");
    await convertToPdf({ ...convertOpts, input, output });
    console.log(`✓ 已生成: ${output}`);
  }
} catch (err) {
  console.error(`\n❌ 执行失败:\n${formatError(err)}`);
  process.exit(1);
}
