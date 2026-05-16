import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { mutateConfigFile as mutateConfigFileFn } from "openclaw/plugin-sdk/config-mutation";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

export const TELEGRAM_GROUP_ACCESS_CALLBACK_PREFIX = "OC_TG_AR";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const REQUEST_ID_HASH_BYTES = 20;
const OWNER_MESSAGE_TEXT_MAX_CHARS = 1200;

export type TelegramGroupAccessAction = "allow_chat" | "allow_chat_user" | "deny";

export type TelegramGroupAccessRequestStatus = "pending" | "approved" | "denied" | "expired";

export type TelegramGroupAccessRequestInput = {
  chatId: string;
  chatTitle?: string;
  chatType?: string;
  messageThreadId?: number;
  senderId: string;
  senderUsername?: string;
  senderName?: string;
  messageId?: number;
  messageText?: string;
  nowIso?: string;
};

export type TelegramGroupAccessRequest = TelegramGroupAccessRequestInput & {
  id: string;
  dedupeKey: string;
  status: TelegramGroupAccessRequestStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  ownerLastNotifiedAt?: string;
  ownerNotificationChatId?: string;
  ownerNotificationMessageId?: number;
  resolvedBy?: string;
  resolvedAt?: string;
};

type TelegramGroupAccessRequestStore = {
  version: 1;
  requests: TelegramGroupAccessRequest[];
};

type OwnerKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

type TelegramAccessBotApi = {
  sendMessage: (
    chatId: number | string,
    text: string,
    params?: { reply_markup?: OwnerKeyboard },
  ) => Promise<{ message_id?: number } | unknown>;
};

export function resolveTelegramGroupAccessRequestsPath(sessionStorePath?: string): string {
  const stateDir = sessionStorePath ? path.dirname(sessionStorePath) : process.cwd();
  return path.join(stateDir, "telegram", "group-access-requests.json");
}

function normalizeId(value: string | number | undefined): string {
  return String(value ?? "").trim();
}

function buildDedupeKey(input: TelegramGroupAccessRequestInput): string {
  return [normalizeId(input.chatId), input.messageThreadId ?? "", normalizeId(input.senderId)].join(
    ":",
  );
}

function buildRequestId(input: TelegramGroupAccessRequestInput): string {
  const digest = createHash("sha256")
    .update(buildDedupeKey(input))
    .digest("base64url")
    .slice(0, REQUEST_ID_HASH_BYTES);
  return `tgreq_${digest}`;
}

async function loadStore(storePath: string): Promise<TelegramGroupAccessRequestStore> {
  const { value } = await readJsonFileWithFallback<TelegramGroupAccessRequestStore>(storePath, {
    version: 1,
    requests: [],
  });
  return {
    version: 1,
    requests: Array.isArray(value.requests) ? value.requests : [],
  };
}

async function saveStore(
  storePath: string,
  store: TelegramGroupAccessRequestStore,
): Promise<void> {
  await writeJsonFileAtomically(storePath, store);
}

async function updateStoredRequest(
  storePath: string,
  requestId: string,
  update: (request: TelegramGroupAccessRequest) => void,
): Promise<TelegramGroupAccessRequest | undefined> {
  const store = await loadStore(storePath);
  const request = store.requests.find((entry) => entry.id === requestId);
  if (!request) {
    return undefined;
  }
  update(request);
  await saveStore(storePath, store);
  return request;
}

export async function upsertTelegramGroupAccessRequest(params: {
  storePath: string;
  input: TelegramGroupAccessRequestInput;
}): Promise<{ request: TelegramGroupAccessRequest; created: boolean }> {
  const store = await loadStore(params.storePath);
  const nowIso = params.input.nowIso ?? new Date().toISOString();
  const dedupeKey = buildDedupeKey(params.input);
  const existing = store.requests.find(
    (request) => request.dedupeKey === dedupeKey && request.status === "pending",
  );
  if (existing) {
    existing.lastSeenAt = nowIso;
    existing.count += 1;
    existing.chatTitle = params.input.chatTitle ?? existing.chatTitle;
    existing.chatType = params.input.chatType ?? existing.chatType;
    existing.senderUsername = params.input.senderUsername ?? existing.senderUsername;
    existing.senderName = params.input.senderName ?? existing.senderName;
    existing.messageId = params.input.messageId;
    existing.messageText = params.input.messageText;
    await saveStore(params.storePath, store);
    return { request: existing, created: false };
  }

  const request: TelegramGroupAccessRequest = {
    ...params.input,
    id: buildRequestId(params.input),
    dedupeKey,
    status: "pending",
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    count: 1,
  };
  store.requests.push(request);
  await saveStore(params.storePath, store);
  return { request, created: true };
}

