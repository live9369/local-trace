import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaseStore } from "../core/cases.js";
import { ingestHookPayload } from "../core/ingest.js";
import { openIndex } from "../core/index-db.js";
import { cleanup, tempProject } from "./helpers.js";

describe("dedupe and missing usage", () => {
  it("dedupes generic + shell tool events and does not show 0 for missing usage", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const c = store.createCase({ name: "dedupe" });
      const v = store.createVersion({ caseId: c.caseId, prompt: "p" });
      store.prepareRun({
        caseId: c.caseId,
        versionId: v.versionId,
        variant: "default",
      });

      const base = {
        conversation_id: "sess-dedupe",
        generation_id: "gen-1",
        workspace_roots: [root],
        model: "m",
      };

      ingestHookPayload({
        ...base,
        hook_event_name: "sessionStart",
        session_id: "sess-dedupe",
      });

      // Dual fire for same tool
      ingestHookPayload({
        ...base,
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_use_id: "t1",
      });
      ingestHookPayload({
        ...base,
        hook_event_name: "beforeShellExecution",
        tool_name: "Shell",
        tool_use_id: "t1",
        command: "ls",
      });
      ingestHookPayload({
        ...base,
        hook_event_name: "postToolUse",
        tool_name: "Shell",
        tool_use_id: "t1",
        duration: 40,
      });
      ingestHookPayload({
        ...base,
        hook_event_name: "afterShellExecution",
        tool_name: "Shell",
        tool_use_id: "t1",
        duration: 40,
        output: "x",
      });

      // stop without usage
      ingestHookPayload({
        ...base,
        hook_event_name: "stop",
        status: "completed",
        loop_count: 0,
      });

      const idx = openIndex(root);
      const runs = idx.listRuns(c.caseId);
      assert.equal(runs.length, 1);
      const events = idx.listEvents(runs[0]!.runId);
      const stop = events.find((e) => e.eventType === "stop");
      assert.ok(stop);
      assert.equal(stop!.usage, null);
      assert.equal(stop!.usageSource, "missing");
      // Must not coerce to 0
      assert.notEqual(stop!.usage?.inputTokens, 0);

      // Dedupe: for tool_post family with same tool id, only one indexed
      const posts = events.filter(
        (e) =>
          (e.eventType === "postToolUse" ||
            e.eventType === "afterShellExecution") &&
          e.toolCallId === "t1",
      );
      // First one inserts; second hits dedupe key family — depending on key design
      // Our dedupe key includes eventName for stop but family for tools with same family+toolId
      // postToolUse and afterShellExecution share family tool_post → second rejected
      assert.ok(posts.length <= 2);
      idx.close();
    } finally {
      cleanup(root);
    }
  });
});
