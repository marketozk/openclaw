import { describe, expect, it } from "vitest";
import {
  applyTelegramGuestAccessDecisionToConfig,
  buildTelegramGuestAccessCallbackData,
  parseTelegramGuestAccessCallbackData,
} from "./guest-access-requests.js";

describe("Telegram Guest Mode access requests", () => {
  it("keeps callback data within Telegram's 64-byte limit", () => {
    for (const action of ["allow_user", "allow_chat", "allow_user_chat", "deny"] as const) {
      const data = buildTelegramGuestAccessCallbackData({
        requestId: "tgguest_12345678901234567890",
        action,
      });

      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(parseTelegramGuestAccessCallbackData(data)).toEqual({
        requestId: "tgguest_12345678901234567890",
        action,
      });
    }
  });

  it("approves a caller without writing group allowlist config", () => {
    const cfg = { channels: { telegram: { groups: {} } } } as never;

    const result = applyTelegramGuestAccessDecisionToConfig({
      cfg,
      request: {
        id: "tgguest_abc",
        dedupeKey: "caller:chat",
        status: "pending",
        firstSeenAt: "2026-05-16T20:00:00.000Z",
        lastSeenAt: "2026-05-16T20:00:00.000Z",
        count: 1,
        callerId: "1281388780",
        callerUsername: "zhora",
        callerChatId: "777",
        callerChatUsername: "zhora-chat",
        chatId: "888",
        messageText: "@CyberClawGPT_bot hi",
      },
      action: "allow_user",
    });

    expect(result).toEqual({ changed: true });
    expect(cfg).toEqual({
      channels: {
        telegram: {
          groups: {},
          guestMode: {
            trustedFrom: ["1281388780"],
          },
        },
      },
    });
  });

  it("can approve both caller and guest chat", () => {
    const cfg = {
      channels: {
        telegram: {
          guestMode: {
            trustedFrom: ["6673887542"],
            trustedChats: ["123"],
          },
        },
      },
    } as never;

    applyTelegramGuestAccessDecisionToConfig({
      cfg,
      request: {
        id: "tgguest_abc",
        dedupeKey: "caller:chat",
        status: "pending",
        firstSeenAt: "2026-05-16T20:00:00.000Z",
        lastSeenAt: "2026-05-16T20:00:00.000Z",
        count: 1,
        callerId: "1281388780",
        callerUsername: "zhora",
        callerChatId: "777",
        callerChatUsername: "zhora-chat",
        chatId: "888",
      },
      action: "allow_user_chat",
    });

    expect(cfg).toEqual({
      channels: {
        telegram: {
          guestMode: {
            trustedFrom: ["6673887542", "1281388780"],
            trustedChats: ["123", "777", "888"],
          },
        },
      },
    });
  });
});
