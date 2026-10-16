import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

/**
 * JARVIS CORE plugin.
 * - Puts node on PATH so bash tool works on this machine.
 * - Cuts huge tool outputs so they don't flood context (token savings).
 * - Slims verbose tool definitions (token savings).
 * - Tags sessions for observability.
 * - EMBEDDED VOICE (Tier 0): speaks assistant replies out loud via Windows
 *   SAPI (plugin/voice/voice-core.ps1). Streaming-friendly: buffers text
 *   parts, flushes on completion / 500+ chars / 3s idle / next tool part.
 *   Toggle anytime with `/tts on|off` (state.json), env JARVIS_TTS=off.
 */

const NODE_DIR = (process.env.USERPROFILE ?? "") + "\\tools\\node"
const MAX_TOOL_OUTPUT = 8000
const MAX_TITLE_LEN = 120

// ---------------------------------------------------------------------------
// Embedded voice (TTS) support
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === "win32"
const PS_EXE = (process.env.SystemRoot ?? "C:\\Windows") +
  "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const VOICE_ROOT = process.env.JARVIS_VOICE_ROOT ||
  path.join(process.env.USERPROFILE ?? "", "Desktop", "god", "plugin", "voice")
const VOICE_CORE = path.join(VOICE_ROOT, "voice-core.ps1")
const STATE_FILE = path.join(VOICE_ROOT, "state.json")
const SPEAK_FILE = path.join(VOICE_ROOT, ".speak.txt")

let ttsOk = false
let current = null as { child: import("node:child_process").ChildProcess } | null
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<string, string>() // part.id -> cumulative text

interface VoiceState { tts: boolean; voice?: string; rate?: number; volume?: number }

function loadState(): VoiceState {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, "utf8"))
      if (typeof j === "object" && typeof j.tts === "boolean") return j
    }
  } catch { /* fall through to default */ }
  // DEFAULT OFF: voice only speaks after an explicit `/tts on`.
  return { tts: process.env.JARVIS_TTS === "on" }
}

function removeFile(f: string) {
  try { rmSync(f, { force: true }) } catch { /* noop */ }
}

function killCurrentSpeak() {
  if (current) {
    current = null
    try {
      spawn(PS_EXE, ["-NoProfile", "-File", VOICE_CORE, "-Stop"],
        { stdio: "ignore", windowsHide: true })
    } catch { /* noop */ }
  }
}

// Speak text through Windows SAPI in a NEW powershell (single-flight:
// cancels any active speak first, mirrors speechSynthesis.cancel()).
// Re-reads state.json every call so `/tts` toggles apply live.
// force=true bypasses the /tts gate so an explicit `/speak` always works.
function speakText(text: string, force = false) {
  if (!IS_WIN || !text || !text.trim()) return false
  try {
    const st = loadState()
    if (!st.tts && !force) return false
    killCurrentSpeak()
    try { mkdirSync(VOICE_ROOT, { recursive: true }) } catch { /* noop */ }
    writeFileSync(SPEAK_FILE, text, "utf8")
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA",
      "-File", VOICE_CORE, "-SpeakFile", SPEAK_FILE]
    if (st.voice) args.push("-Voice", st.voice)
    if (typeof st.rate === "number") args.push("-Rate", String(st.rate))
    if (typeof st.volume === "number") args.push("-Volume", String(st.volume))
    const child = spawn(PS_EXE, args, { stdio: "ignore", windowsHide: true })
    current = { child }
    const done = () => {
      if (current?.child === child) current = null
      removeFile(SPEAK_FILE)
    }
    child.on("exit", done)
    child.on("error", done)
    return true
  } catch { return false }
}

// Enumerate installed Windows SAPI voices (used by /voices).
function listVoices(): Promise<string[]> {
  const script = "Add-Type -AssemblyName System.Speech; " +
    "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
    "ForEach-Object { $_.VoiceInfo.Name }"
  return new Promise((resolve) => {
    const out: string[] = []
    const child = spawn(PS_EXE, ["-NoProfile", "-STA", "-Command", script],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let buf = ""
    child.stdout?.on("data", (d: Buffer) => { buf += d.toString("utf8") })
    child.stderr?.on("data", () => { /* swallow */ })
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 10000)
    child.on("error", () => { clearTimeout(timer); resolve(out) })
    child.on("exit", () => {
      clearTimeout(timer)
      resolve(buf.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean))
    })
  })
}

