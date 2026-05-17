import { randomUUID } from "node:crypto";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline as createChannelReplyPipeline,
} from "openclaw/plugin-sdk/channel-message";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute, sanitizeAgentId } from "openclaw/plugin-sdk/routing";
import { danger, shouldLogVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { hasInboundMedia, resolveInboundMediaFileId } from "./bot-handlers.media.js";
import {
  createTelegramGuestAccessRequestAndNotifyOwner,
  resolveTelegramGuestAccessRequestsPath,
} from "./guest-access-requests.js";

const TRUSTED_TOOL_DEFAULTS = [
  "smart_memory_save_marker",
  "smart_memory_search_markers",
  "smart_memory_save_fact",
  "smart_memory_search_facts",
  "smart_memory_commit_plan",
  "smart_memory_save_secret",
  "smart_memory_lookup_secret",
  "smart_memory_search_entity_bundles",
  "smart_memory_get_entity_context",
  "smart_memory_get_full_artifact",
  "smart_memory_search_graph_triples",
  "smart_memory_search_growth_vectors",
  "smart_memory_review_growth_vector_candidate",
  "smart_memory_search_character_traits",
  "smart_memory_list_pending_character_trait_proposals",
  "smart_memory_review_character_trait_proposal",
  "smart_memory_save_link",
  "smart_memory_search_links",
  "smart_memory_save_media",
  "smart_memory_search_media",
  "smart_memory_search_evidence",
  "smart_memory_list_pending_entity_merges",
  "smart_memory_resolve_pending_entity_merge",
] as const;

type GuestProfile = {
  name: string;
  allowFrom: string[];
  allowChats: string[];
  useMemory: boolean;
  allowTools: boolean;
  tools?: string[];
  allowProjectContext: boolean;
  allowEntityMemory: boolean;
  allowVault: string;
  reply?: string;
  authorized?: boolean;
};

type GuestConfig = {
  enabled: boolean;
  defaultProfile: string;
  profiles: Record<string, GuestProfile>;
  maxInputChars: number;
  maxOutputChars: number;
  agentProfile: string;
  debugSanitizedUpdates: boolean;
};

type GuestIdentity = {
  callerId: string;
  callerUsername: string;
  callerChatId: string;
  callerChatUsername: string;
  chatId: string;
};

type GuestMediaRef = {
  path: string;
  fileId?: string;
  contentType?: string;
  placeholder: string;
  origin: "current" | "reply";
};

type GuestRecord = Record<string, unknown>;

type GuestBot = {
  api: {
    raw: {
      answerGuestQuery: (params: { guest_query_id: string; result: string }) => Promise<unknown>;
    };
    getFile: (fileId: string) => Promise<{ file_path?: string }>;
    sendMessage: (
      chatId: number | string,
      text: string,
      params?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
    ) => Promise<{ message_id?: number } | unknown>;
  };
};

type GuestContext = {
  update?: {
    guest_message?: GuestRecord;
  };
  me?: {
    username?: string;
  };
};

const GUEST_PHOTO_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:[?#]\S*)?$/i;
const GUEST_HTTP_URL_RE = /^https?:\/\//i;

type GuestAnswerResultParams = {
  text: string;
  mediaUrls?: string[];
  mediaRefs?: GuestMediaRef[];
  maxOutputChars?: number;
};

function truncateGuestCaption(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 1024) : undefined;
}

function uniqueGuestMediaUrls(mediaUrls: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of mediaUrls ?? []) {
    const mediaUrl = typeof value === "string" ? value.trim() : "";
    if (!mediaUrl || seen.has(mediaUrl)) {
      continue;
    }
    seen.add(mediaUrl);
    result.push(mediaUrl);
  }
  return result;
}

function resolveGuestSendablePhoto(
  mediaUrls: readonly string[] | undefined,
  mediaRefs: readonly GuestMediaRef[] | undefined,
): { photoUrl?: string; photoFileId?: string } | null {
  const refsByPath = new Map((mediaRefs ?? []).map((media) => [media.path, media]));
  for (const mediaUrl of uniqueGuestMediaUrls(mediaUrls)) {
    const ref = refsByPath.get(mediaUrl);
    if (ref?.fileId && (ref.contentType?.startsWith("image/") ?? true)) {
      return { photoFileId: ref.fileId };
    }
    if (GUEST_PHOTO_URL_RE.test(mediaUrl)) {
      return { photoUrl: mediaUrl };
    }
  }
  return null;
}

