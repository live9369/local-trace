import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../core/normalize.js";
import { containsSensitiveLeak } from "../core/privacy.js";

describe("privacy default", () => {
  it("does not persist sensitive prompt/tool bodies by default", () => {
    const ev = normalizeEvent(
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "s",
        generation_id: "g",
        prompt: "SECRET_PROMPT_XYZ",
        tool_input: { command: "SECRET_CMD" },
        authorization: "Bearer SECRET_KEY",
        user_email: "a@b.com",
      },
      { captureDetail: false },
    );

    const blob = {
      ...ev.rawSummary,
      detail: ev.detail,
    };
    assert.equal(containsSensitiveLeak(blob, "SECRET_PROMPT_XYZ"), false);
    assert.equal(containsSensitiveLeak(blob, "SECRET_CMD"), false);
    assert.equal(containsSensitiveLeak(blob, "SECRET_KEY"), false);
    assert.equal(containsSensitiveLeak(blob, "a@b.com"), false);
    assert.ok(ev.rawSummary.prompt_len === "SECRET_PROMPT_XYZ".length || ev.rawSummary.prompt_present);
  });
});
