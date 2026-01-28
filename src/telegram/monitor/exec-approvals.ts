import type { Api as TelegramApi } from "grammy";
import type { MoltbotConfig } from "../../config/config.js";
import { GatewayClient } from "../../gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { EventFrame } from "../../gateway/protocol/index.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { logDebug, logError } from "../../logger.js";
import type { TelegramExecApprovalConfig } from "../../config/types.telegram.js";
import type { RuntimeEnv } from "../../runtime.js";

const EXEC_APPROVAL_PREFIX = "ea";

export type ExecApprovalRequest = {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type PendingApproval = {
  telegramMessageId: number;
  telegramChatId: string | number;
  timeoutId: NodeJS.Timeout;
};

/**
 * Build compact callback data for Telegram inline buttons.
 * Telegram limits callback_data to 64 bytes, so we use a short format:
 * "ea:<8-char-id>:<action-char>"
 * where action is o=allow-once, a=allow-always, d=deny
 */
export function buildExecApprovalCallbackData(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  const shortId = approvalId.slice(0, 8);
  const actionChar = action === "allow-once" ? "o" : action === "allow-always" ? "a" : "d";
  return `${EXEC_APPROVAL_PREFIX}:${shortId}:${actionChar}`;
}

/**
 * Parse Telegram callback data back to approval ID and action.
 */
export function parseExecApprovalCallbackData(
  data: string,
): { shortId: string; action: ExecApprovalDecision } | null {
  if (!data || !data.startsWith(`${EXEC_APPROVAL_PREFIX}:`)) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const shortId = parts[1];
  const actionChar = parts[2];
  const action: ExecApprovalDecision | null =
    actionChar === "o"
      ? "allow-once"
      : actionChar === "a"
        ? "allow-always"
        : actionChar === "d"
          ? "deny"
          : null;
  if (!action || !shortId) return null;
  return { shortId, action };
}

/**
 * Check if callback data is an exec approval callback.
 */
export function isExecApprovalCallbackData(data: string): boolean {
  return data?.startsWith(`${EXEC_APPROVAL_PREFIX}:`) ?? false;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatExecApprovalMessage(request: ExecApprovalRequest): string {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - Date.now()) / 1000));

  let message = `<b>Exec Approval Required</b>\n\nA command needs your approval.\n\n`;
  message += `<b>Command:</b>\n<code>${escapeHtml(commandPreview)}</code>\n`;

  if (request.request.cwd) {
    message += `\n<b>Working Directory:</b> ${escapeHtml(request.request.cwd)}`;
  }

  if (request.request.host) {
    message += `\n<b>Host:</b> ${escapeHtml(request.request.host)}`;
  }

  if (request.request.agentId) {
    message += `\n<b>Agent:</b> ${escapeHtml(request.request.agentId)}`;
  }

  message += `\n\n<i>Expires in ${expiresIn}s | ID: ${request.id.slice(0, 8)}</i>`;

  return message;
}

function formatResolvedMessage(
  request: ExecApprovalRequest,
  decision: ExecApprovalDecision,
  resolvedBy?: string | null,
): string {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 300 ? `${commandText.slice(0, 300)}...` : commandText;

  const decisionLabel =
    decision === "allow-once"
      ? "Allowed (once)"
      : decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const emoji = decision === "deny" ? "\u274c" : decision === "allow-always" ? "\u2705" : "\u2705";

  let message = `<b>${emoji} Exec Approval: ${decisionLabel}</b>\n\n`;
  if (resolvedBy) {
    message += `Resolved by ${escapeHtml(resolvedBy)}\n\n`;
  }
  message += `<b>Command:</b>\n<code>${escapeHtml(commandPreview)}</code>\n`;
  message += `\n<i>ID: ${request.id.slice(0, 8)}</i>`;

  return message;
}

function formatExpiredMessage(request: ExecApprovalRequest): string {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 300 ? `${commandText.slice(0, 300)}...` : commandText;

  let message = `<b>\u23f0 Exec Approval: Expired</b>\n\n`;
  message += `This approval request has expired.\n\n`;
  message += `<b>Command:</b>\n<code>${escapeHtml(commandPreview)}</code>\n`;
  message += `\n<i>ID: ${request.id.slice(0, 8)}</i>`;

  return message;
}

function buildInlineKeyboard(approvalId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: "\u2705 Allow once",
          callback_data: buildExecApprovalCallbackData(approvalId, "allow-once"),
        },
        {
          text: "\u2714\ufe0f Always allow",
          callback_data: buildExecApprovalCallbackData(approvalId, "allow-always"),
        },
        {
          text: "\u274c Deny",
          callback_data: buildExecApprovalCallbackData(approvalId, "deny"),
        },
      ],
    ],
  };
}

export type TelegramExecApprovalHandlerOpts = {
  token: string;
  accountId: string;
  config: TelegramExecApprovalConfig;
  gatewayUrl?: string;
  cfg: MoltbotConfig;
  runtime?: RuntimeEnv;
  api: TelegramApi;
};

