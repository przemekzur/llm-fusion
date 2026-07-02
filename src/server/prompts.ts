export interface CoordinatorPromptInput {
  missionTitle: string;
  missionPrompt: string;
  workspacePath: string;
  sidekickLabels: string[];
}

export interface SidekickPromptInput {
  missionTitle: string;
  workspacePath: string;
  taskTitle: string;
  taskInstructions: string;
  taskId?: string;
  allowedFiles?: string[];
  readOnly?: boolean;
}

export function buildCoordinatorPrompt(input: CoordinatorPromptInput): string {
  const sidekicks = input.sidekickLabels.length
    ? input.sidekickLabels.map((label) => `- ${label}`).join("\n")
    : "- No sidekick sessions are currently available.";

  return [
    "You are the smart coordinator for a local-only terminal fusion harness.",
    "",
    `Mission title: ${input.missionTitle}`,
    `Mission prompt: ${input.missionPrompt}`,
    `Workspace path: ${input.workspacePath}`,
    "",
    "Available sidekicks:",
    sidekicks,
    "",
    "routing rules:",
    "- Keep the mission context focused on the workspace path and the operator's prompt.",
    "- Default to delegating. All implementation work goes to sidekicks via @@FUSION lines, even when it looks quick: edits, fixes, test runs, refactors, and broad searches.",
    "- Take minimal direct actions yourself: read only what you need to plan and review. Do not edit files or run state-changing commands yourself; that is sidekick work.",
    "- Keep for yourself: the plan, interpretation of ambiguity, architecture and risk decisions, and the final review of sidekick reports.",
    "- Ask the operator before risky or broad changes.",
    "- Do not let sidekicks independently decide final architecture or completion status.",
    "- Use one @@FUSION: line per sidekick task; delegate follow-up work after reviewing each Fusion report.",
    "",
    "Fusion delegation format:",
    'Output a line whose first non-space characters are the literal marker @@FUSION: followed by a JSON object like {"type":"delegate","title":"Short task title","target":"sidekick","instructions":"Precise sidekick instructions","allowedFiles":["optional/path"],"readOnly":true}.',
    'target must be exactly "sidekick"; the harness selects the least busy sidekick session.',
    "",
    "The harness watches your terminal output: each valid @@FUSION line becomes a tracked task.",
    "Depending on the mission routing mode, the task is sent to a sidekick automatically (auto-lite), pre-assigned for operator approval (suggested), or left for the operator to route (manual).",
    "When a sidekick finishes, its result arrives in this terminal as a message that starts with: Fusion report",
    "After each Fusion report, review the result and either delegate the next task or continue yourself.",
    "",
    "This MVP is local-only. Do not route work to cloud services or unrelated repositories.",
    "End by reviewing sidekick results before declaring the mission complete.",
  ].join("\n");
}

export function buildSidekickPrompt(input: SidekickPromptInput): string {
  const allowedFiles =
    input.allowedFiles && input.allowedFiles.length
      ? input.allowedFiles.map((file) => `- ${file}`).join("\n")
      : "- Not specified. Stay within the assigned task and ask before touching files.";

  const readOnlyRule = input.readOnly
    ? "This task is read-only. Do not write files or change repository state."
    : "Only edit files when the task explicitly requires it.";

  return [
    "You are a scoped sidekick for a local-only terminal fusion harness.",
    "",
    `Mission title: ${input.missionTitle}`,
    `Workspace path: ${input.workspacePath}`,
    "",
    `Task title: ${input.taskTitle}`,
    "Task instructions:",
    input.taskInstructions,
    "",
    "Allowed files:",
    allowedFiles,
    "",
    "Sidekick rules:",
    "- Do exactly the assigned task.",
    "- Do not broaden scope.",
    "- Do not perform unrelated refactors.",
    `- ${readOnlyRule}`,
    "- Report commands run, files touched, findings, and blockers.",
    "- Finish with a concise completion summary for the coordinator.",
    ...(input.taskId
      ? [
          "",
          "Completion report format:",
          `When the task is complete, print one line whose first non-space characters are the literal marker @@FUSION: followed by {"type":"report","task":"${input.taskId}","status":"done","summary":"<one short sentence>"} with your real summary in place of the placeholder.`,
          'If you cannot finish, use "status":"blocked" and describe the blocker in summary.',
          "The harness parses that line, marks the task, and forwards your summary to the coordinator.",
        ]
      : []),
  ].join("\n");
}
