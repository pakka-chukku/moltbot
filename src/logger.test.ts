import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./runtime.js";
import { setVerbose } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import {
  DEFAULT_LOG_DIR,
  resetLogger,
  setLoggerOverride,
  parseFileSize,
  getRotatedPath,
} from "./logging.js";

describe("logger helpers", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setVerbose(false);
  });

  it("formats messages through runtime log/error", () => {
    const log = vi.fn();
    const error = vi.fn();
    const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

    logInfo("info", runtime);
    logWarn("warn", runtime);
    logSuccess("ok", runtime);
    logError("bad", runtime);

    expect(log).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("only logs debug when verbose is enabled", () => {
    const logVerbose = vi.spyOn(console, "log");
    setVerbose(false);
    logDebug("quiet");
    expect(logVerbose).not.toHaveBeenCalled();

    setVerbose(true);
    logVerbose.mockClear();
    logDebug("loud");
    expect(logVerbose).toHaveBeenCalled();
    logVerbose.mockRestore();
  });

  it("writes to configured log file at configured level", () => {
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "info", file: logPath });
    fs.writeFileSync(logPath, "");
    logInfo("hello");
    logDebug("debug-only"); // may be filtered depending on level mapping
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    cleanup(logPath);
  });

  it("filters messages below configured level", () => {
    const logPath = pathForTest();
    cleanup(logPath);
    setLoggerOverride({ level: "warn", file: logPath });
    logInfo("info-only");
    logWarn("warn-only");
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("warn-only");
    cleanup(logPath);
  });

  it("uses daily rolling default log file and prunes old ones", () => {
    resetLogger();
    setLoggerOverride({}); // force defaults regardless of user config
    const today = localDateString(new Date());
    const todayPath = path.join(DEFAULT_LOG_DIR, `openclaw-${today}.log`);

    // create an old file to be pruned
    const oldPath = path.join(DEFAULT_LOG_DIR, "openclaw-2000-01-01.log");
    fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
    fs.writeFileSync(oldPath, "old");
    fs.utimesSync(oldPath, new Date(0), new Date(0));
    cleanup(todayPath);

    logInfo("roll-me");

    expect(fs.existsSync(todayPath)).toBe(true);
    expect(fs.readFileSync(todayPath, "utf-8")).toContain("roll-me");
    expect(fs.existsSync(oldPath)).toBe(false);

    cleanup(todayPath);
  });
});

function pathForTest() {
  const file = path.join(os.tmpdir(), `openclaw-log-${crypto.randomUUID()}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function cleanup(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("parseFileSize", () => {
  it("parses MB values", () => {
    expect(parseFileSize("100MB")).toBe(100 * 1024 * 1024);
    expect(parseFileSize("50MB")).toBe(50 * 1024 * 1024);
  });

  it("parses GB values", () => {
    expect(parseFileSize("1GB")).toBe(1024 * 1024 * 1024);
    expect(parseFileSize("2GB")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("parses KB values", () => {
    expect(parseFileSize("512KB")).toBe(512 * 1024);
  });

  it("parses B values", () => {
    expect(parseFileSize("1024B")).toBe(1024);
  });

  it("handles decimal values", () => {
    expect(parseFileSize("1.5GB")).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
  });

  it("is case insensitive", () => {
    expect(parseFileSize("100mb")).toBe(100 * 1024 * 1024);
    expect(parseFileSize("100Mb")).toBe(100 * 1024 * 1024);
  });

  it("returns default for invalid input", () => {
    expect(parseFileSize("invalid")).toBe(100 * 1024 * 1024);
    expect(parseFileSize("100")).toBe(100 * 1024 * 1024);
    expect(parseFileSize("")).toBe(100 * 1024 * 1024);
  });
});

describe("getRotatedPath", () => {
  it("generates rotated paths with index", () => {
    expect(getRotatedPath("/tmp/moltbot/moltbot-2026-01-30.log", 1)).toBe(
      "/tmp/moltbot/moltbot-2026-01-30.1.log",
    );
    expect(getRotatedPath("/tmp/moltbot/moltbot-2026-01-30.log", 5)).toBe(
      "/tmp/moltbot/moltbot-2026-01-30.5.log",
    );
  });
});

describe("size-based rotation", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("rotates when file exceeds max size", () => {
    const logDir = path.join(os.tmpdir(), `moltbot-rotation-test-${crypto.randomUUID()}`);
    const logPath = path.join(logDir, "test.log");
    fs.mkdirSync(logDir, { recursive: true });

    // Set a very small max size to trigger rotation
    setLoggerOverride({ level: "info", file: logPath, maxFileSize: "100B", maxFilesPerDay: 3 });

    // Write enough to exceed limit
    for (let i = 0; i < 10; i++) {
      logInfo(`message-${i}-${"x".repeat(50)}`);
    }

    // Should have created rotated files
    const files = fs.readdirSync(logDir);
    expect(files.length).toBeGreaterThan(1);

    // Cleanup
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
