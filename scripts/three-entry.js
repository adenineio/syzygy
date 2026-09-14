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
  // The stage's scene graph and its transforms.
  Group,
  Object3D,
  MathUtils,
  Matrix4,
  Quaternion,
  Euler,
  // Line geometry: the only thing the WebGL layer behind the panels draws.
  Float32BufferAttribute,
  Line,
  LineSegments,
  LineBasicMaterial,
  LineDashedMaterial,
} from 'three'

// Real DOM positioned by the same camera the WebGL layer uses, so a panel
// keeps its text selectable, its click handling native and its corner tokens.
export { CSS3DRenderer, CSS3DObject, CSS3DSprite } from 'three/addons/renderers/CSS3DRenderer.js'
// Lines with a width the platform will honour. A plain LineBasicMaterial is
// one pixel everywhere regardless of its linewidth.
export { Line2 } from 'three/addons/lines/Line2.js'
export { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
export { LineGeometry } from 'three/addons/lines/LineGeometry.js'
export { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
export { LineMaterial } from 'three/addons/lines/LineMaterial.js'
