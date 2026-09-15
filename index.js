/**
 * pi-thinking-header — dsh-style thinking display for pi.
 *
 * What it does
 * ------------
 * Thinking blocks get a one-line header with an estimated token count:
 *
 *   Thinking (~2.50k tokens)
 *
 * - Expanded:  header line + full thinking text; while the block streams the
 *   header line stays byte-stable ("Thinking…") — pi's TUI redraws whole
 *   lines over the contiguous changed range, so any header change would
 *   redraw every earlier thinking line together with the latest one. The
 *   token count appears once the block settles.
 * - Collapsed: single line — header + a preview of the thinking content that
 *   follows dsh's ReasoningRow: while streaming it shows the LATEST line with
 *   the window pinned to its tail (leading ellipsis — the line "scrolls" as
 *   content arrives); when done it shows the FIRST line from its start
 *
 * Two modes (auto-detected at load time)
 * --------------------------------------
 * 1. FULL MODE — the companion bundle patch (install-patch.mjs) has patched the
 *    running pi installation. The patch implements everything per-message with
 *    width-aware truncation and click-to-toggle. This extension then stays
 *    completely inert to avoid double headers.
 *
 * 2. FALLBACK MODE (pure extension API) — used when the bundle is unpatched:
 *    - Expanded thinking: prepends a `Thinking (~N tokens)` header via a
 *      markdown transformer (correct per-block counts, works everywhere,
 *      survives pi updates). Same streaming-stable header as full mode: while
 *      `ctx.isStreaming` the header stays "Thinking…" and only the final
 *      count is shown once the block settles.
 *    - Collapsed thinking: updates the global hidden-thinking label on each
 *      assistant message with the latest count + preview. Limitation: pi's
 *      extension API only exposes ONE global label, so collapsed blocks in
 *      older transcript messages will show the most recent label. Run
 *      /thinking-header patch for per-message fidelity.
 *
 * Token counts are local estimates: ceil(chars / 4). The k-token decimal places
 * are configurable (default 2): /thinking-header decimals <0-6>, persisted to
 * <agentDir>/thinking-header.json ({"decimals": 2}). Both modes re-read the
 * file, so changes apply without restarting pi.
 */

import { execFile, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Companion installer (same package directory), executed by /thinking-header patch.
const INSTALLER_PATH = fileURLToPath(new URL("./install-patch.mjs", import.meta.url));

// Family-wide marker: ANY patch version owns header rendering end-to-end, so
// the extension must stay inert for all of them (avoids double headers). The
// /thinking-header patch migrates older patch versions to the current one.
const MARKER = "pi-thinking-header";

// ---------------- decimals config (shared with the bundle patch) -------------
// <agentDir>/thinking-header.json: { "decimals": 2 } — k-token decimal places.
// The bundle patch reads the same file at render time (mtime-cached), so both
// modes react to changes without restarting pi.
const DEFAULT_DECIMALS = 2;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, () => homedir())
  : join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "thinking-header.json");

const configCache = { mtime: -1n, value: {} };

function loadConfig() {
  try {
    // mtimeNs (BigInt) as cache key: ms-precision mtime can collide when a
    // config write lands in the same millisecond as the previous read.
    const st = statSync(CONFIG_PATH, { bigint: true });
    if (st.mtimeNs !== configCache.mtime) {
      let value = {};
      try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
      } catch {
        // unparsable config → treat as empty
      }
      configCache.mtime = st.mtimeNs;
      configCache.value = value;
    }
  } catch {
    // file missing → defaults (also drops cache entries for deleted files)
    configCache.mtime = -1n;
    configCache.value = {};
  }
  return configCache.value;
}

const getDecimals = () => {
  const d = loadConfig().decimals;
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6 ? d : DEFAULT_DECIMALS;
};

function saveDecimals(n) {
  let cfg = {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed;
  } catch {
    // no/invalid config → start fresh, keep nothing
  }
  cfg.decimals = n;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  configCache.mtime = -1n; // force re-read on next loadConfig()
}
// Unique fragment of AssistantMessageComponent#setHiddenThinkingLabel in the bundle
const COMPONENT_ANCHOR =
  "setHiddenThinkingLabel(label){this.hiddenThinkingLabel=label,this.lastMessage&&this.updateContent(this.lastMessage)}";

/**
 * Locate the running pi's bundle chunk that contains AssistantMessageComponent.
 * Returns { found: true, patched: boolean } or { found: false }.
 */
