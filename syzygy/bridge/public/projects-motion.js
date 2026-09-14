/* The vendored Motion bundle, reachable from the Projects view's classic
   scripts.

   The bundle is an ES module resolved through the page's importmap, and a
   classic script cannot statically import a bare specifier -- so this module
   is imported dynamically by URL, resolves `motion` itself, and hands the
   three functions the view needs back on `window`.

   Imported on the tab's first show, so a reader who never opens it never
   fetches the bundle. If the bundle or the importmap entry is absent the
   import rejects and the caller falls back to CSS transitions on the same
   numbers -- never to no motion at all. */
import { animate, stagger, spring } from 'motion'

window.MCPMO_LIB = { animate, stagger, spring }