function flushPart(id: string) {
  const t = pending.get(id)
  pending.delete(id)
  if (t && t.trim()) speakText(t)
}

function scheduleIdleFlush(id: string) {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; flushPart(id) }, 3000)
}

// ---------------------------------------------------------------------------
// Smart-pill memory briefing (Lever 1)
// Injects pill_context-style memory at session start by reading
// ~/.smart-pill/store.json + ledger.json directly. Plugins in 1.18.23 can only
// DEFINE tools, never CALL them, so a direct file read is the exact-parity
// path: with the first user message as the lexical topic it replicates
// searchMemory's lexical tier (100/50/30/10) and degrades the semantic tier
// exactly like a missing ONNX model. Any failure -> null -> silent skip.
// ---------------------------------------------------------------------------
const SP_LIMIT = 8
const SP_MAX_KEY = 200
const SP_MAX_VALUE = 600
const spHome = process.env.SMART_PILL_HOME ||
  path.join(homedir(), ".smart-pill")
const spStoreFile = path.join(spHome, "store.json")
const spLedgerFile = path.join(spHome, "ledger.json")
const briefedSessions = new Set<string>()

function readJsonFile(f: string): unknown {
  try {
    if (!existsSync(f)) return undefined
    return JSON.parse(readFileSync(f, "utf8"))
  } catch { return undefined }
}

function spEntryValue(e: unknown, key: string): string {
  if (e && typeof e === "object" && typeof (e as any).value === "string") {
    return (e as any).value as string
  }
  if (typeof e === "string") return e
  try { return JSON.stringify(e) } catch { return key }
}