export class TelegramExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private requestCache = new Map<string, ExecApprovalRequest>();
  private shortIdMap = new Map<string, string>(); // shortId -> fullId
  private opts: TelegramExecApprovalHandlerOpts;
  private started = false;

  constructor(opts: TelegramExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) return false;
    if (!config.approvers || config.approvers.length === 0) return false;

    // Check agent filter
    if (config.agentFilter?.length) {
      if (!request.request.agentId) return false;
      if (!config.agentFilter.includes(request.request.agentId)) return false;
    }

    // Check session filter (substring match or regex)
    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) return false;
      const matches = config.sessionFilter.some((p) => {
        try {
          return session.includes(p) || new RegExp(p).test(session);
        } catch {
          return session.includes(p);
        }
      });
      if (!matches) return false;
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const config = this.opts.config;
    if (!config.enabled) {
      logDebug("telegram exec approvals: disabled");
      return;
    }

    if (!config.approvers || config.approvers.length === 0) {
      logDebug("telegram exec approvals: no approvers configured");
      return;
    }

    logDebug("telegram exec approvals: starting handler");

    // Get gateway auth token from config
    const gatewayAuthToken =
      typeof this.opts.cfg.gateway?.auth === "object"
        ? this.opts.cfg.gateway.auth.token
        : undefined;

    this.gatewayClient = new GatewayClient({
      url: this.opts.gatewayUrl ?? "ws://127.0.0.1:18789",
      token: gatewayAuthToken,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Telegram Exec Approvals",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onHelloOk: () => {
        logDebug("telegram exec approvals: connected to gateway");
      },
      onConnectError: (err) => {
        logError(`telegram exec approvals: connect error: ${err.message}`);
      },
      onClose: (code, reason) => {
        logDebug(`telegram exec approvals: gateway closed: ${code} ${reason}`);
      },
    });

    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Clear all pending timeouts
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();
    this.shortIdMap.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("telegram exec approvals: stopped");
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      const request = evt.payload as ExecApprovalRequest;
      void this.handleApprovalRequested(request);
    } else if (evt.event === "exec.approval.resolved") {
      const resolved = evt.payload as ExecApprovalResolved;
      void this.handleApprovalResolved(resolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) return;

    logDebug(`telegram exec approvals: received request ${request.id}`);

    // Store the request and short ID mapping
    this.requestCache.set(request.id, request);
    const shortId = request.id.slice(0, 8);
    this.shortIdMap.set(shortId, request.id);

    const api = this.opts.api;
    const messageText = formatExecApprovalMessage(request);
    const replyMarkup = buildInlineKeyboard(request.id);

    const approvers = this.opts.config.approvers ?? [];

    for (const approver of approvers) {
      const chatId = String(approver);
      try {
        // Send message with inline keyboard
        const message = await api.sendMessage(chatId, messageText, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });

        if (!message?.message_id) {
          logError(`telegram exec approvals: failed to send message to user ${chatId}`);
          continue;
        }

        // Set up timeout
        const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
        const timeoutId = setTimeout(() => {
          void this.handleApprovalTimeout(request.id);
        }, timeoutMs);

        this.pending.set(request.id, {
          telegramMessageId: message.message_id,
          telegramChatId: chatId,
          timeoutId,
        });

        logDebug(`telegram exec approvals: sent approval ${request.id} to user ${chatId}`);
      } catch (err) {
        logError(`telegram exec approvals: failed to notify user ${chatId}: ${String(err)}`);
      }
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);
    const shortId = resolved.id.slice(0, 8);
    this.shortIdMap.delete(shortId);

    if (!request) return;

    logDebug(`telegram exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    await this.updateMessage(
      pending.telegramChatId,
      pending.telegramMessageId,
      formatResolvedMessage(request, resolved.decision, resolved.resolvedBy),
    );
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    this.pending.delete(approvalId);

    const request = this.requestCache.get(approvalId);
    this.requestCache.delete(approvalId);
    const shortId = approvalId.slice(0, 8);
    this.shortIdMap.delete(shortId);

    if (!request) return;

    logDebug(`telegram exec approvals: timeout for ${approvalId}`);

    await this.updateMessage(
      pending.telegramChatId,
      pending.telegramMessageId,
      formatExpiredMessage(request),
    );
  }

  private async updateMessage(
    chatId: string | number,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.opts.api.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }, // Remove buttons
      });
    } catch (err) {
      logError(`telegram exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      logError("telegram exec approvals: gateway client not connected");
      return false;
    }

    logDebug(`telegram exec approvals: resolving ${approvalId} with ${decision}`);

    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      logDebug(`telegram exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`telegram exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Handle callback query from Telegram inline button.
   * Called from bot-handlers.ts when a callback with exec approval prefix is received.
   */
  async handleCallbackQuery(
    shortId: string,
    action: ExecApprovalDecision,
    userId?: string,
  ): Promise<boolean> {
    const fullId = this.shortIdMap.get(shortId);
    if (!fullId) {
      logDebug(`telegram exec approvals: unknown shortId ${shortId}`);
      return false;
    }

    // Verify user is an approver
    const approvers = this.opts.config.approvers ?? [];
    if (userId && !approvers.some((a) => String(a) === userId)) {
      logDebug(`telegram exec approvals: user ${userId} is not an approver`);
      return false;
    }

    return this.resolveApproval(fullId, action);
  }

  /**
   * Get the full approval ID from a short ID.
   */
  getFullApprovalId(shortId: string): string | undefined {
    return this.shortIdMap.get(shortId);
  }
}
