import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { mutateConfigFile as mutateConfigFileFn } from "openclaw/plugin-sdk/config-mutation";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveTelegramGroupAccessOwnerChatIds } from "./group-access-requests.js";

export const TELEGRAM_GUEST_ACCESS_CALLBACK_PREFIX = "OC_TG_GA";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const REQUEST_ID_HASH_BYTES = 20;
const OWNER_MESSAGE_TEXT_MAX_CHARS = 1200;

export type TelegramGuestAccessAction = "allow_user" | "allow_chat" | "allow_user_chat" | "deny";
export type TelegramGuestAccessRequestStatus = "pending" | "approved" | "denied" | "expired";

export type TelegramGuestAccessRequestInput = {
  callerId: string;
  callerUsername?: string;
  callerChatId?: string;
  callerChatUsername?: string;
  chatId?: string;
  messageText?: string;
  nowIso?: string;
};

export type TelegramGuestAccessRequest = TelegramGuestAccessRequestInput & {
  id: string;
  dedupeKey: string;
  status: TelegramGuestAccessRequestStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  ownerLastNotifiedAt?: string;
  ownerNotificationChatId?: string;
  ownerNotificationMessageId?: number;
  resolvedBy?: string;
  resolvedAt?: string;
};

type TelegramGuestAccessRequestStore = {
  version: 1;
  requests: TelegramGuestAccessRequest[];
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

export function resolveTelegramGuestAccessRequestsPath(sessionStorePath?: string): string {
  const stateDir = sessionStorePath ? path.dirname(sessionStorePath) : process.cwd();
  return path.join(stateDir, "telegram", "guest-access-requests.json");
}

function normalizeId(value: string | number | undefined): string {
  return String(value ?? "").trim();
}

function buildDedupeKey(input: TelegramGuestAccessRequestInput): string {
  return [normalizeId(input.callerId), normalizeId(input.callerChatId), normalizeId(input.chatId)].join(
    ":",
  );
}

function buildRequestId(input: TelegramGuestAccessRequestInput): string {
  const digest = createHash("sha256")
    .update(buildDedupeKey(input))
    .digest("base64url")
    .slice(0, REQUEST_ID_HASH_BYTES);
  return `tgguest_${digest}`;
}

async function loadStore(storePath: string): Promise<TelegramGuestAccessRequestStore> {
  const { value } = await readJsonFileWithFallback<TelegramGuestAccessRequestStore>(storePath, {
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
  store: TelegramGuestAccessRequestStore,
): Promise<void> {
  await writeJsonFileAtomically(storePath, store);
}

async function updateStoredRequest(
  storePath: string,
  requestId: string,
  update: (request: TelegramGuestAccessRequest) => void,
): Promise<TelegramGuestAccessRequest | undefined> {
  const store = await loadStore(storePath);
  const request = store.requests.find((entry) => entry.id === requestId);
  if (!request) {
    return undefined;
  }
  update(request);
  await saveStore(storePath, store);
  return request;
}

export async function upsertTelegramGuestAccessRequest(params: {
  storePath: string;
  input: TelegramGuestAccessRequestInput;
}): Promise<{ request: TelegramGuestAccessRequest; created: boolean }> {
  const store = await loadStore(params.storePath);
  const nowIso = params.input.nowIso ?? new Date().toISOString();
  const dedupeKey = buildDedupeKey(params.input);
  const existing = store.requests.find(
    (request) => request.dedupeKey === dedupeKey && request.status === "pending",
  );
  if (existing) {
    existing.lastSeenAt = nowIso;
    existing.count += 1;
    existing.callerUsername = params.input.callerUsername ?? existing.callerUsername;
    existing.callerChatUsername = params.input.callerChatUsername ?? existing.callerChatUsername;
    existing.messageText = params.input.messageText;
    await saveStore(params.storePath, store);
    return { request: existing, created: false };
  }

  const request: TelegramGuestAccessRequest = {
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

export function buildTelegramGuestAccessCallbackData(params: {
  requestId: string;
  action: TelegramGuestAccessAction;
}): string {
  const data = `${TELEGRAM_GUEST_ACCESS_CALLBACK_PREFIX}|${params.requestId}|${params.action}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error("Telegram guest access callback data exceeds Telegram's 64-byte limit");
  }
  return data;
}

export function parseTelegramGuestAccessCallbackData(
  data: string,
): { requestId: string; action: TelegramGuestAccessAction } | null {
  const [prefix, requestId, action] = data.split("|");
  if (prefix !== TELEGRAM_GUEST_ACCESS_CALLBACK_PREFIX || !requestId) {
    return null;
  }
  if (
    action !== "allow_user" &&
    action !== "allow_chat" &&
    action !== "allow_user_chat" &&
    action !== "deny"
  ) {
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

function appendUnique(values: unknown, nextValues: Array<string | undefined>): string[] {
  const merged = Array.isArray(values) ? values.map((entry) => String(entry)) : [];
  for (const next of nextValues) {
    const normalized = normalizeId(next);
    if (normalized && !merged.includes(normalized)) {
      merged.push(normalized);
    }
  }
  return merged;
}

export function buildTelegramGuestAccessOwnerMessage(params: {
  request: TelegramGuestAccessRequest;
}): string {
  const { request } = params;
  const username = request.callerUsername ? ` @${request.callerUsername}` : "";
  return [
    "Запрос доступа к Telegram Guest Mode",
    "",
    `Пользователь: ${username || "unknown"}`,
    `User ID: ${escapeLine(request.callerId)}`,
    `Caller chat ID: ${escapeLine(request.callerChatId)}`,
    `Caller chat username: ${escapeLine(request.callerChatUsername)}`,
    `Guest chat ID: ${escapeLine(request.chatId)}`,
    "",
    "Сообщение:",
    truncateOwnerMessageText(request.messageText),
    "",
    `Request ID: ${request.id}`,
    `Повторов: ${request.count}`,
  ].join("\n");
}

export function buildTelegramGuestAccessOwnerKeyboard(requestId: string): OwnerKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: "Разрешить человека",
          callback_data: buildTelegramGuestAccessCallbackData({ requestId, action: "allow_user" }),
        },
      ],
      [
        {
          text: "Разрешить этот чат",
          callback_data: buildTelegramGuestAccessCallbackData({ requestId, action: "allow_chat" }),
        },
      ],
      [
        {
          text: "Разрешить человека + чат",
          callback_data: buildTelegramGuestAccessCallbackData({
            requestId,
            action: "allow_user_chat",
          }),
        },
      ],
      [
        {
          text: "Отклонить",
          callback_data: buildTelegramGuestAccessCallbackData({ requestId, action: "deny" }),
        },
      ],
    ],
  };
}

export function applyTelegramGuestAccessDecisionToConfig(params: {
  cfg: OpenClawConfig;
  request: TelegramGuestAccessRequest;
  action: TelegramGuestAccessAction;
}): { changed: boolean } {
  if (params.action === "deny") {
    return { changed: false };
  }
  const cfg = params.cfg as OpenClawConfig & {
    channels?: {
      telegram?: {
        guestMode?: {
          trustedFrom?: string[];
          trustedChats?: string[];
        };
      };
    };
  };
  cfg.channels ??= {};
  cfg.channels.telegram ??= {};
  const guestMode = (cfg.channels.telegram.guestMode ??= {});

  if (params.action === "allow_user" || params.action === "allow_user_chat") {
    guestMode.trustedFrom = appendUnique(guestMode.trustedFrom, [params.request.callerId]);
  }
  if (params.action === "allow_chat" || params.action === "allow_user_chat") {
    guestMode.trustedChats = appendUnique(guestMode.trustedChats, [
      params.request.callerChatId,
      params.request.chatId,
    ]);
  }
  return { changed: true };
}

export async function createTelegramGuestAccessRequestAndNotifyOwner(params: {
  cfg: OpenClawConfig;
  storePath: string;
  botApi: TelegramAccessBotApi;
  input: TelegramGuestAccessRequestInput;
  notifyCooldownMs?: number;
}): Promise<{ request: TelegramGuestAccessRequest; ownerNotified: boolean }> {
  const upsert = await upsertTelegramGuestAccessRequest({
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

  const text = buildTelegramGuestAccessOwnerMessage({ request: upsert.request });
  const keyboard = buildTelegramGuestAccessOwnerKeyboard(upsert.request.id);
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

export async function resolveTelegramGuestAccessRequestDecision(params: {
  storePath: string;
  requestId: string;
  action: TelegramGuestAccessAction;
  ownerId: string;
  mutateConfigFile: typeof mutateConfigFileFn;
}): Promise<{ text: string; changedConfig: boolean }> {
  const store = await loadStore(params.storePath);
  const request = store.requests.find((entry) => entry.id === params.requestId);
  if (!request) {
    return { text: "Заявка Guest Mode не найдена или уже очищена.", changedConfig: false };
  }
  if (request.status !== "pending") {
    return { text: `Заявка Guest Mode уже обработана: ${request.status}.`, changedConfig: false };
  }

  if (params.action === "deny") {
    request.status = "denied";
    request.resolvedBy = params.ownerId;
    request.resolvedAt = new Date().toISOString();
    await saveStore(params.storePath, store);
    return {
      text: `Отклонено.\nUser ID: ${request.callerId}\nCaller chat ID: ${request.callerChatId ?? "none"}`,
      changedConfig: false,
    };
  }

  await params.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      applyTelegramGuestAccessDecisionToConfig({ cfg: draft, request, action: params.action });
    },
  });
  request.status = "approved";
  request.resolvedBy = params.ownerId;
  request.resolvedAt = new Date().toISOString();
  await saveStore(params.storePath, store);
  return {
    text: [
      "Guest Mode разрешён.",
      `Action: ${params.action}`,
      `User ID: ${request.callerId}`,
      `Caller chat ID: ${request.callerChatId ?? "none"}`,
      `Guest chat ID: ${request.chatId ?? "none"}`,
      "Config updated with afterWrite=auto.",
    ].join("\n"),
    changedConfig: true,
  };
}
