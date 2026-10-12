import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaseStore } from "../core/cases.js";
import { compareCases } from "../core/compare-cases.js";
import { UNCATEGORIZED_CASE_ID } from "../core/types.js";
import { cleanup, tempProject } from "./helpers.js";

describe("compareCases", () => {
  it("uses the latest completed run, else the latest run", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const a = store.createCase({ name: "A" });
      const va = store.createVersion({ caseId: a.caseId, prompt: "prompt-a" });
      const completed = store.prepareRun({
        caseId: a.caseId,
        versionId: va.versionId,
      });
      store.updateRunMeta(completed.runId, { status: "completed" });
      const running = store.prepareRun({
        caseId: a.caseId,
        versionId: va.versionId,
      });
      store.updateRunMeta(running.runId, { status: "running" });

      const b = store.createCase({ name: "B" });
      const vb = store.createVersion({ caseId: b.caseId, prompt: "prompt-b" });
      const only = store.prepareRun({
        caseId: b.caseId,
        versionId: vb.versionId,
      });

      const cols = compareCases(root, [a.caseId, b.caseId]);
      assert.equal(cols[0]?.run?.runId, completed.runId);
      assert.equal(cols[0]?.picked, "completed");
      assert.equal(cols[0]?.prompt, "prompt-a");
      assert.equal(cols[0]?.deltas, null);
      assert.equal(cols[1]?.run?.runId, only.runId);
      assert.equal(cols[1]?.picked, "latest");
      assert.ok(cols[1]?.deltas);
    } finally {
      cleanup(root);
    }
  });

  it("rejects the wrong count and uncategorized", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const a = store.createCase({ name: "A" });
      assert.throws(() => compareCases(root, [a.caseId]), /2–4/);
      assert.throws(
        () => compareCases(root, [a.caseId, UNCATEGORIZED_CASE_ID]),
        /未分类/,
      );
    } finally {
      cleanup(root);
    }
  });
});
