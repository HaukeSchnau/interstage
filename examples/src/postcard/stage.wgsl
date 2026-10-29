// The backdrop every effect draws first: an ink-blue table with a faint grid of dots, the card's
// shadow, and the card itself, unbent. Effects fade the card out when they draw it themselves.

struct Stage {
  canvas: vec2f,
  /** The card's rectangle in device pixels: x, y, width, height. */
  card: vec4f,
  /** Device pixels per CSS pixel of the card. */
  scale: f32,
  cardOpacity: f32,
  shadowOpacity: f32,
}

@group(0) @binding(0) var<uniform> stage: Stage;
@group(0) @binding(1) var page: texture_2d<f32>;
@group(0) @binding(2) var pageSampler: sampler;

/** Signed distance to a rectangle with rounded corners, centered on the origin. */
fn roundedBox(p: vec2f, half: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn table(p: vec2f) -> vec3f {
  let uv = p / stage.canvas;
  var color = mix(vec3f(0.031, 0.055, 0.105), vec3f(0.07, 0.1, 0.17), 1.0 - uv.y);
  let spacing = 24.0 * stage.scale;
  let dot = 1.0 - smoothstep(0.05, 0.1, length(fract(p / spacing) - 0.5));
  return color + dot * vec3f(0.05, 0.065, 0.1);
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn backdrop(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let center = stage.card.xy + stage.card.zw * 0.5;
  let half = stage.card.zw * 0.5;
  let radius = 18.0 * stage.scale;
  let shadow = 1.0 - smoothstep(-24.0 * stage.scale, 48.0 * stage.scale, roundedBox(position.xy - center - vec2f(0.0, 22.0 * stage.scale), half, radius));
  var color = table(position.xy) * (1.0 - shadow * 0.6 * stage.shadowOpacity);
  let inside = clamp(0.5 - roundedBox(position.xy - center, half, radius), 0.0, 1.0);
  let paper = textureSampleLevel(page, pageSampler, (position.xy - stage.card.xy) / stage.card.zw, 0.0);
  color = mix(color, paper.rgb, inside * paper.a * stage.cardOpacity);
  return vec4f(color, 1.0);
}
