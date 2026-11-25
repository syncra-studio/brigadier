// The folders a drill made, the only ones it deletes: each is recorded beside itself as it's made, by its own
// device, inode and birth, so another's folder under the same name, or one put in its place, is never taken for it.

import fs from 'node:fs'
import path from 'node:path'

const record = (dir) => path.join(path.dirname(dir), `.${path.basename(dir)}.drill-made`)
const stamp = (dir) => { const s = fs.lstatSync(dir, { throwIfNoEntry: false, bigint: true }); return s && `drill made ${s.dev}:${s.ino}:${s.birthtimeNs}` }
const linked = (p) => { const s = fs.lstatSync(p, { throwIfNoEntry: false }); return s ? s.isSymbolicLink() : false }
// Never a symlink: a planted one shouldn't make the drill treat an absent marker as present, nor follow it on write.
const noted = (dir) => { try { return linked(record(dir)) ? null : fs.readFileSync(record(dir), 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const EXCL_NOFOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)

export const made = (dir) => noted(dir) !== null && noted(dir) === stamp(dir)

// Records a folder this process has just made.
export function mark(dir) {
  const r = record(dir)
  if (linked(r)) throw new Error(`${r} is a symlink, not the drill's marker: move it, or give the drill another folder`)
  let was
  try { was = fs.readFileSync(r, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${r} can't be read: ${e.message} — refuse to replace it`); was = null }
  if (was !== null && !was.startsWith('drill made ')) throw new Error(`${r} isn't the drill's own`)
  fs.rmSync(r, { force: true })
  const fd = fs.openSync(r, EXCL_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, stamp(dir)) } finally { fs.closeSync(fd) }
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