function probeBundle() {
  try {
    const bin = execSync("readlink -f $(which pi)", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (!bin.endsWith(join("dist", "bundle", "cli.js"))) return { found: false };
    const chunksDir = join(dirname(bin), "chunks");
    if (!existsSync(chunksDir)) return { found: false };
    for (const file of readdirSync(chunksDir)) {
      if (!file.endsWith(".js")) continue;
      const path = join(chunksDir, file);
      const src = readFileSync(path, "utf8");
      if (!src.includes(COMPONENT_ANCHOR)) continue;
      return { found: true, patched: src.includes(MARKER) };
    }
  } catch {
    // pi binary not resolvable — fall through
  }
  return { found: false };
}

// decimals: 0–6 (invalid values fall back to DEFAULT_DECIMALS); the setting is
// authoritative — no trailing-zero stripping, so decimals=2 renders 2.50k.
const formatTokens = (n, decimals = getDecimals()) =>
  n >= 1000 ? (n / 1000).toFixed(decimals) + "k" : String(n);

const firstLine = (text) => {
  for (const line of text.split("\n")) {
    if (line.trim()) return line.trim();
  }
  return "";
};

const lastLine = (text) => {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return "";
};

/** Visible-length estimate that counts CJK-wide chars as 2 columns. */
const visibleLength = (s) => {
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return n;
};

/** Truncate a preview so it fits `max` columns, appending an ellipsis when cut. */
const truncatePreview = (text, max) => {
  if (visibleLength(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return out + "…";
};

/** Tail variant: keep the END visible, prepending an ellipsis when cut
 *  (terminal equivalent of dsh's scrollLeft = scrollWidth - clientWidth). */
const tailPreview = (text, max) => {
  if (visibleLength(text) <= max) return text;
  const out = [];
  let width = 0;
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = chars[i].codePointAt(0) >= 0x2e80 ? 2 : 1;
    if (width + w > max - 1) break;
    out.push(chars[i]);
    width += w;
  }
  return "…" + out.reverse().join("");
};

/** Hidden-thinking label: count + preview (tail-following while streaming). */
const thinkingLabel = (blocks, running) => {
  const chars = blocks.reduce((n, c) => n + c.thinking.length, 0);
  let label = `Thinking (~${formatTokens(Math.ceil(chars / 4))} tokens)`;
  const text = running
    ? lastLine(blocks[blocks.length - 1].thinking)
    : firstLine(blocks[blocks.length - 1].thinking);
  if (text) label += " · " + (running ? tailPreview(text, 80) : truncatePreview(text, 80));
  return label;
};

export default function (pi) {
  // /thinking-header — single entry point for everything this package does:
  //   /thinking-header                    status overview + usage
  //   /thinking-header patch              apply/repair the full-mode bundle patch
  //   /thinking-header decimals           show the k-token decimal places
  //   /thinking-header decimals <0-6>     set + persist them (0-6, default 2)
  // Registered in BOTH modes. Fallback mode re-reads the config per label; the
  // bundle patch re-reads it per render (mtime-cached), so decimal changes
  // apply without restarting pi.
  const usage =
    "usage:\n" +
    "  /thinking-header                    status overview\n" +
    "  /thinking-header patch              apply/repair the full-mode patch\n" +
    "  /thinking-header decimals           show k-token decimal places\n" +
    "  /thinking-header decimals <0-6>     set them (persisted, applies live)";

  pi.registerCommand("thinking-header", {
    description:
      "pi-thinking-header: status / `patch` apply-repair full-mode patch / `decimals <0-6>` token-count decimals",
    getArgumentCompletions: (prefix) => {
      const p = (prefix ?? "").trimStart();
      if (p.includes(" ")) return null;
      const items = [
        { value: "patch", label: "apply/repair the full-mode bundle patch" },
        { value: "decimals", label: "k-token decimal places (0-6, default 2)" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(p));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);

      // ---- decimals subcommand -------------------------------------
      if (argv[0] === "decimals") {
        const raw = argv[1];
        if (raw === undefined) {
          ctx.ui.notify(
            `pi-thinking-header: decimals = ${getDecimals()} (default ${DEFAULT_DECIMALS})\n` +
              `config: ${CONFIG_PATH}\n` +
              "usage: /thinking-header decimals <0-6>",
            "info",
          );
          return;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 6) {
          ctx.ui.notify("pi-thinking-header: decimals must be an integer between 0 and 6", "error");
          return;
        }
        try {
          saveDecimals(n);
        } catch (err) {
          ctx.ui.notify(`pi-thinking-header: failed to save ${CONFIG_PATH}: ${err?.message ?? err}`, "error");
          return;
        }
        ctx.ui.notify(
          `pi-thinking-header: decimals = ${n} → saved to ${CONFIG_PATH}\n` +
            `e.g. Thinking (~${formatTokens(2500)} tokens)`,
          "info",
        );
        return;
      }

      // ---- patch subcommand: apply/repair the full-mode bundle patch ----
      if (argv[0] === "patch") {
        try {
          const state = probeBundle();
          if (!state.found) {
            ctx.ui.notify(
              "pi-thinking-header: could not locate the running pi installation (readlink -f $(which pi))",
              "error",
            );
            return;
          }
          if (state.patched) {
            ctx.ui.notify(
              `pi-thinking-header: full-mode patch already applied (v3.3) — decimals = ${getDecimals()}`,
              "info",
            );
            return;
          }
          const ok = await ctx.ui.confirm(
            "pi-thinking-header",
            "Apply the full-mode bundle patch to the running pi installation?\n" +
              "Modifies the installed bundle (a .bak backup is kept). Restart pi afterwards.",
          );
          if (!ok) return;
          const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [INSTALLER_PATH],
            { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
          );
          const out = (stdout + "\n" + stderr).trim();
          ctx.ui.notify("pi-thinking-header: patch applied.\n" + out, "info");
          ctx.ui.notify("pi-thinking-header: restart pi to load the patched renderer.", "warning");
        } catch (err) {
          const detail = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join("\n");
          ctx.ui.notify("pi-thinking-header: patch failed.\n" + detail, "error");
        }
        return;
      }

      // ---- unknown arg → usage -------------------------------------
      if (argv.length > 0) {
        ctx.ui.notify("pi-thinking-header: unknown argument.\n" + usage, "error");
        return;
      }

      // ---- no args → status overview + usage ----
      const state = probeBundle();
      const mode = !state.found
        ? "fallback (pi installation not detected)"
        : state.patched
          ? "full (bundle patch v3.3 applied)"
          : "fallback (bundle unpatched — /thinking-header patch enables full mode)";
      ctx.ui.notify(
        "pi-thinking-header\n" +
          `mode: ${mode}\n` +
          `decimals: ${getDecimals()} (default ${DEFAULT_DECIMALS})\n` +
          `config: ${CONFIG_PATH}\n` +
          usage,
        "info",
      );
    },
  });

  const bundle = probeBundle();
  if (bundle.found && bundle.patched) {
    // FULL MODE: the bundle patch owns rendering end-to-end (per-message labels,
    // width-aware single-line previews). Stay inert — a global label update here
    // would corrupt the patch's per-block counts.
    return;
  }

  // ---------------- FALLBACK MODE (pure extension API) ----------------

  // Expanded thinking: per-block header with token count. While the block is
  // still streaming the header MUST stay byte-stable ("Thinking…"): pi's TUI
  // diffs whole lines and rewrites the contiguous [firstChanged..lastChanged]
  // range, so any header change on every chunk would erase+redraw every
  // earlier thinking line together with the latest one. The token count
  // appears once the block settles (isStreaming flips to false).
  pi.registerMarkdownTransformer((markdown, ctx) => {
    if (ctx?.messageType !== "assistant-thinking") return markdown;
    const text = markdown.trim();
    if (!text) return markdown;
    if (ctx.isStreaming) return `*Thinking…*\n\n${markdown}`;
    return `*Thinking (~${formatTokens(Math.ceil(text.length / 4))} tokens)*\n\n${markdown}`;
  });

  // Collapsed thinking: pi exposes a single global label; keep it in sync with
  // the latest assistant message (count + one-line preview). While streaming
  // (message_update) the preview is the latest line tail-following dsh-style;
  // once the message settles (message_end) it returns to the first line.
  // Limitation: pi's extension API only exposes ONE global label, so collapsed
  // blocks in older transcript messages will show the most recent label. Run
  // /thinking-header patch for per-message fidelity. Re-setting the SAME label
  // is skipped: pi pushes the global label into every message component on
  // each set, so a no-op set would still rebuild all of them.
  let lastLabel = null;
  const updateLabel = async (message, ctx, running) => {
    try {
      if (!message || message.role !== "assistant") return;
      const blocks = (message.content ?? []).filter(
        (c) => c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim(),
      );
      if (blocks.length === 0) return;
      const label = thinkingLabel(blocks, running);
      if (label === lastLabel) return;
      lastLabel = label;
      ctx.ui.setHiddenThinkingLabel(label);
    } catch {
      // display-only; never break the session over a label
    }
  };

  pi.on("message_update", (event, ctx) => updateLabel(event?.message, ctx, true));
  pi.on("message_end", (event, ctx) => updateLabel(event?.message, ctx, false));
}
