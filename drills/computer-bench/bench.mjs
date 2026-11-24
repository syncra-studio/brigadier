#!/usr/bin/env node
// The computer-use bench [D2032]: T1–T8 of the FreeLogo report, each run by a fresh Claude on one
// tool, scored against the fixture's own event log, not the agent's words.
//
//   node drills/computer-bench/bench.mjs <computer|browser|playwright> [runs=3] [T1,T2,…]
//
//   computer    `brigadier computer` on Chrome for Testing. Settings › Computer use › Web pages in
//               Brigadier's browser must be off, or every action is sent to `brigadier browser`, as
//               the switch means. Computer use runs only in workers: BRIGADIER_SESSION is one.
//   browser     `brigadier browser`, in the app running on BRIGADIER_DATA, for BRIGADIER_SESSION.
//   playwright  Playwright MCP, headless and isolated: the baseline.
//
// BIN=<dir with the brigadier to test> (else the one on PATH), with BRIGADIER_DATA/SESSION/GRANT.
// MODEL (default claude-haiku-5-5) and EFFORT (default medium) are the same for every tool. Each
// run appends a JSON line to $OUT/<tool>.jsonl (default /tmp/computer-bench) and keeps everything
// it was scored on in $OUT/raw/<tool>-<task>-<n>: the agent's stream, every `brigadier` call with
// its output, the page's log and the screenshots. Nothing is replaced: a run done again is another
// row, marked with RERUN="why". The last thing printed is the table of every tool run so far.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './server.mjs'

const tool = process.argv[2]
const RUNS = Number(process.argv[3] ?? 3)
const ONLY = process.argv[4]?.split(',')
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5'
const EFFORT = process.env.EFFORT ?? 'medium'
const OUT = process.env.OUT ?? '/tmp/computer-bench'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const PROFILE = process.env.CHROME_PROFILE ?? '/tmp/bcu/chrome'
const BRIGADIER = process.env.BIN ? path.join(process.env.BIN, 'brigadier') : spawnSync('which', ['brigadier'], { encoding: 'utf8' }).stdout.trim()
const PW_MCP = process.env.PW_MCP // path to @playwright/mcp's cli.js
// Chrome's headless shell, so the baseline never shows as a second Chrome for Testing to computer use.
const PW_CHROME = process.env.PW_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const LIMIT = 6 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PORT = { computer: 8765, browser: 8766, playwright: 8767 }[tool]
if (!PORT) { console.error('tool: computer, browser or playwright'); process.exit(2) }
const base = `http://localhost:${PORT}`

// One bench per tool at a time: round 1's first run shared its browser with an agent a killed bench
// had left behind, whose page it was scored on.
const lock = `/tmp/computer-bench-${tool}.pid`
try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); console.error(`a bench of ${tool} is running (${lock})`); process.exit(2) } catch {}
fs.writeFileSync(lock, String(process.pid))
const bin = fs.mkdtempSync('/tmp/bench-bin-')
let running = null
const stopAgent = (signal = 'SIGKILL') => {
  try { if (running) process.kill(-running.pid, signal) } catch {}
  // Its background commands have groups of their own.
  spawnSync('pkill', ['-f', bin])
}
process.on('exit', () => { stopAgent(); fs.rmSync(lock, { force: true }); fs.rmSync(bin, { recursive: true, force: true }) })
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(1))

// Each task: where it starts, what the agent is told, and what in the log means it passed. The
// last, T9, is not of the eight: it runs only by name.
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
    pass: (ev) => has(ev, { used: 'Logo 3' }),
    // Round 1's rule, kept beside it: done with the panel dismissed, or a call that said it covers.
    old: (ev, run) => has(ev, { used: 'Logo 3' }) && (has(ev, { consent: 'dismissed' }) || run.covered > 0) },
  T5: { start: '/templates/plastic', ask: 'Click "Start designing", scroll the list of logos to the last one, select it, then click "Use this logo".',
    pass: (ev) => has(ev, { used: 'Logo 12' }) },
  T6: { start: '/editor', ask: 'Change the "Card name" field to "Bench card", then go back to the dashboard. If the page asks about unsaved changes, leave without saving.',
    pass: (ev) => has(ev, { guard: 'leave' }) && has(ev, { reached: 'dashboard' }) },
  T7: { start: '/home', ask: 'Click the "Plastic Cards" card, then take a screenshot. Click "Start designing", then take a screenshot. Select "Logo 2", then take a screenshot. Say what each screenshot shows.',
    pass: (ev, run) => has(ev, { selected: 'Logo 2' }) && run.shots.length >= 3 && run.stale === 0 },
  T8: { start: '/home', ask: 'Click "Open preview window". In the preview window that opens, click "Approve". Then, in the first window, click "Finish".',
    pass: (ev) => has(ev, { approved: 'clicked' }) && has(ev, { finished: true }) },
  // A press that does nothing while a panel covers its button: the tool says what covers it.
  T9: { start: '/covered', extra: true, ask: 'Click "Open the offer", then click "Use coupon". If it does nothing, say what the tool told you about why.',
    pass: (ev, run) => run.covered > 0 },
}

