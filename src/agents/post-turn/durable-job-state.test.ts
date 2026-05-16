import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";

describe("durable post-turn job state", () => {
  it("persists queued, running, and completed job transitions", async () => {
    await withStateDirEnv("openclaw-post-turn-jobs-", async () => {
      const {
        createPostTurnJob,
        markPostTurnJobCompleted,
        markPostTurnJobRunning,
        readPostTurnJobState,
      } = await import("./durable-job-state.js");

      const job = await createPostTurnJob(
        {
          kind: "context_engine_maintenance",
          label: "Context engine turn maintenance",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
        },
        { bootId: "boot-a", now: 1_000, processId: 111 },
      );

      await markPostTurnJobRunning(job.id, { bootId: "boot-a", now: 1_100, processId: 111 });
      await markPostTurnJobCompleted(job.id, { now: 1_200 });

      const state = await readPostTurnJobState();
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0]).toMatchObject({
        id: job.id,
        kind: "context_engine_maintenance",
        label: "Context engine turn maintenance",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        status: "completed",
        bootId: "boot-a",
        processId: 111,
        createdAt: 1_000,
        startedAt: 1_100,
        completedAt: 1_200,
      });
    });
  });

  it("recovers stale running jobs as crashed and opens the matching circuit breaker", async () => {
    await withStateDirEnv("openclaw-post-turn-jobs-", async () => {
      const {
        createPostTurnJob,
        isPostTurnCircuitBreakerOpen,
        markPostTurnJobRunning,
        readPostTurnJobState,
        recoverStaleRunningPostTurnJobs,
      } = await import("./durable-job-state.js");

      const job = await createPostTurnJob(
        {
          kind: "plugin_hook",
          hookName: "agent_end",
          pluginId: "memory-plugin",
          label: "agent_end hook",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
        },
        { bootId: "old-boot", now: 2_000, processId: 222 },
      );
      await markPostTurnJobRunning(job.id, {
        bootId: "old-boot",
        now: 2_100,
        processId: 222,
      });

      const recovery = await recoverStaleRunningPostTurnJobs({
        bootId: "new-boot",
        now: 3_000,
        processId: 333,
      });

      expect(recovery.crashedJobIds).toEqual([job.id]);
      expect(
        await isPostTurnCircuitBreakerOpen(
          {
            kind: "plugin_hook",
            hookName: "agent_end",
            pluginId: "memory-plugin",
          },
          { now: 3_001 },
        ),
      ).toBe(true);

      const state = await readPostTurnJobState();
      expect(state.jobs[0]).toMatchObject({
        id: job.id,
        status: "crashed",
        completedAt: 3_000,
        lastError: expect.stringContaining("stale running post-turn job"),
      });
      expect(Object.values(state.circuitBreakers)[0]).toMatchObject({
        kind: "plugin_hook",
        hookName: "agent_end",
        pluginId: "memory-plugin",
        openedAt: 3_000,
        expiresAt: 903_000,
        crashCount: 1,
      });
    });
  });

  it("expires circuit breakers after the cooldown window", async () => {
    await withStateDirEnv("openclaw-post-turn-jobs-", async () => {
      const {
        createPostTurnJob,
        isPostTurnCircuitBreakerOpen,
        markPostTurnJobCrashed,
        readPostTurnJobState,
      } = await import("./durable-job-state.js");

      const scope = {
        kind: "plugin_hook" as const,
        hookName: "agent_end",
        pluginId: "memory-plugin",
      };
      const job = await createPostTurnJob({
        ...scope,
        label: "agent_end hook",
      });
      await markPostTurnJobCrashed(job.id, {
        now: 10_000,
        reason: "worker exited with code 139",
      });

      expect(await isPostTurnCircuitBreakerOpen(scope, { now: 909_999 })).toBe(true);
      expect(Object.values((await readPostTurnJobState()).circuitBreakers)[0]).toMatchObject({
        expiresAt: 910_000,
      });

      expect(await isPostTurnCircuitBreakerOpen(scope, { now: 910_000 })).toBe(false);
      expect((await readPostTurnJobState()).circuitBreakers).toEqual({});
    });
  });
});
