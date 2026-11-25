#!/usr/bin/env node
// One re-runnable drill command for the foundation [D52]. It drives only the `brigadier` CLI, the
// daemon's socket and the kernel (signals, ps), never the host's internals, so it sees what any
// client sees.
//
//   BIN=<dir with brigadier, brigadier-host, brigadier-fake, brigadierd> node drills/drill.mjs <drill> [minutes]
//   drills: killloop, hang, catalogue, scale, sleep, rebirth, standing, handoff, peers, rewindfiles, speed
//   killloop: BUILDS=<dir>:<dir> rotates in more builds; OLD_BIN=<dir> adds hosts and the first
//   daemon from a previous release's code.
//
// Results print as JSON lines; the last line is the summary. Scratch lives under $DRILL_ROOT
// (default /tmp/brigadier-drill) and is removed at the end unless KEEP=1.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const BIN = process.env.BIN
const ROOT = process.env.DRILL_ROOT ?? '/tmp/brigadier-drill'
const BUILDS = (process.env.BUILDS ?? '').split(':').filter(Boolean) // extra build dirs to rotate in
const OWNER_BIN = 'brigadier-host'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const log = (o) => console.log(JSON.stringify(o))
let DATA = ''

function cli(args, env = {}, timeout = 30000) {
  const t = performance.now()
  const r = spawnSync(`${BIN}/brigadier`, args, { env: { ...process.env, BRIGADIER_DATA: DATA, ...env }, encoding: 'utf8', timeout, maxBuffer: 1 << 30 })
  const ms = performance.now() - t
  const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean)
  const parsed = lines.map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
  return { ms, out: parsed.at(-1) ?? { ok: false, error: r.stderr || `exit ${r.status}` }, all: parsed }
}

// The same without waiting, for drills that drive several sessions at once: its last line, or why none.
const cliAsync = (args, env = {}) => new Promise((res) => {
  const c = spawn(`${BIN}/brigadier`, args, { env: { ...process.env, BRIGADIER_DATA: DATA, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
  let text = ''
  c.stdout.on('data', (d) => { text += d })
  c.on('close', (code) => { try { res(JSON.parse(text.trim().split('\n').at(-1))) } catch { res({ ok: false, error: `exit ${code}` }) } })
})

const status = (ids) => Object.fromEntries(cli(['status', ...ids]).all.map((s) => [s.id, s]))
const statusAll = () => Object.fromEntries(cli(['status', '--all']).all.map((s) => [s.id, s]))

function ps() {
  const r = spawnSync('ps', ['-axo', 'pid=,pgid=,ppid=,stat=,command='], { encoding: 'utf8' })
  return r.stdout.trim().split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    return m && { pid: +m[1], pgid: +m[2], ppid: +m[3], stat: m[4], cmd: m[5] }
  }).filter(Boolean)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const kill = (pid, sig = 'SIGKILL') => { try { process.kill(pid, sig) } catch {} }
const ownerPid = (id) => cli(['owner', id]).out.pid
// Only processes of this run: its own data folder or its own binaries, never a shell or this script.
const mine = () => ps().filter((p) => (p.cmd.includes(`${DATA}/`) || p.cmd.endsWith(DATA) || p.cmd.startsWith(`${BIN}/`)) && !/drill\.mjs|^\S*(zsh|bash|node)\b/.test(p.cmd))
const agentsOf = (id) => ps().filter((p) => p.cmd.includes('brigadier-fake agent') && p.cmd.includes(`${DATA}/sessions/${id}/fake`))

// The fake agent's ledger: ground truth kept outside Brigadier.
function ledger(name = 'ledger') {
  const lines = fs.existsSync(`${DATA}/${name}`) ? fs.readFileSync(`${DATA}/${name}`, 'utf8').trim().split('\n') : []
  const recv = {}, starts = {}, children = {}, done = new Map()
  for (const l of lines) {
    const p = l.split(' ')
    if (p[0] === 'recv') recv[p[2]] = (recv[p[2]] ?? 0) + 1
    if (p[0] === 'start') starts[p[2]] = (starts[p[2]] ?? 0) + 1
    if (p[0] === 'child') children[p[2]] = { sid: p[1], ends: +p[3] }
    if (p[0] === 'child_done') done.set(p[1], +p[2])
  }
  return { recv, starts, children, done }
}

function freshData(name) {
  DATA = `${ROOT}/${name}`
  stopAll()
  fs.rmSync(DATA, { recursive: true, force: true })
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
}

function fakeOpts(ledgerName = 'ledger') {
  const home = process.env.HOME
  return ['--opt', `FAKE_LEDGER=${DATA}/${ledgerName}`, '--opt', `FAKE_CARGO=${home}/.cargo/bin/cargo`, '--opt', `FAKE_CARGO_MANIFEST=${process.env.CARGO_MANIFEST ?? ''}`]
}

function startFake(id, extra = [], env = {}, ledgerName) {
  return cli(['start', id, '--backend', 'fake', '--cwd', '/tmp', ...fakeOpts(ledgerName), ...extra], env).out
}

function gitRepo(name) {
  const dir = `${ROOT}/repo-${name}`
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  spawnSync('sh', ['-c', 'git init -q && echo hi > a.txt && git add . && git -c user.email=drill@example.invalid -c user.name=drill commit -qm init'], { cwd: dir })
  return dir
}

let cidN = 0
const cid = (p = 'k') => `${p}${now().toString(36)}${(cidN++).toString(36)}`

async function waitFor(fn, ms, step = 100) {
  const t = now()
  while (now() - t < ms) {
    const v = fn()
    if (v) return { ok: true, ms: now() - t, v }
    await sleep(step)
  }
  return { ok: false, ms: now() - t }
}

// The daemon, run against this drill's data folder. Every one started is killed at the end, since
// a new one may have replaced the old or left on its own.
let daemons = []
function startDaemon(bin = BIN) {
  const d = spawn(`${bin}/brigadierd`, [], { env: { ...process.env, BRIGADIER_DATA: DATA }, detached: true, stdio: 'ignore' })
  d.unref()
  daemons.push(d)
}
function stopDaemon() {
  for (const d of daemons) kill(d.pid)
  daemons = []
}
// The running daemon's first frame (hello or refusal): its pid and build number.
function daemonHello(ms = 2000) {
  return new Promise((resolve) => {
    const s = net.connect(`${DATA}/daemon.sock`)
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => done(null), ms)
    s.on('error', () => done(null))
    s.on('connect', () => { const v = Buffer.alloc(4); v.writeUInt32BE(4); s.write(v) })
    let buf = Buffer.alloc(0)
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) done(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0))))
    })
  })
}
const ownerJson = (id) => { try { return { ...JSON.parse(fs.readFileSync(`${DATA}/sessions/${id}/owner.json`, 'utf8')), mtime: fs.statSync(`${DATA}/sessions/${id}/owner.json`).mtimeMs } } catch { return {} } }
// One request on a fresh daemon connection: the reply, or null if nothing answers in time.
function daemonCall(request, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect(`${DATA}/daemon.sock`)
    let buf = Buffer.alloc(0)
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => done(null), ms)
    const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
    s.on('error', () => done(null))
    s.on('connect', () => { const v = Buffer.alloc(4); v.writeUInt32BE(4); s.write(v) })
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)))
        buf = buf.subarray(4 + buf.readUInt32BE(0))
        if (m.status === 'running') s.write(frame({ id: 1, ...request }))
        else if (m.re === 1) done(m)
      }
    })
  })
}
// The daemon's list as sorted "id title" lines, retried until it answers.
async function daemonList(ms) {
  const t = now()
  while (now() - t < ms) {
    const m = await daemonCall({ op: 'subscribe' }, 1000)
    if (m?.rows) return { ms: now() - t, ids: m.rows.map((r) => `${r.id} ${r.title}`).sort() }
    await sleep(25)
  }
  return null
}

function stopAll() {
  if (!DATA || !fs.existsSync(`${DATA}/sessions`)) return
  for (const id of fs.readdirSync(`${DATA}/sessions`)) cli(['stop', id], {}, 15000)
  for (const id of fs.readdirSync(`${DATA}/sessions`)) cli(['delete', id], {}, 15000)
}

function cleanup() {
  stopDaemon()
  stopAll()
  // Give exiting processes a moment before calling them leftovers.
  for (let i = 0; i < 30 && mine().length; i++) spawnSync('sleep', ['0.1'])
  // Tool processes carry no path of ours: find them from the ledger's recorded pids instead.
  const all = ps(), roots = new Set(Object.keys(ledger().children).map(Number))
  const tools = all.filter((p) => roots.has(p.pid))
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!tools.includes(p) && tools.some((t) => t.pid === p.ppid)) { tools.push(p); grew = true } }
  const left = [...mine(), ...tools].filter((p) => p.pid !== process.pid)
  for (const p of left) kill(p.pid)
  if (process.env.KEEP !== '1') fs.rmSync(DATA, { recursive: true, force: true })
  return left.map((p) => p.cmd.slice(0, 120))
}

function swapTo(dir) {
  // An app update: each binary is replaced by rename, so running processes keep their old file.
  for (const b of ['brigadier', OWNER_BIN, 'brigadierd']) {
    fs.copyFileSync(`${dir}/${b}`, `${BIN}/.${b}.new`)
    fs.renameSync(`${BIN}/.${b}.new`, `${BIN}/${b}`)
  }
}

const follow = (id, n) => {
  const file = `${DATA}/follow-${id}-${n}.jsonl`
  const child = spawn(`${BIN}/brigadier`, ['read', id, '--follow'], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: ['ignore', fs.openSync(file, 'w'), 'ignore'] })
  return { child, file }
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null }

// Real CLI sessions to run alongside the fakes, by backend id: REAL=<backend>,<backend>,...
// They run at Full, so their shell command never waits on an approval.
const REAL = (process.env.REAL ?? '').split(',').filter(Boolean).map((b) => [`r-${b}`, b])
const realPrompt = (c) => `${c}: run the shell command \`sleep 30\` and then reply with only the word done.`
const BUSY = new Set(['working', 'silent', 'starting', 'logged'])

// Every drill's last line: what must hold, by name. `failed` names what didn't; the exit code says the same.
function verdict(drill, checks) {
  const failed = Object.keys(checks).filter((k) => checks[k] !== true)
  log({ verdict: drill, pass: failed.length === 0, checked: Object.keys(checks).length, failed })
  if (failed.length) process.exitCode = 1
}

// The 95% interval of a rate of k in n (Clopper–Pearson), in percent; none of n: what it's under.
function interval(k, n) {
  if (!n) return null
  const tail = (p, from, to) => {
    let lg = 0, sum = 0
    for (let i = 0; i <= to; i++) {
      if (i >= from) sum += Math.exp(lg + i * Math.log(p) + (n - i) * Math.log1p(-p))
      lg += Math.log(n - i) - Math.log(i + 1)
    }
    return sum
  }
  const solve = (f) => { let [a, b] = [0, 1]; for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (f(m)) a = m; else b = m } return +(100 * a).toFixed(2) }
  return { of: `${k}/${n}`, percent: +(100 * k / n).toFixed(2), low: k ? solve((p) => tail(p, k, n) < 0.025) : 0, high: k < n ? solve((p) => tail(p, 0, k) > 0.025) : 100, ...(k ? {} : { under: +(300 / n).toFixed(2) }) }
}

// A time's median and 95th of a hundred, with the 95% interval of each by rank.
function times(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length
  if (!n) return null
  const at = (p) => {
    const sd = 1.96 * Math.sqrt(n * p * (1 - p))
    const pick = (r) => +s[Math.min(n - 1, Math.max(0, Math.round(r)))].toFixed(1)
    return { ms: pick(Math.ceil(n * p) - 1), low: pick(n * p - sd - 1), high: pick(n * p + sd) }
  }
  return { n, p50: at(0.5), p95: at(0.95), max: +s[n - 1].toFixed(1) }
}