export function buildGuestAnswerResult(params: GuestAnswerResultParams): Record<string, unknown> {
  const maxOutputChars = params.maxOutputChars ?? 3500;
  const messageText = truncateGuestText(
    params.text || "Не удалось подготовить ответ.",
    maxOutputChars,
  );
  const photo = resolveGuestSendablePhoto(params.mediaUrls, params.mediaRefs);
  if (photo?.photoFileId || photo?.photoUrl) {
    return {
      type: "photo",
      id: randomUUID(),
      title: "Ответ OpenClaw",
      ...(photo.photoFileId
        ? { photo_file_id: photo.photoFileId }
        : { photo_url: photo.photoUrl, thumbnail_url: photo.photoUrl }),
      ...(truncateGuestCaption(messageText) ? { caption: truncateGuestCaption(messageText) } : {}),
    };
  }
  const remoteDocumentUrl = uniqueGuestMediaUrls(params.mediaUrls).find((mediaUrl) =>
    GUEST_HTTP_URL_RE.test(mediaUrl),
  );
  if (remoteDocumentUrl) {
    return {
      type: "document",
      id: randomUUID(),
      title: "Файл OpenClaw",
      document_url: remoteDocumentUrl,
      mime_type: "application/octet-stream",
      ...(truncateGuestCaption(messageText) ? { caption: truncateGuestCaption(messageText) } : {}),
    };
  }
  return {
    type: "article",
    id: randomUUID(),
    title: "Ответ OpenClaw",
    input_message_content: {
      message_text: messageText.slice(0, 4096),
    },
  };
}

function asGuestRecord(value: unknown): GuestRecord {
  return Boolean(value) && typeof value === "object" ? (value as GuestRecord) : {};
}

function scalarToString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function parseBooleanEnv(value: unknown): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseCsvList(value: unknown): string[] {
  return scalarToString(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeGuestList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeOptionalString(entry)).filter(Boolean) as string[];
  }
  if (typeof value === "string") {
    return parseCsvList(value);
  }
  return [];
}

function mergeGuestLists(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    for (const entry of normalizeGuestList(value)) {
      if (!result.includes(entry)) {
        result.push(entry);
      }
    }
  }
  return result;
}

function resolveGuestBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (["1", "true", "yes", "on"].includes(normalized ?? "")) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized ?? "")) {
      return false;
    }
  }
  return false;
}

function resolveGuestTools(value: unknown, fallback?: string[]): string[] | undefined {
  const configured = normalizeGuestList(value);
  if (configured.includes("*")) {
    return undefined;
  }
  if (configured.length > 0) {
    return configured;
  }
  return fallback;
}

function resolveGuestProfile(name: string, rawProfile: unknown = {}, fallback: unknown = {}): GuestProfile {
  const raw = asGuestRecord(rawProfile);
  const base = asGuestRecord(fallback);
  return {
    name,
    allowFrom: normalizeGuestList(raw.allowFrom ?? base.allowFrom),
    allowChats: normalizeGuestList(raw.allowChats ?? base.allowChats),
    useMemory: resolveGuestBoolean(raw.useMemory, base.useMemory),
    allowTools: resolveGuestBoolean(raw.allowTools, base.allowTools),
    tools: resolveGuestTools(raw.tools ?? base.tools, normalizeGuestList(base.tools)),
    allowProjectContext: resolveGuestBoolean(
      raw.allowProjectContext,
      base.allowProjectContext,
    ),
    allowEntityMemory: resolveGuestBoolean(raw.allowEntityMemory, base.allowEntityMemory),
    allowVault: normalizeOptionalLowercaseString(raw.allowVault ?? base.allowVault) ?? "deny",
    reply: normalizeOptionalString(raw.reply ?? base.reply),
  };
}

