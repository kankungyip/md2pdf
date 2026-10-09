#!/usr/bin/env bun
import { parseArgs } from "util";
import { statSync } from "fs";
import { convertToPdf } from "./converter";
import { convertDirectory } from "./batch";
import { formatError } from "./format-error";

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
  --font-dir <dir>        自定义字体目录
                          支持的扩展名：.woff2 / .woff / .otf / .ttf
  --doc-font <family>     文档正文字体族。两种写法：
                          1. 完整文件名（不含扩展名）
                             "MapleMono-NF-CN-Regular"
                          2. 家族名（自动匹配所有字重）
                             "MapleMono-NF-CN" → Regular/Bold/Italic 全部内嵌，
                                                 <strong>/<em> 会用对应字重
                          也支持 CSS font-family 语法（逗号分隔 fallback）：
                             "MapleMono-NF-CN, monospace"
  --code-font <family>    代码字体族，语义同 --doc-font
  --font-size <pt>        基础字号 (默认 11)
  --highlight-theme <t>   代码高亮主题 (默认 github)
  --page-size <size>      A4 | Letter | A3
  --mermaid-theme <t>     Mermaid 主题
  --executable-path <p>   chrome-headless-shell 可执行文件路径 (默认自动查找)`);
  process.exit(1);
}

const convertOpts = {
  documentFont: values["doc-font"],
  codeFont: values["code-font"],
  fontSize: values["font-size"] ? parseFloat(values["font-size"]) : undefined,
  fontDir: values["font-dir"],
  highlightTheme: values["highlight-theme"],
  pageSize: values["page-size"] as "A4" | "Letter" | "A3",
  mermaidTheme: values["mermaid-theme"],
  executablePath: values["executable-path"],
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