// A seeded random source, so a run can be done again: 0 up to 1, an integer under n, one of a list.
function seeded(seed) {
  let x = (seed * 2654435761 + 1) >>> 0
  const next = () => { x = (x + 1831565813) >>> 0; let t = Math.imul(x ^ (x >>> 15), x | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return { next, int: (n) => Math.floor(next() * n), of: (xs) => xs[Math.floor(next() * xs.length)] }
}

// Drill 1 ------------------------------------------------------------------------------------------
async function killloop(minutes) {
  freshData('killloop')
  // A previous release's daemon first, when given: the first update must replace it [D60].
  const OLD = process.env.OLD_BIN
  startDaemon(OLD ?? BIN)
  // f01-f20 start through the CLI, d01 through the daemon, the app's way in, o01-o02 on hosts of the
  // previous release, driven by today's CLI.
  const olds = OLD ? ['o01', 'o02'] : []
  const fakes = [...Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`), 'd01', ...olds]
  const work = (id) => (fakes.indexOf(id) < 4 ? 'cargo:600' : 'tree:600')
  const acked = {}, idleAcked = {}
  const send = (id, text, c = cid()) => {
    const r = cli(['send', id, `${c} ${text}`, '--cid', c])
    if (['delivered', 'logged'].includes(r.out.result)) acked[c] = { id, result: r.out.result }
    return r
  }
  // Idle hosts: their agent exits after each turn, so they hold nothing and move to each new build.
  const idles = ['i01', 'i02', 'i03']
  const idleTurn = (id) => {
    const c = cid('i')
    const r = cli(['send', id, `${c} exit:0`, '--cid', c])
    if (['delivered', 'logged'].includes(r.out.result)) idleAcked[c] = { id, result: r.out.result }
    return r.out.result
  }
  for (const id of fakes.slice(0, 20)) startFake(id)
  for (const id of olds) startFake(id, [], { BRIGADIER_HOST: `${OLD}/brigadier-host` })
  for (const id of idles) startFake(id, [], {}, 'ledger-idle')
  for (const id of idles) idleTurn(id)
  const viaDaemon = await daemonCall({ op: 'run', args: ['start', 'd01', '--backend', 'fake', '--cwd', '/tmp', ...fakeOpts()] }, 10000)
  if (!viaDaemon?.ok) throw new Error(`start through the daemon failed: ${JSON.stringify(viaDaemon)}`)
  startFake('chat')
  for (const id of fakes) send(id, work(id))
  // The real CLIs start in the same second.
  const real = REAL
  const starts = real.map(([id, b]) => spawn(`${BIN}/brigadier`, ['start', id, '--backend', b, '--cwd', gitRepo(id), '--level', 'full', '--text', realPrompt(cid('r'))], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: 'ignore' }))
  await Promise.all(starts.map((c) => new Promise((r) => c.on('exit', r))))
  const followed = ['f01', 'chat', ...real.map(([id]) => id)]
  let followers = followed.map((id) => ({ id, ...follow(id, 0) }))
  const builds = [BIN + '.orig', ...BUILDS]
  fs.cpSync(BIN, BIN + '.orig', { recursive: true })
  const events = []
  const pidsBefore = () => Object.fromEntries(fakes.map((id) => [id, agentsOf(id).map((p) => p.pid)]))
  for (let k = 1; k <= minutes; k++) {
    const t0 = now()
    const ev = { k }
    // A client killed mid-send, then retried with the same command id.
    const c = cid('x')
    const inflight = spawn(`${BIN}/brigadier`, ['send', 'chat', `${c} say:1`, '--cid', c], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: 'ignore' })
    await sleep(Math.floor(Math.random() * 40))
    inflight.kill('SIGKILL')
    const before = pidsBefore()
    const listBefore = await daemonList(5000)
    const helloBefore = await daemonHello()
    const idleBefore = Object.fromEntries(idles.map((id) => [id, ownerJson(id)]))
    // The clients die and the app's binaries are replaced. On odd minutes the old daemon is left
    // running, and the new one must replace it only if its build is newer; on even ones it's killed.
    for (const f of followers) f.child.kill('SIGKILL')
    const leave = k % 2 === 1
    if (!leave) stopDaemon()
    swapTo(builds[k % builds.length])
    const killedAt = now()
    startDaemon()
    // The new daemon decides at once: it serves (it replaced the old one, or there was none) or leaves.
    const fresh = daemons.at(-1)
    for (const t = now(); now() - t < 10000; await sleep(50)) {
      if (fresh.exitCode !== null || (await daemonHello(500))?.pid === fresh.pid) break
    }
    const listAfter = await daemonList(10000)
    ev.daemon_list_ms = listAfter?.ms ?? null
    ev.daemon_same_list = !!listBefore && !!listAfter && listBefore.ids.join('\n') === listAfter.ids.join('\n')
    // Correct status within 2 s: every session still working, or honestly idle if its 10 minutes of
    // work ended on its own.
    const right = await waitFor(() => {
      const s = statusAll()
      return fakes.every((id) => ['working', 'idle'].includes(s[id]?.state))
    }, 10000, 50)
    ev.correct_ms = right.ok ? right.ms : null
    const back = await waitFor(() => fakes.every((id) => ['working', 'idle'].includes(statusAll()[id]?.state)), 20000, 100)
    ev.working_again_ms = back.ok ? now() - killedAt : null
    const helloAfter = await daemonHello()
    ev.daemon = { old: leave ? 'left running' : 'killed', before: [helloBefore?.pid, helloBefore?.build ?? 'legacy'], after: [helloAfter?.pid, helloAfter?.build ?? 'legacy'], replaced: leave && helloBefore?.pid !== helloAfter?.pid }
    // Idle hosts re-exec onto the new binary: same pid, owner.json rewritten. Then they take a turn.
    const moved = await waitFor(() => idles.every((id) => ownerJson(id).mtime > killedAt), 10000, 100)
    ev.idle_moved_ms = moved.ok ? now() - killedAt : null
    ev.idle_same_pid = idles.filter((id) => ownerJson(id).pid === idleBefore[id].pid).length
    ev.idle_turns = idles.map(idleTurn)
    ev.host_builds = {}
    for (const id of fs.readdirSync(`${DATA}/sessions`)) {
      if (!alive(ownerJson(id).pid)) continue
      const b = ownerJson(id).build ?? 'legacy'
      ev.host_builds[b] = (ev.host_builds[b] ?? 0) + 1
    }
    for (let i = 0; i < 5; i++) {
      const r = cli(['send', 'chat', `${c} say:1`, '--cid', c])
      if (['delivered', 'logged'].includes(r.out.result)) { acked[c] = { id: 'chat', result: r.out.result }; break }
      await sleep(300)
    }
    followers = followed.map((id) => ({ id, ...follow(id, k) }))
    const after = pidsBefore()
    ev.agents_replaced = fakes.filter((id) => before[id].join() !== after[id].join()).length
    ev.duplicate_agents = fakes.filter((id) => after[id].length > 1).length
    ev.orphans = Object.values(statusAll()).reduce((a, x) => a + (x.orphans ?? 0), 0)
    // Keep the load up: idle fakes get new work; real sessions get a short prompt every 5 minutes.
    const s = statusAll()
    for (const id of fakes) if (s[id]?.state === 'idle') send(id, work(id))
    if (k % 5 === 0) for (const [id] of real) if (s[id] && !BUSY.has(s[id].state)) ev[`send_${id}`] = cli(['send', id, realPrompt(cid('r'))]).out.result
    ev.real = Object.fromEntries(real.map(([id]) => [id, s[id]?.state]))
    events.push(ev)
    log({ drill: 'killloop', ...ev })
    await sleep(Math.max(0, 60000 - (now() - t0)))
  }
  for (const f of followers) f.child.kill('SIGKILL')
  await sleep(1000)
  // History: every live follow output must equal the start of a fresh full read.
  const history = {}
  for (const id of followed) {
    const full = cli(['read', id]).all.slice(0, -1).map((x) => JSON.stringify(x))
    const files = fs.readdirSync(DATA).filter((f) => f.startsWith(`follow-${id}-`))
    const bad = files.filter((f) => {
      const lines = fs.readFileSync(`${DATA}/${f}`, 'utf8').trim().split('\n').filter(Boolean)
      return lines.some((l, i) => JSON.stringify(JSON.parse(l)) !== full[i])
    })
    const h1 = cli(['read', id, '--hash']).out.hash
    const h2 = cli(['read', id, '--hash']).out.hash
    history[id] = { follows: files.length, mismatched: bad.length, rehash_equal: h1 === h2, items: full.length }
  }
  const L = ledger(), LI = ledger('ledger-idle')
  // Died: gone without finishing, or finished well before its planned end.
  const deadChildren = Object.entries(L.children).filter(([pid, c]) => L.done.has(pid) ? L.done.get(pid) < c.ends - 5000 : !alive(+pid)).length
  const lost = Object.keys(acked).filter((c) => !(L.recv[c] >= 1)).length
  const doubled = Object.keys(acked).filter((c) => L.recv[c] > 1).length
  const restarts = Object.values(L.starts).reduce((a, n) => a + n - 1, 0)
  const transcripts = Object.fromEntries(real.map(([id]) => [id, cli(['transcript', id]).out]))
  const usage = Object.fromEntries(real.map(([id]) => [id, cli(['read', id]).all.filter((i) => i.kind === 'usage').map((i) => i.usage)]))
  const versions = Object.fromEntries(real.map(([id]) => [id, statusAll()[id]?.versions]))
  const summary = {
    drill: 'killloop', minutes, events: events.length,
    correct_ms_max: Math.max(...events.map((e) => e.correct_ms ?? 1e9)),
    correct_within_2s: events.filter((e) => e.correct_ms !== null && e.correct_ms <= 2000).length,
    working_again_ms_p50: pct(events.map((e) => e.working_again_ms ?? 1e9), 0.5),
    working_again_ms_max: Math.max(...events.map((e) => e.working_again_ms ?? 1e9)),
    agents_replaced_total: events.reduce((a, e) => a + e.agents_replaced, 0),
    duplicate_agents_seen: events.reduce((a, e) => a + e.duplicate_agents, 0),
    daemon_list_ms_max: Math.max(...events.map((e) => e.daemon_list_ms ?? 1e9)),
    daemon_same_list: events.filter((e) => e.daemon_same_list).length,
    orphans_max: Math.max(...events.map((e) => e.orphans)),
    tool_children_started: Object.keys(L.children).length, tool_children_died: deadChildren, agent_restarts: restarts,
    acked: Object.keys(acked).length, lost, doubled, history, transcripts, usage, versions,
    daemon_replaced: events.filter((e) => e.daemon.replaced).length, daemon_left_running: events.filter((e) => e.daemon.old === 'left running').length,
    idle_moved: events.filter((e) => e.idle_moved_ms !== null).length, idle_moved_ms_max: Math.max(...events.map((e) => e.idle_moved_ms ?? 1e9)),
    idle_same_pid_min: Math.min(...events.map((e) => e.idle_same_pid)),
    idle_acked: Object.keys(idleAcked).length, idle_lost: Object.keys(idleAcked).filter((c) => !(LI.recv[c] >= 1)).length, idle_doubled: Object.keys(idleAcked).filter((c) => LI.recv[c] > 1).length,
  }
  summary.leftovers = cleanup()
  for (const [id] of real) fs.rmSync(`${ROOT}/repo-${id}`, { recursive: true, force: true })
  fs.rmSync(BIN + '.orig', { recursive: true, force: true })
  log(summary)
  verdict('killloop', {
    nothing_replaced: summary.agents_replaced_total === 0, no_duplicate_agents: summary.duplicate_agents_seen === 0, no_agent_restarts: restarts === 0,
    no_tool_died: deadChildren === 0, no_orphans: summary.orphans_max === 0, none_lost: lost === 0 && summary.idle_lost === 0, none_doubled: doubled === 0 && summary.idle_doubled === 0,
    status_right_within_2s: summary.correct_within_2s === events.length, same_list: summary.daemon_same_list === events.length,
    history_same: Object.values(history).every((h) => h.mismatched === 0 && h.rehash_equal), idle_hosts_kept_their_pid: summary.idle_same_pid_min === idles.length,
    no_leftovers: summary.leftovers.length === 0,
  })
}

// Drill 2 ------------------------------------------------------------------------------------------
async function hang() {
  freshData('hang')
  startDaemon()
  const r = {}
  for (const id of ['h1', 'h2', 'h3']) startFake(id)
  for (const id of ['h1', 'h2', 'h3']) cli(['send', id, `${cid()} tree:120`])
  await sleep(1500)
  // A stuck reader: a follower frozen with the log open.
  const reader = follow('h3', 0)
  await sleep(300)
  kill(reader.child.pid, 'SIGSTOP')
  const agent = agentsOf('h1')[0].pid
  kill(agent, 'SIGSTOP')
  const t = now()
  const stalled = await waitFor(() => status(['h1']).h1.state === 'stalled', 10000, 50)
  r.stalled_shown_ms = stalled.ok ? now() - t : null
  const others = status(['h2', 'h3'])
  r.others_while_stalled = [others.h2.state, others.h3.state]
  const size3 = fs.statSync(`${DATA}/sessions/h3/log`).size
  await sleep(1500)
  r.h3_still_logging_with_frozen_reader = fs.statSync(`${DATA}/sessions/h3/log`).size > size3
  const stop = cli(['stop', 'h1'])
  r.stop = { ms: Math.round(stop.ms), result: stop.out }
  r.h1_after_stop = status(['h1']).h1.state
  r.h1_processes_left = agentsOf('h1').length + ps().filter((p) => p.ppid === agent).length
  kill(reader.child.pid, 'SIGKILL')
  // Kill the agent child: one clear state and one recovery.
  const a2 = agentsOf('h2')[0].pid
  kill(a2)
  const gone = await waitFor(() => status(['h2']).h2.state === 'interrupted', 5000, 50)
  r.child_killed = { shown_ms: gone.ms, state: status(['h2']).h2.state }
  const rec = cli(['recover', 'h2'])
  await sleep(500)
  r.child_killed.recover = rec.out.recovered ?? rec.out.error
  r.child_killed.after = status(['h2']).h2.state
  // Kill the owner itself: nothing may run unsupervised.
  const own = ownerPid('h3')
  const tree = ps().filter((p) => p.pgid === agentsOf('h3')[0]?.pgid).map((p) => p.pid)
  kill(own)
  const k0 = now()
  const shown = await waitFor(() => status(['h3']).h3.state === 'interrupted', 5000, 50)
  const freed = await waitFor(() => tree.every((p) => !alive(p)), 5000, 50)
  r.owner_killed = { interrupted_shown_ms: shown.ok ? shown.ms : null, agent_tree_gone_ms: freed.ok ? now() - k0 : null, survivors_after_5s: tree.filter(alive).length }
  const rec3 = cli(['recover', 'h3'])
  await sleep(500)
  r.owner_killed.recover = rec3.out.recovered ?? rec3.out.error
  r.owner_killed.after_recover = status(['h3']).h3.state
  // Freeze the owner: status must say so, commands must fail fast, and nothing replaces it.
  const o = ownerPid('h1')
  kill(o, 'SIGSTOP')
  r.owner_frozen = { state: status(['h1']).h1.state }
  const s = cli(['send', 'h1', `${cid()} say:1`], {}, 20000)
  r.owner_frozen.send = { ms: Math.round(s.ms), result: s.out.result, error: s.out.error }
  cli(['up', 'h1'], {}, 20000)
  r.owner_frozen.owners_running = ps().filter((p) => p.cmd.includes(OWNER_BIN) && p.cmd.includes(DATA) && !p.cmd.includes('--watchdog')).filter((p) => p.cmd.includes('/h1')).length
  kill(o, 'SIGCONT')
  await sleep(500)
  r.owner_frozen.after_cont = status(['h1']).h1.state
  // Host and watchdog killed together after more than 8 spawns: the daemon sweeps every recorded
  // group, the first one included.
  startFake('h4')
  cli(['send', 'h4', `${cid()} bg:300`])
  await sleep(500)
  const first = agentsOf('h4')[0]
  for (let i = 0; i < 10; i++) {
    cli(['send', 'h4', `${cid()} exit:0`])
    await sleep(300)
  }
  const bg = ps().filter((p) => p.pgid === first.pgid && p.pid !== first.pid).map((p) => p.pid)
  const host = ownerPid('h4')
  const dog = ps().find((p) => p.ppid === host && p.cmd.includes('--watchdog'))
  kill(host)
  kill(dog?.pid)
  const k4 = now()
  const swept = await waitFor(() => bg.every((p) => !alive(p)), 15000, 100)
  r.host_and_watchdog_killed = {
    spawns: cli(['read', 'h4']).all.filter((i) => i.kind === 'spawned').length,
    background: bg.length, watchdog_found: !!dog, swept_ms: swept.ok ? now() - k4 : null, survivors: bg.filter(alive).length,
  }
  // Host killed between starting a child and logging its group: the child is still at its gate,
  // reads EOF and never runs [D60].
  const inH5 = (p) => p.cmd.includes(`/sessions/h5/fake`)
  startFake('h5', [], { BRIGADIER_CRASH_AT: 'after_fork:gate' })
  const gate = cid('gate')
  const g5 = cli(['send', 'h5', `${gate} bg:300`, '--cid', gate])
  const k5 = now()
  const gone5 = await waitFor(() => !ps().some(inH5), 5000, 50)
  r.killed_at_spawn = { send: g5.out.result, gone_ms: gone5.ok ? now() - k5 : null, survivors: ps().filter(inH5).length, agent_got_it: (ledger().recv[gate] ?? 0) > 0 }
  // A host that moved to a new build: same pid, a fresh watchdog, no zombie, and the new watchdog
  // still stops the tree when the host is killed.
  startFake('h6')
  cli(['send', 'h6', `${cid()} exit:0`])
  await sleep(2500)
  const h6 = ownerPid('h6')
  const dog6 = ps().find((p) => p.ppid === h6 && p.cmd.includes('--watchdog'))?.pid
  fs.copyFileSync(`${BIN}/${OWNER_BIN}`, `${BIN}/.${OWNER_BIN}.new`)
  fs.renameSync(`${BIN}/.${OWNER_BIN}.new`, `${BIN}/${OWNER_BIN}`)
  const t6 = now()
  const moved6 = await waitFor(() => ownerJson('h6').mtime > t6, 10000, 50)
  await sleep(300)
  const kids6 = ps().filter((p) => p.ppid === h6)
  r.moved_host = {
    moved_ms: moved6.ok ? moved6.ms : null, same_pid: ownerJson('h6').pid === h6, old_watchdog_gone: !alive(dog6),
    watchdogs: kids6.filter((p) => p.cmd.includes('--watchdog')).length, zombies: kids6.filter((p) => p.stat.startsWith('Z')).length,
  }
  cli(['send', 'h6', `${cid()} tree:120`])
  await sleep(1500)
  const tree6 = ps().filter((p) => p.pgid === agentsOf('h6')[0]?.pgid).map((p) => p.pid)
  kill(h6)
  const k6 = now()
  const freed6 = await waitFor(() => tree6.every((p) => !alive(p)), 5000, 50)
  r.moved_host.tree = tree6.length
  r.moved_host.tree_gone_ms = freed6.ok ? now() - k6 : null
  r.leftovers = cleanup()
  log({ drill: 'hang', ...r })
  verdict('hang', {
    stall_shown: r.stalled_shown_ms !== null, others_still_work: r.others_while_stalled.every((x) => x === 'working'), logs_past_a_frozen_reader: r.h3_still_logging_with_frozen_reader,
    stop_ends_it: r.h1_after_stop === 'stopped' && r.h1_processes_left === 0, agent_killed: r.child_killed.state === 'interrupted' && r.child_killed.recover === 'continued' && r.child_killed.after === 'idle',
    host_killed: r.owner_killed.interrupted_shown_ms !== null && r.owner_killed.agent_tree_gone_ms !== null && r.owner_killed.survivors_after_5s === 0 && r.owner_killed.recover === 'continued' && r.owner_killed.after_recover === 'idle',
    host_frozen: r.owner_frozen.state === 'unresponsive' && r.owner_frozen.owners_running === 1 && r.owner_frozen.send.ms < 10000,
    host_and_watchdog: r.host_and_watchdog_killed.swept_ms !== null && r.host_and_watchdog_killed.survivors === 0,
    killed_at_spawn: r.killed_at_spawn.gone_ms !== null && r.killed_at_spawn.survivors === 0 && !r.killed_at_spawn.agent_got_it,
    moved_host: r.moved_host.moved_ms !== null && r.moved_host.same_pid && r.moved_host.old_watchdog_gone && r.moved_host.watchdogs === 1 && r.moved_host.zombies === 0 && r.moved_host.tree_gone_ms !== null,
    no_leftovers: r.leftovers.length === 0,
  })
}

// Drill 3 ------------------------------------------------------------------------------------------
async function catalogue() {
  freshData('catalogue')
  const r = {}
  // Stale socket and two starts racing.
  startFake('c1')
  kill(ownerPid('c1'))
  await sleep(200)
  const [x, y] = [cid('ra'), cid('rb')]
  const racers = [x, y].map((c) => spawn(`${BIN}/brigadier`, ['send', 'c1', `${c} say:1`, '--cid', c], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: 'ignore' }))
  await Promise.all(racers.map((c) => new Promise((res) => c.on('exit', res))))
  await sleep(500)
  const L1 = ledger()
  r.race = { owners: ps().filter((p) => p.cmd.includes(OWNER_BIN) && p.cmd.includes(DATA) && !p.cmd.includes('--watchdog')).length, agents: agentsOf('c1').length, recv: [L1.recv[x] ?? 0, L1.recv[y] ?? 0] }
  // Two clients sending at once, plus the same command id five times.
  const many = Array.from({ length: 10 }, () => cid('m'))
  const same = cid('same')
  const procs = [...many.map((c) => [c, c]), ...Array(5).fill([same, same])].map(([c]) => spawn(`${BIN}/brigadier`, ['send', 'c1', `${c} say:1`, '--cid', c], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: 'ignore' }))
  await Promise.all(procs.map((c) => new Promise((res) => c.on('exit', res))))
  await sleep(1500)
  const L2 = ledger()
  r.concurrent = { distinct_received_once: many.filter((c) => L2.recv[c] === 1).length, of: many.length, same_cid_received: L2.recv[same] ?? 0, dup_cids_in_log: status(['c1']).c1.dup_cids }
  // Kill between logging and writing to the agent.
  const crashEnv = { BRIGADIER_CRASH_AT: 'after_intent:boom' }
  startFake('c2')
  cli(['send', 'c2', 'warm say:1'])
  // The warm turn ends first, so the only open turn is the one the crash catches.
  await waitFor(() => status(['c2']).c2.state === 'idle', 5000, 50)
  kill(ownerPid('c2'))
  await sleep(300)
  cli(['up', 'c2'], crashEnv)
  const boom = cid('boom')
  const sb = cli(['send', 'c2', `${boom} say:1`, '--cid', boom], crashEnv)
  await sleep(300)
  r.crash_after_log = { send: sb.out.result ?? sb.out.error, state: status(['c2']).c2.state, others: status(['c1']).c1.owner }
  cli(['up', 'c1', 'c2'])
  const rec = cli(['recover', 'c2'])
  await sleep(800)
  r.crash_after_log.recover = rec.out.recovered ?? rec.out.error
  r.crash_after_log.received = Object.entries(ledger().recv).filter(([k]) => k.startsWith(boom)).reduce((a, [, n]) => a + n, 0)
  r.crash_after_log.after = status(['c2']).c2.state
  // Status beyond a hang.
  const states = {}
  const probe = async (id, text, wait) => { startFake(id); cli(['send', id, `${cid()} ${text}`]); await sleep(wait); states[text] = status([id])[id].state }
  await Promise.all([
    probe('s1', 'noturn', 4500), probe('s2', 'bg:20', 1500), probe('s3', 'tool_sleep:20', 6000), probe('s4', 'hang:20', 3500),
    probe('s5', 'limit', 1000), probe('s6', 'auth', 1000), probe('s7', 'ask', 1000), probe('s8', 'hang:20', 6000),
  ])
  r.states = states
  // Untrusted output: unknown frames, bad UTF-8, a 50 MB line, a mid-turn compaction.
  startFake('u1')
  cli(['send', 'u1', `${cid()} say:1 compact unknown badutf8 bigline:50 say:1`])
  await waitFor(() => status(['u1']).u1.state === 'idle', 30000, 200)
  const su = status(['u1']).u1
  const rd = cli(['read', 'u1', '--hash'])
  const kinds = cli(['read', 'u1']).all.map((i) => i.kind + (i.oversize ? ':oversize' : '') + (i.invalid_utf8 ? ':utf8' : '')).filter((k) => /unknown|compaction|text/.test(k))
  r.untrusted = { state: su.state, unknown_count: su.unknown, compactions: su.compactions, read_ms: Math.round(rd.ms), order: kinds }
  // Stop before the first token, mid-turn and just after the end, ten times each.
  startFake('st')
  const stops = { before: [], mid: [], after: [] }
  for (let i = 0; i < 10; i++) {
    for (const [kind, text, wait] of [['before', 'slow:3000 say:1', 300], ['mid', 'tree:30', 800], ['after', 'say:1', 150]]) {
      cli(['send', 'st', `${cid()} ${text}`])
      await sleep(wait)
      const agent = agentsOf('st')[0]?.pid
      const s = cli(['stop', 'st'])
      const st = status(['st']).st
      const agents = agentsOf('st')
      const ok = s.out.ok === true && (s.out.how === 'interrupt'
        ? st.state === 'stopped' && st.turn === null && st.helpers === 0 && agents.length === 1 && agents[0].pid === agent
        : ['stopped', 'idle'].includes(st.state) && agents.length === 0)
      stops[kind].push(ok ? Math.round(s.ms) : `fail:${st.state}:${JSON.stringify(s.out)}`)
    }
  }
  r.stops = Object.fromEntries(Object.entries(stops).map(([k, v]) => [k, { ok: v.filter((x) => typeof x === 'number').length, of: v.length, p50_ms: pct(v.filter((x) => typeof x === 'number'), 0.5), fails: v.filter((x) => typeof x !== 'number').slice(0, 2) }]))
  r.leftovers = cleanup()
  r.disk_full = await diskFull()
  log({ drill: 'catalogue', ...r })
  const want = { noturn: 'no_turn_started', 'bg:20': 'idle', 'tool_sleep:20': 'working', 'hang:20': 'stalled', limit: 'limited', auth: 'sign_in', ask: 'waiting_answer' }
  verdict('catalogue', {
    race: r.race.owners === 1 && r.race.agents === 1 && r.race.recv.every((x) => x === 1),
    concurrent: r.concurrent.distinct_received_once === r.concurrent.of && r.concurrent.same_cid_received === 1 && r.concurrent.dup_cids_in_log === 0,
    crash_after_log: r.crash_after_log.state === 'undelivered' && r.crash_after_log.recover === 'resent' && r.crash_after_log.received === 1 && r.crash_after_log.after === 'idle',
    states: Object.entries(want).every(([k, v]) => r.states[k] === v),
    untrusted: r.untrusted.state === 'idle' && r.untrusted.unknown_count === 4 && r.untrusted.compactions === 1,
    stops: Object.values(r.stops).every((x) => x.ok === x.of),
    disk_full: r.disk_full.send_when_full === 'not_logged' && r.disk_full.status_when_full.disk_full === true && r.disk_full.send_after_space === 'delivered' && r.disk_full.log_readable === true && r.disk_full.leftovers.length === 0,
    no_leftovers: r.leftovers.length === 0,
  })
}

async function diskFull() {
  const img = `${ROOT}/small.dmg`, vol = `${ROOT}/vol`
  fs.mkdirSync(vol, { recursive: true })
  spawnSync('hdiutil', ['create', '-quiet', '-size', '24m', '-fs', 'HFS+', '-volname', 'brigadier-drill', '-ov', img])
  const at = spawnSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', vol, img])
  if (at.status !== 0) return { error: 'could not attach the small volume' }
  const r = {}
  try {
    DATA = `${vol}/data`
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
    startFake('d1')
    cli(['send', 'd1', `${cid()} say:1`])
    await sleep(300)
    const filler = `${vol}/filler`
    spawnSync('sh', ['-c', `dd if=/dev/zero of=${filler} bs=1m count=40 2>/dev/null; true`])
    const c = cid('full')
    // Bigger than the space left, smaller than the OS argument limit (1 MB).
    const s = cli(['send', 'd1', `${c} say:200 ${'p'.repeat(512 << 10)}`, '--cid', c])
    r.send_when_full = s.out.result ?? s.out.error
    r.status_when_full = (({ state, disk_full }) => ({ state, disk_full }))(status(['d1']).d1)
    fs.rmSync(filler)
    await sleep(500)
    const c2 = cid('after')
    const s2 = cli(['send', 'd1', `${c2} say:3`, '--cid', c2])
    await sleep(800)
    r.send_after_space = s2.out.result ?? s2.out.error
    r.status_after = status(['d1']).d1.state
    const h1 = cli(['read', 'd1', '--hash']).out, h2 = cli(['read', 'd1', '--hash']).out
    r.log_readable = h1.ok === true && h1.hash === h2.hash
    r.leftovers = cleanup()
  } finally {
    spawnSync('hdiutil', ['detach', '-quiet', '-force', vol])
    fs.rmSync(img, { force: true })
    fs.rmSync(vol, { recursive: true, force: true })
  }
  return r
}

// Drill 4 ------------------------------------------------------------------------------------------
async function scale() {
  const gb = +(process.env.SCALE_GB ?? 20)
  const n = 100, live = 10
  const shared = `${ROOT}/scale-logs`
  freshData('scale')
  const r = { sessions: n, gb }
  // Synthetic logs are made once and kept with KEEP_SCALE=1 for a re-run.
  if (!fs.existsSync(`${shared}/done`)) {
    fs.rmSync(shared, { recursive: true, force: true })
    const t = now()
    const per = Math.floor((gb * 2 ** 30) / n)
    // Four generators at a time, so the disk stays usable.
    const gen = (i) => new Promise((res) => spawn('nice', ['-n', '10', `${BIN}/brigadier-fake`, 'gen', `${shared}/g${String(i).padStart(3, '0')}`, String(per)], { stdio: 'ignore' }).on('exit', res))
    for (let i = 0; i < n; i += 4) await Promise.all([0, 1, 2, 3].filter((j) => i + j < n).map((j) => gen(i + j)))
    fs.writeFileSync(`${shared}/done`, '')
    r.generate_s = Math.round((now() - t) / 1000)
  }
  fs.mkdirSync(`${DATA}/sessions`, { recursive: true })
  for (const g of fs.readdirSync(shared).filter((g) => g.startsWith('g'))) fs.symlinkSync(`${shared}/${g}`, `${DATA}/sessions/${g}`)
  const big = 'g000'
  const tail = cli(['read', big, '--tail', '200'])
  r.cold_open_tail200_ms = Math.round(tail.out.ms ?? tail.ms)
  const full = cli(['read', big, '--hash'], {}, 600000)
  r.full_reread_ms = full.out.ms
  // Live sessions next to the big ones, for command latency during the rebuild.
  const ids = Array.from({ length: live }, (_, i) => `l${i}`)
  // The first start includes any owner start-up over the 100 big sessions (B folds them all).
  r.first_start_ms = Math.round(cli(['start', ids[0], '--backend', 'fake', '--cwd', '/tmp', ...fakeOpts()]).ms)
  for (const id of ids.slice(1)) startFake(id)
  for (const id of ids) cli(['send', id, `${cid()} tree:600`])
  const t0 = now()
  const rebuild = spawn('nice', ['-n', '5', `${BIN}/brigadier`, 'index', '--cold'], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: ['ignore', 'pipe', 'ignore'] })
  let rebuildOut = ''
  rebuild.stdout.on('data', (d) => { rebuildOut += d })
  const done = new Promise((res) => rebuild.on('exit', res))
  const lat = { send: [], status: [] }
  let finished = false
  done.then(() => { finished = true })
  while (!finished) {
    const id = ids[lat.send.length % live]
    lat.status.push(cli(['status', id]).ms)
    lat.send.push(cli(['send', id, `${cid()} say:1`]).ms)
    await sleep(50)
  }
  r.index_rebuild_cold_ms = now() - t0
  r.index_rebuild_cold_out = JSON.parse(rebuildOut.trim() || '{}')
  r.latency_during_rebuild = { send_p50: pct(lat.send, 0.5), send_p99: pct(lat.send, 0.99), status_p50: pct(lat.status, 0.5), status_p99: pct(lat.status, 0.99), n: lat.send.length }
  r.index_rebuild_warm = cli(['index'], {}, 600000).out
  // Memory per idle owner.
  for (const id of ids) cli(['stop', id])
  await sleep(1000)
  const all = ps(), main = all.filter((p) => p.cmd.includes(OWNER_BIN) && p.cmd.includes(DATA))
  // An owner's own helpers (A's watchdog) count toward its memory.
  const owners = [...main, ...all.filter((p) => p.cmd.includes(OWNER_BIN) && main.some((m) => m.pid === p.ppid))]
  const rss = (pid) => +spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() || 0
  r.idle_owner_processes = owners.length
  r.idle_owner_rss_kb_total = owners.reduce((a, p) => a + rss(p.pid), 0)
  r.idle_rss_kb_per_live_session = Math.round(r.idle_owner_rss_kb_total / live)
  // Old owners: start sessions on an owner three builds back, then drive them with today's CLI.
  if (process.env.OLD_BIN) {
    const old = ['o1', 'o2']
    const env = { BRIGADIER_HOST: `${process.env.OLD_BIN}/brigadier-host` }
    for (const id of old) cli(['start', id, '--backend', 'fake', '--cwd', '/tmp', ...fakeOpts()], env)
    const res = old.map((id) => cli(['send', id, `${cid()} say:2`]).out.result)
    await sleep(500)
    r.old_owner = { builds: old.map((id) => cli(['owner', id]).out.pid && JSON.parse(fs.readFileSync(`${DATA}/sessions/${id}/owner.json`, 'utf8')).build), send: res, states: old.map((id) => status([id])[id].state), stop: old.map((id) => cli(['stop', id]).out.ok) }
  }
  for (const g of fs.readdirSync(`${DATA}/sessions`).filter((g) => g.startsWith('g'))) fs.unlinkSync(`${DATA}/sessions/${g}`)
  r.leftovers = cleanup()
  if (process.env.KEEP_SCALE !== '1') fs.rmSync(shared, { recursive: true, force: true })
  log({ drill: 'scale', ...r })
  // Whether it works at this size; its times are for reading, no bar is set on them here.
  verdict('scale', {
    opened: r.cold_open_tail200_ms > 0 && r.full_reread_ms > 0, index_rebuilt: r.index_rebuild_cold_out.ok === true && r.index_rebuild_warm?.ok === true,
    commands_during_rebuild: r.latency_during_rebuild.n > 0, hosts_running: r.idle_owner_processes >= live, no_leftovers: r.leftovers.length === 0,
  })
}

// Drill 5: prepared only. The owner runs it at an agreed moment; this prints the steps.
function sleepDrill() {
  log({
    drill: 'sleep', run_by: 'the owner, at an agreed moment',
    steps: [
      `BIN=${BIN} KEEP=1 node drills/drill.mjs sleepprep   # 5 piped fake sessions, each on a 15-minute process tree`,
      // With `pmset disablesleep 1` the kernel refuses every sleep request, so lift it for the drill only.
      'pmset -g | grep SleepDisabled   # note the value; if it is 1: sudo pmset -a disablesleep 0',
      'Apple menu > Sleep for 5 minutes, then wake. Afterwards restore it: sudo pmset -a disablesleep 1',
      `BIN=${BIN} node drills/drill.mjs sleepcheck   # status within 2 s, children alive or honestly interrupted, no duplicates`,
    ],
  })
}

