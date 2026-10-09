export type WatermarkLayout = "tile" | "diagonal" | "stamp";

export interface WatermarkOptions {
  /** 水印文本 */
  text: string;
  /**
   * 显示方式：
   *   - tile       多行交错，铺满整页
   *   - diagonal   居中斜线一行（angle 设为 0 即为横线一行）
   *   - stamp      居中印章，带圆角边框
   */
  layout: WatermarkLayout;
  /** 不透明度，0-1，默认 0.15 */
  opacity?: number;
  /** 字号（pt），默认 36 */
  fontSize?: number;
  /** 颜色，任意 CSS 颜色值，默认 #999999 */
  color?: string;
  /** 旋转角度（度），默认 -30。stamp 布局建议设为 0 */
  angle?: number;
  /** 边框圆角半径（px），仅 stamp 布局生效，默认 12 */
  borderRadius?: number;
  /** 边框宽度（px），仅 stamp 布局生效，默认 4 */
  borderWidth?: number;
}

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
  watermark?: WatermarkOptions;
}

export interface BatchOptions {
  /** 输入根目录 */
  dir: string;
  /**
   * 输出根目录。指定后：
   *   - PDF 输出到 <outputDir>/<相对路径>.pdf
   *   - --copy-ext 匹配的文件复制到 <outputDir>/<相对路径>
   *   - --copy-dir 匹配的目录被递归扫描：
   *       · 其中的 .md 会被转换为 PDF
   *       · 其他文件全部复制到 <outputDir>/<相对路径>
   * 不指定则维持原行为：PDF 与源文件同目录。
   */
  outputDir?: string;
  /** 输出 PDF 文件名后缀（不含 .pdf），如 "-v2" → doc-v2.pdf */
  suffix: string;
  /** 忽略的目录/文件名 */
  ignore: string[];
  /** 并发数 */
  concurrency: number;
  /** 跳过已存在的 PDF 和复制文件 */
  skipExisting: boolean;
  /** 全局要复制的文件扩展名（小写、不含点），如 ["pdf", "txt"] */
  copyExts: string[];
  /** 要递归扫描的目录名，如 ["c", "assets"] */
  copyDirs: string[];
  /** 传给每个文件的转换参数 */
  convert: Omit<ConvertOptions, "input" | "output">;
}
