#!/usr/bin/env node
// The computer-use bench [D2032]: T1–T8 of the FreeLogo report, each run by a fresh Claude on one
// tool, scored against the fixture's own event log, not the agent's words.
//
//   node drills/computer-bench/bench.mjs <computer|browser|playwright> [runs=3] [T1,T2,…]
//
//   computer    `brigadier computer` on Chrome for Testing. BIN=<dir with the brigadier to test>;
//               BRIGADIER_DATA/SESSION/GRANT name a worker session there (computer use runs only in
//               workers). Settings › Computer use › Web pages in Brigadier's browser must be off, or
//               every action is sent to `brigadier browser`, as the switch means.
//   browser     `brigadier browser`, in the running app, on the caller's own session.
//   playwright  Playwright MCP, headless and isolated: the baseline.
//
// MODEL (default claude-haiku-5-5) and EFFORT (default medium) are the same for every tool. Each
// run appends a JSON line to $OUT/<tool>.jsonl (default /tmp/computer-bench); the last thing printed
// is the table of every tool run so far.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { serve } from './server.mjs'

const tool = process.argv[2]
const RUNS = Number(process.argv[3] ?? 3)
const ONLY = process.argv[4]?.split(',')
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5'
const EFFORT = process.env.EFFORT ?? 'medium'
const OUT = process.env.OUT ?? '/tmp/computer-bench'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const PROFILE = process.env.CHROME_PROFILE ?? '/tmp/bcu/chrome'
const PW_MCP = process.env.PW_MCP // path to @playwright/mcp's cli.js
// Chrome's headless shell, so the baseline never shows as a second Chrome for Testing to computer use.
const PW_CHROME = process.env.PW_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const LIMIT = 6 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PORT = { computer: 8765, browser: 8766, playwright: 8767 }[tool]
if (!PORT) { console.error('tool: computer, browser or playwright'); process.exit(2) }
const base = `http://localhost:${PORT}`

// Each task: where it starts, what the agent is told, and what in the log means it passed.
const has = (ev, o) => ev.some((e) => e.kind === 'state' && Object.entries(o).every(([k, v]) => e[k] === v))
const TASKS = {
  T1: { start: '/home', ask: `Go to ${base}/target by typing it in the browser's address bar, then confirm the page you reached.`,
    pass: (ev) => has(ev, { reached: 'target' }) },
  T2: { start: '/home', ask: 'Click the "Plastic Cards" card. Say whether the page changed, and what changed.',
    // Reached, and no call said otherwise: a "no change seen" on the change fails it.
    pass: (ev, run) => ev.some((e) => e.kind === 'page' && e.path === '/templates/plastic') && !run.falseNoChange && !run.emptyChange },
  T3: { start: '/templates/plastic', ask: 'Click "Start designing", select "Logo 3" in the list of logos, then click "Use this logo".',
    pass: (ev) => has(ev, { used: 'Logo 3' }) },
  T4: { start: '/templates/plastic?consent=1', ask: 'Click "Start designing", select "Logo 3" in the list of logos, then click "Use this logo". If a privacy or cookie panel is in the way you may dismiss it.',
    // Done with the panel dealt with: dismissed, or reported as covering the list.
    pass: (ev, run) => has(ev, { used: 'Logo 3' }) && (has(ev, { consent: 'dismissed' }) || run.covered > 0) },
  T5: { start: '/templates/plastic', ask: 'Click "Start designing", scroll the list of logos to the last one, select it, then click "Use this logo".',
    pass: (ev) => has(ev, { used: 'Logo 12' }) },
  T6: { start: '/editor', ask: 'Change the "Card name" field to "Bench card", then go back to the dashboard. If the page asks about unsaved changes, leave without saving.',
    pass: (ev) => has(ev, { guard: 'leave' }) && has(ev, { reached: 'dashboard' }) },
  T7: { start: '/home', ask: 'Click the "Plastic Cards" card, then take a screenshot. Click "Start designing", then take a screenshot. Select "Logo 2", then take a screenshot. Say what each screenshot shows.',
    pass: (ev, run) => has(ev, { selected: 'Logo 2' }) && run.shots.length >= 3 && run.stale === 0 },
  T8: { start: '/home', ask: 'Click "Open preview window". In the preview window that opens, click "Approve". Then, in the first window, click "Finish".',
    pass: (ev) => has(ev, { approved: 'clicked' }) && has(ev, { finished: true }) },
}

