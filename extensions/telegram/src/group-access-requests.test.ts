import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTelegramGroupAccessDecisionToConfig,
  buildTelegramGroupAccessCallbackData,
  buildTelegramGroupAccessOwnerKeyboard,
  buildTelegramGroupAccessOwnerMessage,
  createTelegramGroupAccessRequestAndNotifyOwner,
  parseTelegramGroupAccessCallbackData,
  resolveTelegramGroupAccessOwnerChatIds,
  resolveTelegramGroupAccessRequestDecision,
  resolveTelegramGroupAccessRequestsPath,
  upsertTelegramGroupAccessRequest,
  type TelegramGroupAccessRequest,
  type TelegramGroupAccessRequestInput,
} from "./group-access-requests.js";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

async function makeStorePath() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-tg-access-"));
  return path.join(tempRoot, "group-access-requests.json");
}

function makeInput(
  overrides: Partial<TelegramGroupAccessRequestInput> = {},
): TelegramGroupAccessRequestInput {
  return {
    chatId: "-100123456789",
    chatTitle: "Forum Group",
    chatType: "supergroup",
    messageThreadId: 99,
    senderId: "1281388780",
    senderUsername: "mystery_63",
    senderName: "Татьяна",
    messageId: 77,
    messageText: "@openclaw_bot можно?",
    nowIso: "2026-05-16T13:00:00.000Z",
    ...overrides,
  };
}

function makeRequest(overrides: Partial<TelegramGroupAccessRequest> = {}): TelegramGroupAccessRequest {
  return {
    ...makeInput(),
    id: "tgreq_abc123",
    dedupeKey: "-100123456789:99:1281388780",
    status: "pending",
    firstSeenAt: "2026-05-16T13:00:00.000Z",
    lastSeenAt: "2026-05-16T13:00:00.000Z",
    count: 1,
    ...overrides,
  };
}

