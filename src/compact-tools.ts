import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolSummary } from "./content.ts";

const singleLine = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

/** Prefer the useful argument, falling back to a bounded preview of custom input. */
export function toolDescription(args: unknown): string {
  if (typeof args === "string") return singleLine(args);
  if (!args || typeof args !== "object") return args == null ? "" : String(args);
  const record = args as Record<string, unknown>;
  const values = ["command", "query", "pattern", "url", "path", "file_path", "file", "description", "code"];
  for (const key of values) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return singleLine(value);
  }
  // Streamed args are JSON values; don't stringify a large file body just to label a call.
  return Object.entries(record).slice(0, 3).map(([key, value]) => {
    const preview = typeof value === "string" ? value.slice(0, 160) :
      value === null || typeof value !== "object" ? String(value) : Array.isArray(value) ? "[…]" : "{…}";
    return `${singleLine(key)}: ${singleLine(preview)}`;
  }).join(" ");
}

/** The first non-empty line of an answer without its Markdown marks; a code fence line is never the title. */
export function answerTitle(answer: string): string {
  for (const line of stripTerminalSequences(answer).split(/\r?\n|\r/)) {
    if (/^\s*(```|~~~)/.test(line)) continue;
    const title = singleLine(line.replace(/^[\s#>*+-]+|^\s*\d+[.)]\s+/, "").replace(/\*\*|__|`/g, ""));
    if (title) return title;
  }
  return "";
}

/** A folded body may name native lines that stay under the title, such as Pi's truncation, abort or error notice. */
export interface FoldableBody extends Component {
  foldNotes?(): Component[];
}

/**
 * A finished answer folded to its first line, like a compact tool row: `▸` and at most two rows of the title.
 * Pi's notice of an answer that did not finish normally stays visible under the folded title.
 * While open, a `▾` row precedes the original Markdown body, which is rendered untouched.
 */
export class AnswerFold extends Container {
  private readonly row: Component;
  private open = false;

  constructor(private readonly body: Component, answer: () => string, theme: () => Theme, toggle: () => void) {
    super();
    this.row = {
      render: width => this.header(width, answer(), theme()),
      invalidate() {},
      handleMouse: event => {
        if (event.button !== "left") return undefined;
        if (event.type === "press") return { capture: true };
        if (event.type !== "click") return { handled: true };
        toggle();
        return { handled: true, render: true };
      },
    };
    this.children = [this.row];
  }

  /** Change the children before the next render, so native render caches see a different block. */
  show(open: boolean): void {
    const children = open ? [this.row, this.body] : [this.row, ...((this.body as FoldableBody).foldNotes?.() ?? [])];
    if (open === this.open && children.length === this.children.length && children.every((child, index) => child === this.children[index])) return;
    this.open = open;
    this.children = children;
  }

  private header(width: number, answer: string, theme: Theme): string[] {
    const mark = theme.fg("muted", this.open ? "▾" : "▸");
    if (this.open) return [truncateToWidth(mark, width)];
    const inner = Math.max(1, width - 2);
    const rows = wrapTextWithAnsi(answerTitle(answer), inner);
    if (rows.length > 2) rows.splice(1, rows.length - 1, truncateToWidth(rows.slice(1).join(" "), inner, "…"));
    return (rows.length ? rows : [""]).map((row, index) => truncateToWidth((index ? "  " : mark + " ") + row, width));
  }
}

interface CompactToolOptions {
  alignControl?: boolean;
  clock?(): string;
  gutter?(): number;
  count?(): number;
  expanded?(): boolean;
  toggle?(): void;
}

interface HeaderInputs {
  width: number; name: string; args: unknown; status: ToolSummary["status"]; images: number; count?: number; expanded?: boolean;
  label: string; theme: Theme;
}
const sameInputs = (a: HeaderInputs, b: HeaderInputs): boolean => a.width === b.width && a.name === b.name &&
  a.args === b.args && a.status === b.status && a.images === b.images && a.count === b.count && a.expanded === b.expanded && a.label === b.label && a.theme === b.theme;

/** A display-only call or group header; the original renderer owns the body. */
export class CompactTool implements Component {
  // Headers are rebuilt every frame for the whole history. Completed calls keep their
  // argument object, so reuse the row until a displayed input changes.
  private cached?: { inputs: HeaderInputs; lines: string[] };

  constructor(private readonly summary: () => ToolSummary, private readonly theme: () => Theme,
    private readonly options: CompactToolOptions = {}) {}

  render(width: number): string[] {
    width = Math.max(0, width - (this.options.gutter?.() ?? 0));
    const { name, args, status, images = 0 } = this.summary();
    const inputs: HeaderInputs = { width, name, args, status, images, count: this.options.count?.(),
      expanded: this.options.toggle ? this.options.expanded?.() : undefined, label: this.options.clock?.() ?? "", theme: this.theme() };
    // Streamed arguments may be updated in place, so running calls always rebuild.
    if (this.cached && status !== "running" && sameInputs(this.cached.inputs, inputs)) return this.cached.lines;
    const lines = this.header(inputs);
    this.cached = { inputs, lines };
    return lines;
  }
  private header({ width, name, args, status, images, count, expanded, label, theme }: HeaderInputs): string[] {
    const dot = theme.fg(status === "running" ? "warning" : status === "unknown" ? "dim" : status, "●");
    const description = count ? "" : toolDescription(args);
    const control = this.options.toggle ? theme.fg("muted", expanded ? "▾" : "▸") + " " : this.options.alignControl ? "  " : "";
    // Before the description, so truncation keeps it: the collapsed row is the only sign of a hidden image.
    const attachment = images ? " " + theme.fg("accent", `(${images} ${images === 1 ? "image" : "images"})`) : "";
    const text = `${dot} ${control}${singleLine(name)}${count ? ` ×${count}` : ""}${attachment}${description ? " " + theme.fg("muted", description) : ""}`;
    const clock = label && width >= visibleWidth(label) + 8 ? label : "";
    const available = Math.max(0, width - 1 - (clock ? visibleWidth(clock) + 1 : 0));
    const body = truncateToWidth(text, available, "…");
    return [(width > 0 ? " " : "") + (clock ? theme.fg("dim", clock) + " " : "") + body];
  }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    if (!this.options.toggle || event.button !== "left") return undefined;
    if (event.type === "press") return { capture: true };
    if (event.type === "click" && event.x >= 0 && event.x < event.width && event.y === 0) {
      this.options.toggle();
      return { handled: true, render: true };
    }
    return { handled: true };
  }
  invalidate(): void { this.cached = undefined; }
}