// What reads, by tool: everything else the agent calls counts as an action.
const READS = {
  computer: /^brigadier computer\s+(read|screenshot|windows|apps|--help|help)\b/,
  browser: /^brigadier browser\s+(snapshot|screenshot|tabs|events|wait|--help|help)\b/,
  playwright: /browser_(snapshot|take_screenshot|console_messages|network_requests|tabs|wait_for)/,
}

const ARM = {
  computer: {
    intro: 'You work a Chrome for Testing window on this Mac with the `brigadier computer` command; run `brigadier computer --help` first. The page is already open in it.',
    args: ['--allowedTools', 'Bash(brigadier computer:*)'],
    env: { PATH: `${process.env.BIN ?? ''}:${process.env.PATH}` },
    async setup(url) {
      spawnSync('pkill', ['-f', `user-data-dir=${PROFILE}`])
      await sleep(2000)
      spawn(CHROME, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', url], { detached: true, stdio: 'ignore' }).unref()
      await sleep(4000)
    },
  },
  browser: {
    intro: 'You work a web page with the `brigadier browser` command; run `brigadier browser --help` first. Open the start page with it first.',
    args: ['--allowedTools', 'Bash(brigadier browser:*)'],
    env: {},
    async setup() {},
    async teardown() {
      const r = spawnSync('brigadier', ['browser', 'tabs', '--json'], { encoding: 'utf8' })
      for (const t of JSON.parse(r.stdout || '{}').result?.tabs ?? []) spawnSync('brigadier', ['browser', 'close', '--tab', String(t.id)])
    },
  },
  playwright: {
    intro: 'You work a web browser with the Playwright tools. Open the start page with them first.',
    args: ['--allowedTools', 'mcp__playwright', '--mcp-config', JSON.stringify({ mcpServers: { playwright: { command: 'node', args: [PW_MCP, '--headless', '--isolated', '--executable-path', PW_CHROME] } } })],
    env: {},
    async setup() {},
  },
}[tool]
if (tool === 'playwright' && !PW_MCP) { console.error('PW_MCP=<path to @playwright/mcp cli.js>'); process.exit(2) }

// One agent run: its calls as they came, timed here, so the log can judge each report.
function agent(prompt) {
  return new Promise((done) => {
    const args = ['-p', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--model', MODEL, '--effort', EFFORT, '--output-format', 'stream-json', '--verbose', ...ARM.args, '--', prompt]
    const cwd = fs.mkdtempSync('/tmp/bench-cwd-')
    const p = spawn('claude', args, { cwd, env: { ...process.env, ...ARM.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const calls = new Map()
    let buf = '', result = null, said = ''
    const kill = setTimeout(() => p.kill('SIGTERM'), LIMIT)
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m; try { m = JSON.parse(line) } catch { continue }
        const at = Date.now()
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_use') calls.set(c.id, { name: c.name, cmd: c.input?.command ?? c.name, input: c.input, from: at })
          if (c.type === 'tool_result' && calls.has(c.tool_use_id)) {
            const call = calls.get(c.tool_use_id)
            const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }]
            call.to = at
            call.text = parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
            call.images = parts.filter((x) => x.type === 'image').map((x) => x.source?.data ?? '')
            call.error = !!c.is_error
          }
          if (c.type === 'text' && m.type === 'assistant') said = c.text
        }
        if (m.type === 'result') result = m
      }
    })
    let err = ''; p.stderr.on('data', (d) => (err += d))
    p.on('close', () => { clearTimeout(kill); fs.rmSync(cwd, { recursive: true, force: true }); done({ calls: [...calls.values()], result, said: said || err.slice(-400) }) })
  })
}

const hash = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
const changes = (ev, from, to) => ev.filter((e) => (e.kind === 'state' || e.kind === 'page') && e.at >= from && e.at <= to)