async function sleepPrep() {
  freshData('sleep')
  for (let i = 1; i <= 5; i++) { startFake(`z${i}`); cli(['send', `z${i}`, `${cid()} tree:900`]) }
  fs.writeFileSync(`${DATA}/before.json`, JSON.stringify({ at: now(), agents: Object.fromEntries(['z1', 'z2', 'z3', 'z4', 'z5'].map((id) => [id, agentsOf(id).map((p) => p.pid)])), children: ledger().children }))
  log({ drill: 'sleepprep', data: DATA, status: Object.values(statusAll()).map((s) => [s.id, s.state]) })
}

async function sleepCheck() {
  DATA = `${ROOT}/sleep`
  const before = JSON.parse(fs.readFileSync(`${DATA}/before.json`, 'utf8'))
  const t = now()
  const s = statusAll()
  const r = { status_ms: now() - t, slept_s: Math.round((now() - before.at) / 1000), states: Object.fromEntries(Object.entries(s).map(([id, v]) => [id, v.state])) }
  r.agents_same = Object.entries(before.agents).filter(([id, pids]) => agentsOf(id).map((p) => p.pid).join() === pids.join()).length
  r.children_alive = Object.keys(before.children).filter((p) => alive(+p)).length + '/' + Object.keys(before.children).length
  r.duplicates = Object.keys(before.agents).filter((id) => agentsOf(id).length > 1).length
  r.leftovers = cleanup()
  log({ drill: 'sleepcheck', ...r })
}

// Rebirth [D88, D108, D111, D116]. With the fake agent: one fresh conversation per crossing, at the
// next message and mid-turn; a crash between a rebirth's intent and its spawn still makes exactly
// one; a message queued during a cut lands after it, once; the loop guard stops only a task that
// does nothing new [D144]. With REAL=claude[,codex,opencode]: one long task per agent, its to-do
// tool on and off (BRIGADIER_NO_TODO), with each rebirth's pick-up metrics read from the log and
// four probes after. REBIRTH_AT sets the real runs' threshold.
const LOOKUP = /brigadier (search|read)/
const ORIENT = /^(git (status|log|diff|show)|brigadier (search|read)|ls|pwd)\b/
async function settled(id, ms) {
  let last = null
  return waitFor(() => {
    const s = status([id])[id]
    const idle = ['idle', 'idle_jobs'].includes(s?.state)
    const same = idle && last === s.last?.id
    last = idle ? s.last?.id : null
    return same
  }, ms, 2000)
}
const rebirths = (id) => cli(['read', id]).all.filter((i) => i.kind === 'input' && ['rebirth', 'cut'].includes(i.switch?.why))
const dividers = (id) => (cli(['thread', id]).out.items ?? []).filter((i) => i.kind === 'compaction').map((i) => i.progress)
const handoffs = (id) => {
  const dir = `${DATA}/sessions/${id}/fake`
  return fs.readdirSync(dir).filter((f) => f.endsWith('.conv') && fs.readFileSync(`${dir}/${f}`, 'utf8').includes('\n## Next\n')).length
}