// Mirrors smart-pill src/search.ts lexical tier: key exact 100 / key prefix
// 50 / key substring 30 / value-contains 10. Empty topic -> all score 0 in
// store insertion order (same as pill_context with no topic).
function lexTier(entries: Record<string, unknown>, topic: string, limit: number): Array<{ key: string; value: string; score: number }> {
  const t = topic.trim().toLowerCase()
  const hits: Array<{ key: string; value: string; score: number }> = []
  for (const [key, raw] of Object.entries(entries)) {
    const value = spEntryValue(raw, key)
    const k = key.toLowerCase()
    const v = value.toLowerCase()
    let score = 0
    if (t) {
      if (k === t) score = 100
      else if (k.startsWith(t)) score = 50
      else if (k.includes(t)) score = 30
      else if (v.includes(t)) score = 10
    }
    hits.push({ key: key.slice(0, SP_MAX_KEY), value: value.slice(0, SP_MAX_VALUE), score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

function spLedgerLines(): string[] {
  const json = readJsonFile(spLedgerFile) as any
  const events: any[] = Array.isArray(json?.events) ? json.events
    : Array.isArray(json) ? json : []
  const total = typeof json?.totalSavedTokens === "number"
    ? json.totalSavedTokens
    : events.reduce((s, e) => s + (Number(e?.savedTokens) || 0), 0)
  const byTool = new Map<string, number>()
  for (const e of events.slice(-200)) {
    const tool = String(e?.tool || "?")
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1)
  }
  const top = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const lines = [`LEDGER: ${total} tokens saved across ${events.length} events`]
  if (top.length) lines.push(`top tools: ${top.map(([t, n]) => `${t}×${n}`).join(", ")}`)
  return lines
}

// Returns null when smart-pill is not set up or anything fails.
function smartPillBriefing(topic: string): string | null {
  try {
    const store = readJsonFile(spStoreFile)
    if (!store || typeof store !== "object") return null
    const entries = store as Record<string, unknown>
    const keys = Object.keys(entries)
    if (!keys.length) return null
    const hits = lexTier(entries, topic, SP_LIMIT)
    const lines: string[] = []
    lines.push(`📚 SMART-PILL MEMORY (${keys.length} pills stored · session-start briefing)`)
    if (hits.length) {
      lines.push(topic
        ? `top ${hits.length} matches for "${topic.slice(0, 80)}":`
        : "latest pills:")
      for (const h of hits) {
        lines.push(`• ${h.key}${topic ? ` (${h.score})` : ""} — ${h.value}`)
      }
    } else {
      lines.push(`no pills matched "${topic.slice(0, 80)}"`)
    }
    lines.push(...spLedgerLines())
    const armed = !!process.env.OPENROUTER_API_KEY
    const model = process.env.SMART_PILL_ROUTE_MODEL || "anthropic/claude-3.7-sonnet"
    lines.push(armed ? `ROUTE: ${model} (ARMED)` : `ROUTE: ${model} (OFFLINE ADVISORY)`)
    return lines.join("\n")
  } catch {
    return null
  }
}

const plugin: Plugin = async () => {
  // warm up: create state.json so `/tts` has a stable home
  if (IS_WIN) {
    try {
      mkdirSync(VOICE_ROOT, { recursive: true })
      if (!existsSync(STATE_FILE)) {
        writeFileSync(STATE_FILE, JSON.stringify(
          { tts: process.env.JARVIS_TTS !== "off", voice: "", rate: 0, volume: 95 },
          null, 2) + "\n", "utf8")
      }
      ttsOk = true
    } catch { ttsOk = false }
  }

  return {
    "shell.env": async (_input, output) => {
      try {
        const env = output.env ?? {}
        const pathEnv = env.PATH ?? ""
        if (!pathEnv.includes("tools\\node") && !pathEnv.includes("tools/node")) {
          env.PATH = `${NODE_DIR};${pathEnv}`
        }
        env.JARVIS_MODE = "GOD"
        output.env = env
      } catch {
        /* never let the plugin break startup */
      }
    },

    // Register the Adobe Premiere Pro (prpr) MCP server so the AI can drive Premiere.
    "config": async (cfg) => {
      try {
        cfg.mcp = cfg.mcp ?? {}
        if (!cfg.mcp["prpr"]) {
          cfg.mcp["prpr"] = {
            type: "local",
            command: [
              "C:\\Users\\user\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
              "-m",
              "prpr.cli.main",
              "mcp",
              "serve",
            ],
            enabled: true,
            timeout: 120000,
          }
        }
      } catch {
        /* never break startup */
      }
    },

    "tool.execute.after": async (_input, output) => {
      try {
        if (typeof output.output !== "string") return
        if (output.output.length <= MAX_TOOL_OUTPUT) return
        output.output = output.output.slice(0, MAX_TOOL_OUTPUT) +
          `\n...[truncated by JARVIS: ${output.output.length} chars total]`
        if (output.title && output.title.length > MAX_TITLE_LEN) {
          output.title = output.title.slice(0, MAX_TITLE_LEN) + "..."
        }
      } catch {
        /* noop */
      }
    },

    "tool.definition": async (input, output) => {
      try {
        const short: Record<string, string> = {
          bash: "Run a shell command. Chain with `;` on Windows PowerShell. Use full paths.",
          read: "Read a file (text/image/pdf).",
          edit: "Replace exact text in a file. Must read first.",
          write: "Overwrite a file. Must read first if it exists.",
          glob: "Find files by pattern. Returns paths.",
          grep: "Search file contents with regex. Returns file:line.",
          list: "List a directory.",
          task: "Launch a subagent for parallel/background work.",
        }
        const d = short[input.toolID]
        if (d) output.description = d
      } catch {
        /* noop */
      }
    },

    // Lever 1: auto-load smart-pill memory at session start. Prepend a
    // briefing to the FIRST user message, deduped per sessionID.
    "chat.message": async (input: any, output: any) => {
      try {
        const msg = output?.message
        if (!msg || msg.role !== "user") return
        const sessionID = String(input?.sessionID ?? "")
        if (!sessionID || briefedSessions.has(sessionID)) return
        const partsArr: unknown[] = Array.isArray(output?.parts) ? output.parts : []
        if (!partsArr.length) return
        let topic = ""
        for (const p of partsArr) {
          if (p && typeof p === "object" && (p as any).type === "text" && typeof (p as any).text === "string") {
            topic = ((p as any).text as string).trim().slice(0, SP_MAX_KEY)
            if (topic) break
          }
        }
        const brief = smartPillBriefing(topic)
        if (!brief) return
        const prt = {
          id: "prt_" + crypto.randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 24),
          sessionID: (msg as any)?.sessionID ?? sessionID,
          messageID: (msg as any)?.id ?? input?.messageID ?? "",
          type: "text",
          text: brief,
        }
        ;(output.parts as any[]).unshift(prt)
        briefedSessions.add(sessionID)
      } catch {
        /* never break the session */
      }
    },

    event: async (input: any) => {
      // EMBEDDED VOICE: speak assistant text parts via Windows SAPI.
      // Buffer per part -> flush on finish / big delta / 3s idle / tool part.
      try {
        if (!ttsOk) return
        const ev = input?.event
        if (!ev || ev.type !== "message.part.updated") return
        const part = ev.properties?.part
        if (!part) return
        if (part.type !== "text") {
          // assistant finished speaking; next tool part = flush everything
          if (part.type === "tool") {
            for (const k of [...pending.keys()]) flushPart(k)
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
          }
          return
        }
        const text = part.text ?? ""
        if (!text) return
        if (part.finish?.reason) { pending.set(part.id, text); flushPart(part.id); return }
        const prev = pending.get(part.id) ?? ""
        if (text.length >= 500 && text !== prev) { pending.set(part.id, text); flushPart(part.id); return }
        pending.set(part.id, text)
        scheduleIdleFlush(part.id)
      } catch {
        /* voice must never break the session */
      }
    },

    // /tts | /speak | /voices — handled entirely here; consume the turn so the
    // LLM never sees these commands. output.parts is the caller's array: mutate
    // in place (length = 0 + push) — reassignment is ignored.
    "command.execute.before": async (input: any, output: any) => {
      try {
        const name = String(input?.command ?? "").replace(/^\//, "").toLowerCase()
        const args = String(input?.arguments ?? "").trim()
        const parts = output.parts ?? []
        const reply = (text: string) => { parts.length = 0; parts.push({ type: "text", text }) }

        if (name === "tts") {
          const st = loadState()
          const arg = (args || "status").toLowerCase()
          if (arg === "on") st.tts = true
          else if (arg === "off") { st.tts = false; killCurrentSpeak() }
          else if (arg === "toggle") { st.tts = !st.tts; if (!st.tts) killCurrentSpeak() }
          else if (arg === "status") { /* read-only */ }
          else { reply(`Unknown /tts option "${arg}" — use: on | off | toggle | status`); return }
          try {
            mkdirSync(VOICE_ROOT, { recursive: true })
            writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + "\n", "utf8")
          } catch { /* report state anyway */ }
          ttsOk = true
          const voice = st.voice?.trim() || "(default)"
          reply(`🔊 JARVIS TTS: ${st.tts ? "ON" : "OFF"} — voice ${voice} · rate ${st.rate ?? 0} · volume ${st.volume ?? 95}`)
          return
        }

        if (name === "speak") {
          if (!args) { reply("Usage: /speak <text to say aloud>"); return }
          const ok = speakText(args, true)
          reply(ok
            ? `🗣 Speaking ${args.length} chars aloud.`
            : `⚠ Cannot speak: TTS engine unavailable on ${IS_WIN ? "this host" : "non-Windows host"}. Set JARVIS_VOICE_ROOT if voice-core.ps1 lives elsewhere.`)
          return
        }

        if (name === "voices") {
          if (!IS_WIN) { reply("⚠ Voice listing requires Windows SAPI."); return }
          const voices = await listVoices()
          const st = loadState()
          const cur = st.voice?.trim() || "(default)"
          reply(`🎙 Installed SAPI voices:\n` +
            (voices.length ? voices.map((v, i) => `${i + 1}. ${v}`).join("\n") : "(none reported by SAPI)") +
            `\nCurrent: ${cur}`)
          return
        }
      } catch {
        /* never break the session */
      }
    },
  }
}

export default plugin