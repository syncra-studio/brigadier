// A drill's own home. Brigadier writes folder trust into ~/.claude.json and ~/.codex/config.toml, whatever agent
// runs, and a real CLI writes its own there: never the owner's. From `isolate` on, every child gets this home
// instead: HOME, when it's already a scratch one outside the owner's (real CLIs are signed in there), else
// a <root>/drill-home-… of this process alone, removed at the end, whose path it returns. Throws, so the drill doesn't start, when that home leads to the owner's.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drop, mark } from './made.mjs'

// By the account, not $HOME, which any shell may set.
export const OWNER = fs.realpathSync.native(os.userInfo().homedir)
const within = (p, dir) => p === dir || p.startsWith(`${dir}${path.sep}`)
const at = (p, see = fs.statSync) => see(p, { throwIfNoEntry: false })

export function isolate(root) {
  const given = process.env.HOME && at(process.env.HOME) ? fs.realpathSync.native(process.env.HOME) : OWNER
  const own = within(given, OWNER)
  if (own) fs.mkdirSync(root, { recursive: true })
  const home = own ? mark(fs.realpathSync.native(fs.mkdtempSync(path.resolve(root, 'drill-home-')))) : given
  // By the folder or file itself, so no other name for it (a link, a volume's path) passes.
  for (const f of ['', '.claude', '.claude.json', '.claude/.claude.json', '.codex', '.codex/config.toml']) {
    const [here, theirs, link] = [at(path.join(home, f)), at(path.join(OWNER, f)), at(path.join(home, f), fs.lstatSync)]
    if ((here && theirs && here.ino === theirs.ino && here.dev === theirs.dev) || link?.isSymbolicLink()) throw new Error(`${path.join(home, f)} leads to a provider's own files: the drill needs a home apart from the owner's`)
  }
  if (own) {
    fs.writeFileSync(`${home}/.gitconfig`, '[user]\n\tname = drill\n\temail = drill@example.invalid\n')
    // killloop's cargo child builds with the owner's toolchain.
    for (const d of ['.cargo', '.rustup']) if (at(`${OWNER}/${d}`) && !at(`${home}/${d}`)) fs.symlinkSync(`${OWNER}/${d}`, `${home}/${d}`, 'junction')
    process.on('exit', () => { if (process.env.KEEP !== '1') drop(home) })
  }
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, CODEX_HOME: `${home}/.codex` }, process.platform === 'win32' ? { USERPROFILE: home } : {})
  // The login shell reads this home's files, and no CLI its settings from the owner's.
  for (const k of ['ZDOTDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete process.env[k]
  return own ? home : null
}
