import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const CUSTOM_TYPE = "mode-switch";
const SYSTEM_PROMPT_SECTIONS = new Set(["available_tools", "custom_tools_note", "guidelines", "pi_docs", "append_prompt", "project_context", "skills", "date", "cwd"]);
const SECTION_HEADINGS: Record<string, string[]> = {
  available_tools: ["Tools", "Available tools"],
  custom_tools_note: ["Custom tools"],
  guidelines: ["Guidelines"],
  pi_docs: ["Pi documentation"],
  append_prompt: ["Additional instructions"],
  project_context: ["Project Context"],
  skills: ["Skills", "Available skills"],
};

type ModeDef = { key: string; label: string; opener?: string; appendix?: string; systemPrompt?: string; removeSections?: string[] };

const BUILTIN: ModeDef[] = [
  { key: "coding", label: "Coding", opener: "", appendix: "Focus on concise, practical coding help." },
  { key: "plan", label: "Plan", opener: "Make a concise implementation plan before changing files.", appendix: "Do not edit files unless the user asks you to proceed." },
  { key: "review", label: "Review", opener: "Review the current work for correctness, risks, and missing tests." },
  { key: "explain", label: "Explain", opener: "Explain the relevant code and decisions clearly before proposing changes." },
];

function agentDir() { return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"); }
function modeDir() { return join(agentDir(), "modes"); }
function modePath(key: string) { return join(modeDir(), `${key}.json`); }
function slugifyKey(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); }
function valid(raw: any): ModeDef | null {
  const key = String(raw?.key ?? "").trim().toLowerCase();
  const label = String(raw?.label ?? "").trim();
  const opener = String(raw?.opener ?? "").trim();
  const appendix = typeof raw?.appendix === "string" ? raw.appendix : "";
  const systemPrompt = typeof raw?.systemPrompt === "string" ? raw.systemPrompt : "";
  const removeSections = Array.isArray(raw?.removeSections) ? raw.removeSections.filter((s: any) => typeof s === "string" && SYSTEM_PROMPT_SECTIONS.has(s)) : [];
  if (!/^[a-z][a-z0-9_-]*$/.test(key) || !label || (!opener && !appendix.trim() && !systemPrompt)) return null;
  return { key, label, ...(opener ? { opener } : {}), ...(appendix.trim() ? { appendix } : {}), ...(systemPrompt.trim() ? { systemPrompt } : {}), ...(removeSections.length ? { removeSections } : {}) };
}
function loadModes(): ModeDef[] {
  const byKey = new Map(BUILTIN.map((m) => [m.key, m]));
  try {
    if (existsSync(modeDir())) for (const file of readdirSync(modeDir())) {
      if (!file.endsWith(".json")) continue;
      const mode = valid(JSON.parse(readFileSync(join(modeDir(), file), "utf8")));
      if (mode) byKey.set(mode.key, mode);
    }
  } catch {}
  return [...byKey.values()];
}
function modeFromEntries(entries: readonly any[]): string {
  let mode = "coding";
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === CUSTOM_TYPE && typeof entry.data?.mode === "string") mode = entry.data.mode;
  }
  return mode;
}
function customModeKeys(): string[] {
  try {
    if (!existsSync(modeDir())) return [];
    return readdirSync(modeDir()).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
  } catch {
    return [];
  }
}
function saveMode(mode: ModeDef) {
  mkdirSync(modeDir(), { recursive: true });
  writeFileSync(modePath(mode.key), JSON.stringify(mode, null, 2) + "\n", "utf8");
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function removeSectionByHeading(prompt: string, heading: string): string {
  const h = escapeRegex(heading);
  return prompt.replace(new RegExp(`\\n?#{1,3}\\s+${h}\\s*\\n[\\s\\S]*?(?=\\n#{1,3}\\s+|$)`, "gi"), "\n").trim();
}
function removePromptSections(prompt: string, sections: string[] | undefined): string {
  let next = prompt;
  for (const section of sections ?? []) {
    if (section === "date") next = next.replace(/^Current date:.*$/gim, "").trim();
    else if (section === "cwd") next = next.replace(/^Current working directory:.*$/gim, "").trim();
    else for (const heading of SECTION_HEADINGS[section] ?? []) next = removeSectionByHeading(next, heading);
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}
function buildClaudeCodeModeSystemPrompt(mode: ModeDef, event: any): string {
  const removed = new Set(mode.removeSections ?? []);
  const parts: string[] = ["You are Claude Code, Anthropic's official CLI for Claude."];

  if (mode.systemPrompt?.trim()) {
    parts.push(mode.systemPrompt.trim());
  } else {
    const extra = [mode.opener, mode.appendix].filter(Boolean).join("\n\n").trim();
    if (extra) parts.push("# Current prompt mode: " + mode.label + "\n" + extra);
  }

  if (!removed.has("append_prompt")) {
    const append = String(event.systemPromptOptions?.appendSystemPrompt ?? "").trim();
    if (append) parts.push("# Additional instructions\n" + append);
  }

  if (!removed.has("project_context")) {
    const contextFiles = event.systemPromptOptions?.contextFiles ?? [];
    if (Array.isArray(contextFiles) && contextFiles.length > 0) {
      const context = contextFiles
        .map((file: any) => `## ${file.path}\n\n${String(file.content ?? "").trim()}`)
        .join("\n\n");
      if (context.trim()) parts.push("# Project Context\n\nProject-specific instructions and guidelines:\n\n" + context);
    }
  }

  if (!removed.has("cwd")) {
    const cwd = event.systemPromptOptions?.cwd;
    if (cwd) parts.push("Current working directory: " + String(cwd).replace(/\\/g, "/"));
  }
  if (!removed.has("date")) {
    const now = new Date();
    parts.push("Current date: " + now.toISOString().slice(0, 10));
  }
  return parts.filter((part) => part.trim()).join("\n\n");
}

function updateModeStatus(ctx: any, modeKey: string) {
  const mode = loadModes().find((m) => m.key === modeKey);
  const label = mode?.label || modeKey;
  ctx.ui.setStatus("mode", ctx.ui.theme.fg("accent", `mode:${label}`));
}

async function selectModeFuzzy(ctx: any, title: string, modes: ModeDef[], activeMode: string): Promise<string | null> {
  type Item = { mode: ModeDef; haystack: string; score: number };

  return await ctx.ui.custom<string | null>((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const input = new Input();
    input.focused = true;
    let selected = 0;
    let cachedLines: string[] | undefined;

    const textOf = (m: ModeDef) => (m.opener || m.appendix || m.systemPrompt || "").replace(/\s+/g, " ").trim();
    const baseItems: Item[] = modes.map((mode) => ({
      mode,
      haystack: `${mode.key} ${mode.label} ${textOf(mode)}`.toLowerCase(),
      score: 0,
    }));

    function fuzzyScore(query: string, haystack: string): number {
      if (!query) return 1;
      let qi = 0;
      let score = 0;
      let streak = 0;
      for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
        if (haystack[hi] !== query[qi]) { streak = 0; continue; }
        streak++;
        score += 4 + streak * 3 - Math.min(hi, 40) * 0.02;
        qi++;
      }
      return qi === query.length ? score : -1;
    }

    function filtered(): Item[] {
      const query = input.getValue().trim().toLowerCase();
      return baseItems
        .map((item) => ({ ...item, score: fuzzyScore(query, item.haystack) }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score || a.mode.key.localeCompare(b.mode.key));
    }
    function clampSelected(items = filtered()) {
      selected = items.length ? Math.max(0, Math.min(items.length - 1, selected)) : 0;
    }
    function visibleItemCount(): number {
      const rows = process.stdout.rows || 30;
      return Math.max(3, Math.floor((rows * 0.75 - 9) / 2));
    }
    function visibleWindow(items: Item[]) {
      const count = visibleItemCount();
      const start = Math.max(0, Math.min(selected - count + 1, items.length - count));
      return { start, end: Math.min(items.length, start + count), count };
    }

    function refresh() { cachedLines = undefined; tui.requestRender(); }
    function select(delta: number) {
      const items = filtered();
      selected = items.length ? Math.max(0, Math.min(items.length - 1, selected + delta)) : 0;
      refresh();
    }
    function submit() {
      const item = filtered()[selected];
      if (item) done(item.mode.key);
    }
    function pad(line: string, width: number) {
      return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }
    function panel(line: string, width: number) {
      return theme.bg("customMessageBg", pad(truncateToWidth(line, width), width));
    }
    function add(lines: string[], width: number, line = "") {
      lines.push(panel(line, width));
    }

    input.onSubmit = submit;
    input.onEscape = () => done(null);

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(null); return; }
      if (matchesKey(data, Key.enter)) { submit(); return; }
      if (matchesKey(data, Key.up)) { select(-1); return; }
      if (matchesKey(data, Key.down)) { select(1); return; }

      input.handleInput(data);
      selected = 0;
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const inner = Math.max(40, width - 4);
      const items = filtered();
      clampSelected(items);
      const { start, end } = visibleWindow(items);
      const visible = items.slice(start, end);
      const lines: string[] = [];

      add(lines, width, theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮"));
      add(lines, width, theme.fg("accent", `│ ${title}`) + theme.fg("dim", " — fuzzy search, ↑↓, Enter, Esc"));
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      add(lines, width, theme.fg("muted", "│ Search"));
      for (const line of input.render(inner)) add(lines, width, theme.fg("accent", "│ ") + line);
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      if (visible.length === 0) {
        add(lines, width, theme.fg("warning", "│ No matching modes"));
      } else {
        for (let i = 0; i < visible.length; i++) {
          const itemIndex = start + i;
          const mode = visible[i].mode;
          const isSelected = itemIndex === selected;
          const cursor = isSelected ? theme.fg("accent", "❯") : " ";
          const current = mode.key === activeMode ? theme.fg("success", " current") : "";
          const title = `${mode.key} — ${mode.label}`;
          add(lines, width, `│ ${cursor} ${isSelected ? theme.fg("accent", title) : theme.fg("text", title)}${current}`);

          const desc = textOf(mode);
          if (desc) add(lines, width, theme.fg("muted", `│     ${truncateToWidth(desc, inner - 5)}`));
        }
      }

      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      const range = items.length ? `showing ${start + 1}-${end}` : "showing 0";
      add(lines, width, theme.fg("dim", `│ ${items.length} match${items.length === 1 ? "" : "es"} / ${modes.length} modes • ${range}`));
      add(lines, width, theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

      cachedLines = lines;
      return lines;
    }

    return {
      get focused() { return true; },
      set focused(value: boolean) { input.focused = value; },
      render,
      invalidate: () => { cachedLines = undefined; input.invalidate(); },
      handleInput,
    };
  }, { overlay: true, overlayOptions: { width: "75%", maxHeight: "80%", minWidth: 64 } });
}

async function openModeForm(ctx: any, initial: ModeDef): Promise<ModeDef | null> {
  const sections = [...SYSTEM_PROMPT_SECTIONS];

  return await ctx.ui.custom<ModeDef | null>((tui: any, theme: any, _keybindings: any, done: (value: ModeDef | null) => void) => {
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };

    const fieldNames = ["key", "label", "opener", "systemPrompt", "appendix", "removeSections"] as const;
    type FieldName = typeof fieldNames[number];
    const labels: Record<FieldName, string> = {
      key: "Key",
      label: "Label",
      opener: "Opener",
      systemPrompt: "System Prompt",
      appendix: "Appendix",
      removeSections: "Remove Sections",
    };
    let active = 0;
    let checklistIndex = 0;
    let cachedLines: string[] | undefined;
    let outerFocused = true;
    const selectedSections = new Set(initial.removeSections ?? []);

    const editors: Record<Exclude<FieldName, "removeSections">, Editor> = {
      key: new Editor(tui, editorTheme),
      label: new Editor(tui, editorTheme),
      opener: new Editor(tui, editorTheme),
      systemPrompt: new Editor(tui, editorTheme),
      appendix: new Editor(tui, editorTheme),
    };
    editors.key.setText(initial.key ?? "");
    editors.label.setText(initial.label ?? "");
    editors.opener.setText(initial.opener ?? "");
    editors.systemPrompt.setText(initial.systemPrompt ?? "");
    editors.appendix.setText(initial.appendix ?? "");
    for (const editor of Object.values(editors)) editor.disableSubmit = true;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }
    function activeField(): FieldName { return fieldNames[active]; }
    function moveTab(delta: number) {
      active = (active + delta + fieldNames.length) % fieldNames.length;
      refresh();
    }
    function currentMode(): ModeDef | null {
      const key = slugifyKey(editors.key.getExpandedText());
      const label = editors.label.getExpandedText().trim();
      const opener = editors.opener.getExpandedText().trim();
      const systemPrompt = editors.systemPrompt.getExpandedText().trim();
      const appendix = editors.appendix.getExpandedText().trim();
      const removeSections = sections.filter((s) => selectedSections.has(s));
      return valid({ key, label, opener, systemPrompt, appendix, removeSections });
    }

    function save() {
      const mode = currentMode();
      if (!mode) return;
      done(mode);
    }

    function pad(line: string, width: number) {
      return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }
    function panel(line: string, width: number) {
      return theme.bg("customMessageBg", pad(truncateToWidth(line, width), width));
    }
    function add(lines: string[], width: number, line = "") {
      lines.push(panel(line, width));
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(null); return; }
      if (matchesKey(data, Key.ctrl("s"))) { save(); return; }
      if (matchesKey(data, Key.tab)) { moveTab(1); return; }
      if (matchesKey(data, Key.shift("tab"))) { moveTab(-1); return; }

      if (activeField() === "removeSections") {
        if (matchesKey(data, Key.up)) checklistIndex = Math.max(0, checklistIndex - 1);
        else if (matchesKey(data, Key.down)) checklistIndex = Math.min(sections.length - 1, checklistIndex + 1);
        else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
          const section = sections[checklistIndex];
          if (selectedSections.has(section)) selectedSections.delete(section);
          else selectedSections.add(section);
        }
        refresh();
        return;
      }

      const editor = editors[activeField() as Exclude<FieldName, "removeSections">];
      editor.handleInput(data);
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      for (const [name, editor] of Object.entries(editors)) editor.focused = outerFocused && name === activeField();

      const lines: string[] = [];
      const inner = Math.max(40, width - 4);
      add(lines, width, theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮"));
      add(lines, width, theme.fg("accent", "│ Edit prompt mode") + theme.fg("dim", " — Tab/Shift+Tab fields, Ctrl+S save, Esc cancel"));
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      const tabLine = fieldNames.map((name, i) => {
        const label = ` ${labels[name]} `;
        return i === active ? theme.bg("selectedBg", theme.fg("accent", label)) : theme.fg("muted", label);
      }).join(" ");
      add(lines, width, "│ " + tabLine);
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      const field = activeField();
      add(lines, width, theme.fg("accent", `│ ${labels[field]}`));
      add(lines, width, theme.fg("dim", "│ " + (field === "removeSections" ? "↑↓ move • Space toggle" : "Edit text. Tab moves to the next field.")));
      add(lines, width, "│");

      if (field === "removeSections") {
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const cursor = i === checklistIndex ? theme.fg("accent", "❯") : " ";
          const check = selectedSections.has(section) ? theme.fg("success", "☑") : theme.fg("muted", "☐");
          const text = i === checklistIndex ? theme.fg("accent", section) : theme.fg("text", section);
          add(lines, width, `│ ${cursor} ${check} ${text}`);
        }
      } else {
        const editor = editors[field];
        const maxEditorLines = Math.max(6, process.stdout.rows ? process.stdout.rows - 14 : 18);
        const editorLines = editor.render(inner);
        for (const line of editorLines.slice(0, maxEditorLines)) add(lines, width, theme.fg("accent", "│ ") + line);
        if (editorLines.length > maxEditorLines) add(lines, width, theme.fg("dim", `│ … ${editorLines.length - maxEditorLines} more editor lines hidden`));
      }

      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      const mode = currentMode();
      if (!mode) add(lines, width, theme.fg("warning", "│ Invalid mode: key, label, and opener, appendix, or systemPrompt are required."));
      else add(lines, width, theme.fg("success", `│ Will save: ${mode.key} — ${mode.label}`));
      add(lines, width, theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));
      cachedLines = lines;
      return lines;
    }

    return {
      get focused() { return outerFocused; },
      set focused(value: boolean) { outerFocused = value; for (const [name, editor] of Object.entries(editors)) editor.focused = value && name === activeField(); },
      render,
      invalidate: () => { cachedLines = undefined; },
      handleInput,
    };
  }, { overlay: true, overlayOptions: { width: "82%", maxHeight: "85%", minWidth: 64 } });
}

