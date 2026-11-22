import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
import { NativeDocument } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";

// Pi-Bolt ships its own Container: handleMouse reads `this.rendered` and `this.ownChildren()` instead of
// `this.mouseLayout` and `this.children`. This copy follows Pi-Bolt's code so the borrowed call is checked on that host.
type BoltContainer = {
  rendered?: { width: number; children: Component[]; heights: number[] };
  ownChildren(): Component[];
};
function boltHandleMouse(this: BoltContainer, event: TuiMouseEvent) {
  if (event.y < 0 || event.y >= event.height) return undefined;
  const rendered = this.rendered?.width === event.width ? this.rendered : undefined;
  const children = rendered?.children ?? this.ownChildren();
  let childY = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childHeight = rendered ? rendered.heights[i] : child.render(event.width).length;
    if (event.y >= childY && event.y < childY + childHeight) {
      return child.handleMouse?.({ ...event, y: event.y - childY, height: childHeight }) ?? undefined;
    }
    childY += childHeight;
  }
  return undefined;
}

const upstreamHandleMouse = Container.prototype.handleMouse;
/** Make every real Container behave like Pi-Bolt's; plain objects that borrow the method get nothing extra. */
function useBoltContainer(): void {
  Container.prototype.handleMouse = boltHandleMouse as unknown as Container["handleMouse"];
  Reflect.set(Container.prototype, "ownChildren", function (this: Container) { return this.children; });
}
afterEach(() => {
  Container.prototype.handleMouse = upstreamHandleMouse;
  Reflect.deleteProperty(Container.prototype, "ownChildren");
});

class Markdown extends Text {}
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  hasToolCalls = false;
  lastMessage: { content: { type: string; text?: string }[]; stopReason: string };
  constructor(text: string) {
    super();
    this.lastMessage = { content: [{ type: "text", text }], stopReason: "stop" };
    this.addChild(this.contentContainer);
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(new Markdown(text, 0, 0));
  }
  setHideThinkingBlock(): void {}
}
const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme;

function setup(...components: Component[]) {
  const history = new Container(); history.children = components;
  const source = new Container(); source.children = [new Container(), new Container(), history];
  const index = new NativeContentIndex(source, undefined, () => true, () => true);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => theme, () => 0, () => false,
    undefined, true, index, () => {}, () => true, undefined, undefined, undefined, undefined, undefined, () => true);
  const render = (width = 24) => { document.beginFrame(); return document.render(width).map(stripTerminalSequences); };
  const click = (y: number, width = 24): void => {
    const event: TuiMouseEvent = { type: "click", button: "left", x: 1, y, screenX: 1, screenY: y,
      width, height: document.render(width).length, shift: false, alt: false, ctrl: false };
    document.handleMouse({ ...event, type: "press" });
    document.handleMouse(event);
  };
  return { render, click };
}

const FULL = "만들 수 있습니다.\n\n세부 설명 SECOND-PARAGRAPH 입니다.";

test("on Pi-Bolt's Container a click in the split routes to the folded answer instead of throwing", () => {
  useBoltContainer();
  const { render, click } = setup(new AssistantMessageComponent(FULL));
  expect(render().join("\n")).not.toContain("세부 설명");
  expect(() => click(0)).not.toThrow();
  expect(render().join("\n")).toContain("SECOND-PARAGRAPH 입니다.");
});

test("Pi-Bolt routing hits the answer under the pointer when two answers are drawn", () => {
  useBoltContainer();
  const { render, click } = setup(new AssistantMessageComponent(FULL), new AssistantMessageComponent("둘째 답입니다.\n\nSECOND-TAIL 끝"));
  const row = render().findIndex(line => line.includes("둘째 답"));
  expect(row).toBeGreaterThan(0);
  click(row);
  const open = render().join("\n");
  expect(open).toContain("SECOND-TAIL 끝");
  expect(open).not.toContain("SECOND-PARAGRAPH");
});