// What reads, by tool: everything else the agent calls counts as an action.
const READS = {
  computer: /^(read|screenshot|windows|apps|help|--help)$/,
  browser: /^(snapshot|screenshot|tabs|events|wait|help|--help)$/,
  playwright: /browser_(snapshot|take_screenshot|console_messages|network_requests|tabs|wait_for)/,
}
// What a call says when the user's yes never came, which the bench never gives.
const ASKED = /No answer yet:|needs the user's yes|Run this script on/

const brigadier = (...args) => spawnSync(BRIGADIER, args, { encoding: 'utf8' })
// The session's tabs, less the windows their pages opened, which go with them.
const tabs = () => {
  const r = brigadier('browser', 'tabs', '--json')
  const all = JSON.parse(r.stdout || '{}').result?.tabs
  if (!all) throw new Error(`the session's tabs can't be listed: ${r.stdout}${r.stderr}`)
  return all.filter((t) => !t.window).map((t) => String(t.id))
}
// Its tabs from before the bench: never closed.
const before = tool === 'browser' ? new Set(tabs()) : null
const ARM = {
  computer: {
    intro: 'You work a Chrome for Testing window on this Mac with the `brigadier computer` command; run `brigadier computer --help` first. The page is already open in it.',
    args: ['--allowedTools', 'Bash(brigadier computer:*)', 'Read'],
    // Chrome starts afresh on the start page alone: no tab or window from before.
    clear: async () => {
      spawnSync('pkill', ['-f', `user-data-dir=${PROFILE}`])
      for (let i = 0; i < 40 && spawnSync('pgrep', ['-f', `user-data-dir=${PROFILE}`]).status === 0; i++) await sleep(250)
      fs.rmSync(path.join(PROFILE, 'Default', 'Sessions'), { recursive: true, force: true })
    },
    async setup(url) {
      spawn(CHROME, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', url], { detached: true, stdio: 'ignore' }).unref()
      await sleep(4000)
      const ev = await (await fetch(`${base}/events`)).json()
      if (!ev.some((e) => e.kind === 'page' && url.endsWith(e.path + (e.search ?? '')))) throw new Error(`the start page ${url} didn't load`)
    },
  },
  browser: {
    intro: 'You work a web page with the `brigadier browser` command; run `brigadier browser --help` first. Open the start page with it first.',
    args: ['--allowedTools', 'Bash(brigadier browser:*)'],
    clear: async () => {
      for (const id of tabs()) if (!before.has(id)) brigadier('browser', 'close', '--tab', id)
    },
  },
  playwright: {
    intro: 'You work a web browser with the Playwright tools. Open the start page with them first.',
    args: ['--allowedTools', 'mcp__playwright', '--mcp-config', JSON.stringify({ mcpServers: { playwright: { command: 'node', args: [PW_MCP, '--headless', '--isolated', '--executable-path', PW_CHROME] } } })],
  },
}[tool]
if (tool === 'playwright' && !PW_MCP) { console.error('PW_MCP=<path to @playwright/mcp cli.js>'); process.exit(2) }

// `brigadier` as the agent has it: the one under test, with each call kept as it was made, whatever
// shell line it came from, with its times, its output and its screenshot.
fs.symlinkSync(fileURLToPath(new URL('./shim.mjs', import.meta.url)), path.join(bin, 'brigadier'))

// One agent run: what it was scored on goes to `raw`.
function agent(prompt, raw) {
  return new Promise((done) => {
    const args = ['-p', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--model', MODEL, '--effort', EFFORT, '--output-format', 'stream-json', '--verbose', ...ARM.args, '--', prompt]
    const cwd = fs.mkdtempSync('/tmp/bench-cwd-')
    const from = Date.now()
    const p = spawn('claude', args, { cwd, detached: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BENCH_BRIGADIER: BRIGADIER, BENCH_RAW: raw }, stdio: ['ignore', 'pipe', 'pipe'] })
    running = p
    const tools = new Map()
    const a = { calls: [], cost: null, turns: 0, said: '', denied: 0, killed: false }
    let buf = ''
    const kill = setTimeout(() => { a.killed = true; stopAgent('SIGTERM') }, LIMIT)
    const stream = fs.createWriteStream(path.join(raw, 'stream.jsonl'))
    p.stdout.on('data', (d) => {
      stream.write(d)
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m; try { m = JSON.parse(line) } catch { continue }
        const at = Date.now()
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_use') tools.set(c.id, { verb: c.name, from: at })
          if (c.type === 'tool_result' && tools.has(c.tool_use_id)) {
            const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }]
            const text = parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
            if (c.is_error && /permission|denied|not allowed/i.test(text)) a.denied++
            const call = Object.assign(tools.get(c.tool_use_id), { to: at, text, image: parts.find((x) => x.type === 'image')?.source?.data })
            // Playwright saves its picture in the agent's folder when asked to: read now, the folder goes with the run.
            const file = /take_screenshot/.test(call.verb) && text.match(/\]\(([^)]+\.(?:png|jpe?g))\)/i)?.[1]
            if (file && !call.image && fs.existsSync(path.resolve(cwd, file))) {
              call.image = fs.readFileSync(path.resolve(cwd, file)).toString('base64')
              fs.writeFileSync(path.join(raw, `shot-${at}${path.extname(file)}`), call.image, 'base64')
            }
          }
          if (c.type === 'text' && m.type === 'assistant') a.said = c.text
        }
        // A background command ending gives a second result, of its own short turn: each adds up.
        if (m.type === 'result') { a.cost = m.total_cost_usd ?? a.cost; a.turns += m.num_turns ?? 0 }
      }
    })
    p.stderr.pipe(fs.createWriteStream(path.join(raw, 'stderr.txt')))
    p.on('close', () => {
      clearTimeout(kill)
      // From spawn to exit, by this clock: the agent's own figure is its last turn's.
      a.ms = Date.now() - from
      stopAgent(); running = null; stream.end()
      fs.rmSync(cwd, { recursive: true, force: true })
      a.calls = tool === 'playwright'
        ? [...tools.values()].filter((c) => c.verb.startsWith('mcp__playwright')).map((c) => ({ ...c, n: 1, shot: c.image && hash(Buffer.from(c.image, 'base64')) }))
        : shimmed(path.join(raw, 'calls.jsonl'))
      done(a)
    })
  })
}