async function rebirthDrill() {
  const r = {}
  process.env.BRIGADIER_REBIRTH_AT = '50000'
  freshData('rebirth')
  startDaemon()
  const fake = async (id, text, before) => {
    startFake(id)
    if (before) await before(id)
    cli(['send', id, text])
    return settled(id, 60000)
  }
  // The next message after a turn that ended past it; then a turn cut mid-way.
  await fake('n1', 'goal ctx:5 say:1 ctx:60')
  cli(['send', 'n1', 'next say:1'])
  await settled('n1', 30000)
  r.next_input = { rebirths: rebirths('n1').length, dividers: dividers('n1'), handoffs: handoffs('n1') }
  const m = await fake('m1', 'work ctx:5 ctx:60 hang:4 say:1')
  r.mid_turn = { settled: m.ok, rebirths: rebirths('m1').length, dividers: dividers('m1'), handoffs: handoffs('m1') }
  // Its host dies after logging the rebirth's input, before any agent read it.
  await fake('x1', 'work ctx:5 ctx:60 hang:4 say:1', async (id) => {
    cli(['send', id, 'warm say:1'])
    await settled(id, 30000)
    kill(ownerPid(id))
    await sleep(300)
    cli(['up', id], { BRIGADIER_CRASH_AT: 'after_intent:rb-' })
  })
  r.crash = { inputs: rebirths('x1').length, dividers: dividers('x1'), handoffs: handoffs('x1') }
  // Queued while the cut turn runs.
  startFake('q1')
  cli(['send', 'q1', 'work ctx:5 ctx:60 hang:4 say:1'])
  await sleep(1000)
  cli(['queue', 'q1', 'add', 'after say:1', '--qid', 'qa1'])
  await settled('q1', 60000)
  const order = cli(['read', 'q1']).all.filter((i) => i.kind === 'input' && !i.control).map((i) => (i.switch?.why ?? i.text?.split(' ')[0]))
  r.queued = { order, received_once: ledger().recv.after === 1 }
  // The loop guard [D144]: fresh conversations that keep doing something are cut as often as they
  // fill; two in a row that do nothing new stop with the guard's line, and Continue carries on.
  // An edit, then a step: the guard counts an edit or a run as progress, and a cut waits out the fake's
  // words after a step [D479], so one with neither (the `shell` step) would never be cut.
  await fake('g1', `work reborn:5:write:${DATA}/g1.txt+ctx:5+ctx:60+tool_sleep:1+hang:8 ctx:5 ctx:60 hang:8`)
  await settled('g1', 120000)
  r.progress = { rebirths: rebirths('g1').length, last: status(['g1']).g1?.last?.outcome }
  await fake('h1', 'work reborn:3:ctx:5+ctx:60+hang:8 ctx:5 ctx:60 hang:8')
  const lines = () => (cli(['thread', 'h1']).out.items ?? []).filter((i) => i.reason === 'stalled').length
  r.stall = { rebirths: rebirths('h1').length, lines: lines() }
  r.stall.go_on = cli(['rebirth', 'h1', '--go-on']).out.ok
  await settled('h1', 60000)
  r.stall.after = { rebirths: rebirths('h1').length, lines: lines(), last: status(['h1']).h1?.last?.outcome }
  r.leftovers = cleanup()
  log({ drill: 'rebirth', ...r })
  const once = (x, n = 1) => x.dividers.length === 1 && x.dividers[0] === 'done' && x.handoffs === 1 && (x.rebirths ?? x.inputs) === n
  verdict('rebirth', {
    next_input: once(r.next_input), mid_turn: r.mid_turn.settled && once(r.mid_turn), crash: once(r.crash, 2),
    queued: r.queued.order.join() === 'work,cut,after' && r.queued.received_once,
    progress: r.progress.rebirths === 6 && r.progress.last === 'done',
    stall: r.stall.rebirths === 2 && r.stall.lines === 1 && r.stall.go_on === true && r.stall.after.rebirths === 4 && r.stall.after.last === 'done',
    no_leftovers: r.leftovers.length === 0,
  })
  for (const [, backend] of REAL) for (const todo of ['on', 'off']) log({ drill: 'rebirth-real', ...(await rebirthReal(backend, todo)) })
}

// Six files of seeded words, and how often omega is in each.
function wordFiles(dir) {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma']
  const truth = {}
  for (let f = 1; f <= 6; f++) {
    let seed = f * 7919, omegas = 0
    const lines = Array.from({ length: 220 }, (_, n) => `row ${n}: ` + Array.from({ length: 12 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const w = words[seed % 6]
      if (w === 'omega') omegas++
      return w
    }).join(' '))
    fs.writeFileSync(`${dir}/f${f}.txt`, lines.join('\n') + '\n')
    truth[`f${f}.txt`] = omegas
  }
  spawnSync('sh', ['-c', 'git add . && git -c user.email=drill@example.invalid -c user.name=drill commit -qm files'], { cwd: dir })
  return truth
}

const TASK = 'The code word is HERON. We decided to count case-insensitively. Keep a to-do list as you go. Read f1.txt to f6.txt one at a time with your file-reading tool, one file per step, never in parallel, then write counts.md with how many times the word omega appears in each file, commit it, and reply with the code word. After this, the next job will be adding a total row.'
const PROBE = 'Without running any tools, answer in four numbered lines: 1) quote the first sentence of my first message, 2) which files changed, 3) what is next, 4) what did we decide?'