export function buildTelegramGroupAccessCallbackData(params: {
  requestId: string;
  action: TelegramGroupAccessAction;
}): string {
  const data = `${TELEGRAM_GROUP_ACCESS_CALLBACK_PREFIX}|${params.requestId}|${params.action}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Telegram group access callback data exceeds Telegram's 64-byte limit");
  }
  return data;
}

export function parseTelegramGroupAccessCallbackData(
  data: string,
): { requestId: string; action: TelegramGroupAccessAction } | null {
  const [prefix, requestId, action] = data.split("|");
  if (prefix !== TELEGRAM_GROUP_ACCESS_CALLBACK_PREFIX || !requestId) {
    return null;
  }
  if (action !== "allow_chat" && action !== "allow_chat_user" && action !== "deny") {
    return null;
  }
  return { requestId, action };
}

function escapeLine(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "unknown";
}

function truncateOwnerMessageText(value: string | undefined): string {
  const text = value?.trim() || "<empty>";
  if (text.length <= OWNER_MESSAGE_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, OWNER_MESSAGE_TEXT_MAX_CHARS)}\n...[truncated]`;
}

export function resolveTelegramGroupAccessOwnerChatIds(cfg: OpenClawConfig): string[] {
  const entries = cfg.commands?.ownerAllowFrom ?? [];
  const ids: string[] = [];
  for (const entry of entries) {
    const text = String(entry).trim();
    if (!text) {
      continue;
    }
    const telegramId = text.startsWith("telegram:") ? text.slice("telegram:".length) : text;
    if (/^-?\d+$/.test(telegramId) && !ids.includes(telegramId)) {
      ids.push(telegramId);
    }
  }
  return ids;
}

export function buildTelegramGroupAccessOwnerMessage(params: {
  request: TelegramGroupAccessRequest;
}): string {
  const { request } = params;
  const username = request.senderUsername ? ` @${request.senderUsername}` : "";
  return [
    "Запрос доступа к Telegram-чату",
    "",
    `Чат: ${escapeLine(request.chatTitle)}`,
    `Chat ID: ${request.chatId}`,
    `Chat type: ${escapeLine(request.chatType)}`,
    `Topic ID: ${request.messageThreadId ?? "none"}`,
    "",
    `Пользователь: ${escapeLine(request.senderName)}${username}`,
    `User ID: ${request.senderId}`,
    "",
    "Сообщение:",
    truncateOwnerMessageText(request.messageText),
    "",
    `Request ID: ${request.id}`,
    `Повторов: ${request.count}`,
  ].join("\n");
}

export function buildTelegramGroupAccessOwnerKeyboard(requestId: string): OwnerKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: "Разрешить чат",
          callback_data: buildTelegramGroupAccessCallbackData({ requestId, action: "allow_chat" }),
        },
      ],
      [
        {
          text: "Разрешить чат + пользователя",
          callback_data: buildTelegramGroupAccessCallbackData({
            requestId,
            action: "allow_chat_user",
          }),
        },
      ],
      [
        {
          text: "Отклонить",
          callback_data: buildTelegramGroupAccessCallbackData({ requestId, action: "deny" }),
        },
      ],
    ],
  };
}

export function applyTelegramGroupAccessDecisionToConfig(params: {
  cfg: OpenClawConfig;
  request: TelegramGroupAccessRequest;
  action: TelegramGroupAccessAction;
}): { changed: boolean } {
  if (params.action === "deny") {
    return { changed: false };
  }
  params.cfg.channels ??= {};
  const telegram = (params.cfg.channels.telegram ??= {});
  telegram.groupPolicy = "allowlist";
  telegram.groups ??= {};
  telegram.groups[params.request.chatId] = {
    ...(telegram.groups[params.request.chatId] ?? {}),
    requireMention: true,
    ...(params.action === "allow_chat" ? { allowFrom: ["*"] } : {}),
  };

  if (params.action === "allow_chat_user") {
    const values = Array.isArray(telegram.groupAllowFrom)
      ? telegram.groupAllowFrom.map((entry) => String(entry))
      : [];
    if (!values.includes(params.request.senderId)) {
      values.push(params.request.senderId);
    }
    telegram.groupAllowFrom = values;
  }

  return { changed: true };
}

