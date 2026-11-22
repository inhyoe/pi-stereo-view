import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { answerTitle } from "../src/compact-tools.ts";
import { NativeContentIndex } from "../src/content.ts";
import { NativeDocument } from "../src/native.ts";
import type { SearchHit } from "../src/search.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";

class Markdown extends Text {}
class MouseRegion extends Container {}
class ToolExecutionComponent extends Text {
  toolName = "write";
  toolCallId = "collapse-tool";
  args = { path: "file" };
  setExpanded(): void {}
}
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls: boolean;
  lastMessage: { content: { type: string; text?: string; thinking?: string }[]; stopReason: string };
  constructor(blocks: { type: string; text?: string; thinking?: string }[], toolUse = false) {
    super();
    this.hasToolCalls = toolUse;
    this.lastMessage = { content: blocks, stopReason: toolUse ? "toolUse" : "stop" };
    this.addChild(this.contentContainer);
    for (const block of blocks) {
      this.contentContainer.addChild(new Spacer(1));
      if (block.type === "text") this.contentContainer.addChild(new Markdown(block.text!, 0, 0));
      else {
        const thinking = new MouseRegion();
        thinking.addChild(new Text(block.thinking!, 0, 0));
        this.contentContainer.addChild(thinking);
      }
    }
  }
  setHideThinkingBlock(): void {}
}
const answer = (text: string): AssistantMessageComponent => new AssistantMessageComponent([{ type: "text", text }]);
const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme;

function setup(pane: "chat" | "activity", options: { answersOnly?: boolean; collapse?: boolean } = {}, ...components: Component[]) {
  const state = { answersOnly: options.answersOnly ?? true, collapse: options.collapse ?? true };
  const history = new Container(); history.children = components;
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, undefined, () => true, () => state.answersOnly);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  let copied: string | undefined;
  const document = new NativeDocument(source, pane, timestamps, () => theme, () => 0, () => false,
    undefined, true, index, text => { copied = text; }, () => true, undefined, undefined, undefined, undefined, undefined,
    () => state.answersOnly && state.collapse);
  const render = (width = 24) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  const click = (y: number, width = 24): void => {
    const event: TuiMouseEvent = { type: "click", button: "left", x: 1, y, screenX: 1, screenY: y,
      width, height: document.render(width).length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" });
    document.handleMouse(event);
  };
  const hit = (text: string): SearchHit => {
    const entry = document.searchEntries().find(candidate => candidate.text.includes(text))!;
    return { entry, line: entry.text.split("\n").findIndex(line => line.includes(text)), text };
  };
  return { state, history, document, render, click, hit, copied: () => copied };
}
const FULL = "만들 수 있습니다.\n\n세부 설명 SECOND-PARAGRAPH 입니다.";

test("a finished answer shows only its first line, and a click opens and closes the whole Markdown", () => {
  const { render, click } = setup("chat", {}, answer(FULL));
  const folded = render();
  expect(folded.join("\n")).toContain("▸ 만들 수");
  expect(folded.join("\n")).not.toContain("세부 설명");
  click(0);
  const open = render();
  expect(open[0]).toBe("▾");
  expect(open.join("\n")).toContain("세부 설명");
  expect(open.join("\n")).toContain("SECOND-PARAGRAPH 입니다.");
  click(0);
  expect(render().join("\n")).not.toContain("세부 설명");
  expect(render()[0]).toContain("▸");
});

test.each(["한글과😀이모지로 시작하는 아주 긴 결론 문장입니다 폭이 좁아도 넘치지 않아야 합니다 끝까지", "\x1b[31m빨강\x1b[0m 한글😀한글😀한글😀한글😀한글😀한글😀한글😀한글😀한글😀 끝"])(
  "a wide first line wraps to two rows ending in an ellipsis within 24 columns", first => {
    const { render } = setup("chat", {}, answer(first + "\n\nHIDDEN-TAIL"));
    const folded = render();
    expect(folded).toHaveLength(2);
    expect(folded[1].endsWith("…")).toBe(true);
    for (const line of folded) expect(visibleWidth(line), line).toBeLessThanOrEqual(24);
    expect(folded.join("")).not.toContain("HIDDEN-TAIL");
  });

test("two folded answers in 24 columns, as drawn in the design", () => {
  const { render } = setup("chat", {}, answer("만들 수 있습니다.\n\n세부 설명"), answer("진짜 분할은 내부 구조를 건드려야 해서 어렵습니다.\n\n둘째"));
  expect(render()).toEqual(["▸ 만들 수 있습니다.", "", "▸ 진짜 분할은 내부 구조", "  를 건드려야 해서 어렵…"]);
});

test.each([
  ["a leading blank line", "\n\n  결론입니다\n\n본문", "결론입니다"],
  ["a heading", "# 제목 줄\n본문", "제목 줄"],
  ["a list item", "- 첫째 항목\n- 둘째", "첫째 항목"],
  ["a quote", "> 인용 결론\n본문", "인용 결론"],
  ["a numbered item", "1. 번호 결론\n2. 둘째", "번호 결론"],
  ["a code fence", "```ts\nconst answer = 1;\n```\n본문", "const answer = 1;"],
  ["bold text", "**굵은** 결론", "굵은 결론"],
  ["only marks", "```\n---\n", ""],
])("the title skips Markdown marks: %s", (_name, text, title) => {
  expect(answerTitle(text)).toBe(title);
});

/** Pi adds a spacer and one Text line after an answer that ended by truncation, abort or error. */
const failed = (text: string, reason: string, notice: string): AssistantMessageComponent => {
  const message = answer(text);
  message.lastMessage.stopReason = reason;
  message.contentContainer.addChild(new Spacer(1));
  message.contentContainer.addChild(new Text(notice, 0, 0));
  return message;
};

