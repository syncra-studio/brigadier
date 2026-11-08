#!/usr/bin/env node
// One re-runnable drill command for the foundation [D52]. It drives only the `brigadier` CLI, the
// daemon's socket and the kernel (signals, ps), never the host's internals, so it sees what any
// client sees.
//
//   BIN=<dir with brigadier, brigadier-host, brigadier-fake, brigadierd> node drills/drill.mjs <drill> [minutes]
//   drills: killloop, hang, catalogue, scale, sleep
//   killloop: BUILDS=<dir>:<dir> rotates in more builds; OLD_BIN=<dir> adds hosts and the first
//   daemon from a previous release's code.
//
// Results print as JSON lines; the last line is the summary. Scratch lives under $DRILL_ROOT
// (default /tmp/brigadier-drill) and is removed at the end unless KEEP=1.

import { spawn, spawnSync } from 'node:child_process'
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
    s.on('connect', () => { const v = Buffer.alloc(4); v.writeUInt32BE(2); s.write(v) })
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
    s.on('connect', () => { const v = Buffer.alloc(4); v.writeUInt32BE(2); s.write(v) })
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
  startFake('t01', ['--mode', 'pty'])
  startFake('chat')
  for (const id of fakes) send(id, work(id))
  send('t01', 'tree:600')
  // The real CLIs start in the same second.
  const real = REAL
  const starts = real.map(([id, b]) => spawn(`${BIN}/brigadier`, ['start', id, '--backend', b, '--cwd', gitRepo(id), '--level', 'full', '--text', realPrompt(cid('r'))], { env: { ...process.env, BRIGADIER_DATA: DATA }, stdio: 'ignore' }))
  await Promise.all(starts.map((c) => new Promise((r) => c.on('exit', r))))
  const followed = ['f01', 't01', 'chat', ...real.map(([id]) => id)]
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
}

// Drill 5: prepared only. The owner runs it at an agreed moment; this prints the steps.
function sleepDrill() {
  log({
    drill: 'sleep', run_by: 'the owner, at an agreed moment',
    steps: [
      `BIN=${BIN} KEEP=1 node drills/drill.mjs sleepprep   # 5 piped fake sessions and 1 PTY one, each on a 15-minute process tree`,
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
  startFake('zp', ['--mode', 'pty'])
  cli(['send', 'zp', `${cid()} tree:900`])
  fs.writeFileSync(`${DATA}/before.json`, JSON.stringify({ at: now(), agents: Object.fromEntries(['z1', 'z2', 'z3', 'z4', 'z5', 'zp'].map((id) => [id, agentsOf(id).map((p) => p.pid)])), children: ledger().children }))
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

const [drill, arg] = process.argv.slice(2)
if (!BIN) throw new Error('set BIN to a folder with the brigadier binaries')
fs.mkdirSync(ROOT, { recursive: true })
const run = { killloop: () => killloop(+(arg ?? 30)), hang, catalogue, scale, sleep: sleepDrill, sleepprep: sleepPrep, sleepcheck: sleepCheck }[drill]
if (!run) throw new Error('drills: killloop [minutes], hang, catalogue, scale, sleep, sleepprep, sleepcheck')
await run()
