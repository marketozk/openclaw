import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGuestAnswerResult,
  dispatchTelegramGuestMessage,
  resolveGuestModeConfig,
} from "./bot-guest-mode.js";

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

describe("Telegram Guest Mode outbound media", () => {
  it("answers trusted guest media as a photo result for public image URLs", () => {
    const result = buildGuestAnswerResult({
      text: "Вот меню.",
      mediaUrls: ["https://example.com/menu.jpg"],
    });

    expect(result).toMatchObject({
      type: "photo",
      photo_url: "https://example.com/menu.jpg",
      thumbnail_url: "https://example.com/menu.jpg",
      caption: "Вот меню.",
    });
  });

  it("allows signed image URLs without an extension but does not emit document fallback for PDFs", () => {
    const signedImage = buildGuestAnswerResult({
      text: "Вот картинка.",
      mediaUrls: ["https://cdn.example.com/signed/image?id=123"],
    });
    const pdf = buildGuestAnswerResult({
      text: "Файл найден.",
      mediaUrls: ["https://cdn.example.com/report.pdf?sig=1"],
    });

    expect(signedImage).toMatchObject({ type: "photo" });
    expect(pdf).toMatchObject({ type: "article" });
  });

  it("answers current guest image media through cached Telegram file id", () => {
    const result = buildGuestAnswerResult({
      text: "Прикрепляю фото.",
      mediaUrls: ["/home/node/.openclaw/media/inbound/current.jpg"],
      mediaRefs: [
        {
          path: "/home/node/.openclaw/media/inbound/current.jpg",
          fileId: "AgACAgIAAxkBAAIC-photo",
          contentType: "image/jpeg",
          placeholder: "<media:current>",
          origin: "current",
        },
      ],
    });

    expect(result).toMatchObject({
      type: "photo",
      photo_file_id: "AgACAgIAAxkBAAIC-photo",
      caption: "Прикрепляю фото.",
    });
  });

  it("answers saved local memory images through indexed Telegram file id", () => {
    const mediaPath = "/home/node/.openclaw/workspace/memory/media/telegram-media-abc123.jpg";
    const result = buildGuestAnswerResult({
      text: "Вот сохраненное фото.",
      mediaUrls: [mediaPath],
      telegramFileIdsByMediaUrl: {
        [mediaPath]: "AgACAgIAAxkBAAIC-saved-photo",
      },
    });

    expect(result).toMatchObject({
      type: "photo",
      photo_file_id: "AgACAgIAAxkBAAIC-saved-photo",
      caption: "Вот сохраненное фото.",
    });
  });
});
