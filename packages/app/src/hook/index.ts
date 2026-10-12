import { hookResponseFor, ingestHookPayload } from "../core/ingest.js";
import type { HookRawPayload } from "../core/types.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respond(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  let payload: HookRawPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      payload = JSON.parse(raw) as HookRawPayload;
    }
  } catch {
    respond({});
    return;
  }

  // Always answer first-protocol-safe shape; ingest failures must not block Agent
  const response = hookResponseFor(payload);
  try {
    ingestHookPayload(payload);
  } catch (err) {
    try {
      const { writeDiagnostic } = await import("../core/project.js");
      writeDiagnostic({
        type: "ingest_error",
        message: err instanceof Error ? err.message : String(err),
        hook: payload.hook_event_name,
      });
    } catch {
      // ignore
    }
  }
  respond(response);
}

main().catch(() => {
  try {
    respond({});
  } catch {
    // ignore
  }
  process.exit(0);
});