export function resolveGuestModeConfig(params: {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom: Array<string | number>;
}): GuestConfig {
  const telegramCfgRecord = asGuestRecord(params.telegramCfg);
  const cfgRecord = asGuestRecord(params.cfg);
  const channelRecord = asGuestRecord(cfgRecord.channels);
  const cfgTelegramRecord = asGuestRecord(channelRecord.telegram);
  const channelGuestMode = asGuestRecord(cfgTelegramRecord.guestMode);
  const accountGuestMode = asGuestRecord(telegramCfgRecord.guestMode);
  const raw = { ...channelGuestMode, ...accountGuestMode };
  const envAllowFrom = parseCsvList(process.env.OPENCLAW_TELEGRAM_GUEST_ALLOW_FROM);
  const configuredAllowFrom = Array.isArray(raw.allowFrom)
    ? raw.allowFrom
    : envAllowFrom.length > 0
      ? envAllowFrom
      : params.allowFrom;
  const trustedFrom = mergeGuestLists(
    configuredAllowFrom,
    process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_FROM,
    channelGuestMode.trustedFrom,
    accountGuestMode.trustedFrom,
  );
  const trustedChats = mergeGuestLists(
    raw.allowChats,
    process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_CHATS,
    channelGuestMode.trustedChats,
    accountGuestMode.trustedChats,
  );
  const rawProfiles = {
    ...asGuestRecord(channelGuestMode.profiles),
    ...asGuestRecord(accountGuestMode.profiles),
  };
  const publicProfile = resolveGuestProfile("public", rawProfiles.public, {
    allowFrom: [],
    allowChats: [],
    useMemory: false,
    allowTools: false,
    tools: [],
    allowProjectContext: false,
    allowEntityMemory: false,
    allowVault: "deny",
    reply:
      raw.publicReply ??
      process.env.OPENCLAW_TELEGRAM_GUEST_PUBLIC_REPLY ??
      "Этот OpenClaw-бот отвечает в Guest Mode только доверенным пользователям.",
  });
  const trustedProfileName =
    normalizeOptionalString(raw.trustedProfile ?? process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_PROFILE) ??
    "trustedDev";
  const trustedProfile = resolveGuestProfile(
    trustedProfileName,
    rawProfiles[trustedProfileName] ?? rawProfiles.trustedDev,
    {
      allowFrom: trustedFrom,
      allowChats: trustedChats,
      useMemory: resolveGuestBoolean(
        raw.useMemory,
        process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_USE_MEMORY,
        process.env.OPENCLAW_TELEGRAM_GUEST_USE_MEMORY,
      ),
      allowTools: resolveGuestBoolean(
        raw.allowTools,
        process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_ALLOW_TOOLS,
        process.env.OPENCLAW_TELEGRAM_GUEST_ALLOW_TOOLS,
      ),
      tools:
        process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_TOOLS ??
        raw.tools ??
        [...TRUSTED_TOOL_DEFAULTS],
      allowProjectContext: resolveGuestBoolean(
        raw.allowProjectContext,
        process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_PROJECT_CONTEXT,
        true,
      ),
      allowEntityMemory: resolveGuestBoolean(
        raw.allowEntityMemory,
        process.env.OPENCLAW_TELEGRAM_GUEST_TRUSTED_ENTITY_MEMORY,
        true,
      ),
      allowVault: raw.allowVault ?? process.env.OPENCLAW_TELEGRAM_GUEST_VAULT_POLICY ?? "confirm",
    },
  );
  const profiles: Record<string, GuestProfile> = {
    public: publicProfile,
    [trustedProfile.name]: trustedProfile,
  };
  for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
    if (profileName === "public" || profileName === trustedProfile.name || profileName === "trustedDev") {
      continue;
    }
    profiles[profileName] = resolveGuestProfile(profileName, rawProfile);
  }
  return {
    enabled: raw.enabled === true || parseBooleanEnv(process.env.OPENCLAW_TELEGRAM_GUEST_MODE),
    defaultProfile:
      normalizeOptionalString(raw.defaultProfile ?? process.env.OPENCLAW_TELEGRAM_GUEST_DEFAULT_PROFILE) ??
      "public",
    profiles,
    maxInputChars: Math.max(
      1,
      Math.min(16_000, Number(raw.maxInputChars ?? process.env.OPENCLAW_TELEGRAM_GUEST_MAX_INPUT_CHARS ?? 8000) || 8000),
    ),
    maxOutputChars: Math.max(
      100,
      Math.min(
        4096,
        Number(raw.maxOutputChars ?? process.env.OPENCLAW_TELEGRAM_GUEST_MAX_OUTPUT_CHARS ?? 3500) ||
          3500,
      ),
    ),
    agentProfile:
      normalizeOptionalString(raw.agentProfile ?? process.env.OPENCLAW_TELEGRAM_GUEST_AGENT_PROFILE) ??
      "guest-public",
    debugSanitizedUpdates: raw.debugSanitizedUpdates === true || parseBooleanEnv(process.env.OPENCLAW_TELEGRAM_GUEST_DEBUG),
  };
}

