# Telegram Group Access Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an owner-approved Telegram group access request flow for OpenClaw so denied group mentions create auditable approval requests instead of widening group access by wildcard.

**Architecture:** Keep Telegram transport ownership inside the Telegram extension. Add a focused `group-access-requests` module that owns request state, dedupe, owner notifications, callback parsing, and config mutations through the existing `openclaw/plugin-sdk/config-mutation` API. Keep the main handler as orchestration only: denied mention -> request service -> forbidden reply text; owner callback -> request service -> config mutation and message edit.

**Tech Stack:** TypeScript, OpenClaw Telegram extension, Grammy bot API, `openclaw/plugin-sdk/json-store`, `openclaw/plugin-sdk/config-mutation`, existing Vitest Telegram harness.

---

## Current Code Map

- `extensions/telegram/src/bot-handlers.runtime.ts`
  - Existing forbidden group reply is at `sendForbiddenGroupAccessReply(...)` near lines `1016-1039`.
  - Existing denied group decision point is `shouldSkipGroupMessage(...)` near lines `1053-1165`.
  - Actual inbound message call site passes `notifyForbidden` on bot mention near lines `2622-2637`.
  - Existing callback handler is `bot.on("callback_query", ...)` near lines `1788-1875`.
  - Existing config mutation pattern already imports `mutateConfigFile` and uses it for group migration near lines `2491-2496`.
- `extensions/telegram/src/group-access.ts`
  - `evaluateTelegramGroupPolicyAccess(...)` returns block reasons such as `group-chat-not-allowed`, `group-policy-allowlist-unauthorized`, and `group-policy-allowlist-empty`.
- `src/config/group-policy.ts`
  - `resolveChannelGroupPolicy(...)` treats `groups["*"]` as allow-all. Current runtime config deliberately has `channels.telegram.groups = {}` to avoid broad group access.
- `extensions/telegram/src/bot.create-telegram-bot.test.ts`
  - Existing forbidden tests live around the group access tests, including `sends a forbidden notice...` and disabled forum topic coverage.
- `extensions/telegram/src/bot.create-telegram-bot.test-harness.ts`
  - `sendMessageSpy`, `editMessageTextSpy`, `editMessageReplyMarkupSpy`, and `answerCallbackQuerySpy` already exist.
  - `makeForumGroupMessageCtx(...)` exists for forum topic fixtures.
- Runtime config on Schrodinger as of 2026-05-16:
  - `channels.telegram.groupPolicy = "allowlist"`
  - `channels.telegram.allowFrom = ["6673887542", "1281388780"]`
  - `channels.telegram.groupAllowFrom = ["6673887542", "1281388780"]`
  - `channels.telegram.groups = {}`
  - `commands.ownerAllowFrom = ["telegram:6673887542"]`

## File Structure

- Create: `extensions/telegram/src/group-access-requests.ts`
  - Own request types, callback protocol, state load/save, dedupe, owner resolution, owner notification text, owner callbacks, and config mutation.
- Create: `extensions/telegram/src/group-access-requests.test.ts`
  - Unit tests for request state, dedupe, callback parsing, owner extraction, and config mutation draft logic.
- Modify: `extensions/telegram/src/bot-handlers.runtime.ts`
  - Import and call the new module from the denied group mention path.
  - Delegate `OC_TG_AR|...` callback handling before existing approval/plugin callback branches.
- Modify: `extensions/telegram/src/bot.create-telegram-bot.test.ts`
  - Integration tests against the real Telegram harness spies.
- Modify only if needed: `extensions/telegram/src/bot.create-telegram-bot.test-harness.ts`
  - Add a helper for callback contexts only if existing callback fixtures are not enough.
- Modify after implementation: `docs/superpowers/plans/2026-05-16-telegram-group-access-requests.md`
  - Check off completed steps.
- Modify after deployment: `C:\Users\regis\.codex\skills\openclaw-clawcode-schrodinger\references\installation-ledger.md`
  - Record architecture decision, tests, build/recreate, active policy, and rollback tags.

