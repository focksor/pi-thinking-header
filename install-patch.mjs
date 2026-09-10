#!/usr/bin/env node
/**
 * pi-thinking-header — FULL MODE installer (bundle patch, v3.2).
 *
 * Patches pi's AssistantMessageComponent for dsh-style thinking rendering:
 *
 *   Thinking (~2.50k tokens) · preview of the thinking content…
 *
 * - Expanded:  one-line header (token count) + full thinking text
 * - Collapsed: single line — header + content preview, truncated to the
 *              terminal width (CJK-aware); click or ctrl+t toggles
 * - Collapsed preview follows dsh's ReasoningRow: while streaming it shows
 *   the LATEST line with the window pinned to its tail (leading ellipsis —
 *   the single line "scrolls" as content arrives); when done it shows the
 *   FIRST line from its start (trailing ellipsis)
 * - Token count: local estimate ceil(chars / 4); live during streaming
 * - Decimals: k-token decimal places configurable (0–6, default 2) via
 *   <agentDir>/thinking-header.json {"decimals": 2}; read per render with an
 *   mtime cache, so changes apply without restarting pi. Same file the
 *   extension uses in fallback mode.
 *
 * The extension (index.js) detects this patch and stays inert while it is
 * applied; if pi is updated and the patch is gone, the extension's pure-API
 * fallback takes over automatically.
 *
 * Idempotent. Migrates a v1 patch automatically (restores the pristine
 * backup first). Re-run after `pi update` / `npm update -g`.
 *
 * Usage: node install-patch.mjs [path/to/chunk-*.js]
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

// ---------- anchors (verified against pi 0.85.1 minified bundle) ----------
// AssistantMessageComponent#setHiddenThinkingLabel — unique: InteractiveMode's
// version references defaultHiddenThinkingLabel; RPC's takes _label.
const ANCHOR1 =
  "setHiddenThinkingLabel(label){this.hiddenThinkingLabel=label,this.lastMessage&&this.updateContent(this.lastMessage)}";

// The minified bundle contains REAL newline bytes inside this template literal.
const NL = "\n";
const JOIN_TPL = "join(`" + NL + NL + "`)";

const MD_TAIL =
  ",this.outputPad,0,this.markdownTheme,{color:text=>theme.fg(\"thinkingText\",text),italic:!0}," +
  '{transform:createMarkdownTransform("assistant-thinking",this.isStreaming,this.markdownTransformers)})';

const HEADER_TEXT =
  'new Text(theme.italic(theme.fg("thinkingText",this.thinkingLabelText(thinkingBlocks))),this.outputPad,0)';

const ANCHOR2 =
  'thinkingComponent=hidden?new Text(theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel)),this.outputPad,0):new Markdown(thinkingBlocks.' +
  JOIN_TPL +
  MD_TAIL +
  ";";

// ---------- injected code ----------
// Current patch version; also the key for mode detection (family-wide) and
// migration ("any older family member → restore pristine backup, re-apply").
const CURRENT_MARKER = "pi-thinking-header:v3.2";

// Marker comment doubles as the extension's mode-detection key.
const HELPER =
  "/*pi-thinking-header:v3.2*/" +
  // decimals config: per-instance cache keyed on the config file's mtime
  // (mtimeNs BigInt — ns precision beats same-ms collisions). Lazy ??= init
  // (no class fields needed) + a reader that resolves
  // <agentDir>/thinking-header.json without any imports:
  // process.getBuiltinModule works inside ESM (Node >= 22.3; on older runtimes
  // the try/catch degrades to {} → default decimals).
  '_piCfg(){this._pthT??=0n,this._pthC??=null;try{let fs=process.getBuiltinModule("node:fs"),os=process.getBuiltinModule("node:os"),' +
  'p=(process.env.PI_CODING_AGENT_DIR||os.homedir()+"/.pi/agent")+"/thinking-header.json",st=fs.statSync(p,{bigint:!0});' +
  'if(st.mtimeNs!==this._pthT){let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}' +
  "this._pthT=st.mtimeNs,this._pthC=c}}catch{this._pthC=null}return this._pthC||{}}" +
  // One-line label: "Thinking (~2.50k tokens)" (prefix honours a custom label, minus trailing dots)
  // Decimals come from _piCfg(): integer 0–6 wins, anything else → 2. No
  // trailing-zero stripping: the setting is authoritative (2.50k stays 2.50k).
  'thinkingLabelText(blocks){let chars=0;for(let b of blocks)chars+=b.length;' +
  "let tokens=Math.ceil(chars/4),c=this._piCfg()," +
  'd=typeof c.decimals=="number"&&Number.isInteger(c.decimals)&&c.decimals>=0&&c.decimals<=6?c.decimals:2,' +
  'count=tokens>=1000?(tokens/1000).toFixed(d)+"k":""+tokens;' +
  'return this.hiddenThinkingLabel.replace(/\\.{3}$/,"")+" (~"+count+" tokens)"}' +
  // Collapsed state: plain-object component rendering ONE line:
  // label + " · " + preview, truncated to the render width (CJK-aware).
  // dsh ReasoningRow parity: running → latest non-empty line with the window
  // pinned to its tail (leading "…", i.e. scrollLeft=scrollWidth-clientWidth);
  // done → first non-empty line from its start (trailing "…", scrollLeft=0).
  "piThinkingCollapsed(blocks,running){let label=this.thinkingLabelText(blocks),self=this,text=\"\";" +
  'if(running){for(let i=blocks.length-1;i>=0&&!text;i--){let ls=blocks[i].split("\\n");for(let j=ls.length-1;j>=0;j--){let l=ls[j].trim();if(l){text=l;break}}}}' +
  'else{for(let b of blocks){let line=b.split("\\n").find(l=>l.trim());if(line){text=line.trim();break}}}' +
  "let vlen=s=>{let n=0;for(let ch of s)n+=ch.codePointAt(0)>=0x2e80?2:1;return n};" +
  "return {render(w){let inner=Math.max(8,w-self.outputPad*2),max=inner-vlen(label)-3;" +
  "if(max<1){let padTotal=inner-vlen(label);if(padTotal<0)padTotal=0;" +
  'return [" ".repeat(self.outputPad)+theme.italic(theme.fg("thinkingText",label))+" ".repeat(self.outputPad+padTotal)]}' +
  "let prev=text;" +
  "if(vlen(prev)>max){if(running){let out=[],n=0,cs=[...prev];for(let i=cs.length-1;i>=0;i--){let cw=cs[i].codePointAt(0)>=0x2e80?2:1;if(n+cw>max-1)break;out.push(cs[i]);n+=cw}prev=\"…\"+out.reverse().join(\"\")}" +
  "else{let out=\"\",n=0;for(let ch of prev){let cw=ch.codePointAt(0)>=0x2e80?2:1;if(n+cw>max-1)break;out+=ch;n+=cw}prev=out+\"…\"}}" +
  'let line=label+" · "+prev;let padTotal=inner-vlen(line);if(padTotal<0)padTotal=0;' +
  // v3.1: the returned plain object MUST implement invalidate() — MouseRegion
  // forwards lifecycle unconditionally (invalidate(){this.child.invalidate()}),
  // so a render-only object crashed pi on exit/mode-switch with
  // "this.child.invalidate is not a function". The object is stateless (render
  // output is computed fresh on every call), so a no-op invalidate is correct.
  'return [" ".repeat(self.outputPad)+theme.italic(theme.fg("thinkingText",line))+" ".repeat(self.outputPad+padTotal)]},invalidate(){}}}';