function resolveGuestIdentity(message: unknown): GuestIdentity {
  const msg = asGuestRecord(message);
  const caller = asGuestRecord(msg.guest_bot_caller_user ?? msg.from ?? msg.sender_chat);
  const callerChat = asGuestRecord(msg.guest_bot_caller_chat ?? msg.chat);
  const chat = asGuestRecord(msg.chat);
  return {
    callerId: scalarToString(caller.id),
    callerUsername: normalizeOptionalString(caller.username) ?? "",
    callerChatId: scalarToString(callerChat.id),
    callerChatUsername: normalizeOptionalString(callerChat.username) ?? "",
    chatId: scalarToString(chat.id),
  };
}

function allowlistMatches(values: Array<string | number> | undefined, id: string, username: string): boolean {
  const allow = normalizeAllowFrom(values);
  return isSenderAllowed({ allow, senderId: id, senderUsername: username });
}

function isProfileAllowed(profile: GuestProfile, identity: GuestIdentity): boolean {
  if (allowlistMatches(profile.allowFrom, identity.callerId, identity.callerUsername)) {
    return true;
  }
  if (allowlistMatches(profile.allowChats, identity.callerChatId, identity.callerChatUsername)) {
    return true;
  }
  return Boolean(
    identity.chatId &&
      identity.chatId !== identity.callerChatId &&
      allowlistMatches(profile.allowChats, identity.chatId, ""),
  );
}

function resolveTrustProfile(config: GuestConfig, identity: GuestIdentity): GuestProfile {
  for (const profile of Object.values(config.profiles)) {
    if (profile.name !== "public" && isProfileAllowed(profile, identity)) {
      return { ...profile, authorized: true };
    }
  }
  const fallback = config.profiles[config.defaultProfile] ?? config.profiles.public;
  return { ...fallback, authorized: isProfileAllowed(fallback, identity) };
}

