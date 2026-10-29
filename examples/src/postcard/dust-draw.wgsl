// Draws dust-sim.wgsl's motes as small squares, each colored by the live page at its home, so
// whatever the page shows right now flies along with it.

/** The two triangles of a square, corners in [0, 1]. */
const CORNERS = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));

struct Specks {
  canvas: vec2f,
  /** The card's rectangle in device pixels: x, y, width, height. */
  card: vec4f,
  /** Motes across and down. */
  grid: vec2u,
  /** The page texture's size in texels. */
  texels: vec2f,
  /** Device pixels per CSS pixel of the card. */
  scale: f32,
}

/** The same layout as dust-sim.wgsl's: WGSL modules can't import each other. */
struct Mote {
  position: vec2f,
  velocity: vec2f,
  delay: f32,
  seed: f32,
}

@group(0) @binding(0) var<uniform> specks: Specks;
@group(0) @binding(1) var page: texture_2d<f32>;

@group(1) @binding(0) var<storage, read> motes: array<Mote>;

struct Speck {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn speckVertex(@builtin(vertex_index) vertex: u32) -> Speck {
  let instance = vertex / 6u;
  let mote = motes[instance];
  let square = specks.card.zw / vec2f(specks.grid);
  let at = vec2f(f32(instance % specks.grid.x), f32(instance / specks.grid.x));
  let home = specks.card.xy + (at + 0.5) * square;
  let travelled = length(mote.position - home) / specks.scale;
  let texel = vec2i((at + 0.5) / vec2f(specks.grid) * specks.texels);
  let color = textureLoad(page, texel, 0);
  // Specks grow a little as they fly, and fade on the way out.
  let size = square * (1.0 + min(travelled * 0.006, 1.2));
  let pixel = mote.position + (CORNERS[vertex % 6u] - 0.5) * size;
  var speck: Speck;
  speck.position = vec4f(pixel / specks.canvas * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  let fade = 1.0 - smoothstep(120.0, 700.0, travelled + mote.seed * 200.0);
  speck.color = vec4f(color.rgb, color.a * fade);
  return speck;
}

@fragment
fn speckFragment(speck: Speck) -> @location(0) vec4f {
  return speck.color;
}