describe("telegram group access requests", () => {
  it("resolves the state path under the Telegram state directory", () => {
    expect(resolveTelegramGroupAccessRequestsPath("/home/node/.openclaw/session.json")).toBe(
      "/home/node/.openclaw/telegram/group-access-requests.json",
    );
  });

  it("creates a stable pending request and dedupes repeated mentions", async () => {
    const storePath = await makeStorePath();
    const first = await upsertTelegramGroupAccessRequest({ storePath, input: makeInput() });
    const second = await upsertTelegramGroupAccessRequest({
      storePath,
      input: makeInput({ nowIso: "2026-05-16T13:01:00.000Z", messageId: 78 }),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.count).toBe(2);
    expect(second.request.firstSeenAt).toBe("2026-05-16T13:00:00.000Z");
    expect(second.request.lastSeenAt).toBe("2026-05-16T13:01:00.000Z");
    expect(second.request.dedupeKey).toBe("-100123456789:99:1281388780");
  });

  it("keeps generated callback data inside Telegram's 64-byte limit", async () => {
    const storePath = await makeStorePath();
    const { request } = await upsertTelegramGroupAccessRequest({
      storePath,
      input: makeInput({
        chatId: "-1001234567890123",
        messageThreadId: 2147483647,
        senderId: "12345678901",
      }),
    });
    const keyboard = buildTelegramGroupAccessOwnerKeyboard(request.id);
    const callbackData = keyboard.inline_keyboard.flat().map((button) => button.callback_data);

    expect(callbackData).toHaveLength(3);
    expect(callbackData.every((data) => Buffer.byteLength(data, "utf8") <= 64)).toBe(true);
  });

  it("parses compact callback data", () => {
    const callbackData = buildTelegramGroupAccessCallbackData({
      requestId: "tgreq_abc123",
      action: "allow_chat_user",
    });

    expect(callbackData).toBe("OC_TG_AR|tgreq_abc123|allow_chat_user");
    expect(parseTelegramGroupAccessCallbackData(callbackData)).toEqual({
      requestId: "tgreq_abc123",
      action: "allow_chat_user",
    });
    expect(parseTelegramGroupAccessCallbackData("not-this-feature")).toBeNull();
  });

  it("uses commands.ownerAllowFrom telegram ids as owner destinations", () => {
    expect(
      resolveTelegramGroupAccessOwnerChatIds({
        commands: {
          ownerAllowFrom: ["telegram:6673887542", "email:owner@example.com", "1281388780"],
        },
      } as never),
    ).toEqual(["6673887542", "1281388780"]);
  });

  it("renders owner notification with chat and sender evidence", () => {
    const text = buildTelegramGroupAccessOwnerMessage({ request: makeRequest() });

    expect(text).toContain("Запрос доступа к Telegram-чату");
    expect(text).toContain("Chat ID: -100123456789");
    expect(text).toContain("Topic ID: 99");
    expect(text).toContain("Пользователь: Татьяна @mystery_63");
    expect(text).toContain("User ID: 1281388780");
    expect(text).toContain("@openclaw_bot можно?");
  });

  it("bounds long owner notification evidence", () => {
    const text = buildTelegramGroupAccessOwnerMessage({
      request: makeRequest({ messageText: `@openclaw_bot ${"x".repeat(5000)}` }),
    });

    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("...[truncated]");
  });

  it("builds owner action buttons", () => {
    expect(buildTelegramGroupAccessOwnerKeyboard("tgreq_abc123")).toEqual({
      inline_keyboard: [
        [{ text: "Разрешить чат", callback_data: "OC_TG_AR|tgreq_abc123|allow_chat" }],
        [
          {
            text: "Разрешить чат + пользователя",
            callback_data: "OC_TG_AR|tgreq_abc123|allow_chat_user",
          },
        ],
        [{ text: "Отклонить", callback_data: "OC_TG_AR|tgreq_abc123|deny" }],
      ],
    });
  });

  it("allow_chat adds the specific group with requireMention true", () => {
    const cfg = { channels: { telegram: { groupPolicy: "allowlist", groups: {} } } } as never;
    const result = applyTelegramGroupAccessDecisionToConfig({
      cfg,
      request: makeRequest(),
      action: "allow_chat",
    });

    expect(result.changed).toBe(true);
    expect((cfg as any).channels.telegram.groups["-100123456789"]).toEqual({
      requireMention: true,
      allowFrom: ["*"],
    });
    expect((cfg as any).channels.telegram.groupAllowFrom).toBeUndefined();
  });

  it("allow_chat_user also adds sender to groupAllowFrom", () => {
    const cfg = {
      channels: {
        telegram: { groupPolicy: "allowlist", groupAllowFrom: ["6673887542"], groups: {} },
      },
    } as never;
    const result = applyTelegramGroupAccessDecisionToConfig({
      cfg,
      request: makeRequest(),
      action: "allow_chat_user",
    });

    expect(result.changed).toBe(true);
    expect((cfg as any).channels.telegram.groups["-100123456789"]).toEqual({
      requireMention: true,
    });
    expect((cfg as any).channels.telegram.groupAllowFrom).toEqual(["6673887542", "1281388780"]);
  });

  it("deny does not mutate config", () => {
    const cfg = { channels: { telegram: { groupPolicy: "allowlist", groups: {} } } } as never;
    const result = applyTelegramGroupAccessDecisionToConfig({
      cfg,
      request: makeRequest(),
      action: "deny",
    });

    expect(result.changed).toBe(false);
    expect((cfg as any).channels.telegram.groups).toEqual({});
  });

  it("does not notify owner again inside the cooldown window", async () => {
    const storePath = await makeStorePath();
    const sent: Array<{ chatId: string | number; text: string }> = [];
    const cfg = { commands: { ownerAllowFrom: ["telegram:6673887542"] } } as never;

    const first = await createTelegramGroupAccessRequestAndNotifyOwner({
      cfg,
      storePath,
      botApi: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
          return { message_id: 1 };
        },
      },
      input: makeInput({ nowIso: "2026-05-16T13:00:00.000Z" }),
      notifyCooldownMs: 600_000,
    });
    const second = await createTelegramGroupAccessRequestAndNotifyOwner({
      cfg,
      storePath,
      botApi: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
          return { message_id: 2 };
        },
      },
      input: makeInput({ nowIso: "2026-05-16T13:01:00.000Z" }),
      notifyCooldownMs: 600_000,
    });

    expect(first.ownerNotified).toBe(true);
    expect(second.ownerNotified).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("continues notifying later owners when one owner delivery fails", async () => {
    const storePath = await makeStorePath();
    const sent: Array<string | number> = [];
    const cfg = {
      commands: { ownerAllowFrom: ["telegram:6673887542", "telegram:1281388780"] },
    } as never;

    const result = await createTelegramGroupAccessRequestAndNotifyOwner({
      cfg,
      storePath,
      botApi: {
        sendMessage: async (chatId) => {
          if (chatId === 6673887542) {
            throw new Error("blocked");
          }
          sent.push(chatId);
          return { message_id: 2 };
        },
      },
      input: makeInput(),
    });

    expect(result.ownerNotified).toBe(true);
    expect(sent).toEqual([1281388780]);
  });

  it("resolves approval callbacks through config mutation and request state", async () => {
    const storePath = await makeStorePath();
    const upsert = await upsertTelegramGroupAccessRequest({ storePath, input: makeInput() });
    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      mutate({ channels: { telegram: { groupPolicy: "allowlist", groups: {} } } });
      return {} as never;
    });

    const result = await resolveTelegramGroupAccessRequestDecision({
      storePath,
      requestId: upsert.request.id,
      action: "allow_chat",
      ownerId: "6673887542",
      mutateConfigFile: mutateConfigFile as never,
    });

    expect(result.changedConfig).toBe(true);
    expect(result.text).toContain("Разрешено.");
    expect(mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ afterWrite: { mode: "auto" } }),
    );
  });
});