function stripGuestMention(text: string, botUsername: unknown): string {
  let next = text;
  const username = normalizeOptionalLowercaseString(botUsername);
  if (username) {
    const mentionRe = new RegExp(`(^|\\s)@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig");
    next = next.replace(mentionRe, " ");
  }
  return next.replace(/\s+/g, " ").trim();
}

function truncateGuestText(text: string, maxChars: number): string {
  const source = text.trim();
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n[Ответ сокращен]`;
}

export function buildGuestPrompt(params: {
  requestText: string;
  replyText: string;
  media: GuestMediaRef[];
  config: GuestProfile;
}): string {
  const policy = [
    "Ты отвечаешь в Telegram Guest Mode.",
    "Ты видишь только текст вызова и, возможно, сообщение, на которое пользователь ответил.",
    "Не утверждай, что видишь весь чат.",
    `Профиль доверия: ${params.config.name}.`,
    params.config.useMemory
      ? "Разрешено использовать проектную память и сохраненный контекст, если это помогает рабочему ответу."
      : "Не используй приватную память.",
    params.config.allowTools
      ? "Инструменты разрешены по доверенному рабочему профилю. Используй только явно доступные инструменты из allowlist."
      : "Не используй инструменты и не выполняй действий.",
    params.config.allowVault === "confirm"
      ? "Vault/секреты: можно сохранять секреты через smart_memory_save_secret и показывать redacted-кандидаты через smart_memory_lookup_secret; не раскрывай raw значения в Guest Mode/group chats. Для раскрытия нужен owner-verified private owner DM/private operator surface, confirmReveal: true и privateSurface: true."
      : "Vault/секреты запрещены.",
    'Memory retrieval: если пользователь просит всю заметку, полный текст, дословно, сам текст, всю информацию или что было сохранено, вызови smart_memory_get_entity_context с outputMode: "full" и includeFullText: true, либо smart_memory_get_full_artifact при известном artifactId.',
    "Do not summarize full-note requests. If the tool returns pagination, answer with Part 1/N and the next part number.",
    "Secret saves: для явной просьбы trusted owner сохранить API key/token/password используй smart_memory_save_secret; связывай linkedEntity, linkedArtifactId или linkedNoteTitle, если контекст это дает. В обычных receipts используй value=<redacted>.",
    "Secret reveal: в Guest Mode/group chats не раскрывай raw секреты и не вызывай smart_memory_reveal_secret даже при словах подтверждения; используй redacted lookup и попроси владельца обратиться в private owner DM.",
    "Дай короткий plain-text ответ, пригодный для отправки в диалог.",
  ];
  const body = [`[Guest Mode policy]\n${policy.join("\n")}`, `[User request]\n${params.requestText || "Пустой запрос."}`];
  if (params.replyText) {
    body.push(`[Optional replied message]\n${params.replyText}`);
  }
  if (params.media.length > 0) {
    body.push(
      `[Media evidence]\n${params.media
        .map((media, index) =>
          `${index + 1}. origin=${media.origin} ${media.placeholder} ${media.contentType ?? "application/octet-stream"} ${media.path}`,
        )
        .join("\n")}`,
    );
  }
  return body.join("\n\n");
}

function buildGuestRuntimeConfig(runtimeCfgInput: OpenClawConfig, config: GuestProfile): OpenClawConfig {
  const runtimeCfg = asGuestRecord(runtimeCfgInput);
  const agents = asGuestRecord(runtimeCfg.agents);
  const defaults = asGuestRecord(agents.defaults);
  const memorySearch = asGuestRecord(defaults.memorySearch);
  const tools = asGuestRecord(runtimeCfg.tools);
  const nextCfg = {
    ...runtimeCfg,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        ...(!config.useMemory
          ? {
              memorySearch: {
                ...memorySearch,
                enabled: false,
              },
            }
          : {}),
      },
      ...(Array.isArray(agents.list) && !config.useMemory
        ? {
            list: agents.list.map((agent) => {
              const agentRecord = asGuestRecord(agent);
              return Object.assign({}, agentRecord, {
                memorySearch: Object.assign({}, asGuestRecord(agentRecord.memorySearch), {
                  enabled: false,
                }),
              });
            }),
          }
        : {}),
    },
    tools: {
      ...tools,
      ...(config.allowTools && Array.isArray(config.tools)
        ? { allow: config.tools }
        : !config.allowTools
          ? { allow: [] }
          : {}),
    },
  };
  return nextCfg as OpenClawConfig;
}

function buildGuestSessionKey(
  route: { agentId: string },
  identity: GuestIdentity,
  guestQueryId: string,
  config: GuestProfile,
): string {
  if (config.name !== "public") {
    const scope = identity.callerChatId || identity.chatId || identity.callerId || "unknown";
    return `agent:${sanitizeAgentId(route.agentId)}:telegram:guest:${config.name}:${scope}`;
  }
  return `agent:${sanitizeAgentId(route.agentId)}:telegram:guest:public:${identity.callerId || "unknown"}:${guestQueryId}`;
}

async function answerGuestReply(
  bot: GuestBot,
  guestQueryId: string,
  reply: { text: string; mediaUrls?: string[]; mediaRefs?: GuestMediaRef[] },
  config: GuestConfig | GuestProfile,
): Promise<void> {
  const maxOutputChars = "maxOutputChars" in config ? config.maxOutputChars : 3500;
  await bot.api.raw.answerGuestQuery({
    guest_query_id: guestQueryId,
    result: JSON.stringify(buildGuestAnswerResult({ ...reply, maxOutputChars })),
  });
}

