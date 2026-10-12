import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaseStore, rebuildIndexFor } from "../core/cases.js";
import { ingestHookPayload } from "../core/ingest.js";
import { cleanup, tempProject } from "./helpers.js";

describe("index rebuild", () => {
  it("preserves manual evaluation after rebuild", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const c = store.createCase({ name: "idx" });
      const v = store.createVersion({ caseId: c.caseId, prompt: "p" });
      const run = store.prepareRun({
        caseId: c.caseId,
        versionId: v.versionId,
        variant: "default",
      });

      ingestHookPayload({
        hook_event_name: "sessionStart",
        session_id: "sess-idx",
        conversation_id: "sess-idx",
        workspace_roots: [root],
      });
      ingestHookPayload({
        hook_event_name: "stop",
        conversation_id: "sess-idx",
        generation_id: "g1",
        status: "completed",
        input_tokens: 10,
        output_tokens: 1,
        workspace_roots: [root],
      });

      store.updateRunMeta(run.runId, {
        evaluation: "pass",
        notes: "人工备注保留",
      });

      rebuildIndexFor(root);
      const after = store.getRun(run.runId)!;
      assert.equal(after.evaluation, "pass");
      assert.equal(after.notes, "人工备注保留");
    } finally {
      cleanup(root);
    }
  });
});
