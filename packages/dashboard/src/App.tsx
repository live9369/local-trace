import { useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtMs, fmtTokens, statusBadge } from "./api";

function stepRowClass(s: {
  kind?: string;
  status?: string | null;
  name?: string;
}): string {
  const status = String(s.status ?? "").toLowerCase();
  const name = String(s.name ?? "").toLowerCase();
  const failed =
    s.kind === "tool" &&
    (status.includes("error") ||
      status.includes("fail") ||
      status.includes("timeout") ||
      status.includes("denied") ||
      name.includes("failure"));
  if (failed) return "step-fail";
  if (s.kind === "turn_usage") return "step-turn";
  if (s.kind === "tool") return "step-tool";
  if (s.kind === "thought") return "step-thought";
  if (s.kind === "response") return "step-response";
  return "step-other";
}

const GANTT_KINDS = new Set(["tool", "thought", "response", "turn_usage"]);

/** Short label for timeline chips */
function shortStepLabel(s: {
  kind?: string;
  name?: string;
  status?: string | null;
  event?: any;
}): string {
  if (s.kind === "turn_usage") return "轮次结束";
  if (s.kind === "thought") return "思考";
  if (s.kind === "response") return "回复";
  if (s.kind === "session") return "会话";
  if (s.kind === "idle") {
    const n = String(s.name ?? "空闲");
    return n.length > 22 ? `${n.slice(0, 22)}…` : n;
  }
  const raw = String(s.name ?? "操作");
  const base = raw.split(":")[0] ?? raw;
  const map: Record<string, string> = {
    Read: "读文件",
    Write: "写文件",
    StrReplace: "改文件",
    Delete: "删除",
    Grep: "搜索",
    Glob: "匹配路径",
    Shell: "Shell",
    Task: "子代理",
    AwaitShell: "等待",
    CallDynamicTool: "动态工具",
    GetDynamicTools: "列工具",
  };
  const detail = ganttLabelDetail(s);
  let short = map[base] ?? (base.length > 14 ? `${base.slice(0, 14)}…` : base);
  // Shell / MCP often stores the command body as name
  if (!map[base] && (raw.includes("\n") || raw.length > 28 || /^export |^cd |^npm |^curl /i.test(raw))) {
    const first = raw.split("\n").find((l) => l.trim())?.trim() ?? raw;
    short = `Shell·${first.slice(0, 16)}${first.length > 16 ? "…" : ""}`;
  } else if (detail) {
    short = `${short}·${detail}`;
  }
  const st = String(s.status ?? "").toLowerCase();
  if (st.includes("fail") || st.includes("error") || st.includes("timeout")) {
    return `${short}·失败`;
  }
  return short;
}

function ganttLabelDetail(s: { name?: string; event?: any }): string | null {
  const raw = s.event?.rawSummary ?? {};
  const path =
    raw.file_path ?? raw.path ?? raw.target_file ?? raw.glob ?? raw.pattern;
  if (path != null && String(path).trim()) {
    const p = String(path).replace(/\\/g, "/");
    const leaf = p.split("/").filter(Boolean).pop() ?? p;
    return leaf.length > 16 ? `${leaf.slice(0, 16)}…` : leaf;
  }
  const cmd = raw.command ?? raw.cmd;
  if (cmd != null && String(cmd).trim()) {
    const c = String(cmd).trim().split(/\s+/)[0] ?? "";
    return c ? (c.length > 14 ? `${c.slice(0, 14)}…` : c) : null;
  }
  return null;
}

function ganttBlockClass(s: any): string {
  if (s.kind === "idle" || s.synthetic) return "idle";
  const row = stepRowClass(s);
  if (row === "step-fail") return "fail";
  if (row === "step-thought") return "thought";
  if (row === "step-response") return "response";
  if (row === "step-turn") return "turn";
  if (row === "step-tool") return "tool";
  return "other";
}

function stepKindLabel(kind?: string): string {
  switch (kind) {
    case "tool":
      return "工具";
    case "turn_usage":
      return "轮次结束";
    case "thought":
      return "思考";
    case "response":
      return "回复";
    case "session":
      return "会话";
    case "idle":
      return "空闲";
    default:
      return kind ?? "其他";
  }
}