---

### Task 1: Request Module Skeleton And State Store

**Files:**
- Create: `extensions/telegram/src/group-access-requests.ts`
- Create: `extensions/telegram/src/group-access-requests.test.ts`

- [ ] **Step 1: Write failing tests for state path, ids, dedupe, and callback parsing**

Add this test file:

```ts
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramGroupAccessCallbackData,
  parseTelegramGroupAccessCallbackData,
  resolveTelegramGroupAccessRequestsPath,
  upsertTelegramGroupAccessRequest,
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

function makeInput(overrides: Partial<TelegramGroupAccessRequestInput> = {}): TelegramGroupAccessRequestInput {
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
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts
```

Expected: FAIL because `group-access-requests.ts` does not exist.

- [ ] **Step 3: Implement the state and callback core**

Create `extensions/telegram/src/group-access-requests.ts`:

```ts
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

export const TELEGRAM_GROUP_ACCESS_CALLBACK_PREFIX = "OC_TG_AR";

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

export function resolveTelegramGroupAccessRequestsPath(sessionStorePath?: string): string {
  const baseDir = sessionStorePath ? path.dirname(sessionStorePath) : process.cwd();
  return path.join(path.dirname(baseDir), "telegram", "group-access-requests.json");
}

function normalizeId(value: string | number | undefined): string {
  return String(value ?? "").trim();
}

function buildDedupeKey(input: TelegramGroupAccessRequestInput): string {
  return [normalizeId(input.chatId), input.messageThreadId ?? "", normalizeId(input.senderId)].join(":");
}

function buildRequestId(input: TelegramGroupAccessRequestInput): string {
  const source = buildDedupeKey(input).replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `tgreq_${source}`.slice(0, 48);
}

async function loadStore(storePath: string): Promise<TelegramGroupAccessRequestStore> {
  const parsed = await readJsonFileWithFallback<TelegramGroupAccessRequestStore>(storePath, {
    version: 1,
    requests: [],
  });
  return {
    version: 1,
    requests: Array.isArray(parsed.requests) ? parsed.requests : [],
  };
}

async function saveStore(storePath: string, store: TelegramGroupAccessRequestStore): Promise<void> {
  await writeJsonFileAtomically(storePath, store);
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
  return `${TELEGRAM_GROUP_ACCESS_CALLBACK_PREFIX}|${params.requestId}|${params.action}`;
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
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/group-access-requests.test.ts
git commit -m "Add Telegram group access request store"
```

---

### Task 2: Owner Resolution And Notification Rendering

**Files:**
- Modify: `extensions/telegram/src/group-access-requests.ts`
- Modify: `extensions/telegram/src/group-access-requests.test.ts`

- [ ] **Step 1: Add failing tests for owner extraction and notification payload**

Append tests:

```ts
import {
  buildTelegramGroupAccessOwnerMessage,
  buildTelegramGroupAccessOwnerKeyboard,
  resolveTelegramGroupAccessOwnerChatIds,
} from "./group-access-requests.js";

it("uses commands.ownerAllowFrom telegram ids as owner destinations", () => {
  expect(
    resolveTelegramGroupAccessOwnerChatIds({
      commands: { ownerAllowFrom: ["telegram:6673887542", "email:owner@example.com", "1281388780"] },
    } as never),
  ).toEqual(["6673887542", "1281388780"]);
});

it("renders owner notification with chat and sender evidence", () => {
  const text = buildTelegramGroupAccessOwnerMessage({
    request: {
      ...makeInput(),
      id: "tgreq_abc123",
      dedupeKey: "-100123456789:99:1281388780",
      status: "pending",
      firstSeenAt: "2026-05-16T13:00:00.000Z",
      lastSeenAt: "2026-05-16T13:00:00.000Z",
      count: 1,
    },
  });

  expect(text).toContain("Запрос доступа к Telegram-чату");
  expect(text).toContain("Chat ID: -100123456789");
  expect(text).toContain("Topic ID: 99");
  expect(text).toContain("Пользователь: Татьяна @mystery_63");
  expect(text).toContain("User ID: 1281388780");
  expect(text).toContain("@openclaw_bot можно?");
});

it("builds owner action buttons", () => {
  expect(buildTelegramGroupAccessOwnerKeyboard("tgreq_abc123")).toEqual({
    inline_keyboard: [
      [{ text: "Разрешить чат", callback_data: "OC_TG_AR|tgreq_abc123|allow_chat" }],
      [{ text: "Разрешить чат + пользователя", callback_data: "OC_TG_AR|tgreq_abc123|allow_chat_user" }],
      [{ text: "Отклонить", callback_data: "OC_TG_AR|tgreq_abc123|deny" }],
    ],
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts -t "owner|renders|buttons"
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement owner helpers**

Add to `group-access-requests.ts`:

```ts
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