test.each([
  ["length", "Response was truncated before completion."],
  ["aborted", "Operation aborted"],
  ["error", "Error: 429 Too Many Requests"],
])("a folded answer that ended with %s keeps Pi's notice under its title", (reason, notice) => {
  const { render, click } = setup("chat", {}, failed(FULL, reason, notice));
  expect(render(60).map(line => line.trimEnd())).toEqual(["▸ 만들 수 있습니다.", notice]);
  click(0, 60);
  const open = render(60).join("\n");
  expect(open).toContain("세부 설명");
  expect(open.split(notice).length - 1).toBe(1);
  click(0, 60);
  expect(render(60).map(line => line.trimEnd())).toEqual(["▸ 만들 수 있습니다.", notice]);
});

test("a one-line answer still folds and shows the same content when opened", () => {
  const { render, click } = setup("chat", {}, answer("한 줄뿐입니다."));
  expect(render()).toEqual(["▸ 한 줄뿐입니다."]);
  click(0);
  expect(render().map(line => line.trimEnd())).toEqual(["▾", "", "한 줄뿐입니다."]);
});

test("a search match opens its answer temporarily and the user's own choice survives it", () => {
  const { render, click, document, hit } = setup("chat", {}, answer(FULL));
  expect(render().join("\n")).not.toContain("SECOND-PARAGRAPH");
  expect(document.reveal(hit("SECOND-PARAGRAPH"), "SECOND-PARAGRAPH")).toBe(true);
  expect(render().join("\n")).toContain("SECOND-PARAGRAPH");
  document.clearSearch();
  expect(render().join("\n")).not.toContain("SECOND-PARAGRAPH");
  // Opened by the user, a search closing must not fold it again.
  click(0);
  document.reveal(hit("SECOND-PARAGRAPH"), "SECOND-PARAGRAPH");
  document.clearSearch();
  expect(render().join("\n")).toContain("SECOND-PARAGRAPH");
  // Folded by the user during a search, it stays folded afterwards.
  document.reveal(hit("SECOND-PARAGRAPH"), "SECOND-PARAGRAPH");
  click(0);
  expect(render().join("\n")).not.toContain("SECOND-PARAGRAPH");
  document.clearSearch();
  expect(render().join("\n")).not.toContain("SECOND-PARAGRAPH");
});

test("an open answer stays with its own message when another answer is added", () => {
  const first = answer("첫 답 결론\n\nFIRST-BODY");
  const second = answer("둘째 답 결론\n\nSECOND-BODY");
  const { render, click, history } = setup("chat", {}, first);
  click(0);
  history.children = [first, second];
  const lines = render().join("\n");
  expect(lines).toContain("FIRST-BODY");
  expect(lines).not.toContain("SECOND-BODY");
});

test("copying a folded answer copies the whole answer, not its first line", () => {
  const { render, document, copied } = setup("chat", {}, answer(FULL));
  expect(render().join("\n")).not.toContain("세부 설명");
  document.copyBlocks()[0].copy();
  expect(copied()).toBe(FULL);
});

test.each([
  ["Collapse answers off", { collapse: false }],
  ["Answers only off", { answersOnly: false }],
])("%s shows the answer in full", (_name, options) => {
  const { render } = setup("chat", options, answer(FULL));
  expect(render(40).join("\n")).toContain("세부 설명 SECOND-PARAGRAPH");
  expect(render(40).join("")).not.toContain("▸");
});

test("switching the setting off and on again re-folds without keeping a stale block", () => {
  const { render, state } = setup("chat", {}, answer(FULL));
  state.collapse = false;
  expect(render().join("\n")).toContain("세부 설명");
  state.collapse = true;
  expect(render().join("\n")).not.toContain("세부 설명");
});

test("a streaming answer is Activity text and is never folded", () => {
  const streaming = new AssistantMessageComponent([{ type: "text", text: "STREAMING-LINE\n\nMORE" }]);
  streaming.lastMessage.stopReason = "";
  const { render } = setup("chat", {}, streaming);
  expect(render().join("\n")).not.toContain("STREAMING-LINE");
  const activity = setup("activity", {}, streaming);
  expect(activity.render().join("\n")).toContain("MORE");
});

test("text written before a tool call is copied and labelled with Activity, thinking alone stays Thinking", () => {
  const moved = new AssistantMessageComponent([{ type: "text", text: "MID-EXPLANATION" }], true);
  const thinking = new AssistantMessageComponent([{ type: "thinking", thinking: "ONLY-THINKING" }], true);
  const final = answer("FINAL-ANSWER");
  const children = [moved, new ToolExecutionComponent("x", 0, 0), thinking, final];
  const activity = setup("activity", {}, ...children);
  const chat = setup("chat", {}, ...children);
  activity.render(); chat.render();
  const labels = activity.document.copyBlocks().map(block => block.label);
  expect(labels.find(label => label.includes("MID-EXPLANATION"))).toMatch(/Assistant: MID-EXPLANATION/);
  expect(labels.find(label => label.includes("ONLY-THINKING"))).toMatch(/Thinking: ONLY-THINKING/);
  expect(activity.document.searchEntries().find(entry => entry.text.includes("MID-EXPLANATION"))?.label).toBe("Assistant");
  expect(activity.document.searchEntries().find(entry => entry.text.includes("ONLY-THINKING"))?.label).toBe("Thinking");
  activity.document.copyBlocks().find(block => block.label.includes("MID-EXPLANATION"))!.copy();
  expect(activity.copied()).toBe("MID-EXPLANATION");
  expect(chat.document.copyBlocks().map(block => block.label).join("\n")).not.toContain("MID-EXPLANATION");
  expect(chat.document.copyBlocks().map(block => block.label).join("\n")).toContain("FINAL-ANSWER");
});
