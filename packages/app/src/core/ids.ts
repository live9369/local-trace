import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Compact ULID-like id (timestamp + randomness). */
export function ulid(): string {
  const now = Date.now();
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[bytes[i % 10]! % 32];
  }
  return time + rand;
}

export function caseId(): string {
  return `case_${ulid().toLowerCase()}`;
}

export function versionId(): string {
  return `ver_${ulid().toLowerCase()}`;
}

export function runId(): string {
  return `run_${ulid().toLowerCase()}`;
}

export function eventId(): string {
  return `evt_${ulid().toLowerCase()}`;
}

export function writerId(): string {
  return `w_${process.pid}_${ulid().toLowerCase().slice(-8)}`;
}

export function versionLabel(n: number): string {
  return `v${String(n).padStart(4, "0")}`;
}