// The shim's calls: each has a line as it starts and one as it ends; a call never answered has only the first.
function shimmed(file) {
  const calls = new Map()
  for (const l of fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []) {
    const r = JSON.parse(l)
    calls.set(r.id, { ...calls.get(r.id), ...r })
  }
  return [...calls.values()].filter((c) => c.argv[0] === tool).map((c) => {
    const verb = c.argv.includes('--help') ? '--help' : c.argv[1] ?? 'help'
    // `run` is as many actions as its steps.
    const n = verb === 'run' ? Math.max(1, c.argv.slice(2).filter((x) => !x.startsWith('--')).length) : 1
    return { verb, n, cmd: c.argv.join(' '), from: c.from, to: c.to, text: c.out, shot: c.shot }
  })
}

const hash = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
const changes = (ev, from, to) => ev.filter((e) => (e.kind === 'state' || e.kind === 'page') && e.at >= from && e.at <= to)

// A run's figures, from its calls and the page's log.
function score(name, task, a, ev) {
  const run = { tool, task: name, model: MODEL, effort: EFFORT, ms: a.ms, killed: a.killed, turns: a.turns, cost: a.cost, denied: a.denied }
  if (process.env.RERUN) run.rerun = process.env.RERUN
  const acts = a.calls.filter((c) => !READS[tool].test(c.verb))
  run.calls = a.calls.length
  run.reads = run.calls - acts.length
  run.actions = acts.reduce((n, c) => n + c.n, 0)
  const said = (c, re) => re.test((c.text ?? '').trim())
  // A "no change" while the page logged one inside the call; a "change observed" that lists nothing.
  const falseNo = a.calls.filter((c) => c.to && said(c, /no change (seen|on the page)/i) && changes(ev, c.from, c.to).length)
  const empty = a.calls.filter((c) => said(c, /change observed\.\s*(Changed:\s*)?$/))
  run.falseNoChange = falseNo.length
  run.emptyChange = empty.length
  // The calls behind those counts, to judge each one by hand.
  run.flagged = [...falseNo, ...empty].map((c) => ({ cmd: (c.cmd ?? c.verb).slice(0, 200), text: (c.text ?? '').slice(0, 400), changes: changes(ev, c.from, c.to).slice(0, 3) }))
  run.covered = a.calls.filter((c) => said(c, /covered by/i)).length
  // Screenshots by their bytes: one is stale when it matches the last while the page changed between.
  const shots = a.calls.filter((c) => c.shot)
  run.shots = shots.map((c) => c.shot)
  run.stale = shots.filter((c, i) => i > 0 && c.shot === shots[i - 1].shot && changes(ev, shots[i - 1].to, c.to).length).length
  // A call the user's yes never came for, the last the agent acted with: blocked, not failed.
  const last = acts.at(-1)
  run.asked = a.calls.filter((c) => said(c, ASKED)).length
  const blocked = last && (said(last, ASKED) || (last.verb === 'eval' && !last.to))
  const pass = !!task.pass(ev, run)
  // Done with nothing done by the agent isn't a pass: something else did it.
  run.status = pass ? (run.actions ? 'pass' : 'void') : blocked ? 'blocked' : 'fail'
  run.pass = run.status === 'pass'
  if (task.old) {
    run.passOld = !!task.old(ev, run)
    run.panel = !has(ev, { consent: 'shown' }) ? 'not shown' : has(ev, { consent: 'dismissed' }) ? 'dismissed' : !has(ev, { used: 'Logo 3' }) ? 'not done' : run.covered ? 'reported' : 'clicked through'
  }
  run.said = a.said.slice(0, 600)
  return run
}

