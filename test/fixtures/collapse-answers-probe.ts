import { writeFile } from "node:fs/promises";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

type Host = TUI & { layoutRoot: Component; getScreenLines(): string[]; handleTerminalInput(data: string): void };
type Document = Component & { pane: string; lastWidth: number; beginFrame(): void };
interface Frame { screen: string[]; chat: string[]; activity: string[] }

/** Drive Collapse answers through real mouse input and the real settings list, recording each frame. */
export default function collapseAnswersProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const frames: Record<string, Frame> = {};
  const documents = (): Document[] => {
    const found: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") { found.push(component as Document); return; }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    visit(tui.layoutRoot);
    return found;
  };
  const capture = async (name?: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const screen = tui.getScreenLines().map(stripTerminalSequences);
    if (name) {
      const frame: Frame = { screen, chat: [], activity: [] };
      for (const document of documents()) {
        document.beginFrame();
        const lines = document.render(document.lastWidth).map(stripTerminalSequences);
        if (document.pane === "chat") frame.chat = lines; else frame.activity = lines;
      }
      frames[name] = frame;
    }
    return screen;
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  // The Conversation panel is on the right; click the fold mark that is furthest right.
  const clickFold = async (mark: string): Promise<void> => {
    const screen = await capture();
    // Only the Conversation column: Activity rows may carry the same mark.
    const y = screen.findIndex(line => line.lastIndexOf(mark) >= 130);
    if (y < 0) throw new Error("Missing fold mark " + mark);
    const x = visibleWidth(screen[y].slice(0, screen[y].lastIndexOf(mark)));
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    try {
      await capture("folded");
      await clickFold("▸");
      await capture("opened");
      await clickFold("▾");
      await capture("closed");
      // "Answers only" is the tenth setting; Space turns it off.
      ctx.ui.setEditorText("/stereo-view settings");
      await input("\r");
      for (let row = 0; row < 9; row++) await input("\x1b[B");
      await input(" ");
      await input("\x1b");
      await capture("answersOff");
      await setTimeout(200);
      await writeFile(process.env.COLLAPSE_ANSWERS_FILE!, JSON.stringify(frames));
    } catch (error) {
      await capture("failure");
      await writeFile(process.env.COLLAPSE_ANSWERS_FILE!, JSON.stringify({ ...frames, error: String(error) }));
      throw error;
    }
  });
}