async function answerGuestText(
  bot: GuestBot,
  guestQueryId: string,
  text: string,
  config: GuestConfig | GuestProfile,
): Promise<void> {
  await answerGuestReply(bot, guestQueryId, { text }, config);
}

async function resolveGuestMediaFromMessage(params: {
  message: unknown;
  origin: GuestMediaRef["origin"];
  bot: GuestBot;
  cfg: OpenClawConfig;
  accountId: string;
  opts: { token: string };
  telegramTransport?: unknown;
  mediaMaxBytes: number;
  me?: unknown;
  runtime: RuntimeEnv;
}): Promise<GuestMediaRef[]> {
  const inboundMessage = params.message as Parameters<typeof hasInboundMedia>[0];
  if (!params.message || !hasInboundMedia(inboundMessage)) {
    return [];
  }
  const fileId = resolveInboundMediaFileId(inboundMessage);
  if (!fileId) {
    return [];
  }
  try {
    const media = await resolveMedia({
      ctx: {
        message: inboundMessage,
        me: params.me as Parameters<typeof resolveMedia>[0]["ctx"]["me"],
        getFile: async () => await params.bot.api.getFile(fileId),
      },
      maxBytes: params.mediaMaxBytes,
      ...resolveTelegramMediaRuntimeOptions({
        cfg: params.cfg,
        accountId: params.accountId,
        token: params.opts.token,
        transport: params.telegramTransport as Parameters<
          typeof resolveTelegramMediaRuntimeOptions
        >[0]["transport"],
      }),
    });
    if (!media) {
      return [];
    }
    return [
      {
        path: media.path,
        fileId,
        contentType: media.contentType,
        placeholder: media.placeholder,
        origin: params.origin,
      },
    ];
  } catch (err) {
    params.runtime.log?.(`telegram guest ${params.origin} media fetch failed: ${String(err)}`);
    return [];
  }
}

async function resolveGuestMediaBundle(params: {
  guestMessage: GuestRecord;
  bot: GuestBot;
  cfg: OpenClawConfig;
  accountId: string;
  opts: { token: string };
  telegramTransport?: unknown;
  mediaMaxBytes: number;
  me?: unknown;
  runtime: RuntimeEnv;
}): Promise<GuestMediaRef[]> {
  const currentMedia = await resolveGuestMediaFromMessage({
    ...params,
    message: params.guestMessage,
    origin: "current",
  });
  const replyMedia = await resolveGuestMediaFromMessage({
    ...params,
    message: params.guestMessage?.reply_to_message,
    origin: "reply",
  });
  return [...currentMedia, ...replyMedia];
}

