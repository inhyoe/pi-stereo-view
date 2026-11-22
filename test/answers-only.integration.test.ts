import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

interface Capture {
  snapshots: { event: string; panes: Record<string, string[]>; search: Record<string, string[]> }[];
  widths: Record<string, number>;
  screen: string[];
}
const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");
const ANSWER = "FINAL-ANSWER-MARKER: the document says hello";

/** Run real Pi through the extension entry with one tool-using reply and one streamed final answer. */
async function run(name: string, saved: Record<string, unknown> | undefined, cols: number): Promise<Capture> {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(`tmp/${name}-`));
  const agent = await mkdtemp(path.resolve(`tmp/${name}-agent-`));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    if (saved) await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ showTimestamps: false, ...saved }));
    const file = path.resolve(`tmp/test-runs/${name}/answers-only.json`);
    const result = await new PiIntegrationTest({
      testName: name, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      // Without a saved file this is a fresh install: the launcher does not seed any preference.
      environment: { PI_CODING_AGENT_DIR: agent, ANSWERS_ONLY_FILE: file, ...(saved ? {} : { PI_TRANSCRIPT_TEST_DEFAULTS: "1" }) },
      rawMode: false, tuiSize: { cols, rows: 50 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/answers-only-probe.ts")],
      tools: ["write"],
      conversation: [
        assistantMessage([text("MID-EXPLANATION-MARKER: I will write the file"), toolCall({ id: "answers-write", name: "write",
          arguments: { path: "answers.txt", content: "WRITTEN" } })], { stopReason: "toolUse" }),
        assistantMessage([text(ANSWER, { chunks: { kind: "fixed", size: 6 }, delayMs: 15 })], { stopReason: "stop" }),
      ],
    }).run("USER-PROMPT-MARKER");
    expect(result.exitCode).toBe(0);
    return JSON.parse(await readFile(file, "utf8")) as Capture;
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}
const chatOf = (frame: Capture["snapshots"][number]): string => clean(frame.panes.chat);
const activityOf = (frame: Capture["snapshots"][number]): string => clean(frame.panes.activity);

test("a fresh install keeps only answers in a Conversation panel on the right, a tenth of the width", async () => {
  const capture = await run("answers-only-fresh", undefined, 300);
  const final = capture.snapshots.at(-1)!;
  // 1-1: the explanation before a tool call is shown in Activity and found by its search, never in Conversation.
  expect(activityOf(final)).toContain("MID-EXPLANATION-MARKER");
  expect(final.search.activity.join("\n")).toContain("MID-EXPLANATION-MARKER");
  expect(chatOf(final)).not.toContain("MID-EXPLANATION-MARKER");
  expect(final.search.chat.join("\n")).not.toContain("MID-EXPLANATION-MARKER");
  // 1-4: it was never in Conversation at any moment, including while it streamed and after the call ran.
  expect(capture.snapshots.map(frame => frame.event)).toContain("tool_execution_start");
  for (const frame of capture.snapshots) expect(chatOf(frame), frame.event).not.toContain("MID-EXPLANATION-MARKER");
  // 1-2 and 1-6: a finished answer without tool calls is in Conversation, and thinking stays in Activity.
  expect(chatOf(final)).toContain(ANSWER);
  expect(final.search.chat.join("\n")).toContain(ANSWER);
  expect(chatOf(final)).toContain("USER-PROMPT-MARKER");
  expect(activityOf(final)).not.toContain("FINAL-ANSWER-MARKER");
  expect(final.search.activity.join("\n")).not.toContain("FINAL-ANSWER-MARKER");
  expect(activityOf(final)).toContain("THINKING-NOTE");
  expect(chatOf(final)).not.toContain("THINKING-NOTE");
  // 1-3: the same message was in Activity while it streamed and moved to Conversation when it finished.
  const streaming = capture.snapshots.find(frame => frame.event === "update" && activityOf(frame).includes("FINAL-ANSWER"))!;
  expect(streaming, "a frame during streaming").toBeDefined();
  expect(chatOf(streaming)).not.toContain("FINAL-ANSWER");
  expect(streaming.search.chat.join("\n")).not.toContain("FINAL-ANSWER");
  // 3-1: Conversation on the right, 29 columns of a 300-column terminal.
  expect(capture.widths.chat).toBe(29);
  const header = capture.screen.map(stripTerminalSequences).find(line => line.includes("Conversation") && line.includes("Activity"))!;
  expect(header.indexOf("Activity")).toBeLessThan(header.indexOf("Conversation"));
}, 60_000);

test("a narrow terminal keeps the minimum Conversation width", async () => {
  const capture = await run("answers-only-narrow", undefined, 160);
  expect(capture.widths.chat).toBe(24);
}, 60_000);

test("saved side, width and answersOnly off keep the upstream routing", async () => {
  const capture = await run("answers-only-off", { side: "left", chatWidth: 60, layout: "columns", answersOnly: false }, 300);
  const final = capture.snapshots.at(-1)!;
  // 1-5: with the setting off, text before a tool call stays in Conversation, as in upstream.
  expect(chatOf(final)).toContain("MID-EXPLANATION-MARKER");
  expect(chatOf(final)).toContain(ANSWER);
  expect(activityOf(final)).not.toContain("MID-EXPLANATION-MARKER");
  // 3-3: the saved side and width win over the new defaults.
  expect(capture.widths.chat).toBe(60);
  const header = capture.screen.map(stripTerminalSequences).find(line => line.includes("Conversation") && line.includes("Activity"))!;
  expect(header.indexOf("Conversation")).toBeLessThan(header.indexOf("Activity"));
}, 60_000);
