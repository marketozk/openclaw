import { describe, expect, it } from "vitest";
import { buildGuestPrompt } from "./bot-guest-mode.js";

describe("Guest Mode memory contract", () => {
  const baseConfig = {
    name: "trustedDev",
    allowFrom: ["6673887542"],
    allowChats: [],
    useMemory: true,
    allowTools: true,
    tools: [
      "smart_memory_get_entity_context",
      "smart_memory_get_full_artifact",
      "smart_memory_save_secret",
      "smart_memory_lookup_secret",
      "smart_memory_reveal_secret",
    ],
    allowProjectContext: true,
    allowEntityMemory: true,
    allowVault: "confirm",
    authorized: true,
  };

  it("tells trusted mode to use full retrieval instead of summaries", () => {
    const prompt = buildGuestPrompt({
      requestText: "выведи всю заметку по Deepgram полностью",
      replyText: "",
      media: [],
      config: baseConfig,
    });

    expect(prompt).toContain("outputMode: \"full\"");
    expect(prompt).toContain("includeFullText: true");
    expect(prompt).toContain("complete: true");
    expect(prompt).toContain("collectionMode: \"auto\"");
    expect(prompt).toContain("noSilentOmission: true");
    expect(prompt).toContain("coverage.omitted");
    expect(prompt).toContain("mediaDelivery.mediaUrls");
    expect(prompt).toContain("smart_memory_get_full_artifact");
    expect(prompt).toContain("Do not summarize full-note requests");
    expect(prompt).toContain("Part 1/N");
    expect(prompt).toContain("nextCursor");
  });

  it("allows trusted owner secret saves but redirects raw reveal to private owner DM", () => {
    const prompt = buildGuestPrompt({
      requestText: "сохрани API ключ Deepgram",
      replyText: "DEEPGRAM_API_KEY = \"dg_test_123456\"",
      media: [],
      config: baseConfig,
    });

    expect(prompt).toContain("smart_memory_save_secret");
    expect(prompt).toContain("smart_memory_lookup_secret");
    expect(prompt).toContain("smart_memory_reveal_secret");
    expect(prompt).toContain("confirmReveal: true");
    expect(prompt).toContain("privateSurface: true");
    expect(prompt).toContain("private owner DM");
    expect(prompt).toContain("value=<redacted>");
  });
});