function table() {
  const rows = [], panel = []
  for (const t of ['computer', 'browser', 'playwright']) {
    const f = path.join(OUT, `${t}.jsonl`)
    if (!fs.existsSync(f)) continue
    const runs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const k of Object.keys(TASKS)) {
      const r = runs.filter((x) => x.task === k)
      if (!r.length) continue
      const ok = r.filter((x) => x.pass)
      const count = (of) => r.filter(of).length
      const sum = (key, of = r) => of.reduce((n, x) => n + (x[key] ?? 0), 0)
      rows.push(`| ${t} | ${k} | ${ok.length}/${r.length} | ${count((x) => x.status === 'blocked')} | ${sum('falseNoChange')} / ${sum('emptyChange')} | ${sum('stale')} (${count((x) => x.shots.length > 1)}) | ${ok.length ? (sum('actions', ok) / ok.length).toFixed(1) : '–'} | ${(sum('ms') / r.length / 1000).toFixed(0)} s |`)
      if (TASKS[k].old) panel.push(`| ${t} | ${ok.length}/${r.length} | ${count((x) => x.passOld)}/${r.length} | ${count((x) => x.panel === 'dismissed')} | ${count((x) => x.panel === 'reported')} | ${count((x) => x.panel === 'clicked through')} | ${count((x) => /^not/.test(x.panel))} |`)
    }
  }
  return [
    '| Tool | Task | Pass | Blocked on approval | False "no change" / empty "change observed" | Stale shots (runs with two or more) | Actions per pass | Mean time |', '|---|---|---|---|---|---|---|---|', ...rows,
    '', '| Tool | T4 | T4, round 1\'s rule | Panel dismissed | Reported | Clicked through | Not shown or not done |', '|---|---|---|---|---|---|---|', ...panel,
  ].join('\n')
}

fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true })
const server = await serve(PORT)
for (const [name, task] of Object.entries(TASKS)) {
  if (ONLY ? !ONLY.includes(name) : task.extra) continue
  for (let i = 0; i < RUNS; i++) {
    let n = 1
    while (fs.existsSync(path.join(OUT, 'raw', `${tool}-${name}-${n}`))) n++
    const raw = path.join(OUT, 'raw', `${tool}-${name}-${n}`)
    fs.mkdirSync(raw)
    const url = base + task.start
    // What was open goes first, then the log: no page from before this run writes in it (server.mjs).
    await ARM.clear?.()
    await fetch(`${base}/reset`)
    await ARM.setup?.(url)
    const start = tool === 'computer' ? '' : ` The start page is ${url}.`
    const a = await agent(`${ARM.intro}${start}\n\nTask: ${task.ask}\n\nWork on your own; nobody will answer questions. When you're done, say what you did and what you saw.`, raw)
    await sleep(1000)
    const ev = await (await fetch(`${base}/events`)).json()
    fs.writeFileSync(path.join(raw, 'events.json'), JSON.stringify(ev))
    const run = { i: n, ...score(name, task, a, ev) }
    fs.appendFileSync(path.join(OUT, `${tool}.jsonl`), JSON.stringify(run) + '\n')
    console.log(JSON.stringify({ tool, task: name, i: n, status: run.status, panel: run.panel, actions: run.actions, reads: run.reads, falseNoChange: run.falseNoChange, emptyChange: run.emptyChange, shots: run.shots.length, stale: run.stale, asked: run.asked, s: Math.round(run.ms / 1000) }))
  }
}
await ARM.clear?.()
server.close()
console.log(table())
process.exit(0)
