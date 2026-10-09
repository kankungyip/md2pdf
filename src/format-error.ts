/**
 * 健壮地格式化任意类型的错误，避免出现 "[object Object]" 或 "Object"。
 */
export function formatError(err: unknown): string {
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);

  // AggregateError: 展开内部错误
  if (err instanceof AggregateError) {
    const parts = [`AggregateError: ${err.message || "(no message)"}`];
    if (err.errors?.length) {
      parts.push(err.errors.map((e, i) => `  [${i}] ${formatError(e)}`).join("\n"));
    }
    return parts.join("\n");
  }

  if (err instanceof Error) {
    const parts: string[] = [];

    const msg =
      typeof err.message === "string" && err.message.trim() ? err.message : err.name || "Error";
    parts.push(msg);

    if (err.stack) {
      const stackLines = err.stack.split("\n").slice(0, 5);
      parts.push(stackLines.join("\n"));
    }

    const ownKeys = Object.getOwnPropertyNames(err).filter(
      (k) => !["message", "stack", "name"].includes(k),
    );
    if (ownKeys.length) {
      const extra: Record<string, unknown> = {};
      for (const k of ownKeys) extra[k] = (err as any)[k];
      try {
        parts.push(JSON.stringify(extra, null, 2));
      } catch {
        parts.push(String(extra));
      }
    }

    return parts.join("\n");
  }

  if (typeof err === "object") {
    try {
      return JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
    } catch {
      try {
        return JSON.stringify(err, null, 2);
      } catch {
        return String(err);
      }
    }
  }

  return String(err);
}