function escapeLine(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "unknown";
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
  const senderName = escapeLine(request.senderName);
  const username = request.senderUsername ? ` @${request.senderUsername}` : "";
  return [
    "Запрос доступа к Telegram-чату",
    "",
    `Чат: ${escapeLine(request.chatTitle)}`,
    `Chat ID: ${request.chatId}`,
    `Chat type: ${escapeLine(request.chatType)}`,
    `Topic ID: ${request.messageThreadId ?? "none"}`,
    "",
    `Пользователь: ${senderName}${username}`,
    `User ID: ${request.senderId}`,
    "",
    "Сообщение:",
    request.messageText?.trim() || "<empty>",
    "",
    `Request ID: ${request.id}`,
    `Повторов: ${request.count}`,
  ].join("\n");
}

export function buildTelegramGroupAccessOwnerKeyboard(requestId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/group-access-requests.test.ts
git commit -m "Render Telegram group access owner requests"
```

---

### Task 3: Config Mutation Draft Logic

**Files:**
- Modify: `extensions/telegram/src/group-access-requests.ts`
- Modify: `extensions/telegram/src/group-access-requests.test.ts`

- [ ] **Step 1: Write failing tests for approve/deny draft mutations**

Append:

```ts
import { applyTelegramGroupAccessDecisionToConfig } from "./group-access-requests.js";

it("allow_chat adds the specific group with requireMention true", () => {
  const cfg = { channels: { telegram: { groupPolicy: "allowlist", groups: {} } } } as never;
  const result = applyTelegramGroupAccessDecisionToConfig({
    cfg,
    request: {
      ...makeInput(),
      id: "tgreq_abc123",
      dedupeKey: "-100123456789:99:1281388780",
      status: "pending",
      firstSeenAt: "2026-05-16T13:00:00.000Z",
      lastSeenAt: "2026-05-16T13:00:00.000Z",
      count: 1,
    },
    action: "allow_chat",
  });

  expect(result.changed).toBe(true);
  expect((cfg as any).channels.telegram.groups["-100123456789"]).toEqual({
    requireMention: true,
  });
  expect((cfg as any).channels.telegram.groupAllowFrom).toBeUndefined();
});

it("allow_chat_user also adds sender to groupAllowFrom", () => {
  const cfg = {
    channels: { telegram: { groupPolicy: "allowlist", groupAllowFrom: ["6673887542"], groups: {} } },
  } as never;
  const result = applyTelegramGroupAccessDecisionToConfig({
    cfg,
    request: {
      ...makeInput(),
      id: "tgreq_abc123",
      dedupeKey: "-100123456789:99:1281388780",
      status: "pending",
      firstSeenAt: "2026-05-16T13:00:00.000Z",
      lastSeenAt: "2026-05-16T13:00:00.000Z",
      count: 1,
    },
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
    request: {
      ...makeInput(),
      id: "tgreq_abc123",
      dedupeKey: "-100123456789:99:1281388780",
      status: "pending",
      firstSeenAt: "2026-05-16T13:00:00.000Z",
      lastSeenAt: "2026-05-16T13:00:00.000Z",
      count: 1,
    },
    action: "deny",
  });

  expect(result.changed).toBe(false);
  expect((cfg as any).channels.telegram.groups).toEqual({});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts -t "allow_chat|deny"
```

Expected: FAIL because `applyTelegramGroupAccessDecisionToConfig` is missing.

- [ ] **Step 3: Implement config draft mutation**

Add:

```ts
export function applyTelegramGroupAccessDecisionToConfig(params: {
  cfg: OpenClawConfig;
  request: TelegramGroupAccessRequest;
  action: TelegramGroupAccessAction;
}): { changed: boolean } {
  if (params.action === "deny") {
    return { changed: false };
  }
  const cfgRecord = params.cfg as OpenClawConfig & {
    channels: NonNullable<OpenClawConfig["channels"]>;
  };
  cfgRecord.channels ??= {};
  const telegram = (cfgRecord.channels.telegram ??= {});
  telegram.groupPolicy = "allowlist";
  telegram.groups ??= {};
  telegram.groups[params.request.chatId] = {
    ...(telegram.groups[params.request.chatId] ?? {}),
    requireMention: true,
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/group-access-requests.test.ts
git commit -m "Add Telegram group access config decisions"
```

---

### Task 4: Denied Mention Integration

**Files:**
- Modify: `extensions/telegram/src/group-access-requests.ts`
- Modify: `extensions/telegram/src/bot-handlers.runtime.ts`
- Modify: `extensions/telegram/src/bot.create-telegram-bot.test.ts`

- [ ] **Step 1: Add integration test for denied group mention creating owner request**

In `bot.create-telegram-bot.test.ts`, add near the existing forbidden tests:

```ts
it("creates an owner access request for denied mentioned group messages", async () => {
  resetHarnessSpies();
  loadConfig.mockReturnValue({
    commands: { ownerAllowFrom: ["telegram:6673887542"] },
    channels: {
      telegram: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["6673887542"],
        groups: {},
      },
    },
  });

  await dispatchMessage({
    message: {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      from: { id: 1281388780, username: "mystery_63", first_name: "Татьяна" },
      text: "@openclaw_bot можно пользоваться тут?",
      date: 1736380800,
      message_id: 77,
    },
    me: { username: "openclaw_bot" },
  });

  expect(replySpy).not.toHaveBeenCalled();
  expect(sendMessageSpy).toHaveBeenCalledWith(
    6673887542,
    expect.stringContaining("Запрос доступа к Telegram-чату"),
    expect.objectContaining({
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    }),
  );
  expect(sendMessageSpy).toHaveBeenCalledWith(
    -100123456789,
    "Доступ запрещён. Запрос отправлен владельцу.",
    expect.objectContaining({
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    }),
  );
});
```

- [ ] **Step 2: Run integration test to verify failure**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/bot.create-telegram-bot.test.ts -t "owner access request"
```

Expected: FAIL because the handler still only sends `Доступ запрещён.`

- [ ] **Step 3: Add service function to create and notify requests**

Add to `group-access-requests.ts`:

```ts
export async function createTelegramGroupAccessRequestAndNotifyOwner(params: {
  cfg: OpenClawConfig;
  storePath: string;
  botApi: {
    sendMessage: (
      chatId: number | string,
      text: string,
      params?: { reply_markup?: ReturnType<typeof buildTelegramGroupAccessOwnerKeyboard> },
    ) => Promise<{ message_id?: number } | unknown>;
  };
  input: TelegramGroupAccessRequestInput;
}): Promise<{ request: TelegramGroupAccessRequest; ownerNotified: boolean }> {
  const upsert = await upsertTelegramGroupAccessRequest({ storePath: params.storePath, input: params.input });
  const owners = resolveTelegramGroupAccessOwnerChatIds(params.cfg);
  if (owners.length === 0) {
    return { request: upsert.request, ownerNotified: false };
  }
  const text = buildTelegramGroupAccessOwnerMessage({ request: upsert.request });
  const keyboard = buildTelegramGroupAccessOwnerKeyboard(upsert.request.id);
  let ownerNotified = false;
  for (const owner of owners) {
    const result = await params.botApi.sendMessage(Number(owner), text, { reply_markup: keyboard });
    ownerNotified = true;
    if (result && typeof result === "object" && "message_id" in result) {
      upsert.request.ownerNotificationChatId = owner;
      upsert.request.ownerNotificationMessageId = Number(result.message_id);
    }
  }
  return { request: upsert.request, ownerNotified };
}
```

- [ ] **Step 4: Integrate it in `bot-handlers.runtime.ts`**

Import:

```ts
import {
  createTelegramGroupAccessRequestAndNotifyOwner,
  resolveTelegramGroupAccessRequestsPath,
} from "./group-access-requests.js";
```

Change `sendForbiddenGroupAccessReply` to accept text:

```ts
  const sendForbiddenGroupAccessReply = async (params: {
    chatId: string | number;
    messageThreadId?: number;
    messageId?: number;
    text?: string;
  }) => {
    const text = params.text ?? TELEGRAM_FORBIDDEN_REPLY;
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api.sendMessage(params.chatId, text, {
```

Add request orchestration before `shouldSkipGroupMessage` returns for policy denial. The lowest-risk integration is inside `notifyForbiddenAccess`, because it already runs only when `notifyForbidden` is true:

```ts
    const notifyForbiddenAccess = async () => {
      let replyText = TELEGRAM_FORBIDDEN_REPLY;
      if (isGroup && params.notifyForbidden) {
        const requestResult = await createTelegramGroupAccessRequestAndNotifyOwner({
          cfg,
          storePath: resolveTelegramGroupAccessRequestsPath(
            telegramDeps.resolveStorePath(cfg.session?.store),
          ),
          botApi: bot.api,
          input: {
            chatId: String(chatId),
            chatTitle,
            chatType: "group",
            messageThreadId: params.messageThreadId ?? resolvedThreadId,
            senderId,
            senderUsername,
            messageId: params.messageId,
            messageText: undefined,
          },
        }).catch((err) => {
          logVerbose(`telegram group access request failed for chat ${chatId}: ${String(err)}`);
          return undefined;
        });
        if (requestResult?.ownerNotified) {
          replyText = "Доступ запрещён. Запрос отправлен владельцу.";
        }
      }
      await maybeSendForbiddenGroupAccessReply({
        ...params,
        messageThreadId: params.messageThreadId ?? resolvedThreadId,
        text: replyText,
      });
    };
```

Then extend the type accepted by `maybeSendForbiddenGroupAccessReply`:

```ts
  const maybeSendForbiddenGroupAccessReply = async (params: {
    notifyForbidden?: boolean;
    chatId: string | number;
    messageThreadId?: number;
    messageId?: number;
    text?: string;
  }) => {
```

Pass message text from the inbound call site:

```ts
          messageText: "text" in event.msg ? event.msg.text : undefined,
```

If TypeScript complains because `Message` is a union, use:

```ts
const messageText = typeof (event.msg as { text?: unknown }).text === "string"
  ? (event.msg as { text: string }).text
  : undefined;
```

- [ ] **Step 5: Run integration test**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/bot.create-telegram-bot.test.ts -t "owner access request|forbidden notice|disabled forum topic"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/bot-handlers.runtime.ts extensions/telegram/src/bot.create-telegram-bot.test.ts
git commit -m "Create Telegram group access requests on denied mentions"
```

---

### Task 5: Owner Callback Handling

**Files:**
- Modify: `extensions/telegram/src/group-access-requests.ts`
- Modify: `extensions/telegram/src/bot-handlers.runtime.ts`
- Modify: `extensions/telegram/src/bot.create-telegram-bot.test.ts`

- [ ] **Step 1: Add failing callback integration tests**

Add tests:

```ts
it("approves a Telegram group access request from owner callback", async () => {
  resetHarnessSpies();
  loadConfig.mockReturnValue({
    commands: { ownerAllowFrom: ["telegram:6673887542"] },
    channels: { telegram: { groupPolicy: "allowlist", groupAllowFrom: ["6673887542"], groups: {} } },
  });

  await dispatchMessage({
    message: {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      from: { id: 1281388780, username: "mystery_63", first_name: "Татьяна" },
      text: "@openclaw_bot можно пользоваться тут?",
      date: 1736380800,
      message_id: 77,
    },
    me: { username: "openclaw_bot" },
  });

  const ownerCall = sendMessageSpy.mock.calls.find((call) => call[0] === 6673887542);
  const keyboard = ownerCall?.[2]?.reply_markup?.inline_keyboard;
  const callbackData = keyboard?.[0]?.[0]?.callback_data;
  expect(callbackData).toMatch(/^OC_TG_AR\|/);

  const handler = getOnHandler("callback_query");
  await handler({
    callbackQuery: {
      id: "cbq-access-1",
      data: callbackData,
      from: { id: 6673887542, username: "Cyberbort" },
      message: { chat: { id: 6673887542, type: "private" }, message_id: 500, text: "request" },
    },
  });

  expect(answerCallbackQuerySpy).toHaveBeenCalled();
  expect(editMessageTextSpy).toHaveBeenCalledWith(
    expect.stringContaining("Разрешено"),
    expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
  );
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/bot.create-telegram-bot.test.ts -t "approves a Telegram group access request"
```

Expected: FAIL because `OC_TG_AR` callbacks are not handled.

- [ ] **Step 3: Implement request resolution**

Add to `group-access-requests.ts`:

```ts
export async function resolveTelegramGroupAccessRequestDecision(params: {
  storePath: string;
  requestId: string;
  action: TelegramGroupAccessAction;
  ownerId: string;
  mutateConfigFile: typeof import("openclaw/plugin-sdk/config-mutation").mutateConfigFile;
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
    return { text: `Отклонено.\nChat ID: ${request.chatId}\nUser ID: ${request.senderId}`, changedConfig: false };
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
```

- [ ] **Step 4: Integrate callback branch**

In `bot-handlers.runtime.ts`, import:

```ts
  parseTelegramGroupAccessCallbackData,
  resolveTelegramGroupAccessRequestDecision,
```

Inside `bot.on("callback_query", ...)`, immediately after `const data = ...` and before `parseExecApprovalCommandText(data)`:

```ts
      const groupAccessCallback = parseTelegramGroupAccessCallbackData(data);
      if (groupAccessCallback) {
        const ownerId = String(callback.from?.id ?? "");
        const owners = cfg.commands?.ownerAllowFrom ?? [];
        const ownerAllowed = owners.some((entry) => String(entry) === `telegram:${ownerId}` || String(entry) === ownerId);
        if (!ownerAllowed) {
          await editCallbackMessage("Эту заявку может обработать только владелец.", {
            reply_markup: { inline_keyboard: [] },
          });
          return;
        }
        const result = await resolveTelegramGroupAccessRequestDecision({
          storePath: resolveTelegramGroupAccessRequestsPath(
            telegramDeps.resolveStorePath(cfg.session?.store),
          ),
          requestId: groupAccessCallback.requestId,
          action: groupAccessCallback.action,
          ownerId,
          mutateConfigFile,
        });
        await editCallbackMessage(result.text, { reply_markup: { inline_keyboard: [] } });
        return;
      }
```

- [ ] **Step 5: Run callback tests**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/bot.create-telegram-bot.test.ts -t "Telegram group access request|owner access request"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/bot-handlers.runtime.ts extensions/telegram/src/bot.create-telegram-bot.test.ts
git commit -m "Handle Telegram group access approval callbacks"
```

---

### Task 6: Anti-Spam And Owner Notification Cooldown

**Files:**
- Modify: `extensions/telegram/src/group-access-requests.ts`
- Modify: `extensions/telegram/src/group-access-requests.test.ts`
- Modify: `extensions/telegram/src/bot.create-telegram-bot.test.ts`

- [ ] **Step 1: Add failing cooldown tests**

Append:

```ts
it("does not notify owner again inside the cooldown window", async () => {
  const storePath = await makeStorePath();
  const sent: Array<{ chatId: string | number; text: string }> = [];
  const cfg = { commands: { ownerAllowFrom: ["telegram:6673887542"] } } as never;

  const first = await createTelegramGroupAccessRequestAndNotifyOwner({
    cfg,
    storePath,
    botApi: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 }; } },
    input: makeInput({ nowIso: "2026-05-16T13:00:00.000Z" }),
    notifyCooldownMs: 600_000,
  });
  const second = await createTelegramGroupAccessRequestAndNotifyOwner({
    cfg,
    storePath,
    botApi: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 2 }; } },
    input: makeInput({ nowIso: "2026-05-16T13:01:00.000Z" }),
    notifyCooldownMs: 600_000,
  });

  expect(first.ownerNotified).toBe(true);
  expect(second.ownerNotified).toBe(false);
  expect(sent).toHaveLength(1);
});
```

- [ ] **Step 2: Implement cooldown**

Change `createTelegramGroupAccessRequestAndNotifyOwner` signature:

```ts
notifyCooldownMs?: number;
```

Before sending owner messages:

```ts
  const nowMs = Date.parse(params.input.nowIso ?? new Date().toISOString());
  const lastNotifiedMs = upsert.request.ownerLastNotifiedAt
    ? Date.parse(upsert.request.ownerLastNotifiedAt)
    : 0;
  const cooldownMs = params.notifyCooldownMs ?? 600_000;
  if (!upsert.created && Number.isFinite(lastNotifiedMs) && nowMs - lastNotifiedMs < cooldownMs) {
    return { request: upsert.request, ownerNotified: false };
  }
```

After successful send:

```ts
upsert.request.ownerLastNotifiedAt = params.input.nowIso ?? new Date().toISOString();
await saveStore(params.storePath, await loadStore(params.storePath));
```

Make the persistence robust by adding a helper that updates the stored request by id instead of reloading and losing object identity:

```ts
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
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run extensions/telegram/src/group-access-requests.test.ts -t "cooldown|dedupes"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extensions/telegram/src/group-access-requests.ts extensions/telegram/src/group-access-requests.test.ts extensions/telegram/src/bot.create-telegram-bot.test.ts
git commit -m "Deduplicate Telegram group access owner alerts"
```

---

### Task 7: Full Verification And Schrodinger Deployment

**Files:**
- Modify after deployment: `C:\Users\regis\.codex\skills\openclaw-clawcode-schrodinger\references\installation-ledger.md`

- [ ] **Step 1: Run focused Telegram tests on Schrodinger**

Run from `/opt/openclaw/src`:

```bash
pnpm_config_verify_deps_before_run=false ./node_modules/.bin/vitest run \
  extensions/telegram/src/group-access-requests.test.ts \
  extensions/telegram/src/bot.create-telegram-bot.test.ts \
  -t "group access request|owner access request|forbidden notice|disabled forum topic"
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm_config_verify_deps_before_run=false pnpm tsgo:prod
```

Expected: PASS.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Commit final integration if not already committed**

Run:

```bash
git status --short
git add extensions/telegram/src/group-access-requests.ts \
  extensions/telegram/src/group-access-requests.test.ts \
  extensions/telegram/src/bot-handlers.runtime.ts \
  extensions/telegram/src/bot.create-telegram-bot.test.ts
git commit -m "Add Telegram group access request approvals"
```

Expected: clean source commit.

- [ ] **Step 5: Create rollback tag and rebuild Gateway**

Standing approval applies because this changes Gateway source/runtime.

Run:

```bash
cd /opt/openclaw/src
tag=openclaw-gateway:rollback-before-telegram-access-requests-$(date -u +%Y%m%dT%H%M%SZ)
current=$(docker inspect -f '{{.Image}}' src-openclaw-gateway-1)
docker tag "$current" "$tag"
echo "rollback_tag=$tag"
docker compose -f docker-compose.yml \
  -f docker-compose.loopback.yml \
  -f docker-compose.ai-proxy.yml \
  -f docker-compose.ollama.yml \
  build openclaw-gateway
docker compose -f docker-compose.yml \
  -f docker-compose.loopback.yml \
  -f docker-compose.ai-proxy.yml \
  -f docker-compose.ollama.yml \
  up -d --force-recreate openclaw-gateway
```

Expected: build succeeds and Gateway starts.

- [ ] **Step 6: Verify runtime**

Run:

```bash
docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.Image}}' src-openclaw-gateway-1
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:18789/healthz
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:18789/readyz
ss -ltnp | grep -E ':18789|:18790' || true
docker logs --since 3m src-openclaw-gateway-1 2>&1 | grep -Ei 'gateway ready|telegram|codex|error|failed'
```

Expected:
- `running healthy 0 ...`
- `/healthz` HTTP 200
- `/readyz` HTTP 200
- only `127.0.0.1:18789`
- Telegram provider starts as `@CyberClawGPT_bot`

- [ ] **Step 7: Push branch through the existing bundle path**

Run on Schrodinger:

```bash
cd /opt/openclaw/src
git bundle create /tmp/openclaw-telegram-access-requests-$(git rev-parse --short HEAD).bundle \
  HEAD codex/openclaw-telegram-guest-mode
```

Copy to Windows and push from the local clone:

```powershell
$repo='C:\Users\regis\OneDrive\Рабочий стол\Доделка робота 2\codex-tmp\openclaw-telegram-guest-push'
$bundle='C:\Users\regis\OneDrive\Рабочий стол\Доделка робота 2\codex-tmp\openclaw-telegram-access-requests-<sha>.bundle'
git -C $repo fetch $bundle 'codex/openclaw-telegram-guest-mode:codex/openclaw-telegram-guest-mode'
git -C $repo push origin codex/openclaw-telegram-guest-mode
```

Expected: branch pushed to `marketozk/openclaw:codex/openclaw-telegram-guest-mode`.

- [ ] **Step 8: Update ledger**

Add a ledger entry with:
- architecture: Telegram extension-owned access requests, no memory/router provider bypass;
- state path: `/home/node/.openclaw/telegram/group-access-requests.json`;
- callback protocol: `OC_TG_AR|<requestId>|allow_chat|allow_chat_user|deny`;
- config mutation: `mutateConfigFile({ afterWrite: { mode: "auto" } })`;
- tests run;
- rollback tag;
- health/ready results;
- active policy: `groups={}` until owner approves a specific chat.

---

## Self-Review

- Spec coverage:
  - Owner gets chat id/title/user id/username: Task 2 and Task 4.
  - Bot asks whether chat can be used: Task 4 group reply and owner message.
  - Approval buttons: Task 2 and Task 5.
  - Config mutation is centralized and auditable: Task 3 and Task 5.
  - No wildcard access: current policy remains `groups={}` and approve only adds a specific `groups[chatId]`.
  - Forum topic safety: existing review fix remains, and Task 4/5 preserve `messageThreadId` in request state.
- Placeholder scan:
  - No placeholder markers or undefined later work remains in this plan.
- Type consistency:
  - Callback action type is `TelegramGroupAccessAction` everywhere.
  - Request ids use the `tgreq_...` prefix and callback data uses `OC_TG_AR|...`.
  - Config mutation uses existing `mutateConfigFile` from `openclaw/plugin-sdk/config-mutation`, matching current `bot-handlers.runtime.ts` imports.
