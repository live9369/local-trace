import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CaseStore, rebuildIndexFor } from "../core/cases.js";
import { buildSummary, buildTimeline } from "../core/aggregate.js";
import { bindSessionToRun } from "../core/bind.js";
import { compareCases } from "../core/compare-cases.js";
import { exportCase, importCase } from "../core/export-import.js";
import { openIndex } from "../core/index-db.js";
import { loadConfig, saveConfig, initProject } from "../core/project.js";
import { readJson } from "../core/fsutil.js";
import type { TraceConfig } from "../core/types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function isLocalHostHeader(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h.startsWith("127.0.0.1") ||
    h.startsWith("localhost") ||
    h.startsWith("[::1]")
  );
}

/** Allow loopback only; tolerate missing / opaque ("null") Origin from browsers. */
function isLocalOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!isLocalHostHeader(host)) return false;

  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function webRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "web"),
    join(here, "../web"),
    join(here, "../../dashboard/dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

export function createTraceServer(projectRoot: string) {
  initProject(projectRoot);
  const store = () => new CaseStore(projectRoot);

  const server = createServer(async (req, res) => {
    try {
      if (!isLocalOrigin(req)) {
        sendJson(res, 403, { error: "仅允许本机访问" });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/api/")) {
        await handleApi(req, res, method, path, url, projectRoot, store);
        return;
      }

      serveStatic(res, path);
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return server;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
  projectRoot: string,
  store: () => CaseStore,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD" && !isLocalOrigin(req)) {
    sendJson(res, 403, { error: "禁止跨域修改" });
    return;
  }

  if (path === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true, projectRoot });
    return;
  }

  if (path === "/api/config" && method === "GET") {
    sendJson(res, 200, loadConfig(projectRoot));
    return;
  }

  if (path === "/api/config" && method === "PUT") {
    const body = JSON.parse(await readBody(req)) as Partial<TraceConfig>;
    const cfg = loadConfig(projectRoot)!;
    const next = {
      ...cfg,
      captureDetail: body.captureDetail ?? cfg.captureDetail,
      retentionDays:
        body.retentionDays !== undefined ? body.retentionDays : cfg.retentionDays,
      serverPort: body.serverPort ?? cfg.serverPort,
    };
    saveConfig(projectRoot, next);
    sendJson(res, 200, next);
    return;
  }

  if (path === "/api/cases" && method === "GET") {
    const s = store();
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const includeArchived = url.searchParams.get("archived") === "1";
    const idx = openIndex(projectRoot);
    try {
      const cases = s.listCases(includeArchived).filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      );
      sendJson(
        res,
        200,
        cases.map((c) => ({
          ...c,
          stats: idx.caseStats(c.caseId),
        })),
      );
    } finally {
      idx.close();
    }
    return;
  }

  if (path === "/api/cases" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as {
      name: string;
      description?: string;
      tags?: string[];
      prompt?: string;
      acceptanceCriteria?: string;
    };
    const s = store();
    const c = s.createCase({
      name: body.name,
      description: body.description,
      tags: body.tags,
    });
    if (body.prompt != null) {
      s.createVersion({
        caseId: c.caseId,
        prompt: body.prompt,
        acceptanceCriteria: body.acceptanceCriteria,
      });
    }
    sendJson(res, 201, c);
    return;
  }

  const caseMatch = path.match(/^\/api\/cases\/([^/]+)$/);
  if (caseMatch && method === "GET") {
    const id = decodeURIComponent(caseMatch[1]!);
    const s = store();
    const c = s.getCase(id);
    if (!c) {
      sendJson(res, 404, { error: "未找到" });
      return;
    }
    const versions = s.listVersions(id).map((v) => ({
      ...v,
      prompt: s.getPrompt(id, v.versionLabel),
    }));
    sendJson(res, 200, { case: c, versions });
    return;
  }

  if (caseMatch && method === "PATCH") {
    const id = decodeURIComponent(caseMatch[1]!);
    const body = JSON.parse(await readBody(req));
    sendJson(res, 200, store().updateCase(id, body));
    return;
  }

  if (caseMatch && method === "DELETE") {
    const id = decodeURIComponent(caseMatch[1]!);
    store().deleteCase(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  const versionsMatch = path.match(/^\/api\/cases\/([^/]+)\/versions$/);
  if (versionsMatch && method === "POST") {
    const caseId = decodeURIComponent(versionsMatch[1]!);
    const body = JSON.parse(await readBody(req)) as {
      prompt: string;
      acceptanceCriteria?: string;
      changeNote?: string;
      parentVersionId?: string;
    };
    sendJson(
      res,
      201,
      store().createVersion({ caseId, ...body }),
    );
    return;
  }

  const versionPatch = path.match(
    /^\/api\/cases\/([^/]+)\/versions\/([^/]+)$/,
  );
  if (versionPatch && method === "PATCH") {
    const caseId = decodeURIComponent(versionPatch[1]!);
    const vid = decodeURIComponent(versionPatch[2]!);
    const body = JSON.parse(await readBody(req));
    if (body.fork) {
      sendJson(
        res,
        201,
        store().forkVersion(caseId, vid, body.changeNote),
      );
      return;
    }
    sendJson(res, 200, store().updateDraftVersion(caseId, vid, body));
    return;
  }

  const runsList = path.match(/^\/api\/cases\/([^/]+)\/runs$/);
  if (runsList && method === "GET") {
    const caseId = decodeURIComponent(runsList[1]!);
    const versionId = url.searchParams.get("versionId") ?? undefined;
    const s = store();
    const runs = s.listRuns(caseId, versionId).map((r) => {
      const summary =
        readJson(join(s.runPath(r) ?? "", "summary.json")) ??
        null;
      return { ...r, summary };
    });
    sendJson(res, 200, runs);
    return;
  }

  const runDetail = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runDetail && method === "GET") {
    const runId = decodeURIComponent(runDetail[1]!);
    const s = store();
    const run = s.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "未找到" });
      return;
    }
    const idx = openIndex(projectRoot);
    try {
      const events = idx.listEvents(runId);
      const summary =
        readJson(join(s.runPath(run) ?? "", "summary.json")) ??
        buildSummary(runId, events, run.startedAt, run.endedAt);
      const timeline = buildTimeline(events);
      sendJson(res, 200, {
        run,
        summary,
        timeline,
        events,
        promptVerified: false,
        promptVerifiedNote: "未采集实际用户提示词，无法验证与版本 prompt 一致",
      });
    } finally {
      idx.close();
    }
    return;
  }

  if (runDetail && method === "PATCH") {
    const runId = decodeURIComponent(runDetail[1]!);
    const body = JSON.parse(await readBody(req));
    sendJson(res, 200, store().updateRunMeta(runId, body));
    return;
  }

  if (runDetail && method === "DELETE") {
    const runId = decodeURIComponent(runDetail[1]!);
    store().deleteRun(runId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path.match(/^\/api\/runs\/[^/]+\/bind$/) && method === "POST") {
    const runId = decodeURIComponent(path.split("/")[3]!);
    const body = JSON.parse(await readBody(req)) as { sessionId: string };
    sendJson(
      res,
      200,
      bindSessionToRun(projectRoot, body.sessionId, runId),
    );
    return;
  }

  if (path.match(/^\/api\/runs\/[^/]+\/end$/) && method === "POST") {
    const runId = decodeURIComponent(path.split("/")[3]!);
    sendJson(
      res,
      200,
      store().updateRunMeta(runId, { status: "completed" }),
    );
    return;
  }

  if (path === "/api/compare" && method === "GET") {
    const caseIds = (url.searchParams.get("cases") ?? "").split(",");
    try {
      sendJson(res, 200, { columns: compareCases(projectRoot, caseIds) });
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (path === "/api/export" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as { caseId: string };
    sendJson(res, 200, exportCase(projectRoot, body.caseId));
    return;
  }

  if (path === "/api/import" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as {
      path: string;
      forceRename?: boolean;
    };
    sendJson(res, 200, importCase(projectRoot, body.path, body));
    return;
  }

  if (path === "/api/rebuild-index" && method === "POST") {
    rebuildIndexFor(projectRoot);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "未找到接口" });
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const root = webRoot();
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  // SPA fallback
  const candidate = resolve(join(root, normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "")));
  if (!candidate.startsWith(resolve(root))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html");
  }
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("看板未构建。请运行 npm run build");
    return;
  }
  const ext = extname(file);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  });
  res.end(readFileSync(file));
}
