import { describe, expect, it } from "vitest";
import {
  buildExecApprovalCallbackData,
  parseExecApprovalCallbackData,
  isExecApprovalCallbackData,
  type ExecApprovalRequest,
  TelegramExecApprovalHandler,
} from "./exec-approvals.js";
import type { TelegramExecApprovalConfig } from "../../config/types.telegram.js";

describe("buildExecApprovalCallbackData", () => {
  it("encodes approval id and action (allow-once)", () => {
    const data = buildExecApprovalCallbackData("abc12345-6789-def0", "allow-once");
    expect(data).toBe("ea:abc12345:o");
  });

  it("encodes approval id and action (allow-always)", () => {
    const data = buildExecApprovalCallbackData("xyz98765-4321-abcd", "allow-always");
    expect(data).toBe("ea:xyz98765:a");
  });

  it("encodes approval id and action (deny)", () => {
    const data = buildExecApprovalCallbackData("test1234-5678-9abc", "deny");
    expect(data).toBe("ea:test1234:d");
  });

  it("truncates approval id to 8 characters", () => {
    const data = buildExecApprovalCallbackData("verylongapprovalidstring", "allow-once");
    expect(data).toBe("ea:verylong:o");
    expect(data.length).toBeLessThanOrEqual(64); // Telegram callback_data limit
  });

  it("produces compact callback data under 64 bytes", () => {
    const data = buildExecApprovalCallbackData(
      "12345678-90ab-cdef-ghij-klmnopqrstuv",
      "allow-always",
    );
    expect(data.length).toBeLessThanOrEqual(64);
  });
});

describe("parseExecApprovalCallbackData", () => {
  it("parses valid allow-once data", () => {
    const result = parseExecApprovalCallbackData("ea:abc12345:o");
    expect(result).toEqual({ shortId: "abc12345", action: "allow-once" });
  });

  it("parses valid allow-always data", () => {
    const result = parseExecApprovalCallbackData("ea:xyz98765:a");
    expect(result).toEqual({ shortId: "xyz98765", action: "allow-always" });
  });

  it("parses valid deny data", () => {
    const result = parseExecApprovalCallbackData("ea:test1234:d");
    expect(result).toEqual({ shortId: "test1234", action: "deny" });
  });

  it("rejects invalid prefix", () => {
    expect(parseExecApprovalCallbackData("wrong:abc12345:o")).toBeNull();
    expect(parseExecApprovalCallbackData("execapproval:abc12345:o")).toBeNull();
  });

  it("rejects invalid action character", () => {
    expect(parseExecApprovalCallbackData("ea:abc12345:x")).toBeNull();
    expect(parseExecApprovalCallbackData("ea:abc12345:allow")).toBeNull();
  });

  it("rejects malformed data", () => {
    expect(parseExecApprovalCallbackData("ea:abc12345")).toBeNull();
    expect(parseExecApprovalCallbackData("ea::o")).toBeNull();
    expect(parseExecApprovalCallbackData("ea:")).toBeNull();
    expect(parseExecApprovalCallbackData("")).toBeNull();
  });

  it("rejects null/undefined input", () => {
    expect(parseExecApprovalCallbackData(null as any)).toBeNull();
    expect(parseExecApprovalCallbackData(undefined as any)).toBeNull();
  });
});

describe("isExecApprovalCallbackData", () => {
  it("returns true for valid exec approval data", () => {
    expect(isExecApprovalCallbackData("ea:abc12345:o")).toBe(true);
    expect(isExecApprovalCallbackData("ea:xyz98765:a")).toBe(true);
    expect(isExecApprovalCallbackData("ea:test1234:d")).toBe(true);
  });

  it("returns false for other callback data", () => {
    expect(isExecApprovalCallbackData("pagination:next")).toBe(false);
    expect(isExecApprovalCallbackData("button:click")).toBe(false);
    expect(isExecApprovalCallbackData("")).toBe(false);
  });

  it("handles null/undefined gracefully", () => {
    expect(isExecApprovalCallbackData(null as any)).toBe(false);
    expect(isExecApprovalCallbackData(undefined as any)).toBe(false);
  });
});

describe("roundtrip encoding", () => {
  it("encodes and decodes correctly for allow-once", () => {
    const approvalId = "test-approval-id-12345678";
    const action = "allow-once" as const;
    const encoded = buildExecApprovalCallbackData(approvalId, action);
    const decoded = parseExecApprovalCallbackData(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.shortId).toBe(approvalId.slice(0, 8));
    expect(decoded?.action).toBe(action);
  });

  it("encodes and decodes correctly for allow-always", () => {
    const approvalId = "another-approval-uuid-here";
    const action = "allow-always" as const;
    const encoded = buildExecApprovalCallbackData(approvalId, action);
    const decoded = parseExecApprovalCallbackData(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.shortId).toBe(approvalId.slice(0, 8));
    expect(decoded?.action).toBe(action);
  });

  it("encodes and decodes correctly for deny", () => {
    const approvalId = "deny-this-command-now";
    const action = "deny" as const;
    const encoded = buildExecApprovalCallbackData(approvalId, action);
    const decoded = parseExecApprovalCallbackData(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.shortId).toBe(approvalId.slice(0, 8));
    expect(decoded?.action).toBe(action);
  });
});

describe("TelegramExecApprovalHandler.shouldHandle", () => {
  function createHandler(config: TelegramExecApprovalConfig) {
    return new TelegramExecApprovalHandler({
      token: "test-token",
      accountId: "default",
      config,
      cfg: {},
      api: null as any, // Not needed for shouldHandle tests
    });
  }

  function createRequest(
    overrides: Partial<ExecApprovalRequest["request"]> = {},
  ): ExecApprovalRequest {
    return {
      id: "test-id",
      request: {
        command: "echo hello",
        cwd: "/home/user",
        host: "gateway",
        agentId: "test-agent",
        sessionKey: "agent:test-agent:telegram:123",
        ...overrides,
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
    };
  }

  it("returns false when disabled", () => {
    const handler = createHandler({ enabled: false, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns false when no approvers", () => {
    const handler = createHandler({ enabled: true, approvers: [] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns false when approvers is undefined", () => {
    const handler = createHandler({ enabled: true });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns true with minimal config", () => {
    const handler = createHandler({ enabled: true, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(true);
  });

  it("filters by agent ID", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["allowed-agent"],
    });
    expect(handler.shouldHandle(createRequest({ agentId: "allowed-agent" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ agentId: "other-agent" }))).toBe(false);
    expect(handler.shouldHandle(createRequest({ agentId: null }))).toBe(false);
  });

  it("filters by session key substring", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["telegram"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:telegram:123" }))).toBe(
      true,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:discord:123" }))).toBe(
      false,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: null }))).toBe(false);
  });

  it("filters by session key regex", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["^agent:.*:telegram:"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:telegram:123" }))).toBe(
      true,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "other:test:telegram:123" }))).toBe(
      false,
    );
  });

  it("combines agent and session filters", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["my-agent"],
      sessionFilter: ["telegram"],
    });
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:telegram:123",
        }),
      ),
    ).toBe(true);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "other-agent",
          sessionKey: "agent:other:telegram:123",
        }),
      ),
    ).toBe(false);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:discord:123",
        }),
      ),
    ).toBe(false);
  });

  it("handles invalid regex in session filter gracefully", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["[invalid(regex"],
    });
    // Should fall back to substring match
    expect(handler.shouldHandle(createRequest({ sessionKey: "[invalid(regex" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ sessionKey: "something-else" }))).toBe(false);
  });
});
