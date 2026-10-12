import type { HookRawPayload } from "./types.js";

const SECRET_KEY_RE =
  /(api[_-]?key|authorization|password|secret|token|cookie|credential|private[_-]?key)/i;

const SENSITIVE_TOP_LEVEL = new Set([
  "prompt",
  "text",
  "content",
  "tool_input",
  "tool_output",
  "output",
  "command",
  "task",
  "agent_message",
  "user_message",
  "attachments",
  "file_content",
  "diff",
  "edits",
]);

export interface PrivacyOptions {
  captureDetail: boolean;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 200) return `[string:${value.length}]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Strip secrets and (by default) conversation/tool bodies before persistence. */
export function filterPayload(
  payload: HookRawPayload,
  opts: PrivacyOptions,
): {
  safe: HookRawPayload;
  detail: Record<string, unknown> | undefined;
  strippedKeys: string[];
} {
  const strippedKeys: string[] = [];
  const safe: HookRawPayload = {};
  const detail: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY_RE.test(key)) {
      strippedKeys.push(key);
      continue;
    }

    const isSensitive = SENSITIVE_TOP_LEVEL.has(key);
    if (isSensitive && !opts.captureDetail) {
      strippedKeys.push(key);
      if (typeof value === "string") {
        safe[`${key}_len`] = value.length;
      } else if (value != null) {
        safe[`${key}_present`] = true;
      }
      continue;
    }

    if (isSensitive && opts.captureDetail) {
      detail[key] = redactValue(value, 0);
      if (typeof value === "string") safe[`${key}_len`] = value.length;
      else safe[`${key}_present`] = true;
      continue;
    }

    // Keep structural metadata; lightly redact nested secrets
    if (key === "tool_input" || key === "tool_output") {
      // already handled above when captureDetail false
      safe[key] = redactValue(value, 0);
    } else {
      safe[key] = redactValue(value, 0);
    }
  }

  // Never persist user email in events
  if ("user_email" in safe) {
    delete safe.user_email;
    strippedKeys.push("user_email");
  }

  return {
    safe,
    detail: opts.captureDetail && Object.keys(detail).length ? detail : undefined,
    strippedKeys,
  };
}

export function containsSensitiveLeak(
  stored: Record<string, unknown>,
  needle: string,
): boolean {
  const json = JSON.stringify(stored);
  return json.includes(needle);
}
