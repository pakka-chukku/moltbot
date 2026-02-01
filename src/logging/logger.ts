import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import type { LoggingAlertConfig, OpenClawConfig } from "../config/types.js";
import type { ConsoleStyle } from "./console.js";
import { readLoggingConfig } from "./config.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { loggingState } from "./state.js";

// Pin to /tmp so mac Debug UI and docs match; os.tmpdir() can be a per-user
// randomized path on macOS which made the "Open log" button a no-op.
export const DEFAULT_LOG_DIR = "/tmp/openclaw";
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log"); // legacy single-file path

const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Size-based rotation defaults
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_FILES_PER_DAY = 5;

// Error alerting defaults
const DEFAULT_ALERT_THRESHOLD = 100;
const DEFAULT_ALERT_WINDOW_SECONDS = 60;
const DEFAULT_ALERT_COOLDOWN_SECONDS = 300;

const requireConfig = createRequire(import.meta.url);

export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
  maxFileSize?: string;
  maxFilesPerDay?: number;
  alertOnErrorSpike?: LoggingAlertConfig;
};

type LogObj = { date?: Date; _meta?: { logLevelName?: string } } & Record<string, unknown>;

type ResolvedSettings = {
  level: LogLevel;
  file: string;
  maxFileSize: number;
  maxFilesPerDay: number;
  alertOnErrorSpike?: LoggingAlertConfig;
};
export type LoggerResolvedSettings = ResolvedSettings;
export type LogTransportRecord = Record<string, unknown>;
export type LogTransport = (logObj: LogTransportRecord) => void;

const externalTransports = new Set<LogTransport>();

// State for size-based rotation
let currentLogFile: string | null = null;
let currentFileSize = 0;
let currentRotationIndex = 0;

// State for error spike alerting
const errorTimestamps: number[] = [];
let lastAlertSentAt = 0;
let alertConfig: LoggingAlertConfig | undefined;

/** Parse size string like "100MB", "50MB", "1GB" to bytes */
function parseFileSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  if (!match) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  };
  return Math.floor(value * (multipliers[unit] ?? 1));
}

/** Get the next rotation file path (e.g., moltbot-2026-01-30.1.log) */
function getRotatedPath(basePath: string, index: number): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  return path.join(dir, `${base}.${index}${ext}`);
}

/** Count existing rotation files for today */
function countRotationFiles(basePath: string): number {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  let count = 0;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(`${base}.`) && entry.endsWith(ext)) {
        count++;
      }
    }
  } catch {
    // ignore
  }
  return count;
}

/** Get current file size, returns 0 if file doesn't exist */
function getFileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Track error and check if alert should be sent */
function trackErrorAndCheckAlert(): boolean {
  if (!alertConfig?.enabled) {
    return false;
  }

  const now = Date.now();
  const threshold = alertConfig.threshold ?? DEFAULT_ALERT_THRESHOLD;
  const windowMs = (alertConfig.windowSeconds ?? DEFAULT_ALERT_WINDOW_SECONDS) * 1000;
  const cooldownMs = (alertConfig.cooldownSeconds ?? DEFAULT_ALERT_COOLDOWN_SECONDS) * 1000;

  // Add current timestamp
  errorTimestamps.push(now);

  // Remove timestamps outside the window
  const cutoff = now - windowMs;
  while (errorTimestamps.length > 0 && errorTimestamps[0] < cutoff) {
    errorTimestamps.shift();
  }

  // Check if we've exceeded threshold and cooldown has passed
  if (errorTimestamps.length >= threshold && now - lastAlertSentAt > cooldownMs) {
    lastAlertSentAt = now;
    return true;
  }

  return false;
}

/** Send alert via Telegram (async, fire-and-forget) */
function sendTelegramAlert(errorCount: number, windowSeconds: number): void {
  const chatId = alertConfig?.telegramChatId;
  if (!chatId) {
    return;
  }

  // Read token from config
  let token: string | undefined;
  try {
    const loaded = requireConfig("../config/config.js") as {
      loadConfig?: () => OpenClawConfig;
    };
    const cfg = loaded.loadConfig?.();
    const telegramConfig = cfg?.channels?.telegram;

    // Try root-level botToken first, then check accounts
    token = telegramConfig?.botToken;
    if (!token && telegramConfig?.accounts) {
      for (const account of Object.values(telegramConfig.accounts)) {
        if (account.botToken) {
          token = account.botToken;
          break;
        }
      }
    }
  } catch {
    // Can't load config, skip alert
    return;
  }

  if (!token) {
    return;
  }

  const message =
    `⚠️ *OpenClaw Log Alert*\n\n` +
    `Detected ${errorCount} errors in the last ${windowSeconds} seconds.\n\n` +
    `This may indicate a problem requiring attention.\n\n` +
    `_Check logs at: /tmp/openclaw/_`;

  // Fire and forget - don't block logging
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
    }),
  }).catch(() => {
    // Ignore alert failures
  });
}