const PATCH2 =
  "thinkingComponent=hidden?this.piThinkingCollapsed(thinkingBlocks,this.isStreaming):" +
  "(()=>{let body=new Markdown(thinkingBlocks." +
  JOIN_TPL +
  MD_TAIL +
  ",box=new Container;" +
  "return box.addChild(" +
  HEADER_TEXT +
  "),box.addChild(body),box})();";

// ---------- safety net: parse-check before writing ----------
// Same ESM parser pi's loader uses (vm.SourceTextModule), never executes the
// code. A brace-counting mistake must abort the install, not brick pi.
function verifyESM(src) {
  const probe =
    'const vm=require("node:vm");let d="";' +
    'process.stdin.on("data",(c)=>d+=c).on("end",()=>{' +
    'try{new vm.SourceTextModule(d,{identifier:"candidate"});process.exit(0)}' +
    'catch(e){console.error(e.message);process.exit(1)}});';
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "-e", probe], {
    input: src,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error("Candidate bundle failed ESM parse check: " + (r.stderr || "unknown").trim());
  }
}

// ---------- locate target chunk ----------
function locateChunk() {
  if (process.argv[2]) return process.argv[2];
  const bin = execSync("readlink -f $(which pi)").toString().trim(); // <pkg>/dist/bundle/cli.js
  const chunksDir = join(dirname(bin), "chunks");
  for (const f of readdirSync(chunksDir)) {
    if (!f.endsWith(".js")) continue;
    const p = join(chunksDir, f);
    if (readFileSync(p, "utf8").includes(ANCHOR1)) return p;
  }
  throw new Error(`Could not find the AssistantMessageComponent chunk under ${chunksDir}`);
}