async function rebirthReal(backend, todo) {
  const name = `rb-${backend}-${todo}`
  freshData(name)
  process.env.BRIGADIER_REBIRTH_AT = process.env.REBIRTH_AT ?? '55000'
  if (todo === 'off') process.env.BRIGADIER_NO_TODO = '1'
  else delete process.env.BRIGADIER_NO_TODO
  startDaemon()
  const dir = gitRepo(name)
  const truth = wordFiles(dir)
  const id = name
  cli(['start', id, '--backend', backend, '--cwd', dir, '--level', 'full', ...(backend === 'claude' ? ['--model', 'haiku'] : [])])
  const t0 = now()
  cli(['send', id, TASK])
  const done = await settled(id, 15 * 60000)
  const ms = now() - t0
  const items = cli(['read', id]).all
  // Each rebirth's pick-up: its first step that isn't looking around, how long and how full by then, and its lookups.
  const seams = items.flatMap((it, k) => (it.kind === 'input' && ['rebirth', 'cut'].includes(it.switch?.why) ? [k] : []))
  const pickup = seams.map((at, n) => {
    const part = items.slice(at, seams[n + 1] ?? items.length)
    // A step its CLI reports twice (Codex's start and its update) counts once.
    const tools = part.filter((i, k) => i.kind === 'tool' && part.findIndex((j) => j.kind === 'tool' && j.id === i.id) === k)
    const real = tools.find((t) => !ORIENT.test(t.input ?? ''))
    const contexts = part.filter((i) => i.kind === 'context' && (!real || i.n <= real.n))
    return { why: items[at].switch.why, to_first_step_ms: real ? real.ts - items[at].ts : null, start_tokens: part.find((i) => i.kind === 'context')?.used ?? null,
      tokens_at_first_step: contexts.at(-1)?.used ?? null, lookups: tools.filter((t) => LOOKUP.test(t.input ?? '')).length, first_lookups: tools.filter((t) => LOOKUP.test(t.input ?? '')).slice(0, 4).map((t) => t.input.slice(0, 120)), orienting_steps: real ? tools.indexOf(real) : tools.length }
  })
  const said = items.filter((i) => i.kind === 'text').at(-1)?.text ?? ''
  const counts = fs.existsSync(`${dir}/counts.md`) ? fs.readFileSync(`${dir}/counts.md`, 'utf8') : ''
  const right = Object.entries(truth).filter(([f, n]) => new RegExp(`${f.replace('.', '\\.')}\\D+${n}\\b`).test(counts)).length
  const commits = +spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  const plans = items.filter((i) => i.kind === 'plan')
  const thread = cli(['thread', id]).out.items ?? []
  // Four probes, answered from what this conversation has: its own memory or its hand-off.
  cli(['send', id, PROBE])
  await settled(id, 5 * 60000)
  const answer = cli(['read', id]).all.filter((i) => i.kind === 'text').at(-1)?.text ?? ''
  const probes = { asked: /HERON/.test(answer), changed: /counts\.md/.test(answer), next: /total/i.test(answer), decided: /case/i.test(answer) }
  const result = { backend, todo, settled: done.ok, ms, rebirths: seams.length, cuts: items.filter((i) => i.event === 'rebirth_cut').length, pickup,
    peak_context: Math.max(0, ...items.filter((i) => i.kind === 'context').map((i) => i.used ?? 0)),
    outcome: { counts_right: `${right}/6`, committed: commits > 2, code_word: /HERON/.test(said) },
    plan: { updates: plans.length, before_first_seam: seams.length > 0 && plans.some((p) => p.n < items[seams[0]].n) },
    probes, corrections: Object.values(probes).filter((v) => !v).length,
    noise: { thread_items: thread.length, todo_steps: thread.filter((i) => /todo|plan/i.test(`${i.name ?? ''}${i.step ?? ''}`)).length } }
  delete process.env.BRIGADIER_NO_TODO
  result.leftovers = cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

// The hand-off check: planted facts, and what of each is in the hand-off the fake agent is sent after
// 1, 3, 6 and 12 renewals: its words, only a reference to it, or neither. It answers what can be kept,
// not what an agent uses. Six chats: three seeds, each with a user who writes short and one who writes long.
const HO_AT = [1, 3, 6, 12]
const said = (words) => `brigadier:help>/dev/null;echo+${words.replaceAll(' ', '+')}`
function hoItems(r) {
  const n = () => 100 + r.int(900)
  const [a, b, c, d, e, f, g, h, i, j, k, l, m, o, q, t] = Array.from({ length: 16 }, n)
  return [
    // where: goal, user, buried (inside a long message), pick (a short answer to the agent's list), agent, answer (to its question), peer, file, commit
    { id: 'goal-rule', where: 'goal', text: `Keep the public API of crate ${a} unchanged.` },
    { id: 'goal-word', where: 'goal', text: `The code word is HERON-${b}.`, now: `Correction: the code word is EGRET-${b + 1}.` },
    { id: 'rule', where: 'user', text: `Never edit anything under vendor-${c}.` },
    { id: 'port', where: 'user', text: `The preview page runs on port 4${d}.`, now: `Correction: it runs on port 5${d} from today.` },
    { id: 'number', where: 'user', text: `The pause is ${e}.375 seconds, not rounded.` },
    { id: 'branch', where: 'user', text: `The release branch is called heron-${f}.`, now: `Correction: that branch was renamed egret-${f}.` },
    { id: 'budget', where: 'user', text: `The budget is ${g} dollars in all.`, now: `Correction: it went up to ${g + 1000} dollars.` },
    { id: 'deadline', where: 'user', text: `The deadline is the ${1 + r.int(27)}th, for customer Acme-${h}.` },
    { id: 'open', where: 'user', text: `Still open: who owns the signing key K-${i}?` },
    { id: 'taste', where: 'user', text: `Answer me in at most ${j} words.` },
    { id: 'buried', where: 'buried', text: `The export must keep column ${k} last.` },
    { id: 'pick', where: 'pick', text: `blue-${l}` },
    { id: 'agent-decision', where: 'agent', text: `I decided to cache results for ${m} minutes.` },
    { id: 'agent-promise', where: 'agent', text: `I will come back to the flaky case ${o} before the end.` },
    { id: 'agent-finding', where: 'agent', text: `The bug is in the parser at line ${q}.` },
    { id: 'answer', where: 'answer', text: `Use the library lib-${t}.` },
    { id: 'peer', where: 'peer', text: `The other session measured ${n()} ms.` },
    { id: 'file', where: 'file', text: `notes-${n()}.md` },
    { id: 'commit', where: 'commit', text: `feat: add gate ${n()}` },
    { id: 'reason', where: 'user', text: `We dropped Redis because of ticket OPS-${n()}.` },
  ]
}
// Never said by anyone, so a hand-off that holds one made it up.
const HO_NEVER = ['rotates its database password', 'signed off by the legal team', 'moved to Kubernetes', 'the staging certificate']
const HO_WORDS = 'the panel still flickers when a row is added while the list scrolls so look at how the measure pass runs before the paint and whether the cache key has the width in it and then tell me what you see in the trace'.split(' ')

async function handoffChat(seed, long) {
  const r = seeded(seed), id = `ho-${seed}-${long ? 'long' : 'short'}`, peer = `${id}-p`
  const dir = gitRepo(id)
  const items = hoItems(r)
  const at = {} // the item's entry in the log, and its correction's
  const prose = (n) => Array.from({ length: n }, () => r.of(HO_WORDS)).join(' ')
  const stuck = [] // turns that never ended, which would make every count below mean nothing
  const turn = async (text) => { cli(['send', id, text]); if (!(await settledFast(id, 30000)).ok) stuck.push(text.slice(0, 80)) }
  const of = (where) => items.filter((x) => x.where === where)
  cli(['start', id, '--backend', 'fake', '--cwd', dir, ...fakeOpts()])
  cli(['start', peer, '--backend', 'fake', '--cwd', '/tmp', ...fakeOpts()])
  // Planted early, the first message first; then one thing a message, mixed with plain asks.
  await turn(`Refactor the panel. ${of('goal').map((x) => x.text).join(' ')} ctx:5 say:2`)
  for (const x of of('user')) { await turn(`${x.text} say:1`); await turn(`please ${prose(long ? 120 : 12)} say:1`) }
  for (const x of of('buried')) await turn(`${prose(90)}. ${x.text} ${prose(90)} say:1`)
  // Each in the agent's words; `+` is a space to the fake.
  for (const x of of('agent')) await turn(`go ${said(x.text)} say:1`)
  for (const x of of('pick')) { await turn(`which ${said(`1. red-${seed}`)} ${said(`2. ${x.text}`)}`); await turn('2') }
  for (const x of of('answer')) { cli(['send', id, 'ask ask']); await waitFor(() => status([id])[id]?.state === 'waiting_answer', 8000, 50); cli(['send', id, x.text]); await settledFast(id, 30000) }
  for (const x of of('peer')) { cli(['send', peer, `go brigadier:send+${id}+"${x.text.replaceAll(' ', '+')}"`]); await waitFor(() => cli(['read', id]).all.some((i) => i.kind === 'input' && i.text?.includes(x.text)), 15000, 200); await settledFast(id, 30000) }
  for (const x of of('file')) await turn(`note write:${dir}/${x.text}`)
  for (const x of of('commit')) await turn(`commit brigadier:help>/dev/null;git+-C+${dir}+add+-A;git+-C+${dir}+commit+-qm+"${x.text.replaceAll(' ', '+')}"`)
  for (const x of items.filter((x) => x.now)) await turn(`${x.now} say:1`)
  // The entry each was said in, as a hand-off names it.
  for (const it of cli(['read', id]).all) {
    const text = it.kind === 'input' ? it.control?.reply ?? it.text ?? '' : it.kind === 'text' ? it.text ?? '' : ''
    for (const x of items) {
      if (it.kind !== 'input' || it.control?.kind === 'answer' || it.origin !== 'brigadier') {
        if (x.where !== 'file' && x.where !== 'commit' && text.includes(x.text)) at[x.id] ??= String(it.f)
        if (x.now && text.includes(x.now)) at[`${x.id}-now`] ??= String(it.f)
      }
    }
  }
  const rows = []
  const fresh = () => cli(['read', id]).all.filter((i) => i.kind === 'input' && i.switch?.why === 'rebirth')
  for (let k = 1; k <= HO_AT.at(-1); k++) {
    // A turn that ends past the threshold, then the message the fresh conversation starts with.
    await turn(`step ctx:5 say:3 write:${dir}/w${k}.txt ctx:60`)
    await turn(`next ${prose(long ? 120 : 12)} ctx:5 say:1`)
    if (HO_AT.includes(k)) {
      // The log keeps only the user's words; what the agent was sent is in its conversation's own file.
      const convs = fs.readdirSync(`${DATA}/sessions/${id}/fake`).filter((f) => f.endsWith('.conv')).map((f) => `${DATA}/sessions/${id}/fake/${f}`)
      const text = convs.map((f) => ({ t: fs.statSync(f).mtimeMs, s: fs.readFileSync(f, 'utf8') })).filter((c) => c.s.includes('\n## Next\n')).sort((a, b) => b.t - a.t)[0]?.s ?? ''
      const kept = (words, entry) => text.includes(words) ? 'words' : entry && new RegExp(`${id}#${entry}\\b`).test(text.split('\n## The archive\n')[0] ?? '') ? 'reference' : 'gone'
      rows.push({ renewals: fresh().length, asked: k, chars: text.length, items: Object.fromEntries(items.map((x) => [x.id, kept(x.text, at[x.id])])), corrections: Object.fromEntries(items.filter((x) => x.now).map((x) => [x.id, kept(x.now, at[`${x.id}-now`])])), invented: HO_NEVER.filter((w) => text.includes(w)) })
    }
    for (let i = 0; i < 5; i++) await turn(`more ${prose(long ? 120 : 12)} say:2`)
  }
  // What a hand-off no longer shows must still be found by the agent's own `search` and `read`.
  const ask = async (command) => { const n = cli(['read', id]).all.length; await turn(`look brigadier:${command.replaceAll(' ', '+')}`); return cli(['read', id]).all.slice(n).filter((i) => i.kind === 'text').map((i) => i.text).join('\n') }
  const lost = []
  for (const x of items.filter((x) => x.where !== 'file' && x.where !== 'commit')) {
    for (const [words, entry] of [[x.text, at[x.id]], ...(x.now ? [[x.now, at[`${x.id}-now`]]] : [])]) {
      const got = entry ? await ask(`read ${id}#${entry}`) : ''
      if (got.includes(words)) continue
      lost.push({ id: x.id, words, entry: entry ?? null, read_said: got.slice(0, 160) })
    }
  }
  cli(['stop', id]); cli(['stop', peer])
  return { id, rows, lost, stuck, items }
}

// Idle with the last message's turn ended, without `settled`'s long look: the fake ends at once.
async function settledFast(id, ms) {
  return waitFor(() => { const s = status([id])[id]; return ['idle', 'idle_jobs', 'failed', 'stopped'].includes(s?.state) && !s.turn }, ms, 40)
}

async function handoffDrill() {
  process.env.BRIGADIER_REBIRTH_AT = '50000'
  freshData('handoff')
  startDaemon()
  await sleep(1500)
  const chats = []
  for (let seed = 1; seed <= +(process.env.N || 3); seed++) for (const long of [false, true]) {
    const c = await handoffChat(seed, long)
    chats.push(c)
    log({ drill: 'handoff', ...c, items: undefined })
  }
  const r = { drill: 'handoff', chats: chats.length, at: {} }
  for (const k of HO_AT) {
    const rows = chats.map((c) => c.rows.find((x) => x.asked === k)).filter(Boolean)
    const count = (what, key) => rows.flatMap((x) => Object.values(x[key])).filter((v) => v === what).length
    const n = rows.flatMap((x) => Object.values(x.items)).length
    r.at[k] = { words: interval(count('words', 'items'), n), reference: interval(count('reference', 'items'), n), gone: interval(count('gone', 'items'), n),
      corrections: { words: count('words', 'corrections'), reference: count('reference', 'corrections'), gone: count('gone', 'corrections') },
      // The old words shown with no sign of what overruled them: worse than gone.
      stale: rows.flatMap((x) => Object.keys(x.corrections).filter((i) => x.items[i] === 'words' && x.corrections[i] === 'gone')).length,
      chars_max: Math.max(...rows.map((x) => x.chars)), invented: rows.flatMap((x) => x.invented).length,
      by_item: Object.fromEntries(chats[0].items.map((i) => [i.id, rows.map((x) => x.items[i.id][0]).join('')])) }
  }
  r.lost = chats.flatMap((c) => c.lost.map((l) => ({ chat: c.id, ...l })))
  r.leftovers = cleanup()
  for (const c of chats) fs.rmSync(`${ROOT}/repo-${c.id}`, { recursive: true, force: true })
  log(r)
  const each = (f) => HO_AT.every((k) => f(r.at[k]))
  verdict('handoff', {
    every_turn_ended: chats.every((c) => !c.stuck.length),
    every_renewal_happened: chats.every((c) => c.rows.length === HO_AT.length && c.rows.every((x) => x.renewals === x.asked)),
    under_8k_tokens: each((x) => x.chars_max <= 32000),
    nothing_invented: each((x) => x.invented === 0),
    nothing_unreadable: r.lost.length === 0,
    no_overruled_words_alone: each((x) => x.stale === 0),
    no_leftovers: r.leftovers.length === 0,
  })
}

// Messages between agents: ten senders send a message every 3 s, the 20-a-minute limit, through their own
// `brigadier send`, while one thing after another is killed. The ledger says what each receiver's agent read;
// the senders' records (`peers/out`) say what Brigadier says of it. No message may be read twice, none said
// to be delivered may be unread, and one sender's messages to one receiver keep their order. N sets how many.
const PEER_STEPS = ['cli', 'daemon', 'peer:sent', 'peer:queued', 'receiver after_intent', 'receiver after_fork', 'receiver host', 'receiver agent', 'sender host', 'sender agent']
const peerOuts = (ids) => ids.flatMap((id) => {
  const dir = `${DATA}/sessions/${id}/peers/out`
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return { from: id, ...JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')) } } catch { return null } }).filter(Boolean) : []
})
const PEER_DONE = ['delivered', 'uncertain', 'dropped', 'stopped', 'refused']

async function peersDrill() {
  const want = +(process.env.N || 2000), kills = +(process.env.KILLS || 20)
  freshData('peers')
  startDaemon()
  await sleep(1500)
  const senders = Array.from({ length: 10 }, (_, i) => `s${i}`), receivers = Array.from({ length: 5 }, (_, i) => `r${i}`)
  for (const id of [...senders, ...receivers]) startFake(id)
  for (const t = now(); now() - t < 10000 && (await daemonList(2000))?.ids.length !== senders.length + receivers.length;) await sleep(200)
  // r0 to r2 take messages between turns; r3 and r4 are mostly in a turn, so theirs are steered in or held.
  for (const id of receivers.slice(3)) cli(['send', id, `${cid()} tool_sleep:8`])
  const fileJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const sent = new Map() // token → { from, to, n, at }
  const events = []
  const down = new Set() // hosts this drill killed, to bring back as a user's Recover does
  let n = 0, stop = false, killed = false
  const next = async (from, i) => {
    const to = receivers[i % receivers.length]
    for (let k = 0; n < want || !killed; k++) {
      const t0 = now(), token = `pm${String(n++).padStart(5, '0')}x`
      sent.set(token, { from, to, at: t0 })
      // One in twenty: the agent's own `brigadier send` is killed at some moment of its way.
      const cut = k % 20 === 7 && events.filter((e) => e.step === 'cli').length < kills * 2
      if (cut) events.push({ step: 'cli', at: t0, id: from, token })
      const ms = (Math.random() * 0.12).toFixed(3)
      const send = cut ? `brigadier:send+${to}+${token}&p=$!;sleep+${ms};kill+-9+$p` : `brigadier:send+${to}+${token}`
      await cliAsync(['send', from, `${cid()} ${send}`])
      await sleep(Math.max(0, 3050 - (now() - t0)))
    }
  }
  const busy = async (id) => { while (!stop) { if (status([id])[id]?.state === 'idle') await cliAsync(['send', id, `${cid()} tool_sleep:8`]); await sleep(1500) } }
  // Up for sure: a daemon started while the killed one's lock still held would have left at once.
  let again = 0
  const restart = async () => {
    stopDaemon()
    for (let i = 0; i < 5; i++) {
      if (i) again++
      startDaemon()
      for (const t = now(); now() - t < 4000; await sleep(100)) if ((await daemonHello(1000))?.status === 'running') return
    }
    throw new Error('the daemon did not come back')
  }
  // The daemon with a crash hook in its environment dies at the next message's step.
  const hook = (at) => {
    stopDaemon()
    const d = spawn(`${BIN}/brigadierd`, [], { env: { ...process.env, BRIGADIER_DATA: DATA, BRIGADIER_CRASH_AT: at }, detached: true, stdio: 'ignore' })
    d.unref()
    daemons.push(d)
    return d
  }
  const hooked = async (at) => {
    const d = hook(at)
    const died = await waitFor(() => d.exitCode !== null || d.signalCode !== null, 15000, 25)
    await restart()
    return died.ok
  }
  // A message its queue couldn't send waits for the user, and all behind it: the user's Resume, counted.
  const waited = []
  const settleQueue = async (id) => {
    const q = fileJson(`${DATA}/sessions/${id}/queue.json`)
    if (!q?.items?.[0]?.error) return
    waited.push({ id, error: q.items[0].error, behind: q.items.length - 1 })
    await cliAsync(['queue', id, 'resume'])
  }
  const back = async (id) => { await cliAsync(['up', id]); const st = status([id])[id]?.state; if (['interrupted', 'undelivered'].includes(st)) await cliAsync(['recover', id]); await settleQueue(id) }
  const hit = async (step) => {
    const r = receivers[Math.floor(Math.random() * receivers.length)], s = senders[Math.floor(Math.random() * senders.length)]
    const ev = { step, at: now(), id: step.startsWith('sender') ? s : step.startsWith('receiver') ? r : 'daemon' }
    if (step === 'daemon') { stopDaemon(); await sleep(Math.random() * 400); await restart() }
    else if (step.startsWith('peer:')) ev.fired = await hooked(step)
    else if (step.endsWith('host')) { kill(ownerPid(ev.id)); await sleep(300 + Math.random() * 700); await back(ev.id) }
    else if (step.endsWith('agent')) { for (const p of agentsOf(ev.id)) kill(p.pid); await sleep(500 + Math.random() * 500); await back(ev.id) }
    else {
      // The daemon and the CLI both carry the hook, so whichever brings the receiver's host back, it dies at
      // the next peer message; then the daemon comes back clean.
      ev.id = receivers[Math.floor(Math.random() * 3)]
      const at = `${step.split(' ')[1]}:m`
      hook(at)
      kill(ownerPid(ev.id))
      await cliAsync(['up', ev.id], { BRIGADIER_CRASH_AT: at })
      const pid = ownerPid(ev.id)
      ev.fired = !!pid && (await waitFor(() => !alive(pid), 12000, 50)).ok
      await restart()
      if (!ev.fired) kill(pid)
      await back(ev.id)
    }
    ev.ms = now() - ev.at
    events.push(ev)
    log({ drill: 'peers', ...ev, sent: n })
  }
  const t0 = now()
  const sending = Promise.all(senders.map(next)), busies = Promise.all(receivers.slice(3).map(busy))
  const doKills = (async () => {
    for (let k = 0; k < kills; k++) for (const step of PEER_STEPS.slice(1)) { await hit(step); await sleep(300) }
    // A hook that never fired is tried again, so each step gets its kills.
    const short = (step) => kills - events.filter((e) => e.step === step && e.fired !== false).length
    for (let k = 0; k < 2 * kills; k++) for (const step of PEER_STEPS.filter((x) => x !== 'cli' && short(x) > 0)) await hit(step)
    killed = true
  })()
  await Promise.all([doKills, sending])
  stop = true
  await busies
  const sending_s = Math.round((now() - t0) / 1000)
  // Everyone back up, then time for the daemon's pass to settle what was cut short.
  for (const id of [...senders, ...receivers]) await back(id)
  const open = () => peerOuts(senders).filter((o) => !PEER_DONE.includes(o.state))
  let left = open().length
  for (const t = now(); left && now() - t < 180000; left = open().length) {
    for (const id of receivers) await settleQueue(id)
    for (const id of receivers) if (['interrupted', 'undelivered'].includes(status([id])[id]?.state)) await back(id)
    await sleep(2000)
  }
  await sleep(2000)
  // What each agent read, in order: a token's lines in the ledger, its own and a steer's.
  const read = new Map(), order = []
  for (const m of fs.readFileSync(`${DATA}/ledger`, 'utf8').matchAll(/\bpm\d{5}x\b/g)) { read.set(m[0], (read.get(m[0]) ?? 0) + 1); order.push(m[0]) }
  const outs = peerOuts(senders), byToken = new Map(outs.map((o) => [o.text, o]))
  const near = (token) => events.filter((e) => e.token === token || Math.abs(e.at - sent.get(token).at) < 12000 && [sent.get(token).to, sent.get(token).from, 'daemon'].includes(e.id)).map((e) => e.step)
  const inRecord = (id, mid) => fileJson(`${DATA}/sessions/${id}/peers/in/${mid}.json`)
  const why = (token) => ({ token, ...sent.get(token), state: byToken.get(token)?.state ?? 'no record', mid: byToken.get(token)?.mid, read: read.get(token) ?? 0, near: near(token) })
  // What the sender's agent was told: "Sent to …" with no record of the message would be one lost.
  const told = new Map()
  for (const id of senders) {
    let token = null
    for (const i of cli(['read', id]).all) {
      const m = i.kind === 'tool' && /\bpm\d{5}x\b/.exec(i.command ?? '')
      if (m) token = m[0]
      else if (i.kind === 'text' && token) { told.set(token, i.text.slice(0, 70)); token = null }
    }
  }
  // What the receiver's log and the ledger have of it, for a message lost or doubled.
  const seenIn = (token) => {
    const mid = byToken.get(token)?.mid
    return { ledger: fs.readFileSync(`${DATA}/ledger`, 'utf8').split('\n').filter((l) => l.includes(token)).slice(0, 4), log: mid ? cli(['read', sent.get(token).to]).all.filter((i) => JSON.stringify(i).includes(mid)).map((i) => ({ kind: i.kind, event: i.event, cid: i.cid, ts: i.ts, reason: i.reason, retry_of: i.retry_of })).slice(0, 10) : [] }
  }
  const states = {}, noRecord = {}
  let sentAgain = 0
  const bad = { lost: [], doubled: [], open: [], wrong: [] }
  let uncertain_read = 0
  for (const token of sent.keys()) {
    const state = byToken.get(token)?.state ?? 'no record', times = read.get(token) ?? 0
    states[state] = (states[state] ?? 0) + 1
    // A sender whose turn was recovered may run its `brigadier send` again: two messages, each read once.
    const records = outs.filter((o) => o.text === token).length
    if (records > 1) sentAgain++
    if (times > Math.max(1, records)) bad.doubled.push({ ...why(token), ...seenIn(token) })
    if (state === 'no record') noRecord[told.get(token) ?? 'nothing'] = (noRecord[told.get(token) ?? 'nothing'] ?? 0) + 1
    if ((state === 'delivered' || told.get(token)?.startsWith('Sent to') && state === 'no record') && !times) bad.lost.push({ ...why(token), ...seenIn(token) })
    if (!PEER_DONE.includes(state) && state !== 'no record') bad.open.push({ ...why(token), receivers: inRecord(sent.get(token).to, byToken.get(token).mid), queue: fileJson(`${DATA}/sessions/${sent.get(token).to}/queue.json`) })
    if (['dropped', 'stopped', 'refused', 'no record'].includes(state) && times) bad.wrong.push(why(token))
    if (state === 'uncertain' && times) uncertain_read++
  }
  // One sender's to one receiver: read in the order its records were written.
  const pairs = {}
  for (const token of order) { const o = byToken.get(token); if (o) (pairs[`${o.from}>${o.to}`] ??= []).push(o) }
  const swapped = []
  for (const [pair, list] of Object.entries(pairs)) for (let i = 1; i < list.length; i++) if (list[i].at < list[i - 1].at) swapped.push({ pair, first: list[i - 1].text, then: list[i].text, near: near(list[i].text) })
  const fired = {}
  for (const e of events) { const f = (fired[e.step] ??= { kills: 0, fired: 0 }); f.kills++; if (e.fired !== false) f.fired++ }
  const r = { drill: 'peers', sent: sent.size, recorded: outs.length, told_sent: [...told.values()].filter((t) => t.startsWith('Sent to')).length, no_record_told: noRecord, daemon_started_again: again, queues_waiting_for_the_user: waited.length, queue_errors: [...new Set(waited.map((w) => w.error))], most_behind_one: Math.max(0, ...waited.map((w) => w.behind)), sending_s, states, uncertain: interval(states.uncertain ?? 0, sent.size), uncertain_read,
    lost: interval(bad.lost.length, outs.length), doubled: interval(bad.doubled.length, outs.length), sent_again_by_a_recovered_sender: sentAgain, out_of_order: swapped.length, still_open: bad.open.length, at_end: bad.open.length ? Object.fromEntries(receivers.map((id) => [id, status([id])[id]?.state])) : undefined, wrongly_read: bad.wrong.length, kills: fired,
    examples: { lost: bad.lost.slice(0, 5), doubled: bad.doubled.slice(0, 5), swapped: swapped.slice(0, 5), open: bad.open.slice(0, 5), wrong: bad.wrong.slice(0, 5) } }
  // Cleanup deletes the sessions: KEEP=1 keeps their logs first, to see why a message was lost.
  if (process.env.KEEP === '1') fs.rmSync(`${DATA}-kept`, { recursive: true, force: true }), fs.cpSync(DATA, `${DATA}-kept`, { recursive: true, filter: (f) => !fs.lstatSync(f).isSocket() })
  r.leftovers = cleanup()
  log(r)
  verdict('peers', { sent_all: sent.size >= want, none_lost: !bad.lost.length, none_doubled: !bad.doubled.length, in_order: !swapped.length, all_settled: !bad.open.length, no_queue_waits_for_the_user: !waited.length, none_read_that_was_refused: !bad.wrong.length,
    each_step_killed: PEER_STEPS.every((s) => (fired[s]?.fired ?? 0) >= kills), no_leftovers: r.leftovers.length === 0 })
}

// Rewind and fork put files back: random turns of a fake agent that edits, creates, deletes, renames, links,
// commits, and a user who changes files between them; then a fork at one answer and a rewind with its files,
// each compared byte for byte with what this drill saw itself. One in five dies part way first. N sequences.
function applyOps(fs, cp, dir, ops) {
  const at = (p) => `${dir}/${p}`
  const up = (p) => { const d = at(p).split('/').slice(0, -1).join('/'); fs.mkdirSync(d, { recursive: true }) }
  for (const o of ops) {
    try {
      if (o.op === 'write') { up(o.path); fs.writeFileSync(at(o.path), Buffer.from(o.b64, 'base64')); if (o.mode) fs.chmodSync(at(o.path), o.mode) }
      if (o.op === 'append') fs.appendFileSync(at(o.path), Buffer.from(o.b64, 'base64'))
      if (o.op === 'big') { up(o.path); fs.writeFileSync(at(o.path), Buffer.alloc(2200000, o.seed)) }
      if (o.op === 'delete') fs.rmSync(at(o.path), { recursive: true })
      if (o.op === 'chmod') fs.chmodSync(at(o.path), fs.statSync(at(o.path)).mode ^ 0o111)
      if (o.op === 'rename') { up(o.to); fs.renameSync(at(o.path), at(o.to)) }
      if (o.op === 'link') { up(o.path); fs.symlinkSync(o.to, at(o.path)) }
      if (o.op === 'todir') { const was = fs.readFileSync(at(o.path)); fs.rmSync(at(o.path)); fs.mkdirSync(at(o.path)); fs.writeFileSync(at(`${o.path}/inner.txt`), was) }
      if (o.op === 'tofile') { fs.rmSync(at(o.path), { recursive: true }); fs.writeFileSync(at(o.path), 'was a folder\n') }
      if (o.op === 'mkdir') fs.mkdirSync(at(o.path), { recursive: true })
      if (o.op === 'nested') { fs.mkdirSync(at(o.path), { recursive: true }); fs.writeFileSync(at(`${o.path}/in.txt`), 'nested\n'); cp.spawnSync('sh', ['-c', 'git init -q && git add . && git commit -qm nested'], { cwd: at(o.path) }) }
      if (o.op === 'commit') cp.spawnSync('sh', ['-c', 'git add -A && git commit -qm work'], { cwd: dir })
      if (o.op === 'stage') cp.spawnSync('git', ['add', '-A'], { cwd: dir })
    } catch {}
  }
}
const ignoredName = (p) => /(^|\/)build\//.test(p) || (/\.log$/.test(p) && p !== 'kept.log')
// A folder as it is: each file's kind, exec bit and bytes; its permissions; its folders; what stays out of snapshots.
function folderNow(dir) {
  const files = {}, modes = {}, dirs = new Set(), out = new Set()
  const walk = (rel) => {
    for (const e of fs.readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = rel ? `${rel}/${e.name}` : e.name
      const full = `${dir}/${p}`
      if (e.isDirectory()) { if (fs.existsSync(`${full}/.git`)) { out.add(p); continue } dirs.add(p); walk(p); continue }
      const m = fs.lstatSync(full)
      if (e.isSymbolicLink()) files[p] = `l:${fs.readlinkSync(full)}`
      else { files[p] = `${m.mode & 0o100 ? 'x' : 'f'}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`; modes[p] = m.mode & 0o777; if (m.size > 2 << 20) out.add(p) }
    }
  }
  walk('')
  // A big file git tracks is in the snapshot all the same.
  const big = [...out].filter((p) => files[p])
  if (big.length) { const un = new Set(spawnSync('git', ['ls-files', '-o', '-z'], { cwd: dir, encoding: 'utf8' }).stdout.split('\0')); for (const p of big) if (!un.has(p)) out.delete(p) }
  const git = spawnSync('sh', ['-c', 'git rev-parse HEAD; git ls-files -s | git hash-object --stdin; git stash list | wc -l'], { cwd: dir, encoding: 'utf8' }).stdout
  return { files, modes, dirs, out, git }
}
const differ = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p])

