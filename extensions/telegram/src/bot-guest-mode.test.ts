import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchTelegramGuestMessage, resolveGuestModeConfig } from "./bot-guest-mode.js";

describe("Telegram Guest Mode config", () => {
  it("keeps channel allowFrom trusted after a guest approval adds trustedFrom", () => {
    const config = resolveGuestModeConfig({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["6673887542"],
            guestMode: {
              enabled: true,
              trustedFrom: ["1281388780"],
            },
          },
        },
      } as never,
      telegramCfg: {
        allowFrom: ["6673887542"],
        guestMode: {
          enabled: true,
          trustedFrom: ["1281388780"],
        },
      } as never,
      allowFrom: ["6673887542"],
    });

    expect(config.profiles.trustedDev?.allowFrom).toEqual(["6673887542", "1281388780"]);
  });

  it("answers forbidden guest messages and notifies the configured owner", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-telegram-guest-"));
    const answerGuestQuery = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => ({ message_id: 42 }));
    const handled = await dispatchTelegramGuestMessage({
      ctx: {
        me: { username: "CyberClawGPT_bot" },
        update: {
          guest_message: {
            guest_query_id: "guest-query-1",
            text: "@CyberClawGPT_bot Почему людей называю нарциссами?",
            guest_bot_caller_user: { id: 1281388780, username: "zhora" },
            guest_bot_caller_chat: { id: 777, username: "zhora_chat" },
            chat: { id: 888 },
          },
        },
      } as never,
      bot: {
        api: {
          raw: { answerGuestQuery },
          sendMessage,
        },
      } as never,
      cfg: {
        commands: {
          ownerAllowFrom: ["telegram:6673887542"],
        },
        channels: {
          telegram: {
            guestMode: {
              enabled: true,
              trustedFrom: ["6673887542"],
              trustedChats: ["999"],
              profiles: {
                public: {
                  allowFrom: ["999"],
                  allowChats: ["999"],
                },
              },
            },
          },
        },
        session: {
          store: path.join(stateDir, "session.json"),
        },
      } as never,
      account: { accountId: "telegram" } as never,
      telegramCfg: {
        guestMode: {
          enabled: true,
          trustedFrom: ["6673887542"],
          trustedChats: ["999"],
          profiles: {
            public: {
              allowFrom: ["999"],
              allowChats: ["999"],
            },
          },
        },
      } as never,
      allowFrom: ["6673887542"],
      runtime: {} as never,
      telegramDeps: {
        resolveStorePath: (store: string) => store,
      } as never,
      opts: { token: "redacted" },
      mediaMaxBytes: 1_000_000,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      6673887542,
      expect.stringContaining("Запрос доступа к Telegram Guest Mode"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(answerGuestQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        guest_query_id: "guest-query-1",
        result: expect.stringContaining("Доступ запрещ"),
      }),
    );
  });
});
