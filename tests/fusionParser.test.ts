import { describe, expect, it } from "vitest";
import { parseFusionMessages, parseFusionOutput } from "../src/server/fusionParser.js";
import { buildCoordinatorPrompt, buildSidekickPrompt } from "../src/server/prompts.js";

describe("fusion parser", () => {
  it("extracts structured delegation messages from fusion lines", () => {
    const messages = parseFusionMessages(
      [
        "normal output",
        '  @@FUSION:{"type":"delegate","title":"Run unit tests","target":"sidekick","instructions":"Run npm test"}',
        "more normal output",
      ].join("\n"),
    );

    expect(messages).toEqual([
      {
        type: "delegate",
        title: "Run unit tests",
        target: "sidekick",
        instructions: "Run npm test",
      },
    ]);
  });

  it("defaults delegate targets to sidekick and preserves optional constraints", () => {
    const messages = parseFusionMessages(
      '@@FUSION:{"type":"delegate","title":"Inspect auth","instructions":"Read the auth flow.","allowedFiles":["src/auth.ts"],"readOnly":true}',
    );

    expect(messages).toEqual([
      {
        type: "delegate",
        title: "Inspect auth",
        target: "sidekick",
        instructions: "Read the auth flow.",
        allowedFiles: ["src/auth.ts"],
        readOnly: true,
      },
    ]);
  });

  it("ignores malformed and non-delegate fusion lines", () => {
    expect(
      parseFusionMessages(
        [
          'prefix @@FUSION:{"type":"delegate","title":"Echoed example","target":"sidekick","instructions":"Ignore me"}',
          "@@FUSION:{not-json",
          '@@FUSION:{"type":"note","title":"Not a delegate","instructions":"Ignore me"}',
          '@@FUSION:{"type":"delegate","title":"Missing instructions"}',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("reports warnings for malformed fusion lines", () => {
    const result = parseFusionOutput("@@FUSION:{not-json");

    expect(result.messages).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.line).toBe(1);
  });

  it("rejects ambiguous delegate targets", () => {
    const result = parseFusionOutput(
      '@@FUSION:{"type":"delegate","title":"Inspect","target":"Codex Sidekick","instructions":"Read tests."}',
    );

    expect(result.messages).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("prompts", () => {
  it("builds a coordinator prompt with mission context and routing rules", () => {
    const prompt = buildCoordinatorPrompt({
      missionTitle: "Ship search",
      missionPrompt: "Modernize search and verify behavior.",
      workspacePath: "C:\\repo",
      sidekickLabels: ["Codex Sidekick", "Gemini Sidekick"],
    });

    expect(prompt).toContain("smart coordinator");
    expect(prompt).toContain("@@FUSION");
    expect(prompt).toContain("Ship search");
    expect(prompt).toContain("Modernize search and verify behavior.");
    expect(prompt).toContain("C:\\repo");
    expect(prompt).toContain("Codex Sidekick");
    expect(prompt).toContain("Gemini Sidekick");
    expect(prompt).toContain("local-only");
    expect(prompt).toContain("routing rules");
    expect(parseFusionMessages(prompt)).toEqual([]);
  });

  it("builds a scoped sidekick prompt without broadening the assigned task", () => {
    const prompt = buildSidekickPrompt({
      missionTitle: "Ship search",
      workspacePath: "C:\\repo",
      taskTitle: "Run tests",
      taskInstructions: "Run npm test and summarize failures.",
      allowedFiles: ["tests/search.test.ts"],
    });

    expect(prompt).toContain("scoped sidekick");
    expect(prompt).toContain("Ship search");
    expect(prompt).toContain("C:\\repo");
    expect(prompt).toContain("Run tests");
    expect(prompt).toContain("Run npm test and summarize failures.");
    expect(prompt).toContain("tests/search.test.ts");
    expect(prompt).toContain("Do not broaden scope");
  });
});
