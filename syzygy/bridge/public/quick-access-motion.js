/* The vendored Motion bundle, reachable from a classic script.

   The bundle is an ES module resolved through the page's importmap, and a
   classic script cannot statically import a bare specifier -- so this module
   is imported dynamically by URL, resolves `motion` itself, and hands the two
   functions the deck needs back on `window`. That is the only route out of a
   classic script, and it is why this file exists at all rather than the two
   imports living in cmdbar.js.

   Lazily imported on the deck's first show, so a pane that never opens the
   deck never fetches the bundle. If the bundle or the importmap entry is
   absent, the import rejects and the caller falls back to CSS transitions on
   the same numbers -- never to no motion at all. */
import { animate, stagger } from 'motion'

window.MCQMO = { animate, stagger }
