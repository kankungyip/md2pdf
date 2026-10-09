import { readdir, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { constants } from "fs";

const CACHE_DIR = join(homedir(), ".cache", "puppeteer");

/**
 * 根据平台与架构返回 chrome-headless-shell 可执行文件的相对路径。
 */
function shellRelativePath(): string {
  const arch = process.arch;

  switch (process.platform) {
    case "darwin":
      return arch === "arm64"
        ? "chrome-headless-shell-mac-arm64/chrome-headless-shell"
        : "chrome-headless-shell-mac-x64/chrome-headless-shell";

    case "win32":
      return arch === "arm64"
        ? "chrome-headless-shell-win-arm64/chrome-headless-shell.exe"
        : "chrome-headless-shell-win64/chrome-headless-shell.exe";

    default: {
      const suffix = arch === "arm64" ? "linux-arm64" : "linux64";
      return `chrome-headless-shell-${suffix}/chrome-headless-shell`;
    }
  }
}

/**
 * 判断目录名是否为 chrome-headless-shell 的版本目录。
 * 兼容 "linux-139.0.7258.66"、"mac_arm-139.0.7258.66"、"131.0.6778.204" 等形式。
 */
function isVersionDir(name: string): boolean {
  if (/^(linux|mac_arm|mac-arm64|mac_x64|mac-x64|win32|win64|win-arm64)-[\d.]+$/.test(name)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  return false;
}

/** 从目录名中提取可排序的版本号数组 */
function parseVersion(name: string): number[] {
  const match = name.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (!match) return [0];
  return match[1].split(".").map(Number);
}

/** 在 ~/.cache/puppeteer/chrome-headless-shell 下查找可执行文件 */
export async function findChromeShell(): Promise<string> {
  const base = join(CACHE_DIR, "chrome-headless-shell");

  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    throw new Error(
      `未找到 chrome-headless-shell 缓存目录：${base}\n` +
        `请先运行：bun x puppeteer browsers install chrome-headless-shell`,
    );
  }

  const versions = entries.filter(isVersionDir);

  if (versions.length === 0) {
    throw new Error(
      `缓存目录下没有可用版本：${base}\n` +
        `实际目录内容：${entries.join(", ") || "(空)"}\n` +
        `请运行：bun x puppeteer browsers install chrome-headless-shell`,
    );
  }

  versions.sort((a, b) => {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    for (let i = 0; i < 4; i++) {
      if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
    }
    return 0;
  });

  const rel = shellRelativePath();

  for (const ver of versions) {
    const candidate = join(base, ver, rel);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 尝试下一版本
    }
  }

  // 兜底：深度搜索
  for (const ver of versions) {
    const found = await searchExecutable(join(base, ver));
    if (found) return found;
  }

  throw new Error(
    `在 ${base} 下找到了版本目录，但未找到可执行文件。\n` +
      `版本目录：${versions.join(", ")}\n` +
      `期望路径：${rel}\n` +
      `请重新安装：bun x puppeteer browsers install chrome-headless-shell`,
  );
}

async function searchExecutable(dir: string): Promise<string | null> {
  const targetName =
    process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === targetName) return full;
    if (entry.isDirectory()) {
      const found = await searchExecutable(full);
      if (found) return found;
    }
  }
  return null;
}

/** 解析可执行文件路径：优先使用用户指定值，否则自动查找 */
export async function resolveExecutablePath(userPath?: string): Promise<string> {
  if (userPath) return userPath;

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) return envPath;

  return findChromeShell();
}