export default function(pi: ExtensionAPI) {
  let activeMode = "coding";
  pi.registerCommand("mode", {
    description: "Switch prompt mode",
    getArgumentCompletions: (prefix: string) => loadModes().filter((m) => m.key.startsWith(prefix.trim().toLowerCase())).map((m) => ({ value: m.key, label: m.label, opener: m.opener, appendix: m.appendix, systemPrompt: m.systemPrompt, removeSections: m.removeSections })),
    handler: async (args, ctx) => {
      const modes = loadModes();
      let key = args.trim().toLowerCase();
      if (!key) {
        const choice = await selectModeFuzzy(ctx, "Select prompt mode", modes, activeMode);
        if (!choice) {
          ctx.ui.notify("Current mode: " + activeMode + ". Available: " + modes.map((m) => m.key).join(", "), "info");
          return;
        }
        key = choice.trim().toLowerCase();
      }
      const mode = modes.find((m) => m.key === key);
      if (!mode) { ctx.ui.notify("Unknown mode: " + key + ". Available: " + modes.map((m) => m.key).join(", "), "error"); return; }
      activeMode = mode.key;
      pi.appendEntry(CUSTOM_TYPE, { mode: mode.key });
      updateModeStatus(ctx, activeMode);
      ctx.ui.notify("Mode: " + mode.label, "info");
    },
  });

  pi.registerCommand("mode-new", {
    description: "Create a prompt mode from the TUI",
    handler: async (args, ctx) => {
      const key = slugifyKey(args.trim() || "new-mode");
      const mode = await openModeForm(ctx, { key, label: key, opener: "" });
      if (!mode) return;

      if (existsSync(modePath(mode.key))) {
        const overwrite = await ctx.ui.confirm("Overwrite mode?", `${modePath(mode.key)} already exists.`);
        if (!overwrite) return;
      }

      saveMode(mode);
      activeMode = mode.key;
      pi.appendEntry(CUSTOM_TYPE, { mode: mode.key });
      updateModeStatus(ctx, activeMode);
      ctx.ui.notify(`Created and switched to mode: ${mode.label}`, "success");
    },
  });

  pi.registerCommand("mode-edit", {
    description: "Edit a custom prompt mode JSON",
    getArgumentCompletions: (prefix: string) => customModeKeys().filter((key) => key.startsWith(prefix.trim().toLowerCase())).map((key) => ({ value: key, label: key })),
    handler: async (args, ctx) => {
      let key = args.trim().toLowerCase();
      if (!key) {
        const customKeys = new Set(customModeKeys());
        const choice = await selectModeFuzzy(ctx, "Edit custom mode", loadModes().filter((m) => customKeys.has(m.key)), activeMode);
        if (!choice) return;
        key = choice;
      }

      const path = modePath(key);
      if (!existsSync(path)) { ctx.ui.notify(`Custom mode not found: ${key}`, "error"); return; }

      let initial: ModeDef | null = null;
      try { initial = valid(JSON.parse(readFileSync(path, "utf8"))); } catch (err: any) { ctx.ui.notify(`Invalid JSON: ${err.message}`, "error"); return; }
      if (!initial) { ctx.ui.notify("Invalid mode. Required: key, label, and opener or systemPrompt.", "error"); return; }

      const mode = await openModeForm(ctx, initial);
      if (!mode) return;

      saveMode(mode);
      if (mode.key !== key) unlinkSync(path);
      ctx.ui.notify(`Saved mode: ${mode.key}`, "success");
    },
  });

  pi.registerCommand("mode-delete", {
    description: "Delete a custom prompt mode",
    getArgumentCompletions: (prefix: string) => customModeKeys().filter((key) => key.startsWith(prefix.trim().toLowerCase())).map((key) => ({ value: key, label: key })),
    handler: async (args, ctx) => {
      let key = args.trim().toLowerCase();
      if (!key) {
        const customKeys = new Set(customModeKeys());
        const choice = await selectModeFuzzy(ctx, "Delete custom mode", loadModes().filter((m) => customKeys.has(m.key)), activeMode);
        if (!choice) return;
        key = choice;
      }

      const path = modePath(key);
      if (!existsSync(path)) { ctx.ui.notify(`Custom mode not found: ${key}`, "error"); return; }
      if (!await ctx.ui.confirm("Delete mode?", path)) return;

      unlinkSync(path);
      if (activeMode === key) {
        activeMode = "coding";
        pi.appendEntry(CUSTOM_TYPE, { mode: activeMode });
        updateModeStatus(ctx, activeMode);
      }
      ctx.ui.notify(`Deleted mode: ${key}`, "success");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    activeMode = modeFromEntries(ctx.sessionManager.getEntries());
    updateModeStatus(ctx, activeMode);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    activeMode = modeFromEntries(ctx.sessionManager.getEntries());
    const mode = loadModes().find((m) => m.key === activeMode);
    if (!mode) return;
    if (ctx.model?.provider === "claude-code") {
      return { systemPrompt: buildClaudeCodeModeSystemPrompt(mode, event) };
    }

    let systemPrompt = mode.systemPrompt?.trim() ? mode.systemPrompt : removePromptSections(event.systemPrompt, mode.removeSections);
    const extra = [mode.systemPrompt?.trim() ? "" : mode.opener, mode.appendix].filter(Boolean).join("\n\n").trim();
    if (extra) systemPrompt += "\n\n# Current prompt mode: " + mode.label + "\n" + extra;
    return { systemPrompt };
  });
}
