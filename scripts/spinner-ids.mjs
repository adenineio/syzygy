// Canonical spinner id/name list, read directly from spinner-frames.js -- the
// single source of truth the band itself draws from (syzygy/
// hooks/hud.tsx imports the same file). Nothing here duplicates that list, so
// it cannot drift the way a hand-copied one would.
//
// Two callers:
//   `just spinners`        -- `--pretty`, an aligned id/name table for a human
//   scripts/spinner.py     -- no flag, JSON, for `just spinner <id>` to
//                             validate its argument against
import { SPINNERS } from '../syzygy/hooks/spinner-frames.js'

const list = SPINNERS.map((s) => ({ id: s.id, name: s.name }))

if (process.argv.includes('--pretty')) {
  const width = Math.max(...list.map((s) => s.id.length))
  for (const s of list) console.log(`${s.id.padEnd(width + 2)}${s.name}`)
} else {
  process.stdout.write(JSON.stringify(list))
}
