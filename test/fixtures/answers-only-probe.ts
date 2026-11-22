import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";

type Document = Component & {
  pane: string;
  beginFrame(): void;
  searchEntries(): { text: string; label: string }[];
};
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };
interface Snapshot { event: string; panes: Record<string, string[]>; search: Record<string, string[]> }

/** Record what each pane renders and searches while an answer streams, ends and the run settles. */
export default function answersOnlyProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const snapshots: Snapshot[] = [];
  const widths: Record<string, number> = {};
  const wrapped = new Set<Document>();
  let measuring = false;
  const documents = (): Document[] => {
    const found: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") {
        found.push(component as Document);
        return;
      }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    visit(tui.layoutRoot);
    return found;
  };
  // Pi paints through these documents; remember the width each one was given.
  const observeWidths = (): void => {
    for (const document of documents()) {
      if (wrapped.has(document)) continue;
      wrapped.add(document);
      const render = document.render.bind(document);
      document.render = width => {
        if (!measuring) widths[document.pane] = width;
        return render(width);
      };
    }
  };
  const capture = async (event: string): Promise<void> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    observeWidths();
    const snapshot: Snapshot = { event, panes: {}, search: {} };
    measuring = true;
    for (const document of documents()) {
      document.beginFrame();
      snapshot.panes[document.pane] = document.render(180);
      snapshot.search[document.pane] = document.searchEntries().map(entry => entry.text);
    }
    measuring = false;
    snapshots.push(snapshot);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    return { message: {
      ...event.message,
      content: [{ type: "thinking", thinking: "THINKING-NOTE", thinkingSignature: "" }, ...event.message.content],
    } };
  });
  const updates = new Map<unknown, number>();
  pi.on("message_update", async event => {
    if (event.message.role !== "assistant") return;
    const count = (updates.get(event.message.timestamp) ?? 0) + 1;
    updates.set(event.message.timestamp, count);
    if (count === 4) await capture("update");
  });
  pi.on("message_end", async event => {
    if (event.message.role === "assistant") await capture("message_end");
  });
  pi.on("tool_execution_start", async () => { await capture("tool_execution_start"); });
  pi.on("agent_before_settle", async () => {
    await capture("settled");
    await writeFile(process.env.ANSWERS_ONLY_FILE!, JSON.stringify({ snapshots, widths, screen: tui.getScreenLines() }));
  });
}
