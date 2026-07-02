import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "./styles.css";
import {
  buildLaunchSessions,
  defaultLaunchSlots,
  getLaunchProfile,
  launchProfiles,
  type LaunchOverride,
  type LaunchProfile,
  type LaunchSlot,
} from "../shared/launchProfiles.js";
import { buildHarnessFlowProbe, markerStatus } from "../shared/e2eFlow.js";
import { terminalReadinessStatus } from "../shared/terminalReadiness.js";
import type { JobRecord, LedgerEvent, MissionRecord, SessionRecord, TaskRecord } from "../shared/types.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app");

interface DirListing {
  path: string;
  parent?: string;
  dirs: Array<{ name: string; path: string }>;
}

interface State {
  sessions: SessionRecord[];
  missions: MissionRecord[];
  activeMission?: MissionRecord;
  tasks: TaskRecord[];
  ledger: LedgerEvent[];
  jobs: JobRecord[];
  expandedJobId?: string;
  collapsedProjects: Set<string>;
  picker?: DirListing;
  e2eChecks: E2ECheck[];
  launchOverrides: Record<string, LaunchOverride>;
  busy: boolean;
  error?: string;
}

type E2ECheckStatus = "idle" | "running" | "pass" | "fail" | "blocked" | "untested";

interface E2ECheck {
  label: string;
  status: E2ECheckStatus;
  evidence: string;
}

interface ReadinessResponse {
  results: Array<{
    profileId: string;
    label: string;
    status: "ready" | "blocked" | "untested";
    evidence: string;
    durationMs?: number;
    expectedMarker?: string;
  }>;
}

interface TerminalBinding {
  term: Terminal;
  socket: WebSocket;
  resizeObserver: ResizeObserver;
  resizeTimer?: number;
}

type TabId = "launch" | "probe" | "tasks" | "ledger";

const state: State = {
  sessions: [],
  missions: [],
  tasks: [],
  ledger: [],
  jobs: [],
  collapsedProjects: new Set(),
  e2eChecks: [],
  launchOverrides: {},
  busy: false,
};

type ViewId = "agent" | "terminals" | "report";
let activeView: ViewId = "agent";

interface HarnessReport {
  generatedAt: string;
  totals: {
    jobs: number;
    succeeded: number;
    failed: number;
    active: number;
    escalated: number;
    totalTokens: number;
    costUsd: number;
    avgMinutes: number;
  };
  routes: Array<{
    route: string;
    jobs: number;
    succeeded: number;
    escalated: number;
    avgMinutes: number;
    totalTokens: number;
    costUsd: number;
  }>;
  projects: Array<{ path: string; name: string; jobs: number; succeeded: number; totalTokens: number; costUsd: number }>;
  jobs: Array<{
    id: string;
    goal: string;
    route?: string;
    status: string;
    attempts: number;
    escalated: boolean;
    minutes: number;
    totalTokens: number;
    costUsd?: number;
  }>;
}

let report: HarnessReport | undefined;

const terminals = new Map<string, TerminalBinding>();
const panes = new Map<string, HTMLElement>();
// Populated from the server's default workspace (its cwd) on first load.
let DEFAULT_WORKSPACE = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.json() as Promise<T>;
}

async function refresh(): Promise<void> {
  try {
    state.sessions = await api<SessionRecord[]>("/api/sessions");
    state.missions = await api<MissionRecord[]>("/api/missions");
    state.jobs = await api<JobRecord[]>("/api/jobs");
    state.activeMission = selectActiveMission();

    if (state.activeMission) {
      const missionId = state.activeMission.id;
      state.tasks = await api<TaskRecord[]>(`/api/missions/${encodeURIComponent(missionId)}/tasks`);
      state.ledger = await api<LedgerEvent[]>(`/api/missions/${encodeURIComponent(missionId)}/ledger`);
    } else {
      state.tasks = [];
      state.ledger = [];
    }

    state.error = undefined;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }

  updateAll();
}

function selectActiveMission(): MissionRecord | undefined {
  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]));
  const hasLiveSessions = (mission: MissionRecord) => {
    const coordinator = sessionsById.get(mission.coordinatorSessionId);
    if (!coordinator || coordinator.role !== "coordinator" || coordinator.status !== "active") return false;
    return mission.sidekickSessionIds.every((sessionId) => {
      const sidekick = sessionsById.get(sessionId);
      return sidekick?.role === "sidekick" && sidekick.status === "active";
    });
  };

  if (state.activeMission) {
    const match = state.missions.find((mission) => mission.id === state.activeMission?.id);
    if (match && hasLiveSessions(match)) return match;
  }
  return state.missions.filter(hasLiveSessions).at(-1);
}

/* ── Shell: rendered once, updated in place ─────────────────────── */

