export interface ConvertOptions {
  input: string;
  output: string;
  /**
   * 文档正文字体族。
   *
   * 与 fontDir 中的字体文件名对应，支持两种写法：
   *   1. 完整文件名（不含扩展名）：
   *      "MapleMono-NF-CN-Regular" → fonts/MapleMono-NF-CN-Regular.ttf
   *   2. 家族名（去掉尾部字重/样式后缀，会自动匹配同家族所有字重）：
   *      "MapleMono-NF-CN" → fonts/MapleMono-NF-CN-Regular.ttf
   *                          fonts/MapleMono-NF-CN-Bold.ttf
   *                          fonts/MapleMono-NF-CN-Italic.ttf
   *                          ...
   *
   * 也支持 CSS font-family 语法（逗号分隔、引号包裹、fallback 列表）：
   *   "MapleMono-NF-CN, monospace"
   *   → MapleMono-NF-CN 若在 fontDir 中找到字体则内嵌；
   *     monospace 作为 CSS 回退保留
   *
   * 匹配时忽略大小写、空格、连字符、下划线。
   */
  documentFont?: string;
  /** 代码字体族，语义同 documentFont */
  codeFont?: string;
  /** 基础字号（pt），默认 11 */
  fontSize?: number;
  /**
   * 自定义字体目录。
   *
   * 目录中所有 .woff2 / .woff / .otf / .ttf 文件都会被扫描，
   * 文件名（不含扩展名）会被解析成 (family, weight, style)。
   * 每个字体族名会匹配到若干个字体文件，为每个文件生成一条 @font-face。
   */
  fontDir?: string;
  /** 代码高亮主题，默认 github */
  highlightTheme?: string;
  /** 页面尺寸，默认 A4 */
  pageSize?: "A4" | "Letter" | "A3";
  /** Mermaid 主题，默认 default */
  mermaidTheme?: string;
  /** chrome-headless-shell 可执行文件路径，不传则自动查找 */
  executablePath?: string;
}

export interface BatchOptions {
  dir: string;
  suffix: string;
  ignore: string[];
  concurrency: number;
  skipExisting: boolean;
  convert: Omit<ConvertOptions, "input" | "output">;
}
