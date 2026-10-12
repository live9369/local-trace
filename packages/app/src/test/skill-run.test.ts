import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestHookPayload } from "../core/ingest.js";
import {
  beginSkillRun,
  endSkillRun,
  rememberSession,
  skillRunStatus,
} from "../core/skill-run.js";
import { openIndex } from "../core/index-db.js";
import { cleanup, tempProject } from "./helpers.js";

describe("skill run begin/end", () => {
  it("binds current session and routes subsequent events", () => {
    const root = tempProject();
    try {
      rememberSession(root, "sess-skill-1");
      const begin = beginSkillRun({
        projectRoot: root,
        name: "skill demo",
        prompt: "do the thing",
      });
      assert.equal(begin.bound, true);
      assert.equal(begin.sessionId, "sess-skill-1");
      assert.ok(begin.url.includes(begin.run.runId));

      ingestHookPayload({
        hook_event_name: "preToolUse",
        conversation_id: "sess-skill-1",
        generation_id: "g1",
        tool_name: "Read",
        tool_use_id: "t1",
        workspace_roots: [root],
      });
      ingestHookPayload({
        hook_event_name: "postToolUse",
        conversation_id: "sess-skill-1",
        generation_id: "g1",
        tool_name: "Read",
        tool_use_id: "t1",
        duration: 12,
        workspace_roots: [root],
      });
      ingestHookPayload({
        hook_event_name: "stop",
        conversation_id: "sess-skill-1",
        generation_id: "g1",
        status: "completed",
        input_tokens: 100,
        output_tokens: 5,
        workspace_roots: [root],
      });

      const idx = openIndex(root);
      const events = idx.listEvents(begin.run.runId);
      idx.close();
      assert.ok(events.some((e) => e.eventType === "stop"));
      assert.ok(events.some((e) => e.eventType === "postToolUse"));

      const ended = endSkillRun(root);
      assert.ok(ended.run);
      assert.equal(ended.run!.status, "completed");
      assert.equal(ended.summary?.usage?.inputTokens, 100);
      assert.equal(skillRunStatus(root).active, null);
    } finally {
      cleanup(root);
    }
  });
});
