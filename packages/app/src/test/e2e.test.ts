import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CaseStore } from "../core/cases.js";
import { ingestHookPayload } from "../core/ingest.js";
import { exportCase } from "../core/export-import.js";
import { openIndex } from "../core/index-db.js";
import { buildSummary } from "../core/aggregate.js";
import { cleanup, tempProject } from "./helpers.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures",
);

function ingestFile(file: string, root: string): void {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const payload = JSON.parse(t);
    payload.workspace_roots = [root];
    ingestHookPayload(payload);
  }
}

describe("e2e fixture flow", () => {
  it("create case → ingest → compare → export", () => {
    const root = tempProject();
    try {
      const store = new CaseStore(root);
      const c = store.createCase({
        name: "模拟对比案例",
        description: "fixture only",
      });
      const v = store.createVersion({
        caseId: c.caseId,
        prompt: "分析调用链",
        acceptanceCriteria: "给出结论",
      });

      // Prepare first run then ingest its session
      const r1 = store.prepareRun({
        caseId: c.caseId,
        versionId: v.versionId,
      });
      ingestFile(join(fixtures, "simulated-baseline-turn.jsonl"), root);

      // Second awaiting would conflict — complete first
      store.updateRunMeta(r1.runId, { status: "completed" });

      const r2 = store.prepareRun({
        caseId: c.caseId,
        versionId: v.versionId,
        config: { source: "manual" },
      });
      ingestFile(join(fixtures, "simulated-codegraph-turn.jsonl"), root);
      store.updateRunMeta(r2.runId, { status: "completed" });

      const idx = openIndex(root);
      const events1 = idx.listEvents(r1.runId);
      const events2 = idx.listEvents(r2.runId);
      assert.ok(events1.length > 0);
      assert.ok(events2.length > 0);

      // Privacy: secret strings not in stored events
      const blob = JSON.stringify(events1);
      assert.equal(blob.includes("SECRET_PROMPT_SHOULD_NOT_PERSIST"), false);
      assert.equal(blob.includes("SECRET_OUTPUT"), false);

      const s1 = buildSummary(r1.runId, events1, r1.startedAt, new Date().toISOString());
      const s2 = buildSummary(r2.runId, events2, r2.startedAt, new Date().toISOString());
      assert.equal(s1.usageSource, "platform");
      assert.equal(s1.usage?.inputTokens, 100000);
      assert.equal(s2.usage?.inputTokens, 60000);

      const exp = exportCase(root, c.caseId);
      assert.ok(exp.path.includes(c.caseId));
      idx.close();
    } finally {
      cleanup(root);
    }
  });
});