/** Infer what an uncovered wall-clock gap was likely doing. */
function idleGapLabel(prev: any | null, next: any | null): string {
  if (!prev && next) return "空闲·启动/等待首个操作";
  if (prev && !next) return "空闲·收尾/等待结束";
  const pk = prev?.kind;
  const nk = next?.kind;
  if (pk === "tool" && nk === "tool") return "空闲·工具间（多为模型推理）";
  if (pk === "tool" && nk === "thought") return "空闲·工具后进入思考";
  if (pk === "thought" && nk === "tool") return "空闲·思考后调用工具";
  if (pk === "thought" && nk === "response") return "空闲·思考后生成回复";
  if (nk === "response") return "空闲·生成回复前";
  if (pk === "response") return "空闲·回复后等待";
  if (pk === "turn_usage" || nk === "turn_usage") return "空闲·轮次间隙";
  if (pk === "thought" || nk === "thought") return "空闲·与思考相邻（未细分）";
  return "空闲·未观测区间（可能为推理/调度）";
}

/** Insert synthetic idle rows so [rangeStart, rangeEnd] is continuously covered. */
function fillGanttIdles(
  ops: any[],
  rangeStart: number,
  rangeEnd: number,
  minGapMs = 12,
): any[] {
  if (!(rangeEnd > rangeStart)) return ops;
  const sorted = [...ops].sort((a, b) => {
    const as = a.startMs ?? 0;
    const bs = b.startMs ?? 0;
    if (as !== bs) return as - bs;
    return String(a.id).localeCompare(String(b.id));
  });
  const out: any[] = [];
  let cursor = rangeStart;
  let prev: any | null = null;

  const pushIdle = (from: number, to: number, next: any | null) => {
    if (to - from < minGapMs) return;
    const startMs = from;
    const endMs = to;
    out.push({
      id: `idle_${Math.round(startMs)}_${Math.round(endMs)}`,
      kind: "idle",
      name: idleGapLabel(prev, next),
      status: null,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      usage: null,
      usageScope: null,
      usageIsTurnLevel: false,
      synthetic: true,
      idlePrevId: prev?.id ?? null,
      idleNextId: next?.id ?? null,
      event: null,
    });
  };

  for (const op of sorted) {
    const start = Math.max(op.startMs ?? 0, rangeStart);
    const end = Math.min(Math.max(op.endMs ?? start, start), rangeEnd);
    if (end <= rangeStart || start >= rangeEnd) continue;
    if (start > cursor) pushIdle(cursor, start, op);
    out.push(op);
    cursor = Math.max(cursor, end);
    prev = op;
  }
  if (rangeEnd > cursor) pushIdle(cursor, rangeEnd, null);
  return out;
}

function stepDetailLines(s: any): string[] {
  const ev = s?.event ?? {};
  const raw = ev.rawSummary ?? {};
  const lines: string[] = [];
  lines.push(`类型：${stepKindLabel(s.kind)}（${s.kind ?? "unknown"}）`);
  lines.push(`名称：${s.name ?? "—"}`);
  if (s.kind === "idle" || s.synthetic) {
    lines.push("说明：由相邻步骤墙钟间隙推断，平台未给出该时段细分类别");
    if (s.idlePrevId) lines.push(`前一步：${s.idlePrevId}`);
    if (s.idleNextId) lines.push(`后一步：${s.idleNextId}`);
  }
  if (s.durationMs != null) lines.push(`耗时：${s.durationMs} ms`);
  else lines.push("耗时：未提供");
  if (s.status) lines.push(`状态：${s.status}`);
  if (s.turnId) lines.push(`轮次：${s.turnId}`);
  if (ev.toolCallId) lines.push(`toolCallId：${ev.toolCallId}`);
  if (ev.model) lines.push(`模型：${ev.model}`);
  if (s.usageIsTurnLevel && s.usage) {
    lines.push(
      `轮次 token：in=${s.usage.inputTokens ?? "未提供"} out=${s.usage.outputTokens ?? "未提供"}`,
    );
  } else if (s.kind !== "idle") {
    lines.push("步骤 token：未提供（不均摊整轮用量）");
  }
  if (raw.tool_name) lines.push(`工具：${String(raw.tool_name)}`);
  if (raw.eventType || ev.eventType) {
    lines.push(`事件：${String(raw.hook_event_name ?? ev.eventType ?? "—")}`);
  }
  const stripped = raw._strippedKeys;
  if (Array.isArray(stripped) && stripped.length) {
    lines.push(`未采集字段：${stripped.join(", ")}（默认隐私）`);
  }
  return lines;
}

