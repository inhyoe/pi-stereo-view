import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

interface Frame { screen: string[]; chat: string[]; activity: string[] }
// Longer than the panel, so opening it while Conversation follows the end must not scroll its first rows away.
const ANSWER = "😀한글로 시작하는 아주 긴 첫 줄 결론입니다 폭 24칸을 넘습니다\n\n세부 설명 SECOND-PART\n\n" +
  Array.from({ length: 60 }, (_, line) => `LINE-${line}`).join("\n\n");

test("a fresh install folds the answer in the 24-column Conversation; a click opens it and Answers only off restores upstream routing", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/collapse-answers-"));
  const agent = await mkdtemp(path.resolve("tmp/collapse-answers-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    const file = path.resolve("tmp/test-runs/collapse-answers/frames.json");
    const result = await new PiIntegrationTest({
      testName: "collapse-answers", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, COLLAPSE_ANSWERS_FILE: file, PI_TRANSCRIPT_TEST_DEFAULTS: "1" },
      rawMode: false, tuiSize: { cols: 160, rows: 50 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/collapse-answers-probe.ts")],
      tools: ["write"],
      conversation: [
        assistantMessage([text("MID-NOTE: I will write the file"), toolCall({ id: "collapse-write", name: "write",
          arguments: { path: "collapse.txt", content: "WRITTEN" } })], { stopReason: "toolUse" }),
        assistantMessage([text(ANSWER)], { stopReason: "stop" }),
      ],
    }).run("USER-PROMPT-MARKER");
    expect(result.exitCode).toBe(0);
    const frames = JSON.parse(await readFile(file, "utf8")) as Record<string, Frame> & { error?: string };
    expect(frames.error).toBeUndefined();
    const all = (frame: Frame): string => frame.screen.join("\n");
    // 4-1 and 4-6: only the first line, wrapped to two rows inside 24 columns.
    const folded = frames.folded;
    expect(all(folded)).toContain("▸ 😀한글로");
    expect(all(folded)).not.toContain("SECOND-PART");
    expect(folded.chat.some(line => line.includes("▸"))).toBe(true);
    for (const line of folded.chat) expect(visibleWidth(line), line).toBeLessThanOrEqual(24);
    // 4-2: a mouse click opens the whole Markdown, a second click folds it again.
    expect(all(frames.opened)).toContain("▾");
    expect(all(frames.opened)).toContain("SECOND-PART");
    expect(all(frames.closed)).not.toContain("SECOND-PART");
    expect(all(frames.closed)).toContain("▸ 😀한글로");
    // 6-1: Answers only off in the real settings list re-routes at once and is saved.
    expect(folded.chat.join("\n")).not.toContain("MID-NOTE");
    expect(frames.answersOff.chat.join("\n")).toContain("MID-NOTE");
    expect(frames.answersOff.activity.join("\n")).not.toContain("MID-NOTE");
    expect(frames.answersOff.chat.join("\n")).toContain("SECOND-PART");
    expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8")).answersOnly).toBe(false);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);