// ---------- apply (with v1 migration) ----------
const chunkPath = locateChunk();
const backup = chunkPath + ".pre-thinking-header.bak";
let src = readFileSync(chunkPath, "utf8");

// Distinctive tail of piThinkingCollapsed's returned object, with and without
// the v3.1 invalidate() fix. `padTotal)]}}}` can only match the final return —
// the max<1 branch ends with a single `}` before `let prev=text;` — and it
// does NOT occur inside TAIL_FIXED (there `)]` is followed by a single `}`
// then `,`). TAIL_FIXED closes, in order: render fn, the invalidate method
// body (inside its own `(){}`), the object literal, and finally the
// piThinkingCollapsed class method itself — four `}` after `]` in total.
const TAIL_BROKEN = "padTotal)]}}}";
const TAIL_FIXED = "padTotal)]},invalidate(){}}}";

if (src.includes(CURRENT_MARKER) && src.includes(TAIL_FIXED)) {
  console.log(`Already patched (v3.2): ${chunkPath}`);
  process.exit(0);
}

// Any older member of the patch family (v1/v2/v3/v3.1, detected via the family
// string or the v1/v2 helper name) → restore pristine, then re-apply fresh.
if (src.includes("pi-thinking-header") || src.includes("thinkingLabelText(")) {
  // Early v3 (pre-3.1) shipped a render-only collapsed component: MouseRegion
  // .invalidate crashed pi on exit/mode-switch ("this.child.invalidate is not
  // a function"). Without a pristine backup we cannot re-apply, so hotfix that
  // one shape in place; a later installer run (with a backup) migrates fully.
  if (src.includes(TAIL_BROKEN) && !existsSync(backup)) {
    src = src.replace(TAIL_BROKEN, TAIL_FIXED);
    if (!src.includes(TAIL_FIXED)) throw new Error("v3 → v3.1 hotfix failed");
    verifyESM(src);
    writeFileSync(chunkPath, src);
    console.log("Hotfixed (early v3 → v3.1): added missing invalidate() to the collapsed-thinking component");
    console.log(`File:         ${chunkPath}`);
    console.log("Re-run the installer to update the patch to v3.2 (configurable decimals).");
    process.exit(0);
  }
  if (!existsSync(backup)) {
    throw new Error("Older pi-thinking-header patch found but no pristine backup; reinstall pi, then re-run.");
  }
  src = readFileSync(backup, "utf8");
  console.log("Migrating: older pi-thinking-header patch detected, restored pristine bundle from backup.");
} else if (!existsSync(backup)) {
  copyFileSync(chunkPath, backup);
}

if (!src.includes(ANCHOR1)) throw new Error("ANCHOR1 not found (pi version changed?)");
if (!src.includes(ANCHOR2)) throw new Error("ANCHOR2 not found (pi version changed?)");

src = src.replace(ANCHOR1, ANCHOR1 + HELPER);
src = src.replace(ANCHOR2, PATCH2);

if (!src.includes(CURRENT_MARKER) || !src.includes("piThinkingCollapsed(") || !src.includes(TAIL_FIXED)) {
  throw new Error("Patch did not apply");
}

verifyESM(src);
writeFileSync(chunkPath, src);
console.log(`Patched (v3.2): ${chunkPath}`);
console.log(`Backup:       ${backup}`);
console.log("Revert with:  cp '" + backup + "' '" + chunkPath + "'");
