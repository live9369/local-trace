import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTurnUsage,
  buildTimeline,
} from "../core/aggregate.js";
import { normalizeEvent } from "../core/normalize.js";
import type { TraceEvent } from "../core/types.js";

describe("usage", () => {
  it("does not treat afterAgentResponse usage as step usage; stop is turn-level", () => {
    const stop = normalizeEvent(
      {
        hook_event_name: "stop",
        conversation_id: "s",
        generation_id: "g",
        input_tokens: 1000,
        output_tokens: 20,
        cache_read_tokens: 800,
        cache_write_tokens: 50,
        status: "completed",
      },
      { captureDetail: false },
    );
    const resp = normalizeEvent(
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "s",
        generation_id: "g",
        text: "hi",
        input_tokens: 1000,
        output_tokens: 20,
      },
      { captureDetail: false },
    );
    const tool = normalizeEvent(
      {
        hook_event_name: "postToolUse",
        conversation_id: "s",
        generation_id: "g",
        tool_name: "Read",
        tool_use_id: "t1",
        duration: 100,
      },
      { captureDetail: false },
    );

    assert.equal(stop.usageScope, "turn");
    assert.equal(stop.usageSource, "platform");
    assert.equal(tool.usage, null);

    const agg = aggregateTurnUsage([stop, resp, tool]);
    assert.equal(agg.usage?.inputTokens, 1000);
    // Must not double-count afterAgentResponse
    assert.notEqual(agg.usage?.inputTokens, 2000);

    const timeline = buildTimeline([tool, resp, stop]);
    const respStep = timeline.find((s) => s.kind === "response");
    assert.equal(respStep?.usage, null);
    assert.equal(respStep?.usageIsTurnLevel, false);
    const turnStep = timeline.find((s) => s.kind === "turn_usage");
    assert.equal(turnStep?.usageIsTurnLevel, true);
    assert.equal(turnStep?.usage?.inputTokens, 1000);
  });
});