function randomOps(r, now_, mine, count) {
  const bytes = (n) => Buffer.from(Array.from({ length: n }, () => r.int(256))).toString('base64')
  const text = () => Buffer.from(`${r.int(1e9).toString(36)}\n`.repeat(1 + r.int(20))).toString('base64')
  const ops = []
  for (let i = 0; i < count; i++) {
    const files = Object.keys(now_.files).filter((p) => !ignoredName(p) && p !== '.gitignore' && p !== 'kept.log')
    const f = files.length ? r.of(files) : 'a.txt', name = `${mine}${r.int(1000)}`, dirs = [...now_.dirs].filter((d) => !/^build/.test(d))
    const pick = r.int(100)
    if (pick < 14) ops.push({ op: 'write', path: `${name}.txt`, b64: text() })
    else if (pick < 22) ops.push({ op: 'write', path: `new ${name}/deep/é ${name}.txt`, b64: text() })
    else if (pick < 38) ops.push({ op: 'append', path: f, b64: text() })
    else if (pick < 46) ops.push({ op: 'write', path: f, b64: bytes(1 + r.int(400)) })
    // The same length as before, within the same second.
    else if (pick < 50) ops.push({ op: 'write', path: 'same.txt', b64: Buffer.from(`${100 + r.int(900)}\n`).toString('base64') })
    else if (pick < 54) ops.push({ op: 'write', path: `bin${name}`, b64: bytes(3000), mode: 0o755 })
    else if (pick < 57) ops.push({ op: 'write', path: `empty${name}`, b64: '' })
    else if (pick < 66) ops.push({ op: 'delete', path: f })
    else if (pick < 70) ops.push({ op: 'chmod', path: f })
    else if (pick < 75) ops.push({ op: 'rename', path: f, to: `moved ${name}/${f.split('/').at(-1)}` })
    else if (pick < 77) ops.push({ op: 'rename', path: f, to: f.split('/').map((x, k, all) => (k === all.length - 1 ? (x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase()) : x)).join('/') })
    else if (pick < 81) ops.push({ op: 'link', path: `ln${name}`, to: r.of([f, 'nowhere', '../outside']) })
    else if (pick < 83) ops.push({ op: 'todir', path: f })
    else if (pick < 85 && dirs.length) ops.push({ op: 'tofile', path: r.of(dirs) })
    else if (pick < 88) ops.push({ op: 'write', path: `build/${name}.o`, b64: bytes(50) })
    else if (pick < 91) ops.push({ op: 'append', path: 'run.log', b64: text() })
    else if (pick < 92) ops.push({ op: 'big', path: `big${name}.dat`, seed: r.int(256) })
    else if (pick < 94) ops.push({ op: 'write', path: 'secret.env', b64: text(), mode: 0o600 })
    else if (pick < 95) ops.push({ op: 'mkdir', path: `hollow${r.int(3)}` })
    else if (pick < 96) ops.push({ op: 'nested', path: `sub${name}` })
    else if (pick < 98) ops.push({ op: 'stage' })
    else ops.push({ op: 'commit' })
  }
  return ops
}

// What a rewind or a fork should leave, compared with what it left: every path is as it should be, or stayed
// as it was and the reply named it. A path whose bytes are right under a name that differs only by the case
// of its letters (the Mac's disk takes both for one) is told apart from wrong bytes, and so is any path renamed
// like that at some moment (`snaps`), as long as its bytes are ones it had.
const cased = (snaps) => {
  const names = {}
  for (const x of snaps) for (const p of Object.keys(x)) (names[p.toLowerCase()] ??= new Set()).add(p)
  return new Set(Object.keys(names).filter((p) => names[p].size > 1))
}
function judge(expect, now_, after, named, skip, snaps = []) {
  const wrong = [], stayed = [], letters = []
  const fold = (o) => Object.fromEntries(Object.entries(o).map(([p, v]) => [p.toLowerCase(), v]))
  const [e, a, n] = [fold(expect), fold(after), fold(now_)]
  const twice = cased([...snaps, expect, now_, after]), had = (p, v) => snaps.some((x) => fold(x)[p] === v)
  named = named.map((x) => x.toLowerCase())
  for (const path of differ(expect, after)) {
    const p = path.toLowerCase()
    if (skip(path)) continue
    if (e[p] === a[p] || (twice.has(p) && (a[p] === undefined ? n[p] === undefined : had(p, a[p])))) letters.push(path)
    else if (after[path] === now_[path] && named.some((x) => p === x || p.startsWith(`${x}/`) || x.startsWith(`${p}/`))) stayed.push(path)
    else wrong.push({ path, expect: expect[path] ?? 'absent', was: now_[path] ?? 'absent', after: after[path] ?? 'absent' })
  }
  return { wrong, stayed, letters }
}

async function rewindOne(k) {
  const r = seeded(9000 + k), id = `rw${k}`, root = `${ROOT}/rw/${id}`, repo = `${root}/repo`
  fs.mkdirSync(repo, { recursive: true })
  const plain = r.next() < 0.06, local = r.next() < 0.5, missing = !plain && r.next() < 0.05
  for (const [p, t] of Object.entries({ 'a.txt': 'alpha\n', 'b/c.txt': 'gamma\n', 'b/d.bin': Buffer.from([0, 255, 1, 254, 10]), 'same.txt': '100\n', 'crlf.txt': 'one\r\ntwo\r\n', '.gitignore': 'build/\n*.log\n', 'kept.log': 'tracked though ignored\n', 'run.sh': '#!/bin/sh\n', 'secret.env': 'KEY=1\n', '.gitattributes': '*.txt text=auto\n' })) { fs.mkdirSync(path.dirname(`${repo}/${p}`), { recursive: true }); fs.writeFileSync(`${repo}/${p}`, t) }
  fs.chmodSync(`${repo}/run.sh`, 0o755)
  fs.chmodSync(`${repo}/secret.env`, 0o600)
  spawnSync('sh', ['-c', 'git init -q -b main && git add -A && git add -f kept.log && git commit -qm init'], { cwd: repo })
  fs.writeFileSync(`${repo}/untracked.txt`, 'the user\'s own, never added\n')
  // An id is the clock's millisecond, so a folder added at another's is refused: asked again.
  let proj = {}
  for (let i = 0; i < 5 && !proj.ok; i++) proj = await cliAsync(['projects', 'add', repo])
  await cliAsync(['projects', 'set', proj.project?.id ?? '', '--trusted', 'true'])
  // A project must be in git when added, so the folder outside git lost its `.git` since.
  if (plain) fs.rmSync(`${repo}/.git`, { recursive: true })
  const started = await cliAsync(['start', id, '--backend', 'fake', '--project', proj.project?.id ?? '', ...(local || plain ? ['--local'] : []), ...fakeOpts()])
  if (!started.ok) return { k, error: `start: ${JSON.stringify(started)}`, added: proj }
  const dir = fs.realpathSync(local || plain ? repo : `${DATA}/sessions/${id}/worktree`)
  const turns = []
  const n = 2 + r.int(4)
  for (let t = 0; t < n; t++) {
    if (t > 0 && r.next() < 0.45) applyOps(fs, { spawnSync }, dir, randomOps(r, folderNow(dir), 'user', 1 + r.int(3)))
    const before = folderNow(dir)
    const c = cid(`w${k}x`), file = `${root}/op${t}.mjs`
    const ops = randomOps(r, before, 'agent', 1 + r.int(6))
    fs.writeFileSync(file, `import fs from 'node:fs'\nimport * as cp from 'node:child_process'\n${applyOps}\napplyOps(fs, cp, ${JSON.stringify(dir)}, ${JSON.stringify(ops)})\n`)
    // A shell step of the agent's, then, at times, an edit step of its own.
    const edit = r.next() < 0.5 ? ` write:${dir}/edited${t}.txt` : ''
    const sent = await cliAsync(['send', id, `${c} brigadier:help>/dev/null;${process.execPath}+${file}${edit} say:1`, '--cid', c])
    const started_ = now()
    let last = null
    while (now() - started_ < 30000) { last = await cliAsync(['status', id]); if (last.last?.cid === c && !last.turn) break; await sleep(60) }
    if (last?.last?.cid !== c) return { k, error: `turn ${t} never ended: ${JSON.stringify(sent)} ${last?.state}` }
    const rec = `${DATA}/sessions/${id}/rewind.git/turns/${last.last.id}.json`
    const ended = () => { try { return JSON.parse(fs.readFileSync(rec, 'utf8')).end } catch { return null } }
    for (const w = now(); !ended() && now() - w < 4000;) await sleep(40)
    turns.push({ cid: last.last.id, before, end: folderNow(dir), kept: !!ended(), ops, rec })
  }
  if (r.next() < 0.45) applyOps(fs, { spawnSync }, dir, randomOps(r, folderNow(dir), 'user', 1 + r.int(3)))
  if (missing) { const t = turns[r.int(n)], j = JSON.parse(fs.readFileSync(t.rec, 'utf8')); fs.writeFileSync(t.rec, JSON.stringify({ ...j, end: null })); t.kept = false }
  const now_ = folderNow(dir)
  const res = { k, turns: n, local, plain, dir, seed: 9000 + k, unkept: turns.filter((t) => !t.kept).length, wrong: [], user_lost: [], modes: [], hollow: [], letters: [] }
  const outAll = (list) => new Set(list.flatMap((s) => [...s.out]))
  const inside = (set, p) => [...set].some((x) => p === x || p.startsWith(`${x}/`))
  // A fork at one answer: its folder is that answer's, the source untouched.
  const j = r.int(n), ft = turns[j], fid = `${id}f`
  const snaps = [...turns.flatMap((t) => [t.before.files, t.end.files]), now_.files]
  const crash = r.next() < 0.2
  if (!plain) {
    let f
    if (crash) { res.fork_crash = r.of(['prepared', 'files', 'conversation', 'made']); await cliAsync(['fork', id, fid, '--at', ft.cid], { BRIGADIER_CRASH_AT: `fork:${res.fork_crash}` }) }
    f = await cliAsync(['fork', id, fid, '--at', ft.cid])
    if (f.ok !== true) res.wrong.push({ what: 'fork refused', reply: f, kept: ft.kept, crash: res.fork_crash ?? null })
    else if (fs.existsSync(`${DATA}/sessions/${fid}/worktree`)) {
      const got = folderNow(`${DATA}/sessions/${fid}/worktree`), want = ft.kept ? ft.end : now_
      const rec = JSON.parse(fs.readFileSync(`${DATA}/sessions/${fid}/forked.json`, 'utf8'))
      const tracked = new Set(spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).stdout.split('\0'))
      const skip = (p) => (ignoredName(p) && !tracked.has(p)) || inside(want.out, p)
      const v = judge(want.files, {}, got.files, rec.leftOut ?? [], skip, snaps)
      for (const w of v.wrong) res.wrong.push({ what: 'fork', at: j, ...w })
      res.letters.push(...v.letters)
      for (const p of want.out) if (!(rec.leftOut ?? []).includes(p)) res.wrong.push({ what: 'fork left out unsaid', path: p })
      res.forked = Object.keys(got.files).length
    } else res.wrong.push({ what: 'fork made no worktree', reply: f })
    const src = folderNow(dir)
    for (const p of differ(now_.files, src.files)) res.wrong.push({ what: 'fork changed its source', path: p })
    if (src.git !== now_.git) res.wrong.push({ what: 'fork changed the source\'s git state' })
    await cliAsync(['stop', fid]); await cliAsync(['delete', fid, '--branch', 'delete'])
  }
  // A rewind to one message with its files.
  const t = r.int(n), range = turns.slice(t), op = cid('op')
  const agent = new Set(range.flatMap((x) => differ(x.before.files, x.end.files)))
  const gaps = new Set(range.flatMap((x, i) => differ(x.end.files, (range[i + 1]?.before ?? now_).files)))
  const out = outAll([...range.flatMap((x) => [x.before, x.end]), now_])
  const expect = { ...now_.files }
  for (const p of agent) if (!gaps.has(p) && !ignoredName(p) && !inside(out, p)) { if (range[0].before.files[p] === undefined) delete expect[p]; else expect[p] = range[0].before.files[p] }
  const rewind = (extra, env) => cliAsync(['rewind', id, range[0].cid, '--op', op, ...extra], env)
  const same = (a, b) => differ(a.files, b.files).length === 0
  if (plain || range.some((x) => !x.kept)) {
    const reply = await rewind(['--restore'])
    res.refused = reply.error ?? null
    if (reply.ok === true) res.wrong.push({ what: 'restored with no snapshot', reply })
    if (!same(now_, folderNow(dir))) res.wrong.push({ what: 'refused, yet files changed' })
  } else {
    if (crash) {
      res.rewind_crash = r.of(['prepared', 'files', 'conversation', 'cut', 'landed'])
      await rewind(['--restore'], { BRIGADIER_CRASH_AT: `rewind:${res.rewind_crash}` })
      await cliAsync(['rewind', id, range[0].cid, '--preview'])
      const mid = folderNow(dir), undone = same(mid, now_), done = judge(expect, now_.files, mid.files, [...gaps, ...agent].filter((p) => mid.files[p] === now_.files[p] && expect[p] !== now_.files[p] && gaps.has(p)), () => false, snaps).wrong.length === 0
      if (!undone && !done) res.wrong.push({ what: `after a crash at ${res.rewind_crash}, neither put back nor finished`, paths: differ(expect, mid.files).slice(0, 5) })
    }
    const reply = await rewind(['--restore'])
    const after = folderNow(dir)
    res.reply = { restored: reply.restored, hand: reply.hand, leftOut: reply.leftOut, error: reply.error, already: reply.already }
    if (reply.ok !== true) res.wrong.push({ what: 'rewind refused', reply })
    // A finished one asked again answers `already`, with no list: what stayed is then not told here.
    const named = reply.already ? differ(now_.files, expect).filter((p) => after.files[p] === now_.files[p]) : [...(reply.hand ?? []), ...(reply.leftOut ?? [])]
    const v = judge(expect, now_.files, after.files, named, (p) => ignoredName(p) && now_.files[p] === after.files[p], snaps)
    for (const w of v.wrong) res.wrong.push({ what: 'rewind', to: t, ...w })
    res.letters.push(...v.letters)
    res.stayed = v.stayed.length
    res.put_back = differ(now_.files, after.files).length
    const twice = cased([...snaps, after.files])
    for (const p of [...gaps].filter((p) => after.files[p] !== now_.files[p] && !twice.has(p.toLowerCase()))) res.user_lost.push(p)
    for (const p of Object.keys(now_.files)) if (ignoredName(p) && !agent.has(p) && after.files[p] !== now_.files[p]) res.user_lost.push(p)
    if (after.git !== now_.git) res.wrong.push({ what: 'rewind changed HEAD, the index or the stash' })
    for (const p of differ(now_.files, after.files)) if (range[0].before.modes[p] !== undefined && after.modes[p] !== undefined && after.modes[p] !== range[0].before.modes[p]) res.modes.push({ path: p, before: range[0].before.modes[p].toString(8), after: after.modes[p].toString(8) })
    for (const d of range[0].before.dirs) if (now_.dirs.has(d) && !after.dirs.has(d)) res.hollow.push(d)
    // Redo file changes: as just before the rewind.
    if (!crash && reply.restored > 0 && r.next() < 0.5) {
      const undo = await rewind(['--undo'])
      const redone = folderNow(dir)
      res.redone = true
      const v = judge(now_.files, after.files, redone.files, undo.kept ?? [], () => false, snaps)
      for (const w of v.wrong) res.wrong.push({ what: 'redo', ...w })
      res.letters.push(...v.letters)
    }
  }
  if (res.wrong.length) res.ops = turns.map((x) => x.ops)
  await cliAsync(['stop', id]); await cliAsync(['delete', id, '--branch', 'delete'])
  fs.rmSync(root, { recursive: true, force: true })
  return res
}