function attachExternalTransport(logger: TsLogger<LogObj>, transport: LogTransport): void {
  logger.attachTransport((logObj: LogObj) => {
    if (!externalTransports.has(transport)) {
      return;
    }
    try {
      transport(logObj as LogTransportRecord);
    } catch {
      // never block on logging failures
    }
  });
}

function resolveSettings(): ResolvedSettings {
  let cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg) {
    try {
      const loaded = requireConfig("../config/config.js") as {
        loadConfig?: () => OpenClawConfig;
      };
      cfg = loaded.loadConfig?.().logging;
    } catch {
      cfg = undefined;
    }
  }
  const level = normalizeLogLevel(cfg?.level, "info");
  const file = cfg?.file ?? defaultRollingPathForToday();
  const maxFileSize = cfg?.maxFileSize ? parseFileSize(cfg.maxFileSize) : DEFAULT_MAX_FILE_SIZE;
  const maxFilesPerDay = cfg?.maxFilesPerDay ?? DEFAULT_MAX_FILES_PER_DAY;

  // Update alert config
  alertConfig = cfg?.alertOnErrorSpike;

  return { level, file, maxFileSize, maxFilesPerDay, alertOnErrorSpike: alertConfig };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file;
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path.dirname(settings.file));
  }

  // Initialize rotation state
  currentLogFile = settings.file;
  currentFileSize = getFileSize(settings.file);
  currentRotationIndex = countRotationFiles(settings.file);

  const logger = new TsLogger<LogObj>({
    name: "openclaw",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // no ansi formatting
  });

  logger.attachTransport((logObj: LogObj) => {
    try {
      const time = logObj.date?.toISOString?.() ?? new Date().toISOString();
      const line = JSON.stringify({ ...logObj, time });
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline

      // Check if we need to rotate
      if (
        currentLogFile &&
        currentFileSize + lineBytes > settings.maxFileSize &&
        currentRotationIndex < settings.maxFilesPerDay
      ) {
        currentRotationIndex++;
        currentLogFile = getRotatedPath(settings.file, currentRotationIndex);
        currentFileSize = 0;
      }

      // If we've hit max rotations, stop logging to prevent unbounded growth
      if (
        currentRotationIndex >= settings.maxFilesPerDay &&
        currentFileSize > settings.maxFileSize
      ) {
        // Log is full for today - silently drop
        return;
      }

      if (currentLogFile) {
        fs.appendFileSync(currentLogFile, `${line}\n`, { encoding: "utf8" });
        currentFileSize += lineBytes;
      }

      // Track errors for alerting
      const logLevel = logObj._meta?.logLevelName?.toLowerCase?.();
      if (logLevel === "error" || logLevel === "fatal") {
        if (trackErrorAndCheckAlert()) {
          sendTelegramAlert(
            alertConfig?.threshold ?? DEFAULT_ALERT_THRESHOLD,
            alertConfig?.windowSeconds ?? DEFAULT_ALERT_WINDOW_SECONDS,
          );
        }
      }
    } catch {
      // never block on logging failures
    }
  });
  for (const transport of externalTransports) {
    attachExternalTransport(logger, transport);
  }

  return logger;
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : undefined;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
}

export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
  // Reset rotation state
  currentLogFile = null;
  currentFileSize = 0;
  currentRotationIndex = 0;
  // Reset alert state
  errorTimestamps.length = 0;
  lastAlertSentAt = 0;
}

export function registerLogTransport(transport: LogTransport): () => void {
  externalTransports.add(transport);
  const logger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  if (logger) {
    attachExternalTransport(logger, transport);
  }
  return () => {
    externalTransports.delete(transport);
  };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRollingPathForToday(): string {
  const today = formatLocalDate(new Date());
  return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}

// Export for testing
export { parseFileSize, getRotatedPath, trackErrorAndCheckAlert };
