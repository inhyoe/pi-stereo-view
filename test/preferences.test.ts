import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { defaults, loadPreferences, savePreferences, type Preferences } from "../src/preferences.ts";

const arrangement = {
  side: "right", chatWidth: 73, layout: "rows", chatHeight: 17,
  showTimestamps: false, showCopyButtons: false, answersOnly: false, collapseAnswers: false, compactTools: true, groupTools: false, nestedTree: false, streamTools: true, streamDelay: 8, buttonStyle: "icons",
} as const;

test.each(["chat", "activity", null] as const)("ignores legacy temporary state with %s zoom without losing the saved arrangement", async zoom => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    for (const mode of ["split", "combined"]) {
      await writeFile(file, JSON.stringify({ ...arrangement, mode, zoom }));
      expect(await loadPreferences(file)).toEqual({ ...arrangement, mode: "split", zoom: null });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["columns", "rows"] as const)("saves the %s arrangement without temporary mode or zoom", async layout => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const state: Preferences = { ...arrangement, layout, mode: "combined", zoom: "activity" };
    await savePreferences(file, state);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...arrangement, layout });
    expect(state).toEqual({ ...arrangement, layout, mode: "combined", zoom: "activity" });
    expect(await loadPreferences(file)).toEqual({ ...arrangement, layout, mode: "split", zoom: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retains automatic sizes and accepts settings with no temporary-state keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { mode: _mode, zoom: _zoom, ...saved } = defaults;
    await writeFile(file, JSON.stringify(saved));
    expect(await loadPreferences(file)).toEqual(defaults);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reads a saved file without answersOnly as on and keeps a saved off", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { answersOnly: _answersOnly, ...legacy } = arrangement;
    await writeFile(file, JSON.stringify(legacy));
    expect((await loadPreferences(file)).answersOnly).toBe(true);
    await writeFile(file, JSON.stringify(arrangement));
    expect((await loadPreferences(file)).answersOnly).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reads a saved file without collapseAnswers as on and keeps a saved off", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    const { collapseAnswers: _collapseAnswers, ...legacy } = arrangement;
    await writeFile(file, JSON.stringify(legacy));
    expect((await loadPreferences(file)).collapseAnswers).toBe(true);
    await writeFile(file, JSON.stringify(arrangement));
    expect((await loadPreferences(file)).collapseAnswers).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([null, "true", 1, 0])("rejects a saved collapseAnswers of %j", async collapseAnswers => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...arrangement, collapseAnswers }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([null, "true", 1, 0])("rejects a saved answersOnly of %j", async answersOnly => {
  const directory = await mkdtemp(path.join(tmpdir(), "stereo-preferences-"));
  const file = path.join(directory, "transcript.json");
  try {
    await writeFile(file, JSON.stringify({ ...arrangement, answersOnly }));
    await expect(loadPreferences(file)).rejects.toThrow("Invalid pi-stereo-view preferences");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
