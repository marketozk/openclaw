// ROB-111: agent-path media trust for extension plugins (default-ON, env opt-out/restrict).
// Unit-tests the pure decision logic with synthetic entries (the live module registry is empty
// under VITEST by design, so end-to-end extension delivery is covered by the live verify step).
import { describe, expect, it } from "vitest";
import {
  isExtensionToolMediaTrusted,
  resolveExtensionMediaTrust,
} from "./pi-embedded-subscribe.tools.js";

const ENTRIES = [
  {
    pluginId: "smart-memory-router",
    toolNames: ["smart_memory_get_entity_context", "smart_memory_search_media"],
  },
  { pluginId: "other-ext", toolNames: ["other_tool"] },
];

describe("resolveExtensionMediaTrust", () => {
  it("unset/empty/whitespace → all (default-ON)", () => {
    expect(resolveExtensionMediaTrust(undefined).mode).toBe("all");
    expect(resolveExtensionMediaTrust("").mode).toBe("all");
    expect(resolveExtensionMediaTrust("   ").mode).toBe("all");
  });
  it("none/off/- → off (kill-switch)", () => {
    expect(resolveExtensionMediaTrust("none").mode).toBe("off");
    expect(resolveExtensionMediaTrust("OFF").mode).toBe("off");
    expect(resolveExtensionMediaTrust("-").mode).toBe("off");
  });
  it("CSV → restrict with trimmed, de-blanked ids", () => {
    const t = resolveExtensionMediaTrust(" a , b ,, c ");
    expect(t.mode).toBe("restrict");
    expect([...t.ids].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("isExtensionToolMediaTrusted", () => {
  it("default-ON trusts any declared extension tool", () => {
    expect(isExtensionToolMediaTrusted("smart_memory_get_entity_context", ENTRIES, undefined)).toBe(true);
    expect(isExtensionToolMediaTrusted("other_tool", ENTRIES, "")).toBe(true);
  });
  it("off disables ALL extension trust (kill-switch works)", () => {
    expect(isExtensionToolMediaTrusted("smart_memory_get_entity_context", ENTRIES, "none")).toBe(false);
    expect(isExtensionToolMediaTrusted("other_tool", ENTRIES, "off")).toBe(false);
  });
  it("restrict trusts only listed plugin ids", () => {
    expect(isExtensionToolMediaTrusted("smart_memory_get_entity_context", ENTRIES, "smart-memory-router")).toBe(true);
    expect(isExtensionToolMediaTrusted("other_tool", ENTRIES, "smart-memory-router")).toBe(false);
  });
  it("typo / unmatched id → our tool NOT trusted (visible-fail, not silent-on)", () => {
    expect(isExtensionToolMediaTrusted("smart_memory_get_entity_context", ENTRIES, "smart-memroy-typo")).toBe(false);
  });
  it("unknown tool not trusted even under default-ON", () => {
    expect(isExtensionToolMediaTrusted("not_a_plugin_tool", ENTRIES, undefined)).toBe(false);
  });
  it("empty registry → nothing trusted (matches VITEST live registry)", () => {
    expect(isExtensionToolMediaTrusted("smart_memory_get_entity_context", [], undefined)).toBe(false);
  });
});