function useTheme() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("clt-theme") ?? "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem("clt-theme", theme);
  }, [theme]);
  return { theme, setTheme };
}

function Shell({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useTheme();
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">Cursor Local Trace</div>
        <nav className="nav">
          <Link to="/">案例</Link>
          <Link to="/settings">设置</Link>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            aria-label="主题"
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </nav>
      </header>
      {children}
    </div>
  );
}

const UNCATEGORIZED_CASE_ID = "case_uncategorized";

function CaseList() {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cases, setCases] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const nav = useNavigate();

  const load = () => {
    setErr(null);
    api
      .cases(q)
      .then(setCases)
      .catch((e) => setErr(String(e.message ?? e)));
  };

  useEffect(() => {
    load();
  }, [q]);

  const toggleCase = (caseId: string) => {
    setSelected((cur) => {
      if (cur.includes(caseId)) return cur.filter((id) => id !== caseId);
      if (cur.length >= 4) return cur;
      return [...cur, caseId];
    });
  };

  if (err) return <div className="error">加载失败：{err}</div>;
  if (!cases) return <div className="loading">加载中…</div>;

  return (
    <div className="stack">
      <div className="row">
        <h1>案例</h1>
        <input
          placeholder="搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="primary"
          disabled={selected.length < 2}
          onClick={() =>
            nav(`/compare?cases=${selected.map(encodeURIComponent).join(",")}`)
          }
        >
          A/B
        </button>
        <span className="muted">已选 {selected.length} / 4</span>
      </div>

      <div className="panel stack">
        <h2>新建案例</h2>
        <input
          placeholder="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          placeholder="首版提示词（可选）"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={async () => {
            const c = await api.createCase({
              name: name.trim(),
              prompt: prompt || undefined,
            });
            setName("");
            setPrompt("");
            nav(`/cases/${c.caseId}`);
          }}
        >
          创建
        </button>
      </div>

      {cases.length === 0 ? (
        <div className="empty">暂无案例。创建一个测试问题开始观测。</div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>名称</th>
                <th>版本</th>
                <th>运行</th>
                <th>最近</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const selectable = c.caseId !== UNCATEGORIZED_CASE_ID;
                const checked = selected.includes(c.caseId);
                return (
                <tr key={c.caseId}>
                  <td>
                    {selectable ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && selected.length >= 4}
                        aria-label={`选择 ${c.name}`}
                        onChange={() => toggleCase(c.caseId)}
                      />
                    ) : null}
                  </td>
                  <td>
                    <Link to={`/cases/${c.caseId}`}>{c.name}</Link>
                    {c.archived ? (
                      <span className="badge warn"> 已归档</span>
                    ) : null}
                  </td>
                  <td className="mono">{c.stats?.versionCount ?? 0}</td>
                  <td className="mono">{c.stats?.runCount ?? 0}</td>
                  <td className="muted mono">
                    {c.stats?.lastRunAt
                      ? new Date(c.stats.lastRunAt).toLocaleString("zh-CN")
                      : "—"}
                  </td>
                  <td>
                    {c.stats?.lastStatus ? (
                      <span className={`badge ${statusBadge(c.stats.lastStatus)}`}>
                        {c.stats.lastStatus}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CaseDetail() {
  const { caseId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [vid, setVid] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = async () => {
    const d = await api.caseDetail(caseId);
    setData(d);
    const versions = d.versions as any[];
    const current = vid || versions.at(-1)?.versionId || "";
    setVid(current);
    if (current) setRuns(await api.runs(caseId, current));
  };

  useEffect(() => {
    reload().catch((e) => setErr(String(e.message ?? e)));
  }, [caseId]);

  useEffect(() => {
    if (!vid) return;
    api.runs(caseId, vid).then(setRuns).catch(() => setRuns([]));
  }, [vid, caseId]);

  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="loading">加载中…</div>;

  const versions = data.versions as any[];
  const current = versions.find((v) => v.versionId === vid);

  return (
    <div className="stack">
      <div className="row">
        <Link to="/">← 案例列表</Link>
      </div>
      <h1>{data.case.name}</h1>
      <p className="muted">{data.case.description || "无说明"}</p>

      <div className="panel stack">
        <div className="row">
          <h2>版本</h2>
          <select value={vid} onChange={(e) => setVid(e.target.value)}>
            {versions.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.versionLabel} ({v.status})
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              if (!current) return;
              const v = await api.patchVersion(caseId, current.versionId, {
                fork: true,
                changeNote: "从旧版创建草稿",
              });
              await reload();
              setVid(v.versionId);
            }}
          >
            从当前版创建草稿
          </button>
          <button
            onClick={async () => {
              const prompt = window.prompt("新版本提示词");
              if (!prompt) return;
              const v = await api.createVersion(caseId, {
                prompt,
                changeNote: "新建版本",
                parentVersionId: current?.versionId,
              });
              await reload();
              setVid(v.versionId);
            }}
          >
            新建版本
          </button>
          <button
            onClick={async () => {
              const out = await api.exportCase(caseId);
              alert(`已导出到 ${out.path}`);
            }}
          >
            导出
          </button>
        </div>
        {current ? (
          <>
            <div className="muted">
              状态：{current.status} · 哈希 {current.contentHash}
              {current.changeNote ? ` · ${current.changeNote}` : ""}
            </div>
            <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
              {current.prompt || "（空）"}
            </pre>
            {current.acceptanceCriteria ? (
              <div>
                <strong>完成标准</strong>
                <div>{current.acceptanceCriteria}</div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty">尚无版本，请新建。</div>
        )}
      </div>

      <div className="panel">
        <h2>运行列表</h2>
        {runs.length === 0 ? (
          <div className="empty">当前版本尚无运行</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>运行</th>
                <th>模型</th>
                <th>状态</th>
                <th>token (input)</th>
                <th>耗时</th>
                <th>完整性</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    <Link to={`/cases/${caseId}/runs/${r.runId}`} className="mono">
                      {r.runId.slice(-8)}
                    </Link>
                  </td>
                  <td className="mono">{r.config?.model ?? "unknown"}</td>
                  <td>
                    <span className={`badge ${statusBadge(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="mono">
                    {fmtTokens(r.summary?.usage?.inputTokens)}
                  </td>
                  <td className="mono">{fmtMs(r.summary?.wallClockMs)}</td>
                  <td className="muted">
                    {r.summary?.usageSource === "missing"
                      ? "token 未提供"
                      : r.measurementCapabilities?.join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunDetail() {
  const { caseId = "", runId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortDur, setSortDur] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<any>(null);
  const ganttScrollRef = useRef<HTMLDivElement | null>(null);
  const [ganttViewportW, setGanttViewportW] = useState(0);

  const load = () =>
    api
      .runDetail(runId)
      .then(setData)
      .catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [runId]);

  useEffect(() => {
    const el = ganttScrollRef.current;
    if (!el) return;
    const measure = () => setGanttViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, runId]);

  // #region agent log
  useEffect(() => {
    const el = ganttScrollRef.current;
    if (!el || !data?.timeline) return;
    const id = requestAnimationFrame(() => {
      const cols = document.querySelector(".step-cols") as HTMLElement | null;
      const stepBars = document.querySelectorAll(".step-col-bar");
      const heights = Array.from(stepBars)
        .slice(0, 8)
        .map((n) => (n as HTMLElement).style.height);
      const firstCol = document.querySelector(".step-col") as HTMLElement | null;
      fetch("http://127.0.0.1:7874/ingest/5b5e007d-63d6-4ea4-b198-73245c5a3a9e", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "9b288c",
        },
        body: JSON.stringify({
          sessionId: "9b288c",
          runId: "post-fix",
          hypothesisId: "H-step-pack",
          location: "App.tsx:RunDetail",
          message: "step cols packed",
          data: {
            runId,
            stepBarCount: stepBars.length,
            sampleHeights: heights,
            gap: cols ? getComputedStyle(cols).gap : null,
            colWidth: firstCol ? firstCol.getBoundingClientRect().width : null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(id);
  }, [data, runId, ganttViewportW]);
  // #endregion

  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="loading">加载中…</div>;

  const { run, summary, timeline, promptVerifiedNote } = data;
  let steps = [...timeline] as any[];
  if (filter) {
    steps = steps.filter((s) =>
      String(s.name).toLowerCase().includes(filter.toLowerCase()) ||
      shortStepLabel(s).toLowerCase().includes(filter.toLowerCase()),
    );
  }
  if (sortDur) {
    steps = steps.sort(
      (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
    );
  }

  const toggleExpand = (s: any) => {
    setExpandedId((id) => (id === s.id ? null : s.id));
  };

  /** Gantt X range: prefer run wall window so late/unrelated events don't stretch the axis. */
  const ganttRange = (() => {
    const t0s = timeline
      .map((s: any) =>
        s.event?.receivedAt ? Date.parse(s.event.receivedAt) : NaN,
      )
      .filter(Number.isFinite) as number[];
    const t0 = t0s.length ? Math.min(...t0s) : NaN;
    const runStartAbs = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const runEndAbs = run.endedAt ? Date.parse(run.endedAt) : NaN;
    const toolsAll = timeline.filter((s: any) => s.kind === "tool");
    const rawMax = Math.max(
      1,
      ...timeline.map((s: any) => s.endMs ?? s.startMs ?? 0),
    );
    const rangeStart =
      Number.isFinite(t0) && Number.isFinite(runStartAbs)
        ? runStartAbs - t0
        : Math.min(0, ...toolsAll.map((s: any) => s.startMs ?? 0), 0);
    let rangeEnd =
      Number.isFinite(t0) && Number.isFinite(runEndAbs)
        ? runEndAbs - t0
        : rawMax;
    if (!(rangeEnd > rangeStart)) rangeEnd = rangeStart + Math.max(1, rawMax);
    return { rangeStart, rangeEnd, rawMax };
  })();

  return (
    <div className="stack">
      <div className="row">
        <Link to={`/cases/${caseId}`}>← 案例</Link>
        <span className={`badge ${statusBadge(run.status)}`}>{run.status}</span>
        {run.status === "running" || run.status === "awaiting_session" ? (
          <button onClick={() => api.endRun(runId).then(load)}>结束运行</button>
        ) : null}
        <select
          value={run.evaluation}
          onChange={(e) =>
            api.patchRun(runId, { evaluation: e.target.value }).then(load)
          }
        >
          <option value="unevaluated">未评估</option>
          <option value="pass">通过</option>
          <option value="fail">未通过</option>
        </select>
      </div>

      <h1>运行详情</h1>
      <p className="muted">{promptVerifiedNote}</p>

      <div className="grid-metrics">
        <div className="metric">
          <div className="label">墙钟耗时</div>
          <div className="value">{fmtMs(summary.wallClockMs)}</div>
        </div>
        <div className="metric">
          <div className="label">input tokens（轮次）</div>
          <div className="value">{fmtTokens(summary.usage?.inputTokens)}</div>
        </div>
        <div className="metric">
          <div className="label">output tokens（轮次）</div>
          <div className="value">{fmtTokens(summary.usage?.outputTokens)}</div>
        </div>
        <div className="metric">
          <div className="label">工具调用</div>
          <div className="value">{summary.toolCallCount}</div>
        </div>
        <div className="metric">
          <div className="label">失败</div>
          <div className="value">{summary.failureCount}</div>
        </div>
      </div>

      <div className="panel muted" style={{ fontSize: 12 }}>
        口径：token 为平台在 stop 上报的<strong>整轮</strong>值（父 Agent），不均摊到步骤；
        cache 字段与 input 存在包含关系，未直接相加。子 Agent token：未提供。
        {summary.parallelAwareNote}
      </div>

      <div className="panel">
        <div className="row">
          <h2>时间线</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            横轴=墙钟（可横滑），纵轴=顺序；空闲段已补全并标注可能用途
          </span>
          <input
            placeholder="筛选…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="row">
            <input
              type="checkbox"
              checked={sortDur}
              onChange={(e) => setSortDur(e.target.checked)}
            />
            步骤按耗时排序
          </label>
        </div>
        {(() => {
          // Y = execution order (top = first); X = wall time within run window
          const { rangeStart, rangeEnd, rawMax } = ganttRange;
          const pad = 2000;
          const allOps = steps
            .filter((s) => GANTT_KINDS.has(s.kind))
            .slice()
            .sort((a, b) => {
              const as = a.startMs ?? 0;
              const bs = b.startMs ?? 0;
              if (as !== bs) return as - bs;
              return String(a.id).localeCompare(String(b.id));
            });
          const observed = allOps.filter((s) => {
            const a = s.startMs ?? 0;
            const b = Math.max(s.endMs ?? a, a);
            return b >= rangeStart - pad && a <= rangeEnd + pad;
          });
          const ganttSteps = fillGanttIdles(observed, rangeStart, rangeEnd);
          const idleCount = ganttSteps.filter((s) => s.kind === "idle").length;

          const span = Math.max(1, rangeEnd - rangeStart);
          const vp = ganttViewportW > 0 ? ganttViewportW : 640;
          const minTrackW = Math.ceil(vp * 2.2);
          const pxPerMs = Math.min(3, Math.max(minTrackW / span, 0.12));
          const chartW = Math.min(16000, Math.max(minTrackW, Math.ceil(span * pxPerMs)));
          const rowH = 28;
          const chartH = ganttSteps.length * rowH + 4;
          const expanded = ganttSteps.find((s) => s.id === expandedId);
          const clipped = allOps.length - observed.length;

          if (ganttSteps.length === 0) {
            return <div className="empty">暂无时间线步骤（或仍在等待采集）</div>;
          }

          const xOf = (ms: number) => (ms - rangeStart) * pxPerMs;

          return (
            <div className="timeline-gantt">
              <div className="timeline-gantt-body">
                <div className="timeline-gantt-labels" style={{ height: chartH + 22 }}>
                  <div className="timeline-gantt-corner">顺序</div>
                  {ganttSteps.map((s, i) => (
                    <div key={s.id} className="timeline-gantt-label" style={{ height: rowH }}>
                      <span className="seq mono">#{i + 1}</span>
                      <span className="name" title={String(s.name ?? "")}>
                        {shortStepLabel(s)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="timeline-gantt-scroll" ref={ganttScrollRef}>
                  <div className="timeline-gantt-track" style={{ width: chartW }}>
                    <div className="timeline-axis" style={{ width: chartW }}>
                      <span>{fmtMs(Math.round(rangeStart))}</span>
                      <span>
                        {fmtMs(Math.round(rangeStart + span / 2))}
                      </span>
                      <span>{fmtMs(Math.round(rangeEnd))}</span>
                    </div>
                    <div className="timeline-chart" style={{ height: chartH, width: chartW }}>
                      {ganttSteps.map((s, i) => {
                        const start = s.startMs ?? 0;
                        const end = Math.max(s.endMs ?? start, start);
                        const left = Math.max(0, xOf(start));
                        const width = Math.max(8, xOf(end) - xOf(start));
                        const kindCls = ganttBlockClass(s);
                        const dur =
                          s.durationMs != null
                            ? `${Math.round(s.durationMs)}ms`
                            : end > start
                              ? `${Math.round(end - start)}ms`
                              : "—";
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={`timeline-h-block ${kindCls}${
                              expandedId === s.id ? " active" : ""
                            }`}
                            style={{
                              left,
                              width,
                              top: 4 + i * rowH,
                            }}
                            title={`#${i + 1} ${stepKindLabel(s.kind)} · ${shortStepLabel(s)} · ${dur}`}
                            onClick={() => toggleExpand(s)}
                          >
                            <span className="timeline-h-text">
                              <span className="timeline-h-name">
                                {shortStepLabel(s)}
                              </span>
                              <span className="timeline-h-dur">{dur}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                已补全 {idleCount} 段空闲（按相邻步骤推断用途）。
                {clipped > 0
                  ? ` 另有 ${clipped} 步在 run 窗口外（全量约 ${fmtMs(Math.round(rawMax))}）。`
                  : null}
              </div>
              {expanded ? (
                <div className="timeline-detail">
                  <div className="row">
                    <strong>
                      #{ganttSteps.findIndex((x) => x.id === expanded.id) + 1}{" "}
                      {shortStepLabel(expanded)}
                    </strong>
                    <span className="muted mono">
                      {expanded.durationMs != null
                        ? `${Math.round(expanded.durationMs)} ms`
                        : "耗时未提供"}
                    </span>
                  </div>
                  <ul>
                    {stepDetailLines(expanded).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <div className="row">
                    {expanded.kind !== "idle" ? (
                      <button type="button" onClick={() => setDrawer(expanded)}>
                        查看原始字段
                      </button>
                    ) : null}
                    <button type="button" onClick={() => setExpandedId(null)}>
                      收起
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })()}
      </div>

      <div className="panel">
        <div className="row">
          <h2>步骤（按轮次）</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            柱高≈耗时；颜色区分类型
          </span>
        </div>
        <div className="step-legend">
          <span className="lg-turn">轮次结束</span>
          <span className="lg-fail">失败</span>
          <span className="lg-tool">工具</span>
          <span className="lg-thought">思考</span>
          <span className="lg-response">回复</span>
        </div>
        {(() => {
          const durOf = (s: any) =>
            s.durationMs != null
              ? Math.max(0, s.durationMs)
              : Math.max(0, (s.endMs ?? 0) - (s.startMs ?? 0));
          const maxDur = Math.max(1, ...steps.map(durOf), 1);
          const BAR_MAX = 100;
          if (steps.length === 0) {
            return <div className="empty">暂无步骤</div>;
          }
          return (
            <div className="step-cols" role="list">
              {steps.map((s, i) => {
                const cls = stepRowClass(s);
                const open = expandedId === s.id;
                const dur = durOf(s);
                const h = Math.max(8, Math.round((dur / maxDur) * BAR_MAX));
                const kindCls = ganttBlockClass(s);
                return (
                  <div
                    key={s.id}
                    role="listitem"
                    className={`step-col ${cls}${open ? " open" : ""}`}
                  >
                    <button
                      type="button"
                      className="step-col-main"
                      title={`#${i + 1} ${stepKindLabel(s.kind)} · ${shortStepLabel(s)} · ${Math.round(dur)}ms`}
                      onClick={() => toggleExpand(s)}
                    >
                      <span className="step-col-dur mono">
                        {dur > 0 ? `${Math.round(dur)}ms` : "—"}
                      </span>
                      <span className="step-col-plot">
                        <span
                          className={`step-col-bar ${kindCls}`}
                          style={{ height: `${h}px` }}
                        />
                      </span>
                      <span className="step-col-label">{shortStepLabel(s)}</span>
                      <span className="step-col-kind">{stepKindLabel(s.kind)}</span>
                    </button>
                    {open ? (
                      <div className="step-col-detail">
                        <ul>
                          {stepDetailLines(s).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                        {s.kind !== "idle" ? (
                          <button type="button" onClick={() => setDrawer(s)}>
                            查看原始字段
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {drawer ? (
        <div className="drawer">
          <div className="row">
            <h2>原始字段</h2>
            <button onClick={() => setDrawer(null)}>关闭</button>
          </div>
          <p>
            {shortStepLabel(drawer)} · {drawer.name}
          </p>
          <p className="muted">
            参数/结果正文默认未采集。开启详细采集见设置。
          </p>
          <pre>{JSON.stringify(drawer.event, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function fmtSigned(n: number | null, text: string): string {
  if (n == null) return "不可比";
  if (n > 0) return `+${text}`;
  return text;
}

function fmtSignedMs(ms: number | null): string {
  if (ms == null) return "不可比";
  const body = fmtMs(Math.abs(ms));
  if (ms > 0) return `+${body}`;
  if (ms < 0) return `-${body}`;
  return body;
}

function ComparePage() {
  const [sp] = useSearchParams();
  const casesKey = sp.get("cases") ?? "";
  const [columns, setColumns] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ids = casesKey.split(",").map(decodeURIComponent).filter(Boolean);
    if (ids.length < 2 || ids.length > 4) {
      setErr("需要 2–4 个案例");
      setColumns(null);
      return;
    }
    setErr(null);
    setColumns(null);
    api
      .compareCases(ids)
      .then((d) => setColumns(d.columns))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [casesKey]);

  return (
    <div className="stack">
      <Link to="/">← 案例列表</Link>
      <h1>A/B 对比</h1>
      <p className="muted">
        每列是一个案例最近一次已完成的运行。没有完成记录时显示最近一条。差值相对第一列。
      </p>
      {err ? <div className="error">{err}</div> : null}
      {!columns && !err ? <div className="loading">加载中…</div> : null}
      {columns ? (
        <div
          className="compare-cols"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
          }}
        >
          {columns.map((col, i) => (
            <div className="panel stack" key={col.caseId}>
              <h2>
                <Link to={`/cases/${col.caseId}`}>{col.name}</Link>
              </h2>
              <div className="muted">
                {i === 0 ? "基准 · " : ""}
                {col.versionLabel ?? "无版本"}
                {col.picked === "latest" ? " · 尚无已完成运行" : ""}
                {col.picked === "none" ? " · 尚无运行" : ""}
              </div>
              <pre className="mono compare-prompt">
                {col.prompt || "（空）"}
              </pre>
              {col.run ? (
                <>
                  <div>
                    <Link to={`/cases/${col.caseId}/runs/${col.run.runId}`}>
                      {col.run.runId.slice(-8)}
                    </Link>{" "}
                    <span className={`badge ${statusBadge(col.run.status)}`}>
                      {col.run.status}
                    </span>
                  </div>
                  <div>墙钟 {fmtMs(col.summary?.wallClockMs)}</div>
                  <div>input {fmtTokens(col.summary?.usage?.inputTokens)}</div>
                  <div>工具 {col.summary?.toolCallCount ?? "—"}</div>
                  <div>失败 {col.summary?.failureCount ?? "—"}</div>
                  <div>评价 {col.run.evaluation}</div>
                  {col.deltas ? (
                    <div className="muted">
                      <div>
                        Δ input{" "}
                        {fmtSigned(
                          col.deltas.inputTokens,
                          fmtTokens(col.deltas.inputTokens),
                        )}
                      </div>
                      <div>
                        Δ 墙钟 {fmtSignedMs(col.deltas.wallClockMs)}
                      </div>
                      <div>
                        Δ 工具{" "}
                        {fmtSigned(
                          col.deltas.toolCallCount,
                          String(col.deltas.toolCallCount),
                        )}
                      </div>
                      <div>
                        Δ 失败{" "}
                        {fmtSigned(
                          col.deltas.failureCount,
                          String(col.deltas.failureCount),
                        )}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty">这个案例还没有运行。</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SettingsPage() {
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => {
    api.config().then(setCfg);
  }, []);
  if (!cfg) return <div className="loading">加载中…</div>;
  return (
    <div className="stack">
      <h1>设置</h1>
      <div className="panel stack">
        <label className="row">
          <input
            type="checkbox"
            checked={!!cfg.captureDetail}
            onChange={async (e) => {
              const next = await api.saveConfig({
                captureDetail: e.target.checked,
              });
              setCfg(next);
            }}
          />
          详细内容采集（显式开启才保存工具参数/输出等；默认关闭）
        </label>
        <div className="muted">
          项目根：<span className="mono">{cfg.projectRoot}</span>
        </div>
        <div className="muted">服务端口：{cfg.serverPort}</div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<CaseList />} />
        <Route path="/cases/:caseId" element={<CaseDetail />} />
        <Route path="/cases/:caseId/runs/:runId" element={<RunDetail />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
