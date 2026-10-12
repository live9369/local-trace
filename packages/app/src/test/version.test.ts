import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaseStore } from "../core/cases.js";
import { cleanup, tempProject } from "./helpers.js";

describe("version freeze", () => {
  it("freezes on first run and keeps historical runs on old version", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const c = store.createCase({ name: "vtest" });
      const v1 = store.createVersion({
        caseId: c.caseId,
        prompt: "prompt v1",
        acceptanceCriteria: "ok",
      });
      assert.equal(v1.status, "draft");

      const run1 = store.prepareRun({
        caseId: c.caseId,
        versionId: v1.versionId,
        variant: "default",
      });
      const frozen = store.getVersion(c.caseId, v1.versionId)!;
      assert.equal(frozen.status, "frozen");

      assert.throws(() =>
        store.updateDraftVersion(c.caseId, v1.versionId, {
          prompt: "changed",
        }),
      );

      const v2 = store.forkVersion(c.caseId, v1.versionId, "改任务");
      store.updateDraftVersion(c.caseId, v2.versionId, {
        prompt: "prompt v2",
      });
      const run2 = store.prepareRun({
        caseId: c.caseId,
        versionId: v2.versionId,
        variant: "default",
      });

      assert.equal(run1.versionId, v1.versionId);
      assert.equal(run2.versionId, v2.versionId);
      assert.equal(store.getPrompt(c.caseId, "v0001"), "prompt v1");
      assert.equal(store.getPrompt(c.caseId, "v0002"), "prompt v2");
    } finally {
      cleanup(root);
    }
  });
});
