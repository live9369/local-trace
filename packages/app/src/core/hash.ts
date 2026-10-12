import { createHash } from "node:crypto";

export function contentHash(parts: {
  prompt: string;
  acceptanceCriteria: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.prompt);
  h.update("\n---\n");
  h.update(parts.acceptanceCriteria);
  return h.digest("hex").slice(0, 16);
}
