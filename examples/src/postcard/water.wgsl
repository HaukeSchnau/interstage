// A sheet of water over the table and the card. The wave equation runs on a grid a quarter of the
// screen's resolution; the picture bends the table and the card through the water's slope and
// lights its surface.

const WORKGROUP = 8;

struct Water {
  canvas: vec2f,
  /** Cells of the simulation grid. */
  grid: vec2f,
  /** The card's rectangle in device pixels: x, y, width, height. */
  card: vec4f,
  /** Where the pointer stirs the water, in cells. */
  pointer: vec2f,
  /** Where a raindrop lands this frame, in cells. */
  drop: vec2f,
  pointerForce: f32,
  dropForce: f32,
  damping: f32,
  /** Device pixels per CSS pixel of the card. */
  scale: f32,
}

@group(0) @binding(0) var<uniform> water: Water;
@group(0) @binding(1) var page: texture_2d<f32>;
@group(0) @binding(2) var pageSampler: sampler;

@group(1) @binding(0) var<storage, read> heights: array<f32>;
@group(1) @binding(1) var<storage, read> previousHeights: array<f32>;
@group(1) @binding(2) var<storage, read_write> nextHeights: array<f32>;

fn cell(c: vec2i) -> u32 {
  let size = vec2i(water.grid);
  let clamped = clamp(c, vec2i(0), size - 1);
  return u32(clamped.y * size.x + clamped.x);
}

/** The water's height between cells, interpolated from the four around a point. */
fn heightAt(p: vec2f) -> f32 {
  let q = p - 0.5;
  let base = vec2i(floor(q));
  let t = fract(q);
  let low = mix(heights[cell(base)], heights[cell(base + vec2i(1, 0))], t.x);
  let high = mix(heights[cell(base + vec2i(0, 1))], heights[cell(base + vec2i(1, 1))], t.x);
  return mix(low, high, t.y);
}

fn roundedBox(p: vec2f, half: vec2f, radius: f32) -> f32 {
  let q = abs(p) - half + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn table(p: vec2f) -> vec3f {
  let uv = p / water.canvas;
  var color = mix(vec3f(0.031, 0.055, 0.105), vec3f(0.07, 0.1, 0.17), 1.0 - uv.y);
  let spacing = 24.0 * water.scale;
  let dot = 1.0 - smoothstep(0.05, 0.1, length(fract(p / spacing) - 0.5));
  return color + dot * vec3f(0.05, 0.065, 0.1);
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn ripple(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= water.grid.x || f32(id.y) >= water.grid.y) {
    return;
  }
  let c = vec2i(id.xy);
  let around = heights[cell(c + vec2i(1, 0))] + heights[cell(c - vec2i(1, 0))]
    + heights[cell(c + vec2i(0, 1))] + heights[cell(c - vec2i(0, 1))];
  var height = (around * 0.5 - previousHeights[cell(c)]) * water.damping;
  let p = vec2f(id.xy) + 0.5;
  let toPointer = p - water.pointer;
  height += water.pointerForce * exp(-dot(toPointer, toPointer) / 5.0);
  let toDrop = p - water.drop;
  height += water.dropForce * exp(-dot(toDrop, toDrop) / 2.5);
  nextHeights[cell(c)] = height;
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn shade(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let perCell = water.canvas / water.grid;
  let p = position.xy / perCell;
  let slope = vec2f(heightAt(p + vec2f(1.0, 0.0)) - heightAt(p - vec2f(1.0, 0.0)), heightAt(p + vec2f(0.0, 1.0)) - heightAt(p - vec2f(0.0, 1.0)));
  let normal = normalize(vec3f(-slope * 2.2, 1.0));
  let bend = slope * 14.0 * water.scale;

  let center = water.card.xy + water.card.zw * 0.5;
  let half = water.card.zw * 0.5;
  let radius = 18.0 * water.scale;
  let seen = position.xy + bend;
  let shadow = 1.0 - smoothstep(-24.0 * water.scale, 48.0 * water.scale, roundedBox(seen - center - vec2f(0.0, 22.0 * water.scale), half, radius));
  var color = table(seen) * (1.0 - shadow * 0.6);

  // Each color bends a little differently, as light does through water.
  let spread = bend * 0.12;
  let uv = (seen - water.card.xy) / water.card.zw;
  let red = textureSampleLevel(page, pageSampler, uv + spread / water.card.zw, 0.0);
  let green = textureSampleLevel(page, pageSampler, uv, 0.0);
  let blue = textureSampleLevel(page, pageSampler, uv - spread / water.card.zw, 0.0);
  let paper = vec4f(red.r, green.g, blue.b, green.a);
  let inside = clamp(0.5 - roundedBox(seen - center, half, radius), 0.0, 1.0) * paper.a;
  color = mix(color, paper.rgb, inside);

  let light = normalize(vec3f(-0.45, -0.6, 1.0));
  let halfway = normalize(light + vec3f(0.0, 0.0, 1.0));
  let glint = pow(max(dot(normal, halfway), 0.0), 120.0);
  let caustic = clamp(length(slope) * 6.0, 0.0, 1.0);
  color += glint * 0.55 + caustic * vec3f(0.02, 0.05, 0.08);
  return vec4f(color, 1.0);
}
