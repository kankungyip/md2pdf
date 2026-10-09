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

    "doc-font": { type: "string" },
    "code-font": { type: "string" },
    "font-size": { type: "string" },
    "font-dir": { type: "string" },
    "highlight-theme": { type: "string", default: "github" },
    "page-size": { type: "string", default: "A4" },
    "mermaid-theme": { type: "string", default: "default" },
    "executable-path": { type: "string" },

    // 水印
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

批量选项:
  --suffix <s>            输出文件名后缀 (默认 "", 例如 "-v2" → doc-v2.pdf)
  --ignore <a,b,c>        忽略的目录/文件名 (默认 node_modules,.git,...)
  --concurrency <n>       并发数 (默认 2)
  --skip-existing         跳过已存在的 PDF (默认覆盖)

通用选项:
  -o, --output <path>     单文件模式输出路径
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
  --watermark-layout <l>  水印布局 (默认 tile)
                            tile       多行交错，铺满整页
                            diagonal   居中斜线一行（angle=0 即为横线一行）
                            stamp      居中印章，带圆角边框
  --watermark-opacity <n>      不透明度 0-1 (默认 0.15)
  --watermark-font-size <pt>   字号 (默认 36)
  --watermark-color <c>        颜色 (默认 #999999)
  --watermark-angle <deg>      旋转角度 (默认 -30)
  --watermark-border-radius <px> 边框圆角，仅 stamp 生效 (默认 12)
  --watermark-border-width <px>  边框宽度，仅 stamp 生效 (默认 4)

示例:
  # 多行交错
  bun run src/index.ts doc.md --watermark "内部机密"

  # 居中斜线一行（红色，大字号）
  bun run src/index.ts doc.md --watermark "仅供内部使用" \\
    --watermark-layout diagonal --watermark-font-size 80 \\
    --watermark-color "#cc3333" --watermark-opacity 0.2

  # 居中横线一行（斜线布局 + angle=0）
  bun run src/index.ts doc.md --watermark "DRAFT" \\
    --watermark-layout diagonal --watermark-angle 0 \\
    --watermark-font-size 100

  # 印章效果（红色公章，方形边框）
  bun run src/index.ts doc.md --watermark "已阅" \\
    --watermark-layout stamp --watermark-color "#c62828" \\
    --watermark-opacity 0.75 --watermark-font-size 60 \\
    --watermark-angle -8 --watermark-border-radius 8 \\
    --watermark-border-width 6

  # 圆形印章
  bun run src/index.ts doc.md --watermark "机密" \\
    --watermark-layout stamp --watermark-color "#c62828" \\
    --watermark-opacity 0.8 --watermark-font-size 52 \\
    --watermark-border-radius 999 --watermark-border-width 5`);
  process.exit(1);
}

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

let stat;
try {
  stat = statSync(input);
} catch {
  console.error(`路径不存在: ${input}`);
  process.exit(1);
}

try {
  if (stat.isDirectory()) {
    await convertDirectory({
      dir: input,
      suffix: values.suffix ?? "",
      ignore: (values.ignore ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      concurrency: Math.max(1, parseInt(values.concurrency ?? "2")),
      skipExisting: !!values["skip-existing"],
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
