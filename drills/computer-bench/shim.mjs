#!/usr/bin/env node
// `brigadier` as a bench agent has it (bench.mjs): passes each call to the one under test and keeps it in $BENCH_RAW, a
// line as it starts and one as it ends, with a screenshot's bytes, which the next one may overwrite.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const raw = process.env.BENCH_RAW
const argv = process.argv.slice(2)
const id = crypto.randomUUID()
const keep = (line) => fs.appendFileSync(path.join(raw, 'calls.jsonl'), JSON.stringify({ id, ...line }) + '\n')
const fake = path.join(path.dirname(process.env.BENCH_BRIGADIER), 'brigadier-fake')
const starts = JSON.parse(spawnSync(fake, ['procs'], { encoding: 'utf8' }).stdout)
keep({ from: Date.now(), argv, pid: process.pid, start_us: starts[process.pid] })
const p = spawn(process.env.BENCH_BRIGADIER, argv, { stdio: ['inherit', 'pipe', 'pipe'] })
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => p.kill(s))
let out = ''
p.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
p.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
p.on('close', (code) => {
  const end = { to: Date.now(), code, out }
  // A path may hold spaces, as Library/Application Support does: up to its extension.
  const file = argv.includes('screenshot') && out.match(/(\/[^\n"'`]+?\.(?:jpg|jpeg|png))\b/i)?.[1]
  if (file && fs.existsSync(file)) {
    const bytes = fs.readFileSync(file)
    end.shot = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    fs.writeFileSync(path.join(raw, `shot-${end.to}${path.extname(file)}`), bytes)
  }
  keep(end)
  process.exitCode = code ?? 1
})