export async function dispatchTelegramGuestMessage(params: {
  ctx: unknown;
  bot: unknown;
  cfg: OpenClawConfig;
  account: { accountId: string };
  telegramCfg: TelegramAccountConfig;
  allowFrom: Array<string | number>;
  runtime: RuntimeEnv;
  telegramDeps: TelegramBotDeps;
  opts: { token: string };
  telegramTransport?: unknown;
  mediaMaxBytes: number;
}): Promise<boolean> {
  const ctx = params.ctx as GuestContext;
  const bot = params.bot as GuestBot;
  const guestMessage = ctx.update?.guest_message;
  if (!guestMessage) {
    return false;
  }

  const config = resolveGuestModeConfig(params);
  const guestQueryId = normalizeOptionalString(guestMessage.guest_query_id);
  if (!guestQueryId) {
    params.runtime.error?.(danger("telegram guest_message without guest_query_id"));
    return true;
  }
  if (!config.enabled) {
    await answerGuestText(bot, guestQueryId, "Guest Mode не включен для этого OpenClaw-бота.", config);
    return true;
  }

  const identity = resolveGuestIdentity(guestMessage);
  const trustProfile = resolveTrustProfile(config, identity);
  if (!trustProfile.authorized) {
    const accessRequest = await createTelegramGuestAccessRequestAndNotifyOwner({
      cfg: params.cfg,
      storePath: resolveTelegramGuestAccessRequestsPath(
        params.telegramDeps.resolveStorePath(params.cfg.session?.store),
      ),
      botApi: bot.api,
      input: {
        callerId: identity.callerId,
        callerUsername: identity.callerUsername,
        callerChatId: identity.callerChatId,
        callerChatUsername: identity.callerChatUsername,
        chatId: identity.chatId,
        accountId: params.account.accountId,
        messageText: scalarToString(guestMessage.text ?? guestMessage.caption),
      },
    }).catch((err) => {
      params.runtime.log?.(`telegram guest access request failed: ${String(err)}`);
      return undefined;
    });
    await answerGuestText(
      bot,
      guestQueryId,
      accessRequest?.ownerNotified
        ? "Доступ запрещён. Запрос отправлен владельцу."
        : trustProfile.reply ??
            "Этот OpenClaw-бот отвечает в Guest Mode только доверенным пользователям.",
      config,
    );
    return true;
  }

  const replyMessage = asGuestRecord(guestMessage.reply_to_message);
  const rawText = scalarToString(guestMessage.text ?? guestMessage.caption).slice(0, config.maxInputChars);
  const replyText = scalarToString(replyMessage.text ?? replyMessage.caption).slice(0, config.maxInputChars);
  const requestText = stripGuestMention(rawText, ctx.me?.username);
  if (!requestText.trim()) {
    await answerGuestText(bot, guestQueryId, "Напиши запрос после имени бота, например: @my_bot переведи это на английский.", config);
    return true;
  }
  const guestMedia = await resolveGuestMediaBundle({
    guestMessage,
    bot,
    cfg: params.cfg,
    accountId: params.account.accountId,
    opts: params.opts,
    telegramTransport: params.telegramTransport,
    mediaMaxBytes: params.mediaMaxBytes,
    me: ctx.me,
    runtime: params.runtime,
  });
  if (config.debugSanitizedUpdates || shouldLogVerbose()) {
    params.runtime.log?.(
      `telegram guest_message: query=present profile=${trustProfile.name} caller=${identity.callerId || "unknown"} callerChat=${identity.callerChatId || "unknown"} chat=${identity.chatId || "unknown"} textLen=${rawText.length} replyLen=${replyText.length} media=${guestMedia.length}`,
    );
  }
  const runtimeCfg = params.telegramDeps.getRuntimeConfig();
  const guestRuntimeCfg = buildGuestRuntimeConfig(runtimeCfg, trustProfile);
  const route = resolveAgentRoute({
    cfg: guestRuntimeCfg,
    channel: "telegram",
    accountId: params.account.accountId,
  });
  const now = Date.now();
  const sessionKey = buildGuestSessionKey(route, identity, guestQueryId, trustProfile);
  const storePath = params.telegramDeps.resolveStorePath(guestRuntimeCfg.session?.store, { agentId: route.agentId });
  const prompt = buildGuestPrompt({ requestText, replyText, media: guestMedia, config: trustProfile });
  const ctxPayload = {
    Body: formatInboundEnvelope({
      channel: "Telegram Guest",
      from: identity.callerId ? `telegram:${identity.callerId}` : "telegram:guest:unknown",
      timestamp: now,
      body: prompt,
      chatType: "guest",
      sender: {
        id: identity.callerId || undefined,
        username: identity.callerUsername || undefined,
      },
      envelope: resolveEnvelopeFormatOptions(guestRuntimeCfg),
    }),
    BodyForAgent: prompt,
    RawBody: requestText,
    CommandBody: requestText,
    From: identity.callerId ? `telegram:guest:${identity.callerId}` : "telegram:guest:unknown",
    To: `telegram:guest:${ctx.me?.username ?? "bot"}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: "guest",
    ConversationLabel: "Telegram Guest Mode",
    SenderId: identity.callerId || undefined,
    SenderUsername: identity.callerUsername || undefined,
    CallerChatId: identity.callerChatId || undefined,
    CallerChatUsername: identity.callerChatUsername || undefined,
    Provider: "telegram",
    Surface: "telegram_guest",
    BotUsername: ctx.me?.username ?? undefined,
    MessageSid: guestQueryId,
    ReplyToBody: replyText || undefined,
    MediaPath: guestMedia[0]?.path,
    MediaType: guestMedia[0]?.contentType,
    MediaUrl: guestMedia[0]?.path,
    MediaPaths: guestMedia.length > 0 ? guestMedia.map((media) => media.path) : undefined,
    MediaUrls: guestMedia.length > 0 ? guestMedia.map((media) => media.path) : undefined,
    MediaTypes:
      guestMedia.length > 0
        ? guestMedia.map((media) => media.contentType ?? "application/octet-stream")
        : undefined,
    GuestModeMediaOrigins: guestMedia.length > 0 ? guestMedia.map((media) => media.origin) : undefined,
    Timestamp: now,
    CommandAuthorized: false,
    OriginatingChannel: "telegram_guest",
    OriginatingTo: `telegram:guest:${guestQueryId}`,
    GuestMode: true,
    GuestModeTrustProfile: trustProfile.name,
    GuestModeAuthorized: true,
    GuestModeUseMemory: trustProfile.useMemory,
    GuestModeAllowTools: trustProfile.allowTools,
    GuestModeAllowVault: trustProfile.allowVault,
  };

  let finalText = "";
  const finalMediaUrls: string[] = [];
  let errorText = "";
  try {
    const { onModelSelected, ...replyPipeline } = (
      params.telegramDeps.createChannelMessageReplyPipeline ??
      createChannelReplyPipeline
    )({
      cfg: guestRuntimeCfg,
      agentId: route.agentId,
      channel: "telegram",
      accountId: route.accountId,
      typing: {
        start: async () => {},
        onStartError: () => {},
      },
    });
    const turnResult = await runInboundReplyTurn({
      channel: "telegram",
      accountId: route.accountId,
      raw: {
        guest: true,
        guestQueryId,
        callerId: identity.callerId,
        callerChatId: identity.callerChatId || undefined,
        trustProfile: trustProfile.name,
      },
      adapter: {
        ingest: () => ({
          id: guestQueryId,
          timestamp: now,
          rawText: requestText,
          textForAgent: prompt,
          textForCommands: requestText,
          raw: guestMessage,
        }),
        resolveTurn: () => ({
          channel: "telegram",
          accountId: route.accountId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: async () => {},
          record: {},
          runDispatch: () =>
            params.telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg: guestRuntimeCfg,
              dispatcherOptions: {
                ...replyPipeline,
                beforeDeliver: async (payload: ReplyPayload) => payload,
                deliver: async (payload: unknown, info: { kind: string }) => {
                  if (info.kind !== "final") {
                    return;
                  }
                  const reply = resolveSendableOutboundReplyParts(
                    payload as Parameters<typeof resolveSendableOutboundReplyParts>[0],
                  );
                  if (reply.text) {
                    finalText += `${finalText ? "\n" : ""}${reply.text}`;
                  }
                  for (const mediaUrl of reply.mediaUrls ?? []) {
                    if (mediaUrl && !finalMediaUrls.includes(mediaUrl)) {
                      finalMediaUrls.push(mediaUrl);
                    }
                  }
                },
                onSkip: () => {},
                onError: (err: unknown) => {
                  errorText = String(err);
                },
              },
              replyOptions: {
                disableTools: !trustProfile.allowTools,
                suppressToolErrorWarnings: !trustProfile.allowTools,
                disableBlockStreaming: true,
                suppressDefaultToolProgressMessages: true,
                onModelSelected,
              },
            }),
        }),
      },
    });
    if (!turnResult.dispatched && !finalText) {
      finalText = "Не удалось подготовить ответ.";
    }
  } catch (err) {
    errorText = String(err);
  }
  if (errorText && !finalText) {
    params.runtime.error?.(danger(`telegram guest dispatch failed: ${errorText}`));
    finalText = "Не удалось подготовить ответ в Guest Mode. Попробуй еще раз коротким запросом.";
  }
  await answerGuestReply(
    bot,
    guestQueryId,
    { text: finalText || "Готово.", mediaUrls: finalMediaUrls, mediaRefs: guestMedia },
    config,
  );
  return true;
}
