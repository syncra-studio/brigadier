// The folders a drill made, the only ones it deletes: each is recorded beside itself as it's made, by its own
// device, inode and birth, so another's folder under the same name, or one put in its place, is never taken for it.

import fs from 'node:fs'
import path from 'node:path'

const record = (dir) => path.join(path.dirname(dir), `.${path.basename(dir)}.drill-made`)
const stamp = (dir) => { const s = fs.lstatSync(dir, { throwIfNoEntry: false, bigint: true }); return s && `drill made ${s.dev}:${s.ino}:${s.birthtimeNs}` }
const noted = (dir) => { try { return fs.readFileSync(record(dir), 'utf8') } catch { return null } }

export const made = (dir) => noted(dir) !== null && noted(dir) === stamp(dir)

// Records a folder this process has just made.
export function mark(dir) {
  const was = noted(dir)
  if (was !== null && !was.startsWith('drill made ')) throw new Error(`${record(dir)} isn't the drill's own`)
  fs.writeFileSync(record(dir), stamp(dir))
  return dir
}

// A new folder; an earlier run's of the drill's goes first, anyone else's stops the drill.
export function make(dir) {
  drop(dir)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (e) { throw e.code === 'EEXIST' ? new Error(`${dir} is there and the drill didn't make it: move it, or give the drill another folder`) : e }
  return mark(dir)
}

export function drop(dir) {
  if (!made(dir)) return
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(record(dir), { force: true })
}
