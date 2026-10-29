type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.DRAMA_LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(level: Level, scope: string, msg: string): void {
  if (ORDER[level] < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (m: string) => emit("debug", scope, m),
    info: (m: string) => emit("info", scope, m),
    warn: (m: string) => emit("warn", scope, m),
    error: (m: string) => emit("error", scope, m),
  };
}
