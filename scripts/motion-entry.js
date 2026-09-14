// Build input for `just vendor-motion`. NOT served to the browser.
//
// The vendored bundle contains ONLY what this file re-exports. Importing a
// Motion function that is absent here fails at run time with `undefined`, and
// the error will not mention this file -- so add it here and re-run the
// recipe. One shared bundle: any view in the pane imports it unchanged.
export {
  animate, animateMini, spring, stagger, inView, hover, press,
  frame, cancelFrame, transform, mapValue, mix, motionValue,
  prefersReducedMotion, easeIn, easeOut, easeInOut, cubicBezier, delay,
  clamp, progress, wrap,
} from 'motion'