function renderShell(): void {
  root!.innerHTML = `
    <div class="deck">
      <aside class="sidebar">
        <section class="brand">
          <div class="brand-mark" aria-hidden="true">${icon("terminal")}</div>
          <div>
            <h1>LLM Fusion</h1>
            <span class="cap">Local agent harness</span>
          </div>
        </section>

        <nav class="side-nav" aria-label="Views">
          <button class="side-item" data-view="agent" aria-selected="true">${icon("home")}<span>Home</span></button>
          <button class="side-item" data-view="terminals" aria-selected="false">${icon("terminal")}<span>Terminals</span><span class="count" id="count-sessions"></span></button>
          <button class="side-item" data-view="report" aria-selected="false">${icon("chart")}<span>Report</span></button>
        </nav>

        <div class="side-section">
          <span>Projects</span>
          <span id="jobs-count">0</span>
        </div>
        <div class="side-jobs" id="sidebar-jobs"></div>

        <footer class="side-foot">
          <span class="cap">local only · 127.0.0.1:4174</span>
        </footer>
        <div class="side-resizer" id="side-resizer" title="Drag to resize"></div>
      </aside>

      <div class="main-col">
      <div class="error-strip" id="error-strip" hidden>
        <span class="cap">Fault</span>
        <p id="error-text"></p>
        <button class="btn-icon" id="error-dismiss" type="button" title="Dismiss">${icon("close")}</button>
      </div>

      <section class="view" id="view-agent">
        <div class="agent-scroll">
          <div class="composer-wrap">
            <div class="composer-mark" aria-hidden="true">${icon("terminal")}</div>
            <div class="composer">
              <textarea id="job-goal" rows="3" placeholder="Describe a task, set the goal, and the harness decides the rest…"></textarea>
              <div class="composer-bar">
                <select id="job-route" class="chip-select" aria-label="Routing">
                  <option value="auto" selected>Auto</option>
                  <option value="cheap">Cheap</option>
                  <option value="frontier">Frontier</option>
                  <option value="fusion">Fusion</option>
                </select>
                <span class="spacer"></span>
                <button class="composer-send" id="job-start" type="button" title="Start task">${icon("arrow-up")}</button>
              </div>
            </div>
            <div class="composer-chips">
              <label class="chip" title="Workspace folder">
                ${icon("folder")}
                <input id="job-workspace" value="${escapeHtml(DEFAULT_WORKSPACE)}" placeholder="/path/to/repo" />
                <button class="chip-btn" id="browse-workspace" type="button" title="Browse folders">${icon("chevron")}</button>
              </label>
              <label class="chip" title="Verify command (optional)">
                ${icon("check")}
                <input id="job-verify" placeholder="verify command, e.g. npm test" />
              </label>
            </div>
            <div class="folder-picker" id="folder-picker" hidden></div>
          </div>

          <div class="radar">
            <div class="rail-head jobs-head">
              <strong>On your radar</strong>
              <span class="cap" id="jobs-recent">0 tasks</span>
            </div>
            <div id="job-list"></div>
          </div>
        </div>
      </section>

      <section class="view" id="view-report" hidden>
        <div class="agent-scroll">
          <div class="report-head">
            <div>
              <h2>Harness report</h2>
              <p class="hero-sub" id="report-caption">Aggregates every task: routes, escalations, durations, and real token cost harvested from the CLI transcripts.</p>
            </div>
            <div class="report-actions">
              <button class="btn btn-primary" id="report-generate" type="button">${icon("chart")}<span>Generate report</span></button>
              <button class="btn btn-secondary" id="report-download" type="button" hidden>${icon("arrow-up")}<span>Download .md</span></button>
            </div>
          </div>
          <div id="report-body"></div>
        </div>
      </section>

      <section class="view" id="view-terminals" hidden>
      <header class="commandbar">
        <label class="field">
          <span class="cap">Workspace</span>
          <input id="workspace" value="${escapeHtml(DEFAULT_WORKSPACE)}" placeholder="/path/to/repo" />
        </label>

        <label class="field">
          <span class="cap">Mission</span>
          <input id="mission-title" placeholder="Ship the next slice" />
        </label>

        <label class="field prompt-field">
          <span class="cap">Prompt</span>
          <input id="mission-prompt" placeholder="Describe the mission objective" />
        </label>

        <label class="field">
          <span class="cap">Routing</span>
          <select id="routing-mode">
            <option value="manual" selected>Manual</option>
            <option value="suggested">Suggested</option>
            <option value="auto-lite">Auto-lite</option>
          </select>
        </label>

        <button class="btn btn-secondary" id="create-defaults" type="button">${icon("grid")}<span>Launch Trio</span></button>
        <button class="btn btn-primary" id="start-mission" type="button">${icon("play")}<span>Start Mission</span></button>
      </header>

      <div class="deck-body">
        <section class="terminal-grid" id="terminal-grid" aria-label="Terminals"></section>

        <aside class="rail">
          <nav class="rail-tabs" role="tablist" aria-label="Panels">
            <button class="rail-tab" role="tab" data-tab="launch" aria-selected="true">Launch</button>
            <button class="rail-tab" role="tab" data-tab="probe" aria-selected="false">Probe<span class="count" id="count-probe"></span></button>
            <button class="rail-tab" role="tab" data-tab="tasks" aria-selected="false">Tasks<span class="count" id="count-tasks"></span></button>
            <button class="rail-tab" role="tab" data-tab="ledger" aria-selected="false">Ledger<span class="count" id="count-ledger"></span></button>
          </nav>

          <section class="rail-panel" data-panel="launch" role="tabpanel">
            <div class="rail-head">
              <strong>LLM Launcher</strong>
              <span class="cap">local pty</span>
            </div>
            <div id="launch-slots"></div>
            <button class="btn btn-secondary" id="side-create-defaults" type="button">${icon("grid")}<span>Launch Trio</span></button>
          </section>

          <section class="rail-panel" data-panel="probe" role="tabpanel" hidden>
            <div class="rail-head">
              <strong>E2E Probe</strong>
              <span class="cap" id="probe-caption">not run</span>
            </div>
            <div class="probe-actions">
              <button class="btn btn-secondary" id="run-readiness" type="button">${icon("check")}<span>Check Profiles</span></button>
              <button class="btn btn-secondary" id="run-harness-flow" type="button">${icon("beaker")}<span>Run Flow</span></button>
            </div>
            <div id="probe-list"></div>
          </section>

          <section class="rail-panel" data-panel="tasks" role="tabpanel" hidden>
            <div class="rail-head">
              <strong>New Task</strong>
              <span class="cap" id="task-scope">no mission</span>
            </div>
            <div class="task-form">
              <input id="task-title" placeholder="Task title" />
              <textarea id="task-instructions" placeholder="Instructions for a sidekick terminal"></textarea>
              <select id="task-session" aria-label="Assign to sidekick"></select>
              <button class="btn btn-primary" id="create-task" type="button">${icon("plus")}<span>Add Task</span></button>
            </div>
            <div class="rail-head">
              <strong>Task Queue</strong>
              <span class="cap" id="task-count">0 total</span>
            </div>
            <div id="task-list"></div>
          </section>

          <section class="rail-panel" data-panel="ledger" role="tabpanel" hidden>
            <div class="rail-head">
              <strong>Routing Ledger</strong>
              <span class="cap" id="ledger-count">0 events</span>
            </div>
            <div id="ledger-list"></div>
          </section>
        </aside>
      </div>
      </section>

      <footer class="statusbar">
        <span class="seg">Sessions <b id="stat-sessions">0</b></span>
        <span class="seg">Coordinator <b id="stat-coordinator">missing</b></span>
        <span class="seg">Sidekicks <b id="stat-sidekicks">0</b></span>
        <span class="seg">Tasks <b id="stat-tasks">0</b></span>
        <span class="seg">Ledger <b id="stat-ledger">0</b></span>
        <span class="seg" id="stat-busy" hidden>Working…</span>
        <span class="spacer"></span>
        <button class="btn-icon" id="refresh" type="button" title="Refresh">${icon("refresh")}</button>
      </footer>
      </div>
    </div>
  `;

  bindShellControls();
  renderLauncherSlots();
}