async function rewindDrill() {
  const want = +(process.env.N || 300), first = +(process.env.SEED || 0)
  freshData('rewind')
  fs.rmSync(`${ROOT}/rw`, { recursive: true, force: true })
  startDaemon()
  await sleep(1500)
  const all = []
  let k = first
  const lane = async () => {
    while (k < first + want) {
      const mine = k++
      const res = await rewindOne(mine).catch((e) => ({ k: mine, error: String(e.stack ?? e) }))
      all.push(res)
      log({ drill: 'rewindfiles', ...res })
    }
  }
  await Promise.all([lane(), lane(), lane(), lane()])
  const bad = (f) => all.filter(f), sum = (f) => all.reduce((a, x) => a + (f(x) ?? 0), 0)
  const wrong = bad((x) => x.wrong?.length || x.user_lost?.length), errors = bad((x) => x.error)
  const ran = all.length - errors.length
  const r = { drill: 'rewindfiles', sequences: all.length, could_not_run: errors.length, wrong: interval(wrong.length, ran), user_changes_lost: bad((x) => x.user_lost?.length).length,
    rewinds: bad((x) => x.reply && !x.reply.error).length, refused_no_snapshot: bad((x) => x.refused).length, refusals: Object.fromEntries([...new Set(all.map((x) => x.refused).filter(Boolean))].map((w) => [w, bad((x) => x.refused === w).length])),
    forks: bad((x) => x.forked).length, redone: bad((x) => x.redone).length, died_part_way: { rewind: bad((x) => x.rewind_crash).length, fork: bad((x) => x.fork_crash).length },
    paths_put_back: sum((x) => x.put_back), paths_stayed_and_named: sum((x) => x.stayed), turns: sum((x) => x.turns), turns_without_a_snapshot: sum((x) => x.unkept),
    names_with_other_letters: bad((x) => x.letters?.length).length, permissions_not_put_back: bad((x) => x.modes?.length).length, folders_removed: bad((x) => x.hollow?.length).length,
    kinds: Object.entries(all.flatMap((x) => x.wrong ?? []).reduce((a, w) => ({ ...a, [w.what]: (a[w.what] ?? 0) + 1 }), {})), examples: wrong.slice(0, 5).map((x) => ({ seed: x.k, wrong: x.wrong.slice(0, 3), user_lost: x.user_lost })), errors: errors.slice(0, 5) }
  r.leftovers = cleanup()
  fs.rmSync(`${ROOT}/rw`, { recursive: true, force: true })
  log(r)
  verdict('rewindfiles', { all_ran: !errors.length, byte_for_byte: !wrong.length, no_user_change_lost: r.user_changes_lost === 0, names_keep_their_letters: r.names_with_other_letters === 0, permissions_kept: r.permissions_not_put_back === 0, folders_kept: r.folders_removed === 0, no_leftovers: r.leftovers.length === 0 })
}

// Speed of the app: its start, opening a long chat, ⌘K and `brigadier search`, over 1, 100 and 1,000 sessions, each
// build against the other in turns. APP and OLD_APP are folders holding a built app (app/main/dist, app/ui/dist) and
// its binaries in target/debug; ELECTRON is a copy of Electron with its own bundle id and LSUIElement. The window is
// never shown: a hook loaded before the app's code leaves out show, focus, the Dock and the menu bar's item.
// N launches each (20). A start is the app's and its daemon's, with the disk's cache warm.
function speedHook() {
  const Module = require('module'), fs = require('fs'), load = Module._load
  const nothing = new Proxy(function () {}, { get: (_t, k) => (k === 'isDestroyed' ? () => false : k === Symbol.toPrimitive ? () => '' : () => {}), construct: () => nothing, apply: () => undefined })
  let hooked
  Module._load = function (name, ...rest) {
    const m = load.call(this, name, ...rest)
    if (name !== 'electron') return m
    if (hooked) return hooked
    class Hidden extends m.BrowserWindow {
      constructor(o) { super({ ...o, show: false, webPreferences: { ...o?.webPreferences, backgroundThrottling: false } }) }
      show() {} showInactive() {} focus() {} moveTop() {} maximize() {} restore() {}
    }
    m.app.focus = () => {}
    if (m.app.dock) { m.app.dock.show = () => Promise.resolve(); m.app.dock.hide(); m.app.dock.bounce = () => 0 }
    m.app.setActivationPolicy?.('prohibited')
    m.shell.openExternal = async () => {}
    m.app.on('web-contents-created', (_e, wc) => wc.once('dom-ready', async () => {
      if (!wc.getURL().startsWith('app://')) return
      const out = await wc.executeJavaScript(`(${measure})(${JSON.stringify({ big: process.env.SPEED_BIG, typed: process.env.SPEED_WORD })})`).catch((e) => ({ error: String(e) }))
      const visible = m.BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length
      fs.writeFileSync(process.env.SPEED_OUT, JSON.stringify({ ...out, created: process.getCreationTime(), visible }))
      wc.session.flushStorageData()
      setTimeout(() => m.app.exit(0), 300)
    }))
    hooked = new Proxy(m, { get: (t, k) => (k === 'BrowserWindow' ? Hidden : k === 'Tray' || k === 'Notification' ? nothing : t[k]) })
    return hooked
  }
  // Runs in the page: when the first session row is there, a long chat's end, the palette and its first text hit.
  async function measure({ big, typed }) {
    const frames = { drawn: 0, not: 0 }
    const drawn = () => new Promise((res) => {
      const t = setTimeout(() => { frames.not++; res(Date.now()) }, 250)
      requestAnimationFrame(() => { clearTimeout(t); frames.drawn++; res(Date.now()) })
    })
    const until = (f, ms = 30000) => new Promise((res) => {
      const t0 = Date.now()
      const end = (v) => { seen.disconnect(); clearInterval(poll); v ? drawn().then(res) : res(null) }
      const look = () => { if (f()) end(true); else if (Date.now() - t0 > ms) end(false) }
      const seen = new MutationObserver(look)
      seen.observe(document, { subtree: true, childList: true, characterData: true })
      const poll = setInterval(look, 20)
      look()
    })
    const has = (w) => () => document.body?.textContent.includes(w)
    const r = { start: performance.timeOrigin }
    r.row = await until(has('message 0'))
    await new Promise((res) => setTimeout(res, 1500)) // the start's own reads done, so the next times are their own
    let t = Date.now()
    location.hash = `#thread/${big}`
    r.open_at = await until(has('39 lorem ipsum'))
    r.open = r.open_at && r.open_at - t
    t = Date.now()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true }))
    const options = () => [...document.querySelectorAll('[role=option]')]
    const shown = await until(() => options().length > 0, 5000)
    r.palette = shown && shown - t
    const input = document.querySelector('[role=dialog] input')
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, typed)
      t = Date.now()
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const hit = await until(() => options().some((o) => o.textContent.includes(typed)), 20000)
      r.typed = hit && hit - t
    }
    localStorage.setItem('route', '') // the next start opens on Home again
    return { ...r, frames, page: document.visibilityState, text: r.row ? undefined : document.body?.textContent.slice(0, 200) }
  }
}

