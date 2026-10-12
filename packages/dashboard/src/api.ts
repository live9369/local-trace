async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  cases: (q?: string) =>
    req<any[]>(`/api/cases${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createCase: (body: {
    name: string;
    description?: string;
    prompt?: string;
    acceptanceCriteria?: string;
  }) => req<any>("/api/cases", { method: "POST", body: JSON.stringify(body) }),
  caseDetail: (id: string) => req<any>(`/api/cases/${id}`),
  patchCase: (id: string, body: Record<string, unknown>) =>
    req<any>(`/api/cases/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  createVersion: (
    caseId: string,
    body: {
      prompt: string;
      acceptanceCriteria?: string;
      changeNote?: string;
      parentVersionId?: string;
    },
  ) =>
    req<any>(`/api/cases/${caseId}/versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchVersion: (caseId: string, vid: string, body: Record<string, unknown>) =>
    req<any>(`/api/cases/${caseId}/versions/${vid}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  runs: (caseId: string, versionId?: string) =>
    req<any[]>(
      `/api/cases/${caseId}/runs${versionId ? `?versionId=${versionId}` : ""}`,
    ),
  compareCases: (caseIds: string[]) =>
    req<{ columns: any[] }>(
      `/api/compare?cases=${caseIds.map(encodeURIComponent).join(",")}`,
    ),
  runDetail: (runId: string) => req<any>(`/api/runs/${runId}`),
  patchRun: (runId: string, body: Record<string, unknown>) =>
    req<any>(`/api/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  endRun: (runId: string) =>
    req<any>(`/api/runs/${runId}/end`, { method: "POST", body: "{}" }),
  exportCase: (caseId: string) =>
    req<any>("/api/export", {
      method: "POST",
      body: JSON.stringify({ caseId }),
    }),
  config: () => req<any>("/api/config"),
  saveConfig: (body: Record<string, unknown>) =>
    req<any>("/api/config", { method: "PUT", body: JSON.stringify(body) }),
};

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "未提供";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "未提供";
  return n.toLocaleString("zh-CN");
}

export function statusBadge(status: string): string {
  if (status === "completed") return "ok";
  if (status === "failed") return "err";
  if (status === "running" || status === "awaiting_session") return "run";
  if (status === "interrupted") return "warn";
  return "";
}