function bindShellControls(): void {
  bindClick("#create-defaults", createDefaultSessions);
  bindClick("#side-create-defaults", createDefaultSessions);
  bindClick("#run-readiness", runReadinessProbe);
  bindClick("#run-harness-flow", runHarnessFlowProbe);
  bindClick("#start-mission", startMission);
  bindClick("#create-task", createTask);
  bindClick("#refresh", refresh);
  bindClick("#job-start", createJob);
  bindClick("#report-generate", generateReport);
  document.querySelector("#report-download")?.addEventListener("click", downloadReportMarkdown);

  document.querySelectorAll<HTMLButtonElement>(".side-item").forEach((tab) => {
    tab.addEventListener("click", () => selectView(tab.dataset.view as ViewId));
  });

  document.querySelector("#sidebar-jobs")?.addEventListener("click", (event) => {
    const project = (event.target as HTMLElement).closest<HTMLElement>("[data-project]");
    if (project?.dataset.project) {
      const path = project.dataset.project;
      if (state.collapsedProjects.has(path)) state.collapsedProjects.delete(path);
      else state.collapsedProjects.add(path);
      updateJobs();
      return;
    }
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-job-open]");
    if (!item?.dataset.jobOpen) return;
    state.expandedJobId = item.dataset.jobOpen;
    selectView("agent");
    updateJobs();
    document.querySelector(`.job-row[data-job-id="${item.dataset.jobOpen}"]`)?.scrollIntoView({ block: "nearest" });
  });

  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const savedWidth = Number(localStorage.getItem("fusion.sidebarWidth"));
  if (sidebar && savedWidth >= 210 && savedWidth <= 560) sidebar.style.width = `${savedWidth}px`;

  document.querySelector<HTMLElement>("#side-resizer")?.addEventListener("pointerdown", (down) => {
    if (!sidebar) return;
    down.preventDefault();
    const resizer = down.currentTarget as HTMLElement;
    resizer.setPointerCapture(down.pointerId);
    document.body.classList.add("resizing");

    const onMove = (move: PointerEvent) => {
      const width = Math.min(560, Math.max(210, move.clientX - sidebar.getBoundingClientRect().left));
      sidebar.style.width = `${width}px`;
    };
    const onUp = () => {
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      localStorage.setItem("fusion.sidebarWidth", String(Math.round(sidebar.getBoundingClientRect().width)));
      window.dispatchEvent(new Event("resize"));
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });

  document.querySelector("#browse-workspace")?.addEventListener("click", (event) => {
    event.preventDefault();
    const picker = document.querySelector<HTMLElement>("#folder-picker");
    if (picker && !picker.hidden) {
      picker.hidden = true;
      return;
    }
    void openPicker(value("#job-workspace") || undefined);
  });

  document.querySelector("#folder-picker")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-picker-nav]");
    if (nav?.dataset.pickerNav) {
      void openPicker(nav.dataset.pickerNav);
      return;
    }
    if (target.closest("#picker-select") && state.picker) {
      const input = document.querySelector<HTMLInputElement>("#job-workspace");
      if (input) input.value = state.picker.path;
      const picker = document.querySelector<HTMLElement>("#folder-picker");
      if (picker) picker.hidden = true;
    }
    if (target.closest("#picker-close")) {
      const picker = document.querySelector<HTMLElement>("#folder-picker");
      if (picker) picker.hidden = true;
    }
  });

  document.querySelector("#job-list")?.addEventListener("click", (event) => {
    const jump = (event.target as HTMLElement).closest<HTMLElement>("[data-session-jump]");
    if (jump?.dataset.sessionJump) {
      selectView("terminals");
      document
        .querySelector(`[data-session-id="${jump.dataset.sessionJump}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-job-id]");
    if (!row?.dataset.jobId) return;
    state.expandedJobId = state.expandedJobId === row.dataset.jobId ? undefined : row.dataset.jobId;
    updateJobs();
  });

  document.querySelector("#error-dismiss")?.addEventListener("click", () => {
    state.error = undefined;
    updateError();
  });

  document.querySelectorAll<HTMLButtonElement>(".rail-tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab as TabId));
  });

  // Delegated: pane stop buttons + empty-state launch (grid content changes)
  document.querySelector("#terminal-grid")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const stop = target.closest<HTMLButtonElement>("[data-stop-session]");
    if (stop?.dataset.stopSession) {
      const sessionId = stop.dataset.stopSession;
      void runBusy(() => api(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", body: "{}" }));
      return;
    }
    if (target.closest("#empty-create-defaults")) {
      void runBusy(createDefaultSessions);
    }
  });

  // Delegated: task send buttons (list re-renders)
  document.querySelector("#task-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-send-task]");
    if (!button?.dataset.sendTask) return;
    const taskId = button.dataset.sendTask;
    void runBusy(() => api(`/api/tasks/${encodeURIComponent(taskId)}/send`, { method: "POST", body: "{}" }));
  });
}

function selectView(view: ViewId): void {
  activeView = view;
  document.querySelectorAll<HTMLButtonElement>(".side-item").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  });
  document.querySelectorAll<HTMLElement>(".view").forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });
  // xterm needs a re-fit after the terminals view becomes visible again.
  if (view === "terminals") window.dispatchEvent(new Event("resize"));
}

function selectTab(tab: TabId): void {
  document.querySelectorAll<HTMLButtonElement>(".rail-tab").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  });
  document.querySelectorAll<HTMLElement>(".rail-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

function renderLauncherSlots(): void {
  const host = document.querySelector<HTMLDivElement>("#launch-slots");
  if (!host) return;

  host.innerHTML = defaultLaunchSlots.map(renderLaunchSlot).join("");

  host.querySelectorAll<HTMLSelectElement>("[data-launch-profile]").forEach((select) => {
    select.addEventListener("change", () => {
      const slotId = select.dataset.launchProfile;
      if (!slotId) return;
      const profile = getLaunchProfile(select.value);
      state.launchOverrides[slotId] = {
        ...state.launchOverrides[slotId],
        profileId: profile.id,
        label: profile.label,
        command: profile.command,
      };
      const commandInput = host.querySelector<HTMLInputElement>(`[data-launch-command="${slotId}"]`);
      if (commandInput) commandInput.value = profile.command;
    });
  });

  host.querySelectorAll<HTMLInputElement>("[data-launch-command]").forEach((input) => {
    input.addEventListener("input", () => {
      const slotId = input.dataset.launchCommand;
      if (!slotId) return;
      state.launchOverrides[slotId] = {
        ...state.launchOverrides[slotId],
        command: input.value,
      };
    });
  });
}

function renderLaunchSlot(slot: LaunchSlot): string {
  const override = state.launchOverrides[slot.id];
  const profile = getLaunchProfile(override?.profileId ?? slot.defaultProfileId);
  const command = override?.command ?? profile.command;
  return `
    <article class="launch-slot">
      <header>
        <strong>${escapeHtml(slot.label)}</strong>
        <span class="cap">${escapeHtml(slot.role)}</span>
      </header>
      <select data-launch-profile="${slot.id}" aria-label="${escapeHtml(slot.label)} profile">
        ${launchProfiles.map((item) => option(item.id, item.label, profile.id)).join("")}
      </select>
      <input data-launch-command="${slot.id}" value="${escapeHtml(command)}" aria-label="${escapeHtml(slot.label)} command" />
    </article>
  `;
}

/* ── Targeted updates ───────────────────────────────────────────── */

function updateAll(): void {
  updateTerminals();
  updateTasks();
  updateLedger();
  updateProbe();
  updateJobs();
  updateStatusBar();
  updateError();
  updateMissionFields();
}

function jobLamp(status: JobRecord["status"]): string {
  if (status === "succeeded") return "pass";
  if (status === "failed") return "fail";
  return "running";
}

function updateJobs(): void {
  setText("#jobs-count", String(state.jobs.length));
  setText("#jobs-recent", `${state.jobs.length} task${state.jobs.length === 1 ? "" : "s"}`);
  setText("#count-sessions", state.sessions.length ? String(state.sessions.length) : "");

  const sidebar = document.querySelector<HTMLDivElement>("#sidebar-jobs");
  if (sidebar) {
    const projects = new Map<string, JobRecord[]>();
    for (const job of state.jobs.slice().reverse()) {
      const list = projects.get(job.workspacePath) ?? [];
      list.push(job);
      projects.set(job.workspacePath, list);
    }

    sidebar.innerHTML = [...projects.entries()]
      .map(([path, jobs]) => {
        const collapsed = state.collapsedProjects.has(path);
        const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
        return `
          <button class="side-project ${collapsed ? "collapsed" : ""}" data-project="${escapeHtml(path)}" type="button" title="${escapeHtml(path)}">
            <span class="chev">${icon("chevron")}</span>
            ${icon("folder")}
            <span class="side-job-title">${escapeHtml(name)}</span>
            <span class="count">${jobs.length}</span>
          </button>
          ${
            collapsed
              ? ""
              : jobs
                  .map(
                    (job) => `
                      <button class="side-job ${state.expandedJobId === job.id ? "selected" : ""}" data-job-open="${job.id}" type="button" title="${escapeHtml(job.goal.slice(0, 300))}">
                        <span class="dot ${jobLamp(job.status)}"></span>
                        <span class="side-job-title">${escapeHtml(job.goal.slice(0, 120))}</span>
                      </button>`,
                  )
                  .join("")
          }`;
      })
      .join("");
  }

  const list = document.querySelector<HTMLDivElement>("#job-list");
  if (!list) return;
  list.innerHTML = state.jobs.length
    ? state.jobs.slice().reverse().map(renderJob).join("")
    : `<p class="muted">No tasks yet. Describe a goal above and the harness takes it from there.</p>`;
}

function renderJob(job: JobRecord): string {
  const expanded = state.expandedJobId === job.id;
  const started = new Date(job.createdAt);
  const minutes = Math.max(0, Math.round((Date.parse(job.updatedAt) - Date.parse(job.createdAt)) / 6000) / 10);
  return `
    <article class="job-row ${expanded ? "expanded" : ""}" data-job-id="${job.id}">
      <header>
        <span class="lamp ${jobLamp(job.status)}">${escapeHtml(job.status)}</span>
        <h3>${escapeHtml(job.goal.slice(0, 120))}${job.goal.length > 120 ? "…" : ""}</h3>
        ${job.route ? `<span class="count route-badge">${escapeHtml(job.route)}</span>` : ""}
        <span class="cap">${escapeHtml(started.toLocaleTimeString([], { hour12: false }))} · ${minutes}m</span>
      </header>
      ${
        expanded
          ? `<div class="job-detail">
              ${job.routeReason ? `<p class="cap">Routing: ${escapeHtml(job.routeReason)}</p>` : ""}
              <div class="job-attempts">
                ${job.attempts
                  .map(
                    (attempt) => `
                      <div class="job-attempt">
                        <span class="lamp ${attempt.status === "succeeded" ? "pass" : attempt.status === "running" ? "running" : "fail"}">${escapeHtml(attempt.status)}</span>
                        <div>
                          <strong>${escapeHtml(attempt.label)}</strong>
                          ${attempt.sessionId ? `<button class="btn-icon session-jump" data-session-jump="${attempt.sessionId}" type="button" title="Open terminal">${icon("terminal")}</button>` : ""}
                          ${attempt.summary ? `<p>${escapeHtml(attempt.summary)}</p>` : ""}
                        </div>
                      </div>`,
                  )
                  .join("")}
              </div>
              ${job.resultSummary ? `<p class="task-result">↳ ${escapeHtml(job.resultSummary)}</p>` : ""}
              <p class="cap">${escapeHtml(job.workspacePath)}${job.verifyCommand ? ` · verify: ${escapeHtml(job.verifyCommand)}` : " · unverified"}</p>
            </div>`
          : ""
      }
    </article>
  `;
}

async function generateReport(): Promise<void> {
  setText("#report-caption", "Generating… harvesting transcripts and pricing tokens.");
  report = await api<HarnessReport>("/api/report");
  renderReport();
}

function money(value?: number): string {
  return value === undefined ? "—" : `$${value.toFixed(2)}`;
}

function renderReport(): void {
  const body = document.querySelector<HTMLDivElement>("#report-body");
  if (!body || !report) return;

  setText("#report-caption", `Generated ${new Date(report.generatedAt).toLocaleString()} · ${report.totals.jobs} tasks`);
  const download = document.querySelector<HTMLButtonElement>("#report-download");
  if (download) download.hidden = false;

  const maxCost = Math.max(...report.routes.map((row) => row.costUsd), 0.0001);
  const t = report.totals;

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="cap">Tasks</span><strong>${t.jobs}</strong></div>
      <div class="stat"><span class="cap">Succeeded</span><strong class="ok-text">${t.succeeded}</strong></div>
      <div class="stat"><span class="cap">Failed</span><strong class="${t.failed ? "bad-text" : ""}">${t.failed}</strong></div>
      <div class="stat"><span class="cap">Escalated</span><strong>${t.escalated}</strong></div>
      <div class="stat"><span class="cap">Avg duration</span><strong>${t.avgMinutes}m</strong></div>
      <div class="stat"><span class="cap">Tokens</span><strong>${t.totalTokens.toLocaleString()}</strong></div>
      <div class="stat"><span class="cap">Cost (OpenRouter eq.)</span><strong>${money(t.costUsd)}</strong></div>
    </div>

    <div class="report-section">
      <div class="rail-head"><strong>By route</strong></div>
      <table class="report-table">
        <thead><tr><th>Route</th><th>Tasks</th><th>Success</th><th>Escalated</th><th>Avg min</th><th>Tokens</th><th>Cost</th><th class="bar-col"></th></tr></thead>
        <tbody>
          ${report.routes
            .map(
              (row) => `
                <tr>
                  <td><span class="count route-badge">${escapeHtml(row.route)}</span></td>
                  <td>${row.jobs}</td>
                  <td>${row.jobs ? Math.round((row.succeeded / row.jobs) * 100) : 0}%</td>
                  <td>${row.escalated}</td>
                  <td>${row.avgMinutes}</td>
                  <td>${row.totalTokens.toLocaleString()}</td>
                  <td>${money(row.costUsd)}</td>
                  <td class="bar-col"><div class="cost-bar" style="width:${Math.round((row.costUsd / maxCost) * 100)}%"></div></td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="rail-head"><strong>By project</strong></div>
      <table class="report-table">
        <thead><tr><th>Project</th><th>Tasks</th><th>Succeeded</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          ${report.projects
            .map(
              (row) => `
                <tr>
                  <td title="${escapeHtml(row.path)}">${escapeHtml(row.name)}</td>
                  <td>${row.jobs}</td><td>${row.succeeded}</td>
                  <td>${row.totalTokens.toLocaleString()}</td><td>${money(row.costUsd)}</td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="rail-head"><strong>Tasks</strong></div>
      <table class="report-table">
        <thead><tr><th>Goal</th><th>Route</th><th>Status</th><th>Attempts</th><th>Min</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          ${report.jobs
            .map(
              (row) => `
                <tr>
                  <td class="goal-cell" title="${escapeHtml(row.goal.slice(0, 300))}">${escapeHtml(row.goal.slice(0, 70))}${row.goal.length > 70 ? "…" : ""}</td>
                  <td>${escapeHtml(row.route ?? "—")}</td>
                  <td><span class="lamp ${row.status === "succeeded" ? "pass" : row.status === "failed" ? "fail" : "running"}">${escapeHtml(row.status)}</span></td>
                  <td>${row.attempts}${row.escalated ? " ⬆" : ""}</td>
                  <td>${row.minutes}</td>
                  <td>${row.totalTokens.toLocaleString()}</td>
                  <td>${money(row.costUsd)}</td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function downloadReportMarkdown(): void {
  if (!report) return;
  const t = report.totals;
  const lines = [
    `# LLM Fusion harness report`,
    ``,
    `Generated ${report.generatedAt}`,
    ``,
    `Tasks: ${t.jobs} · Succeeded: ${t.succeeded} · Failed: ${t.failed} · Escalated: ${t.escalated} · Avg ${t.avgMinutes}m · Tokens: ${t.totalTokens.toLocaleString()} · Cost: ${money(t.costUsd)}`,
    ``,
    `## By route`,
    ``,
    `| Route | Tasks | Success | Escalated | Avg min | Tokens | Cost |`,
    `|---|---|---|---|---|---|---|`,
    ...report.routes.map(
      (row) =>
        `| ${row.route} | ${row.jobs} | ${row.jobs ? Math.round((row.succeeded / row.jobs) * 100) : 0}% | ${row.escalated} | ${row.avgMinutes} | ${row.totalTokens} | ${money(row.costUsd)} |`,
    ),
    ``,
    `## By project`,
    ``,
    `| Project | Tasks | Succeeded | Tokens | Cost |`,
    `|---|---|---|---|---|`,
    ...report.projects.map(
      (row) => `| ${row.name} | ${row.jobs} | ${row.succeeded} | ${row.totalTokens} | ${money(row.costUsd)} |`,
    ),
    ``,
    `## Tasks`,
    ``,
    `| Goal | Route | Status | Attempts | Min | Tokens | Cost |`,
    `|---|---|---|---|---|---|---|`,
    ...report.jobs.map(
      (row) =>
        `| ${row.goal.slice(0, 80).replaceAll("|", "\\|")} | ${row.route ?? ""} | ${row.status} | ${row.attempts}${row.escalated ? " (escalated)" : ""} | ${row.minutes} | ${row.totalTokens} | ${money(row.costUsd)} |`,
    ),
    ``,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fusion-report-${report.generatedAt.slice(0, 10)}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function openPicker(path?: string): Promise<void> {
  try {
    state.picker = await api<DirListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  } catch {
    // Bad path typed into the input: fall back to the home directory.
    state.picker = await api<DirListing>("/api/fs/dirs");
  }

  const picker = document.querySelector<HTMLElement>("#folder-picker");
  if (!picker || !state.picker) return;
  picker.hidden = false;
  picker.innerHTML = `
    <header>
      <code>${escapeHtml(state.picker.path)}</code>
      <button class="btn btn-primary picker-use" id="picker-select" type="button">Use this folder</button>
      <button class="btn-icon" id="picker-close" type="button" title="Close">${icon("close")}</button>
    </header>
    <div class="picker-list">
      ${state.picker.parent ? `<button class="picker-dir" data-picker-nav="${escapeHtml(state.picker.parent)}" type="button">${icon("folder")}<span>..</span></button>` : ""}
      ${state.picker.dirs
        .map(
          (dir) =>
            `<button class="picker-dir" data-picker-nav="${escapeHtml(dir.path)}" type="button">${icon("folder")}<span>${escapeHtml(dir.name)}</span></button>`,
        )
        .join("")}
      ${state.picker.dirs.length ? "" : `<p class="muted">No subfolders.</p>`}
    </div>
  `;
}

async function createJob(): Promise<void> {
  const goal = value("#job-goal");
  if (!goal) throw new Error("Describe a goal first.");
  const workspacePath = value("#job-workspace") || DEFAULT_WORKSPACE;
  const verifyCommand = value("#job-verify") || undefined;
  const routeChoice = value("#job-route");
  const route = routeChoice === "auto" ? undefined : routeChoice;

  await api<JobRecord>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ goal, workspacePath, verifyCommand, route }),
  });

  const goalInput = document.querySelector<HTMLTextAreaElement>("#job-goal");
  if (goalInput) goalInput.value = "";
}

function updateTerminals(): void {
  const grid = document.querySelector<HTMLElement>("#terminal-grid");
  if (!grid) return;

  const liveIds = new Set(state.sessions.map((session) => session.id));
  for (const [id, binding] of terminals) {
    if (liveIds.has(id)) continue;
    disposeBinding(binding);
    terminals.delete(id);
    panes.get(id)?.remove();
    panes.delete(id);
  }

  const emptyState = grid.querySelector(".empty-state");
  if (!state.sessions.length) {
    if (!emptyState) {
      grid.innerHTML = `
        <article class="empty-state">
          <span class="cap">${icon("terminal")}</span>
          <h2>No active terminals</h2>
          <p>Launch a coordinator and two sidekick LLM CLIs to bring the fusion deck online, or configure profiles in the Launch panel first.</p>
          <button class="btn btn-primary" id="empty-create-defaults" type="button">${icon("grid")}<span>Launch Trio</span></button>
        </article>
      `;
    }
    return;
  }
  emptyState?.remove();

  state.sessions.forEach((session, index) => {
    const existing = panes.get(session.id);
    if (existing) {
      updatePane(existing, session);
      return;
    }

    const pane = document.createElement("article");
    pane.className = `terminal-pane role-${session.role}`;
    pane.dataset.sessionId = session.id;
    pane.innerHTML = `
      <header class="pane-header">
        <span class="pane-index">#${index + 1}</span>
        <div class="pane-id">
          <strong>${escapeHtml(session.label)}</strong>
          <code>${escapeHtml(session.command)}</code>
        </div>
        <div class="pane-actions">
          <span class="lamp ${session.status}" data-lamp>${escapeHtml(session.status)}</span>
          <button class="btn-icon" data-stop-session="${session.id}" type="button" title="Stop session">${icon("stop")}</button>
        </div>
      </header>
      <div class="pane-body" id="terminal-${cssId(session.id)}"></div>
      <footer class="pane-telemetry">
        <span class="cap">${escapeHtml(session.role)} · ${escapeHtml(session.cwd)}</span>
        <span class="cap" data-chars>${session.bufferTail.length.toLocaleString()} chars</span>
      </footer>
    `;
    grid.appendChild(pane);
    panes.set(session.id, pane);
    attachTerminal(session);
  });
}

function updatePane(pane: HTMLElement, session: SessionRecord): void {
  const lamp = pane.querySelector<HTMLElement>("[data-lamp]");
  if (lamp && !lamp.classList.contains(session.status)) {
    lamp.className = `lamp ${session.status}`;
    lamp.textContent = session.status;
  }
  const chars = pane.querySelector<HTMLElement>("[data-chars]");
  if (chars) chars.textContent = `${session.bufferTail.length.toLocaleString()} chars`;
  const stop = pane.querySelector<HTMLButtonElement>("[data-stop-session]");
  if (stop) stop.disabled = session.status !== "active";
}

function updateTasks(): void {
  const sidekicks = state.sessions.filter((session) => session.role === "sidekick" && session.status === "active");

  const select = document.querySelector<HTMLSelectElement>("#task-session");
  if (select) {
    const previous = select.value;
    select.innerHTML = sidekicks
      .map((session) => `<option value="${session.id}">${escapeHtml(session.label)}</option>`)
      .join("");
    if (previous && sidekicks.some((session) => session.id === previous)) select.value = previous;
  }

  setText("#task-scope", state.activeMission ? "mission scoped" : "no mission");
  setText("#task-count", `${state.tasks.length} total`);
  setText("#count-tasks", state.tasks.length ? String(state.tasks.length) : "");

  const list = document.querySelector<HTMLDivElement>("#task-list");
  if (!list) return;
  list.innerHTML = state.tasks.length
    ? state.tasks.map(renderTask).join("")
    : `<p class="muted">No tasks routed yet. Tasks you add here are sent as scoped prompts to a sidekick terminal.</p>`;
}

function taskLamp(status: TaskRecord["status"]): string {
  if (status === "sent" || status === "working") return "running";
  if (status === "done" || status === "reviewed") return "pass";
  if (status === "blocked") return "fail";
  if (status === "cancelled") return "idle";
  return "idle";
}

function renderTask(task: TaskRecord): string {
  const assigned = state.sessions.find((session) => session.id === task.assignedSessionId);
  const sendable = task.status === "todo" && Boolean(task.assignedSessionId);
  return `
    <article class="task-row">
      <header>
        <h3>${escapeHtml(task.title)}</h3>
        <span class="lamp ${taskLamp(task.status)}">${escapeHtml(task.status)}</span>
      </header>
      <p>${escapeHtml(task.instructions)}</p>
      ${task.resultSummary ? `<p class="task-result">↳ ${escapeHtml(task.resultSummary)}</p>` : ""}
      <div class="task-meta">
        <span class="cap">${task.createdBy === "coordinator" ? "⚙ delegated · " : ""}${escapeHtml(assigned?.label ?? task.assignedSessionId ?? "unassigned")}</span>
        <button class="btn btn-secondary task-send" data-send-task="${task.id}" type="button" ${sendable ? "" : "disabled"}>
          ${icon("play")}<span>Send</span>
        </button>
      </div>
    </article>
  `;
}

function updateLedger(): void {
  setText("#ledger-count", `${state.ledger.length} events`);
  setText("#count-ledger", state.ledger.length ? String(state.ledger.length) : "");

  const list = document.querySelector<HTMLDivElement>("#ledger-list");
  if (!list) return;
  list.innerHTML = state.ledger.length
    ? state.ledger.slice().reverse().map(renderLedgerEvent).join("")
    : `<p class="muted">Mission routing events will appear here, newest first.</p>`;
}

function renderLedgerEvent(event: LedgerEvent): string {
  return `
    <article class="ledger-row">
      <time>${escapeHtml(new Date(event.ts).toLocaleTimeString([], { hour12: false }))}</time>
      <div>
        <strong>${escapeHtml(event.type)}</strong>
        <p>${escapeHtml(event.summary)}</p>
      </div>
    </article>
  `;
}

function updateProbe(): void {
  setText("#probe-caption", state.e2eChecks.length ? `${state.e2eChecks.length} checks` : "not run");
  const running = state.e2eChecks.filter((check) => check.status === "running").length;
  const failed = state.e2eChecks.filter((check) => check.status === "fail" || check.status === "blocked").length;
  setText("#count-probe", running ? `${running}…` : failed ? String(failed) : "");

  const list = document.querySelector<HTMLDivElement>("#probe-list");
  if (!list) return;
  list.innerHTML = state.e2eChecks.length
    ? state.e2eChecks.map(renderE2ECheck).join("")
    : `<p class="muted">Check Profiles runs non-interactive CLI probes. Run Flow launches the trio and waits for output markers end to end.</p>`;
}

function renderE2ECheck(check: E2ECheck): string {
  return `
    <article class="probe-row">
      <span class="lamp ${check.status}">${escapeHtml(check.status)}</span>
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <p>${escapeHtml(check.evidence)}</p>
      </div>
    </article>
  `;
}

function updateStatusBar(): void {
  const coordinator = state.sessions.find(
    (session) => session.role === "coordinator" && session.status === "active",
  );
  const sidekicks = state.sessions.filter(
    (session) => session.role === "sidekick" && session.status === "active",
  );

  setText("#stat-sessions", String(state.sessions.length));
  setText("#stat-sidekicks", String(sidekicks.length));
  setText("#stat-tasks", String(state.tasks.length));
  setText("#stat-ledger", String(state.ledger.length));

  const coordStat = document.querySelector<HTMLElement>("#stat-coordinator");
  if (coordStat) {
    coordStat.textContent = coordinator ? "ready" : "missing";
    coordStat.className = coordinator ? "ok" : "bad";
  }

  const busy = document.querySelector<HTMLElement>("#stat-busy");
  if (busy) busy.hidden = !state.busy;
}

function updateError(): void {
  const strip = document.querySelector<HTMLElement>("#error-strip");
  const text = document.querySelector<HTMLElement>("#error-text");
  if (!strip || !text) return;
  strip.hidden = !state.error;
  text.textContent = state.error ?? "";
}

function updateMissionFields(): void {
  const workspace = document.querySelector<HTMLInputElement>("#workspace");
  if (workspace && !workspace.value.trim() && state.activeMission) {
    workspace.value = state.activeMission.workspacePath;
  }
  const title = document.querySelector<HTMLInputElement>("#mission-title");
  if (title && !title.value.trim() && state.activeMission && document.activeElement !== title) {
    title.value = state.activeMission.title;
  }
}

function setText(selector: string, text: string): void {
  const node = document.querySelector<HTMLElement>(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

/* ── Probes ─────────────────────────────────────────────────────── */

async function runReadinessProbe(): Promise<void> {
  const workspacePath = value("#workspace") || DEFAULT_WORKSPACE;
  const profileIds = defaultLaunchSlots.map((slot) => value(`[data-launch-profile="${slot.id}"]`) || slot.defaultProfileId);
  selectTab("probe");
  setE2EChecks(
    profileIds.map((profileId) => ({
      label: getLaunchProfile(profileId).label,
      status: "running",
      evidence: "Running non-interactive CLI readiness probe.",
    })),
  );

  const response = await api<ReadinessResponse>("/api/e2e/readiness", {
    method: "POST",
    body: JSON.stringify({ workspacePath, profileIds }),
  });

  setE2EChecks(
    response.results.map((result) => ({
      label: result.label,
      status: result.status === "ready" ? "pass" : result.status,
      evidence: `${result.expectedMarker ?? "probe"} | ${result.evidence}`.slice(0, 360),
    })),
  );
}

async function runHarnessFlowProbe(): Promise<void> {
  const cwd = value("#workspace") || DEFAULT_WORKSPACE;
  const flow = buildHarnessFlowProbe({ workspacePath: cwd });
  const selectedProfiles = collectSelectedLaunchProfiles();
  const launchRequests = buildLaunchSessions({ cwd, overrides: collectLaunchOverrides() });
  selectTab("probe");
  setE2EChecks([
    { label: "Launch sessions", status: "running", evidence: "Creating coordinator and sidekick PTYs." },
    { label: "Terminal readiness", status: "idle", evidence: "Waiting for active PTYs." },
    { label: "Mission routing", status: "idle", evidence: "Waiting for terminal prompts." },
    { label: "Coordinator marker", status: "idle", evidence: flow.coordinatorMarker },
    ...flow.sidekickTasks.map((task, index) => ({
      label: `Sidekick ${index + 1} marker`,
      status: "idle" as const,
      evidence: task.marker,
    })),
  ]);

  const sessions = await api<SessionRecord[]>("/api/sessions/batch", {
    method: "POST",
    body: JSON.stringify({ sessions: launchRequests }),
  });
  await refresh();
  const failedSessions = sessions.filter((session) => session.status !== "active");
  if (failedSessions.length) {
    setE2ECheck(
      "Launch sessions",
      "fail",
      failedSessions.map((session) => `${session.label}: ${session.bufferTail || session.status}`).join(" | "),
    );
    return;
  }

  const coordinator = sessions.find((session) => session.role === "coordinator" && session.status === "active");
  const sidekicks = sessions.filter((session) => session.role === "sidekick" && session.status === "active");
  if (!coordinator || !sidekicks.length) {
    setE2ECheck("Launch sessions", "fail", "Missing active coordinator or sidekick sessions.");
    return;
  }

  setE2ECheck("Launch sessions", "pass", `${sessions.length} sessions created.`);
  setE2ECheck("Terminal readiness", "running", "Waiting for interactive CLI prompts.");
  const readinessResult = await waitForTerminalReadiness(sessions, selectedProfiles, 150_000);
  setE2ECheck("Terminal readiness", readinessResult.status, readinessResult.evidence);
  if (!readinessResult.ok) return;

  setE2ECheck("Mission routing", "running", "Creating mission and sending sidekick task.");

  let mission: MissionRecord;
  const routedTasks: TaskRecord[] = [];
  try {
    mission = await api<MissionRecord>("/api/missions", {
      method: "POST",
      body: JSON.stringify({
        title: flow.missionTitle,
        workspacePath: cwd,
        routingMode: "manual",
        coordinatorSessionId: coordinator.id,
        sidekickSessionIds: sidekicks.map((session) => session.id),
      }),
    });
    await api<MissionRecord>(`/api/missions/${encodeURIComponent(mission.id)}/start`, {
      method: "POST",
      body: JSON.stringify({ prompt: flow.missionPrompt }),
    });
    for (const [index, sidekick] of sidekicks.entries()) {
      const sidekickTask = flow.sidekickTasks[index] ?? flow.sidekickTasks.at(-1);
      if (!sidekickTask) throw new Error("Missing sidekick probe task.");

      const task = await api<TaskRecord>(`/api/missions/${encodeURIComponent(mission.id)}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: sidekickTask.title,
          instructions: sidekickTask.instructions,
          assignedSessionId: sidekick.id,
        }),
      });
      await api(`/api/tasks/${encodeURIComponent(task.id)}/send`, { method: "POST", body: "{}" });
      routedTasks.push(task);
    }
  } catch (error) {
    setE2ECheck("Mission routing", "fail", error instanceof Error ? error.message : String(error));
    throw error;
  }

  setE2ECheck("Mission routing", "pass", `Mission ${mission.id} and ${routedTasks.length} sidekick tasks sent.`);

  setE2ECheck("Coordinator marker", "running", `Waiting for ${flow.coordinatorMarker}.`);
  const coordinatorResult = await waitForSessionMarker(coordinator.id, flow.coordinatorMarker, 120_000);
  setE2ECheck(
    "Coordinator marker",
    coordinatorResult.ok ? "pass" : "fail",
    coordinatorResult.evidence || `Timed out waiting for ${flow.coordinatorMarker}.`,
  );

  for (const [index, sidekick] of sidekicks.entries()) {
    const sidekickTask = flow.sidekickTasks[index] ?? flow.sidekickTasks.at(-1);
    if (!sidekickTask) continue;

    const label = `Sidekick ${index + 1} marker`;
    setE2ECheck(label, "running", `Waiting for ${sidekickTask.marker}.`);
    const sidekickResult = await waitForSessionMarker(sidekick.id, sidekickTask.marker, 120_000);
    setE2ECheck(
      label,
      sidekickResult.ok ? "pass" : "fail",
      sidekickResult.evidence || `Timed out waiting for ${sidekickTask.marker}.`,
    );
  }
}

function setE2EChecks(checks: E2ECheck[]): void {
  state.e2eChecks = checks;
  updateProbe();
}

function setE2ECheck(label: string, status: E2ECheckStatus, evidence: string): void {
  state.e2eChecks = state.e2eChecks.map((check) => (check.label === label ? { label, status, evidence } : check));
  updateProbe();
}

async function waitForSessionMarker(
  sessionId: string,
  marker: string,
  timeoutMs: number,
): Promise<{ ok: boolean; evidence: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await api<{ buffer: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/buffer`);
    if (markerStatus(response.buffer, marker) === "pass") {
      return { ok: true, evidence: `Observed ${marker} in terminal buffer.` };
    }
    await delay(1_000);
  }

  const response = await api<{ buffer: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/buffer`);
  return { ok: false, evidence: response.buffer.slice(-240) };
}

async function waitForTerminalReadiness(
  sessions: SessionRecord[],
  profiles: LaunchProfile[],
  timeoutMs: number,
): Promise<{ ok: boolean; status: "pass" | "fail" | "blocked"; evidence: string }> {
  const deadline = Date.now() + timeoutMs;
  let readyStreak = 0;
  let latestEvidence = "No terminal output observed yet.";

  while (Date.now() < deadline) {
    const checks = [];

    for (const [index, session] of sessions.entries()) {
      const profile = profiles[index] ?? getProfileForSession(session);
      const response = await api<{ buffer: string }>(`/api/sessions/${encodeURIComponent(session.id)}/buffer`);
      const result = terminalReadinessStatus({ provider: profile.provider, buffer: response.buffer });
      checks.push({
        session,
        result,
        tail: compactTerminalTail(response.buffer),
      });
    }

    latestEvidence = checks
      .map(({ session, result, tail }) => `${session.label}: ${result.evidence}${tail ? ` Tail: ${tail}` : ""}`)
      .join(" | ")
      .slice(0, 480);

    const blocked = checks.find((check) => check.result.status === "blocked");
    if (blocked) {
      return { ok: false, status: "blocked", evidence: latestEvidence };
    }

    if (checks.every((check) => check.result.status === "ready")) {
      readyStreak += 1;
      if (readyStreak >= 2) {
        return {
          ok: true,
          status: "pass",
          evidence: `${sessions.length} terminals input-ready for two consecutive checks.`,
        };
      }
    } else {
      readyStreak = 0;
    }

    await delay(1_000);
  }

  return { ok: false, status: "fail", evidence: latestEvidence };
}

function compactTerminalTail(buffer: string): string {
  return buffer
    .slice(-180)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* ── Actions ────────────────────────────────────────────────────── */

function bindClick(selector: string, handler: () => Promise<void>): void {
  document.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", () => {
    void runBusy(handler);
  });
}

async function runBusy(action: () => Promise<unknown>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  updateStatusBar();
  try {
    await action();
    await refresh();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    updateError();
  } finally {
    state.busy = false;
    updateStatusBar();
  }
}

async function createDefaultSessions(): Promise<void> {
  const cwd = value("#workspace") || DEFAULT_WORKSPACE;
  await api<SessionRecord[]>("/api/sessions/batch", {
    method: "POST",
    body: JSON.stringify({
      sessions: buildLaunchSessions({ cwd, overrides: collectLaunchOverrides() }),
    }),
  });
}

function collectLaunchOverrides(): Record<string, LaunchOverride> {
  const overrides: Record<string, LaunchOverride> = {};

  for (const slot of defaultLaunchSlots) {
    const stored = state.launchOverrides[slot.id];
    const profileId = value(`[data-launch-profile="${slot.id}"]`) || stored?.profileId || slot.defaultProfileId;
    const profile = getLaunchProfile(profileId);
    overrides[slot.id] = {
      profileId,
      label: stored?.label || profile.label,
      command: value(`[data-launch-command="${slot.id}"]`) || stored?.command || profile.command,
    };
  }

  return overrides;
}

function collectSelectedLaunchProfiles(): LaunchProfile[] {
  return defaultLaunchSlots.map((slot) => {
    const stored = state.launchOverrides[slot.id];
    return getLaunchProfile(value(`[data-launch-profile="${slot.id}"]`) || stored?.profileId || slot.defaultProfileId);
  });
}

function getProfileForSession(session: SessionRecord): LaunchProfile {
  return launchProfiles.find((profile) => session.command === profile.command || session.label === profile.label) ?? launchProfiles.at(-1)!;
}

async function startMission(): Promise<void> {
  let mission = state.activeMission;
  const coordinator = state.sessions.find((session) => session.role === "coordinator" && session.status === "active");
  const sidekickIds = state.sessions
    .filter((session) => session.role === "sidekick" && session.status === "active")
    .map((session) => session.id);

  if (!coordinator) throw new Error("Create an active coordinator session first.");

  if (!mission) {
    mission = await api<MissionRecord>("/api/missions", {
      method: "POST",
      body: JSON.stringify({
        title: value("#mission-title") || "Fusion mission",
        workspacePath: value("#workspace") || coordinator.cwd,
        routingMode: value("#routing-mode") || "manual",
        coordinatorSessionId: coordinator.id,
        sidekickSessionIds: sidekickIds,
      }),
    });
    state.activeMission = mission;
  }

  await api<MissionRecord>(`/api/missions/${encodeURIComponent(mission.id)}/start`, {
    method: "POST",
    body: JSON.stringify({ prompt: value("#mission-prompt") || mission.title }),
  });
}

async function createTask(): Promise<void> {
  if (!state.activeMission) await startMission();
  if (!state.activeMission) throw new Error("Mission was not created.");

  const assignedSessionId = value("#task-session");
  if (!assignedSessionId) throw new Error("Create an active sidekick before adding a task.");

  await api<TaskRecord>(`/api/missions/${encodeURIComponent(state.activeMission.id)}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      title: value("#task-title") || "Untitled task",
      instructions: value("#task-instructions") || "Report current status and blockers.",
      assignedSessionId,
    }),
  });
}

/* ── Terminals ──────────────────────────────────────────────────── */

function attachTerminal(session: SessionRecord): void {
  const container = document.querySelector<HTMLDivElement>(`#terminal-${cssId(session.id)}`);
  if (!container) return;

  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: "Cascadia Mono, SF Mono, Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.35,
    theme: {
      background: "#010409",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      cursorAccent: "#010409",
      selectionBackground: "#1f3350",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  const binding: TerminalBinding = {
    term,
    socket: new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/sessions?id=${encodeURIComponent(session.id)}`,
    ),
    resizeObserver: new ResizeObserver(() => {
      if (binding.resizeTimer) window.clearTimeout(binding.resizeTimer);
      binding.resizeTimer = window.setTimeout(() => {
        binding.resizeTimer = undefined;
        syncTerminalSize(session, term, fit);
      }, 120);
    }),
  };
  syncTerminalSize(session, term, fit);
  binding.resizeObserver.observe(container);

  binding.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; buffer?: string; chunk?: string; error?: string };
    if (message.type === "replay") term.write(message.buffer ?? "");
    if (message.type === "data") term.write(message.chunk ?? "");
    if (message.type === "error") term.writeln(`\r\n[llm-fusion] ${message.error ?? "terminal error"}`);
  });
  binding.socket.addEventListener("close", () => {
    term.writeln("\r\n[llm-fusion] disconnected");
  });
  term.onData((data) => {
    if (binding.socket.readyState === WebSocket.OPEN) binding.socket.send(data);
  });

  terminals.set(session.id, binding);
}

function disposeBinding(binding: TerminalBinding): void {
  if (binding.resizeTimer) window.clearTimeout(binding.resizeTimer);
  binding.resizeObserver.disconnect();
  binding.socket.close();
  binding.term.dispose();
}

function destroyTerminals(): void {
  for (const binding of terminals.values()) disposeBinding(binding);
  terminals.clear();
  panes.clear();
}

function syncTerminalSize(session: SessionRecord, term: Terminal, fit: FitAddon): void {
  fit.fit();
  if (session.status !== "active") return;

  void api(`/api/sessions/${encodeURIComponent(session.id)}/resize`, {
    method: "POST",
    body: JSON.stringify({ cols: term.cols, rows: term.rows }),
  }).catch((error) => {
    term.writeln(`\r\n[llm-fusion] resize failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/* ── Helpers ────────────────────────────────────────────────────── */

function option(value: string, label: string, selected = "manual"): string {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function value(selector: string): string {
  return document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)?.value.trim() ?? "";
}

function cssId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function icon(name: "terminal" | "grid" | "play" | "refresh" | "stop" | "plus" | "check" | "beaker" | "close" | "home" | "arrow-up" | "folder" | "chevron" | "chart"): string {
  const icons = {
    terminal:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 5 5-5 5"/><path d="M12 19h7"/></svg>',
    grid:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 12a9 9 0 0 1 15.3-6.4"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    beaker:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2v7.5L5.5 18A3 3 0 0 0 8.2 22h7.6a3 3 0 0 0 2.7-4L14 9.5V2"/><path d="M8 2h8"/><path d="M7 16h10"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 9v11h14V9"/></svg>',
    "arrow-up": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>',
  };
  return icons[name];
}

window.addEventListener("beforeunload", destroyTerminals);

async function boot(): Promise<void> {
  try {
    const config = await api<{ defaultWorkspace: string }>("/api/config");
    DEFAULT_WORKSPACE = config.defaultWorkspace ?? "";
  } catch {
    DEFAULT_WORKSPACE = "";
  }
  renderShell();
  await refresh();
}

void boot();

// Auto-routed tasks and reports change server state without UI actions.
window.setInterval(() => {
  if (!state.busy && !document.hidden) void refresh();
}, 5_000);
