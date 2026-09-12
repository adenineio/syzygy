// Build input for `just vendor-three`. NOT served to the browser.
//
// The vendored bundle contains ONLY what this file re-exports. Importing a
// three class that is absent here fails at run time with `undefined`, and the
// error will not mention this file — so if the swarm needs a new class, add it
// here and re-run `just vendor-three`.
export {
  REVISION,
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  BufferGeometry,
  BufferAttribute,
  Points,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  GLSL3,
  Color,
  Vector2,
  Vector3,
  Vector4,
  // Lift's occluder (swarm.js) — a
  // static, second draw call that makes a sunken streams channel vanish
  // into the body instead of merely dimming.
  SphereGeometry,
  Mesh,
  MeshBasicMaterial,
} from 'three'
