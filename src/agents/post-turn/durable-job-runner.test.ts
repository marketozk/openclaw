import { describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";

describe("durable post-turn job runner", () => {
  it("records completed work and returns the work result", async () => {
    await withStateDirEnv("openclaw-post-turn-runner-", async () => {
      const { readPostTurnJobState } = await import("./durable-job-state.js");
      const { runDurablePostTurnJob } = await import("./durable-job-runner.js");

      const result = await runDurablePostTurnJob(
        {
          kind: "plugin_hook",
          hookName: "llm_output",
          pluginId: "memory-plugin",
          label: "llm_output hook",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          work: async () => "ok",
        },
        { bootId: "boot-a", processId: 111 },
      );

      expect(result).toEqual({ status: "completed", result: "ok" });
      expect((await readPostTurnJobState()).jobs[0]).toMatchObject({
        kind: "plugin_hook",
        hookName: "llm_output",
        pluginId: "memory-plugin",
        status: "completed",
      });
    });
  });

  it("skips matching work while its crash circuit breaker is open", async () => {
    await withStateDirEnv("openclaw-post-turn-runner-", async () => {
      const { createPostTurnJob, markPostTurnJobCrashed, readPostTurnJobState } = await import(
        "./durable-job-state.js"
      );
      const { runDurablePostTurnJob } = await import("./durable-job-runner.js");
      const work = vi.fn(async () => undefined);

      const crashed = await createPostTurnJob({
        kind: "plugin_hook",
        hookName: "agent_end",
        pluginId: "memory-plugin",
        label: "agent_end hook",
      });
      await markPostTurnJobCrashed(crashed.id, {
        now: 10_000,
        reason: "worker exited with code 139",
      });

      const result = await runDurablePostTurnJob(
        {
          kind: "plugin_hook",
          hookName: "agent_end",
          pluginId: "memory-plugin",
          label: "agent_end hook",
          work,
        },
        {
          now: 10_001,
        },
      );

      expect(result.status).toBe("skipped");
      expect(work).not.toHaveBeenCalled();
      expect((await readPostTurnJobState()).jobs.at(-1)).toMatchObject({
        kind: "plugin_hook",
        hookName: "agent_end",
        pluginId: "memory-plugin",
        status: "skipped",
        lastError: expect.stringContaining("circuit breaker"),
      });
    });
  });

  it("allows matching work to retry after the crash circuit breaker cooldown expires", async () => {
    await withStateDirEnv("openclaw-post-turn-runner-", async () => {
      const { createPostTurnJob, markPostTurnJobCrashed, readPostTurnJobState } = await import(
        "./durable-job-state.js"
      );
      const { runDurablePostTurnJob } = await import("./durable-job-runner.js");
      const work = vi.fn(async () => "recovered");
      const scope = {
        kind: "plugin_hook" as const,
        hookName: "agent_end",
        pluginId: "memory-plugin",
      };

      const crashed = await createPostTurnJob({
        ...scope,
        label: "agent_end hook",
      });
      await markPostTurnJobCrashed(crashed.id, {
        now: 10_000,
        reason: "worker exited with code 139",
      });

      const result = await runDurablePostTurnJob(
        {
          ...scope,
          label: "agent_end hook",
          work,
        },
        { now: 910_001 },
      );

      expect(result).toEqual({ status: "completed", result: "recovered" });
      expect(work).toHaveBeenCalledOnce();
      expect((await readPostTurnJobState()).jobs.at(-1)).toMatchObject({
        status: "completed",
      });
    });
  });
});