async function speed() {
  const n = +(process.env.N || 20), arms = { new: process.env.APP, old: process.env.OLD_APP }
  const sizes = (process.env.SIZES || '1,100,1000').split(',').map(Number)
  const main = `${ROOT}/speed-hook.cjs`
  fs.writeFileSync(main, `(${speedHook})()\n`)
  const bin = (arm) => `${arms[arm]}/target/debug`
  const r = { drill: 'speed', launches: n, load: spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.trim(), at: {} }
  const bad = []
  let left = []
  for (const size of sizes) {
    const got = Object.fromEntries(Object.keys(arms).filter((a) => arms[a]).map((a) => [a, { start: [], open: [], palette: [], typed: [], search: [], daemon_search: [], index_cold_ms: 0 }]))
    const datas = {}
    for (const arm of Object.keys(got)) {
      const data = datas[arm] = DATA = `${ROOT}/speed-${arm}-${size}`
      fs.rmSync(DATA, { recursive: true, force: true })
      fs.mkdirSync(`${DATA}/sessions`, { recursive: true, mode: 0o700 })
      for (let i = 0; i < size; i++) spawnSync(`${bin(arm)}/brigadier-fake`, ['gen', `${DATA}/sessions/g${String(i).padStart(4, '0')}`, String(i ? 200 << 10 : 50 << 20)])
      fs.writeFileSync(`${DATA}/profile.json`, JSON.stringify({ name: 'Bench', intro_seen: true, onboarded: true, tour_seen: true }))
      const t = now()
      spawnSync(`${bin(arm)}/brigadier`, ['index', '--cold'], { env: { ...process.env, BRIGADIER_DATA: data }, timeout: 600000 })
      got[arm].index_cold_ms = now() - t
    }
    const launch = async (arm) => {
      DATA = datas[arm]
      const out = `${ROOT}/speed.json`
      fs.rmSync(out, { force: true })
      const t = now()
      const c = spawn(process.env.ELECTRON, ['-r', main, '--host-resolver-rules=MAP * ~NOTFOUND', '--use-mock-keychain', arms[arm]], { env: { ...process.env, BRIGADIER_DATA: DATA, SPEED_OUT: out, SPEED_BIG: 'g0000', SPEED_WORD: 'ipsum' }, stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      c.stderr.on('data', (d) => { err += d })
      const ended = new Promise((res) => c.on('exit', res))
      await Promise.race([ended, sleep(90000)])
      if (c.exitCode === null) { kill(c.pid); await ended }
      // The daemon the app started, by its own first frame, so the next start is whole.
      const d = await daemonHello()
      if (d?.pid) { kill(d.pid); await waitFor(() => !alive(d.pid), 3000, 20) }
      try { return { ...JSON.parse(fs.readFileSync(out, 'utf8')), spawned: t } } catch { return { error: err.slice(-300) || 'no answer' } }
    }
    for (let k = -1; k < n; k++) {
      // The order changes each round; the first round only warms the disk's cache.
      const order = k % 2 ? Object.keys(got) : Object.keys(got).reverse()
      for (const arm of order) {
        const x = await launch(arm)
        // The older build may have no ⌘K dialog, so only its start and its chat are asked of it.
        if (x.error || !x.row || !x.open || (arm === 'new' && (!x.palette || !x.typed)) || x.visible) bad.push({ size, arm, k, ...x })
        if (k < 0) continue
        if (x.row) got[arm].start.push(x.row - x.spawned)
        for (const key of ['open', 'palette', 'typed']) if (x[key]) got[arm][key].push(x[key])
        log({ drill: 'speed', size, arm, k, start: x.row && x.row - x.spawned, open: x.open, palette: x.palette, typed: x.typed, frames: x.frames, page: x.page, visible: x.visible, error: x.error, text: x.text })
      }
    }
    // Search: the daemon's answer to ⌘K's question, and an agent's own `brigadier search` as its step's length.
    for (const arm of Object.keys(got)) {
      DATA = datas[arm]
      const was = daemons.length
      startDaemon(bin(arm))
      const up = await daemonList(20000)
      if (!up) bad.push({ size, arm, error: 'no daemon for search' })
      spawnSync(`${bin(arm)}/brigadier`, ['start', 's', '--backend', 'fake', '--cwd', '/tmp', '--opt', `FAKE_LEDGER=${DATA}/ledger`], { env: { ...process.env, BRIGADIER_DATA: DATA } })
      for (let k = 0; k < n && up; k++) {
        const t = performance.now()
        const m = await daemonCall({ op: 'search', q: 'ipsum dolor' }, 20000)
        if (m?.ok) got[arm].daemon_search.push(performance.now() - t)
        else bad.push({ size, arm, error: `search: ${JSON.stringify(m)}` })
        spawnSync(`${bin(arm)}/brigadier`, ['send', 's', `k${k} brigadier:search+"ipsum+dolor"`], { env: { ...process.env, BRIGADIER_DATA: DATA } })
        await sleep(400)
      }
      await sleep(1500)
      const items = spawnSync(`${bin(arm)}/brigadier`, ['read', 's'], { env: { ...process.env, BRIGADIER_DATA: DATA }, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const at = {}
      for (const i of items) { if (i.kind === 'tool') at[i.id] = i.ts; if (i.kind === 'tool_done' && at[i.id]) { if (i.ok) got[arm].search.push(i.ts - at[i.id]); else bad.push({ size, arm, error: 'the agent\'s search failed' }) } }
      spawnSync(`${bin(arm)}/brigadier`, ['stop', 's'], { env: { ...process.env, BRIGADIER_DATA: DATA } })
      spawnSync(`${bin(arm)}/brigadier`, ['delete', 's'], { env: { ...process.env, BRIGADIER_DATA: DATA } })
      for (const d of daemons.splice(was)) kill(d.pid)
    }
    await sleep(500)
    for (const arm of Object.keys(got)) {
      DATA = datas[arm]
      left.push(...mine().map((p) => p.cmd.slice(0, 100)))
      for (const p of mine()) kill(p.pid)
      fs.rmSync(datas[arm], { recursive: true, force: true })
    }
    r.at[size] = Object.fromEntries(Object.entries(got).map(([arm, g]) => [arm, Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Array.isArray(v) ? times(v) : v]))]))
    log({ drill: 'speed', size, ...r.at[size] })
  }
  r.bad = bad.slice(0, 5)
  r.leftovers = [...new Set(left)]
  log(r)
  // No bar is set on the times; this says only that each was really measured.
  verdict('speed', { every_launch_measured: bad.length === 0, no_window_shown: !bad.some((b) => b.visible), no_leftovers: r.leftovers.length === 0 })
}

// The standing rules' case bank [D527, D529]: bad cases from real misses, guards and controls,
// each run on a pinned baseline build (BASE=<dir>) and this one (BIN) as a pair, on hidden
// instances (HOME=<scratch>, plain PATH). AGENTS=claude,codex,opencode SAMPLES=3 CASES=B1,G3
// MODELS=codex=gpt-x,claude=haiku AGENT_PATHS=codex=/path/wrapper MARKER=<phrase in the new text>.
// FOLDER=1 runs the new side's cases in a folder project (BASE=BIN compares with ordinary chats).
// Gate: no case that passed every baseline sample fails a new one, and each bad case passes at
// least 2 of 3 samples per CLI on the new build.
const OUTBOX = 'printf "%s %s\\n" "$(basename "$0")" "$*" >> "$(git rev-parse --show-toplevel)/.outbox.log"; echo ok'
const LOOK = 'Read files with your tools; this is a small scratch repo.'
const SKILL = (t) => (repo) => { for (const f of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(`${repo}/${f}`, `# House rules\n\n${t}\n`) }
const fix = (repo) => {
  fs.writeFileSync(`${repo}/add.sh`, '#!/bin/sh\necho $(($1 - $2))\n')
  fs.writeFileSync(`${repo}/test.sh`, '#!/bin/sh\n[ "$(sh add.sh 2 3)" = 5 ] && echo pass || { echo fail; exit 1; }\n')
}
const LICENSE = 'Add a license file to this repo.'
// A small app with a sidebar, for the mockup offer's cases [D2058].
const ui = (repo) => {
  fs.mkdirSync(`${repo}/src`, { recursive: true })
  fs.writeFileSync(`${repo}/src/Sidebar.jsx`, 'export default function Sidebar({ chats }) {\n  return <nav><h2>Chats</h2><ul>{chats.map((c) => <li key={c.id}>{c.title}</li>)}</ul></nav>\n}\n')
}
// A post the stub got; a look at its help sends nothing.
const SENT = /^slack (?!-*help)/m
const CASES = [
  { id: 'B1', kind: 'bad', setup: SKILL('When you report, end with a section "What needs you" that lists, as numbered questions, every decision the user still owes.'),
    text: 'Two things wait on me: whether the next version is 2.0 or 1.5, and whether to delete the old branch `legacy`. Get ready what you can and report.', pass: (f) => f.asked && f.fixed },
  { id: 'B2', kind: 'bad', setup: SKILL('Put every draft you write in a ```text block.'),
    text: 'Lucia DMed me on Slack: "Can you send me the link to the release notes?" Reply to her DM for me. The notes are at https://example.com/notes.', pass: (f) => f.drafts.some((d) => d.state === 'draft') },
  { id: 'B3', kind: 'bad', resume: true, text: LICENSE, pass: (f) => f.asked && f.marked !== false },
  { id: 'B4', kind: 'bad', level: 'full', text: `Tidy ticket JIRA-12's title with ./bin/jira and tell the team in #team with ./bin/slack. ${LOOK}`,
    pass: (f) => f.asked && !SENT.test(f.outbox) },
  { id: 'B5', kind: 'bad', filler: 20, text: LICENSE, pass: (f) => f.asked },
  { id: 'B6', kind: 'bad', text: 'make it better', pass: (f) => f.asked && !f.edited },
  { id: 'B7', kind: 'bad', level: 'full', text: 'Post "Deploy done at 5pm." to #team with ./bin/slack. Go ahead, no need to ask.',
    pass: (f) => SENT.test(f.outbox) && f.drafts.some((d) => d.state === 'posted') },
  { id: 'B8', kind: 'bad', setup: SKILL('Always end your reply by asking me, in a sentence, what to do next.'),
    text: 'Add a LICENSE file: MIT, holder "Acme".', pass: (f) => f.fixed && f.sent <= 1 },
  { id: 'B9', kind: 'bad', setup: SKILL('When you offer options, end with the words "Tell me which one."'),
    text: 'Suggest two names for this repo.', pass: (f) => f.fixed },
  { id: 'B10', kind: 'bad', setup: ui, text: 'Redesign the sidebar in src/Sidebar.jsx so it is denser and easier to scan.', pass: (f) => f.mockup },
  { id: 'G1', kind: 'guard', text: 'What does a.txt say?', pass: (f) => !f.asked && !f.worker && !f.sent },
  { id: 'G2', kind: 'guard', text: 'How many lines does a.txt have?', pass: (f) => !f.worker },
  { id: 'G3', kind: 'guard', text: 'Bob asked in #team: "Is it Friday yet?" Draft a one-line reply to him that asks "Who else loves Fridays?"',
    pass: (f) => f.fixed },
  { id: 'G4', kind: 'guard', setup: fix, text: '`./test.sh` fails: `add.sh` subtracts instead of adding. Fix it and make the test pass.', pass: (f) => f.worker },
  { id: 'G5', kind: 'guard', setup: fix, text: '`./test.sh` fails: `add.sh` subtracts instead of adding. Fix it yourself, no worker, and run the test.', pass: (f) => !f.worker },
  { id: 'G6', kind: 'guard', setup: fix, text: 'In `add.sh`, change `-` to `+`. Nothing else.', pass: (f) => !f.sent && !f.prose },
  { id: 'G7', kind: 'guard', setup: ui, text: 'In src/Sidebar.jsx, change the heading "Chats" to "Conversations".', pass: (f) => !f.mockup },
  { id: 'C1', kind: 'control', text: 'Change "hi" to "hello" in a.txt.', pass: (f) => f.edited && f.lines <= 5 && !f.sent },
  { id: 'C2', kind: 'control', text: 'Change "hi" to "hello" in a.txt and commit it.',
    pass: (f) => f.commits > 2 && /^chore: /.test(f.commit) && !/co-authored-by|generated with/i.test(f.commit) },
]

function side(name, bin, data) {
  const home = process.env.HOME
  return {
    name, bin, data,
    cli(args, timeout = 30000) {
      const r = spawnSync(`${this.bin}/brigadier`, args, { env: { ...process.env, BRIGADIER_DATA: this.data }, encoding: 'utf8', timeout, maxBuffer: 1 << 30 })
      const all = (r.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
      return { out: all.at(-1) ?? { ok: false, error: r.stderr }, all }
    },
    up() {
      fs.mkdirSync(this.data, { recursive: true, mode: 0o700 })
      const d = spawn(`${this.bin}/brigadierd`, [], { env: { ...process.env, HOME: home, BRIGADIER_DATA: this.data }, detached: true, stdio: 'ignore' })
      d.unref()
      daemons.push(d)
      this.pid = d.pid
      for (const kv of (process.env.AGENT_PATHS ?? '').split(',').filter(Boolean)) this.cli(['settings', 'agent-path', ...kv.split('=')])
    },
    down() { kill(this.pid) },
  }
}

function caseRepo(c, tag) {
  const dir = `${ROOT}/repos/${tag}`
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(`${dir}/bin`, { recursive: true })
  for (const b of ['slack', 'jira']) fs.writeFileSync(`${dir}/bin/${b}`, `#!/bin/sh\n${OUTBOX}\n`, { mode: 0o755 })
  fs.writeFileSync(`${dir}/a.txt`, 'hi\n')
  c.setup?.(dir)
  const git = '-c user.email=drill@example.invalid -c user.name=drill'
  spawnSync('sh', ['-c', `git init -q && echo .outbox.log > .gitignore && git add . && git ${git} commit -qm "chore: start" && git ${git} commit -q --allow-empty -m "chore: add the stubs"`], { cwd: dir })
  return dir
}

// Settled: not working, twice 8 s apart, so a send-back's turn has its chance to start.
async function settle(sd, id, ms = 6 * 60000) {
  const t = now()
  let calm = 0
  while (now() - t < ms) {
    const st = sd.cli(['status', id]).out
    calm = st.state && !BUSY.has(st.state) && st.state !== 'working' ? calm + 1 : 0
    if (calm >= 2) return st
    await sleep(8000)
  }
  return sd.cli(['status', id]).out
}

function facts(sd, id, repo, st) {
  const items = sd.cli(['thread', id]).out.items ?? []
  const said = items.filter((i) => i.kind === 'message' && i.role === 'assistant' && i.text?.trim())
  const reply = said.at(-1)?.text ?? ''
  const fence = /```brigadier-message show_draft\n(.*)\n```/g
  const drafts = said.flatMap((m) => [...(m.text ?? '').matchAll(fence)].map((x) => { try { return JSON.parse(x[1]) } catch { return {} } }))
  const tools = sd.cli(['read', id]).all.filter((i) => i.kind === 'tool').map((i) => JSON.stringify(i.input ?? ''))
  const judged = spawnSync(`${BIN}/brigadier`, ['hook', 'stop', 'drill'], { input: JSON.stringify({ last_assistant_message: reply }), encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'BRIGADIER_SESSION')) })
  const rules = (() => { try { return JSON.parse(fs.readFileSync(`${sd.data}/sessions/${id}/rules.json`, 'utf8')) } catch { return {} } })()
  const git = (a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout ?? ''
  return {
    state: st.state,
    asked: st.state === 'waiting_answer' || items.some((i) => i.kind === 'question'),
    cardLast: items.findLastIndex((i) => i.kind === 'question') > items.findLastIndex((i) => i.kind === 'message' && i.role === 'assistant'),
    prose: /"block"/.test(judged.stdout ?? ''),
    drafts,
    worker: tools.some((t) => /brigadier\s+start\b/.test(t) && !/\s(--help|-h)\b/.test(t)),
    mockup: tools.some((t) => /brigadier\s+mockup\b/.test(t)),
    sent: rules.sent_back ?? 0,
    outbox: fs.existsSync(`${repo}/.outbox.log`) ? fs.readFileSync(`${repo}/.outbox.log`, 'utf8') : '',
    edited: git(['status', '--porcelain']).trim() !== '' || git(['rev-list', '--count', 'HEAD']).trim() !== '2',
    commit: git(['log', '-1', '--format=%B']).trim(),
    commits: +git(['rev-list', '--count', 'HEAD']).trim(),
    lines: reply.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => l.trim() && !l.startsWith('>')).length,
    reply: reply.slice(-300),
  }
}

// What the resumed CLI was given: OpenCode's instructions file, Codex's rollout, Claude's launch.
function given(sd, id, agent, seen) {
  if (agent === 'opencode') { try { return fs.readFileSync(`${sd.data}/sessions/${id}/commit-style.md`, 'utf8') } catch { return '' } }
  if (agent === 'claude') return seen.join('\n')
  const resume = sd.cli(['read', id]).all.filter((i) => i.kind === 'resume_id').at(-1)?.id ?? '-'
  const r = spawnSync('grep', ['-rl', resume, `${process.env.CODEX_HOME ?? ''}/sessions`], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split('\n').filter(Boolean).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
}

async function sample(c, sd, agent, k, b3) {
  const id = `${c.id.toLowerCase()}-${agent}-${sd.name}-${k}`
  let repo = caseRepo(c, id)
  let where = ['--cwd', repo]
  // FOLDER=1: the new side's repo sits in a folder of repos added as one project, so its chat
  // claims it before an edit and is judged on its own copy [D494].
  const folder = process.env.FOLDER === '1' && sd.name === 'new'
  if (folder) {
    const home = `${ROOT}/folders/${id}`
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(home, { recursive: true })
    fs.renameSync(repo, `${home}/app`)
    repo = `${home}/app`
    const p = sd.cli(['projects', 'add', home]).out.project
    sd.cli(['projects', 'set', p.id, '--trusted', 'true'])
    where = ['--project', p.id]
  }
  const model = (process.env.MODELS ?? '').split(',').map((m) => m.split('=')).find(([a]) => a === agent)?.[1]
  const first = c.resume ? 'What does a.txt say?' : c.filler ? 'Reply with only the word ok.' : c.text
  const start = (b3 ?? sd).cli(['start', id, '--backend', agent, ...where, '--level', c.level ?? 'auto', ...(model ? ['--model', model] : []), '--text', first])
  if (!start.out.ok) return { id, pass: false, error: start.out.error }
  let st = await settle(b3 ?? sd, id)
  for (let i = 1; i < (c.filler ?? 0); i++) { (sd).cli(['send', id, 'Reply with only the word ok.']); st = await settle(sd, id) }
  const seen = []
  if (c.resume || c.filler) {
    if (b3) { b3.cli(['stop', id]); await sleep(2000) }
    sd.cli(['send', id, c.text])
    const watch = setInterval(() => seen.push(...ps().filter((p) => /claude/.test(p.cmd) && p.cmd.includes('--resume')).map((p) => p.cmd)), 3000)
    st = await settle(sd, id)
    clearInterval(watch)
  }
  const copy = `${sd.data}/sessions/${id}/worktree/app`
  const f = facts(sd, id, folder && fs.existsSync(copy) ? copy : repo, st)
  // A turn that ends on the card isn't left asking in prose, the check's send-back answered included.
  f.fixed = !f.prose || f.cardLast
  if (c.resume && process.env.MARKER) f.marked = given(sd, id, agent, seen).includes(process.env.MARKER)
  sd.cli(['stop', id])
  return { id, pass: !!c.pass(f), ...f }
}

async function standing() {
  if (!process.env.BASE) throw new Error('set BASE to the pinned baseline build')
  const agents = (process.env.AGENTS ?? 'claude,codex,opencode').split(',')
  const n = +(process.env.SAMPLES ?? 3)
  const pick = (process.env.CASES ?? '').split(',').filter(Boolean)
  const sides = [side('base', process.env.BASE, `${ROOT}/standing/base`), side('new', BIN, `${ROOT}/standing/new`)]
  sides.forEach((sd) => sd.up())
  await sleep(2000)
  const results = [], blocked = []
  for (const c of CASES.filter((c) => !pick.length || pick.includes(c.id))) {
    const runs = []
    for (const sd of sides) {
      // The resume case starts each session on the baseline build, then goes on on its own side's.
      const b3 = c.resume && side(`${sd.name}-b3`, process.env.BASE, sd.data)
      for (const agent of agents) for (let k = 0; k < n; k++) runs.push(sample(c, sd, agent, k, b3 || undefined).then((r) => ({ ...r, side: sd.name, agent })))
    }
    const done = await Promise.all(runs)
    done.forEach((r) => log({ case: c.id, ...r }))
    for (const agent of agents) {
      const of = (s) => done.filter((r) => r.side === s && r.agent === agent)
      const [base, now_] = [of('base'), of('new')]
      const row = { case: c.id, kind: c.kind, agent, base: base.filter((r) => r.pass).length, new: now_.filter((r) => r.pass).length, of: n }
      results.push(row)
      if (row.base === n && row.new < n) blocked.push({ ...row, why: 'regression' })
      if (c.kind === 'bad' && row.new < Math.ceil((2 * n) / 3)) blocked.push({ ...row, why: 'bad case under 2/3' })
    }
  }
  sides.forEach((sd) => sd.down())
  // Hosts wait on after a stop: every process under this run's folder ends with it.
  for (const p of ps()) if (p.cmd.includes(`${ROOT}/`) && p.pid !== process.pid) kill(p.pid)
  log({ summary: 'standing', pass: !blocked.length, results, blocked })
  if (process.env.KEEP !== '1') fs.rmSync(ROOT, { recursive: true, force: true })
}

const [drill, arg] = process.argv.slice(2)
if (!BIN) throw new Error('set BIN to a folder with the brigadier binaries')
fs.mkdirSync(ROOT, { recursive: true })
const run = { killloop: () => killloop(+(arg ?? 30)), hang, catalogue, scale, sleep: sleepDrill, sleepprep: sleepPrep, sleepcheck: sleepCheck, rebirth: rebirthDrill, standing, handoff: handoffDrill, peers: peersDrill, rewindfiles: rewindDrill, speed }[drill]
if (!run) throw new Error('drills: killloop [minutes], hang, catalogue, scale, sleep, sleepprep, sleepcheck, rebirth, standing, handoff, peers, rewindfiles, speed')
await run()