export async function createTelegramGroupAccessRequestAndNotifyOwner(params: {
  cfg: OpenClawConfig;
  storePath: string;
  botApi: TelegramAccessBotApi;
  input: TelegramGroupAccessRequestInput;
  notifyCooldownMs?: number;
}): Promise<{ request: TelegramGroupAccessRequest; ownerNotified: boolean }> {
  const upsert = await upsertTelegramGroupAccessRequest({
    storePath: params.storePath,
    input: params.input,
  });
  const owners = resolveTelegramGroupAccessOwnerChatIds(params.cfg);
  if (owners.length === 0) {
    return { request: upsert.request, ownerNotified: false };
  }

  const nowIso = params.input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const lastNotifiedMs = upsert.request.ownerLastNotifiedAt
    ? Date.parse(upsert.request.ownerLastNotifiedAt)
    : 0;
  const cooldownMs = params.notifyCooldownMs ?? 600_000;
  if (
    !upsert.created &&
    Number.isFinite(nowMs) &&
    Number.isFinite(lastNotifiedMs) &&
    nowMs - lastNotifiedMs < cooldownMs
  ) {
    return { request: upsert.request, ownerNotified: false };
  }

  const text = buildTelegramGroupAccessOwnerMessage({ request: upsert.request });
  const keyboard = buildTelegramGroupAccessOwnerKeyboard(upsert.request.id);
  let ownerNotified = false;
  let ownerNotificationChatId: string | undefined;
  let ownerNotificationMessageId: number | undefined;
  for (const owner of owners) {
    try {
      const result = await params.botApi.sendMessage(Number(owner), text, {
        reply_markup: keyboard,
      });
      ownerNotified = true;
      ownerNotificationChatId = owner;
      if (result && typeof result === "object" && "message_id" in result) {
        ownerNotificationMessageId = Number(result.message_id);
      }
    } catch {
      // Try every configured owner; one blocked/deleted DM must not prevent other owners from seeing it.
    }
  }

  if (!ownerNotified) {
    return { request: upsert.request, ownerNotified: false };
  }

  const updatedRequest =
    (await updateStoredRequest(params.storePath, upsert.request.id, (request) => {
      request.ownerLastNotifiedAt = nowIso;
      request.ownerNotificationChatId = ownerNotificationChatId;
      request.ownerNotificationMessageId = ownerNotificationMessageId;
    })) ?? upsert.request;

  return { request: updatedRequest, ownerNotified };
}

export async function resolveTelegramGroupAccessRequestDecision(params: {
  storePath: string;
  requestId: string;
  action: TelegramGroupAccessAction;
  ownerId: string;
  mutateConfigFile: typeof mutateConfigFileFn;
}): Promise<{ text: string; changedConfig: boolean }> {
  const store = await loadStore(params.storePath);
  const request = store.requests.find((entry) => entry.id === params.requestId);
  if (!request) {
    return { text: "Заявка не найдена или уже очищена.", changedConfig: false };
  }
  if (request.status !== "pending") {
    return { text: `Заявка уже обработана: ${request.status}.`, changedConfig: false };
  }

  if (params.action === "deny") {
    request.status = "denied";
    request.resolvedBy = params.ownerId;
    request.resolvedAt = new Date().toISOString();
    await saveStore(params.storePath, store);
    return {
      text: `Отклонено.\nChat ID: ${request.chatId}\nUser ID: ${request.senderId}`,
      changedConfig: false,
    };
  }

  await params.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      applyTelegramGroupAccessDecisionToConfig({ cfg: draft, request, action: params.action });
    },
  });
  request.status = "approved";
  request.resolvedBy = params.ownerId;
  request.resolvedAt = new Date().toISOString();
  await saveStore(params.storePath, store);
  return {
    text: [
      "Разрешено.",
      `Action: ${params.action}`,
      `Chat ID: ${request.chatId}`,
      `User ID: ${request.senderId}`,
      "Config updated with afterWrite=auto.",
    ].join("\n"),
    changedConfig: true,
  };
}