// A run's figures, from its calls and the page's log.
function score(name, task, a, ev) {
  const run = { tool, task: name, model: MODEL, effort: EFFORT, ms: a.result?.duration_ms ?? null, turns: a.result?.num_turns ?? null, cost: a.result?.total_cost_usd ?? null }
  // Each command of a shell line counts: `read && click 3 && click 4` is a read and two actions.
  const steps = a.calls.flatMap((c) => tool === 'playwright' ? [c.cmd] : String(c.cmd).split(/&&|\|\||;|\n/).map((x) => x.trim()).filter((x) => x.startsWith('brigadier ')))
  run.calls = steps.length
  run.reads = steps.filter((x) => READS[tool].test(x)).length
  run.actions = run.calls - run.reads
  run.denied = a.calls.filter((c) => c.error && /permission|denied|not allowed/i.test(c.text ?? '')).length
  // A "no change" while the page logged one inside the call; a "change observed" that lists nothing.
  run.falseNoChange = a.calls.filter((c) => /no change seen/i.test(c.text ?? '') && changes(ev, c.from - 250, c.to).length).length
  run.emptyChange = a.calls.filter((c) => /change observed\.\s*(Changed:\s*)?$/.test((c.text ?? '').trim())).length
  run.covered = a.calls.filter((c) => /covered by/i.test(c.text ?? '')).length
  // Screenshots, hashed here: one is stale when it matches the last while the page changed between.
  run.shots = []
  for (const c of a.calls) {
    let h = null
    if (c.images?.length) h = hash(Buffer.from(c.images[0], 'base64'))
    else if (/screenshot/.test(c.cmd)) {
      // A path may hold spaces, as Library/Application Support does: up to its extension.
      const f = (c.text ?? '').match(/(\/[^\n"'`]+?\.(?:jpg|jpeg|png))\b/i)?.[1]
      if (f && fs.existsSync(f)) h = hash(fs.readFileSync(f))
    }
    if (h) run.shots.push({ h, at: c.to })
  }
  run.stale = run.shots.filter((s, i) => i > 0 && s.h === run.shots[i - 1].h && changes(ev, run.shots[i - 1].at, s.at).length).length
  run.pass = !!task.pass(ev, run)
  run.said = a.said.slice(0, 400)
  run.shots = run.shots.map((s) => s.h)
  return run
}

function table() {
  const rows = []
  for (const t of ['computer', 'browser', 'playwright']) {
    const f = path.join(OUT, `${t}.jsonl`)
    if (!fs.existsSync(f)) continue
    const runs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const k of Object.keys(TASKS)) {
      const r = runs.filter((x) => x.task === k)
      if (!r.length) continue
      const ok = r.filter((x) => x.pass)
      const sum = (key, of = r) => of.reduce((n, x) => n + (x[key] ?? 0), 0)
      rows.push(`| ${t} | ${k} | ${ok.length}/${r.length} | ${sum('falseNoChange')} / ${sum('emptyChange')} | ${sum('stale')} | ${ok.length ? (sum('actions', ok) / ok.length).toFixed(1) : '–'} | ${(sum('ms') / r.length / 1000).toFixed(0)} s |`)
    }
  }
  return ['| Tool | Task | Pass | False "no change" / empty "change observed" | Stale shots | Actions per pass | Mean time |', '|---|---|---|---|---|---|---|', ...rows].join('\n')
}

fs.mkdirSync(OUT, { recursive: true })
const server = await serve(PORT)
for (const [name, task] of Object.entries(TASKS)) {
  if (ONLY && !ONLY.includes(name)) continue
  for (let i = 0; i < RUNS; i++) {
    const url = base + task.start
    await fetch(`${base}/reset`)
    await ARM.setup(url)
    const start = tool === 'computer' ? '' : ` The start page is ${url}.`
    const a = await agent(`${ARM.intro}${start}\n\nTask: ${task.ask}\n\nWork on your own; nobody will answer questions. When you're done, say what you did and what you saw.`)
    await sleep(1000)
    const ev = await (await fetch(`${base}/events`)).json()
    const run = score(name, task, a, ev)
    run.i = i + 1
    fs.appendFileSync(path.join(OUT, `${tool}.jsonl`), JSON.stringify(run) + '\n')
    console.log(JSON.stringify({ tool, task: name, i: run.i, pass: run.pass, actions: run.actions, reads: run.reads, falseNoChange: run.falseNoChange, emptyChange: run.emptyChange, stale: run.stale, s: Math.round((run.ms ?? 0) / 1000) }))
    await ARM.teardown?.()
  }
}
server.close()
console.log(table())
