// Terrain for a procedural atlas. The map's fragment shader is written in TypeScript (main.ts)
// and calls `elevation` below, so TypeScript checks each call against this signature.

const OCTAVES = 6;

struct View {
  center: vec2f,
  resolution: vec2f,
  scale: f32,
  seaLevel: f32,
  relief: f32,
  contours: f32,
  seed: f32,
  time: f32,
}

@group(0) @binding(0) var<uniform> view: View;

/** Mark Jarzynski and Marc Olano's pcg2d: a well-mixed hash of two integers. */
fn pcg2d(input: vec2u) -> vec2u {
  var v = input * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> vec2u(16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> vec2u(16u);
  return v;
}

/** A random unit vector for each grid cell and seed. */
fn gradient(cell: vec2f) -> vec2f {
  let seeded = vec2i(cell) + vec2i(i32(view.seed * 7919.0), 0);
  let angle = f32(pcg2d(bitcast<vec2u>(seeded)).x) / 4294967295.0 * 6.2831853;
  return vec2f(cos(angle), sin(angle));
}

/** Gradient noise in about [-1, 1], smoothed with a quintic curve. */
fn noise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(gradient(cell), f);
  let b = dot(gradient(cell + vec2f(1.0, 0.0)), f - vec2f(1.0, 0.0));
  let c = dot(gradient(cell + vec2f(0.0, 1.0)), f - vec2f(0.0, 1.0));
  let e = dot(gradient(cell + vec2f(1.0, 1.0)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, e, u.x), u.y) * 1.6;
}

/** Fractal noise: octaves of noise, each rotated, doubled in frequency and halved in strength. */
fn fbm(p: vec2f) -> f32 {
  let turn = mat2x2f(0.8, -0.6, 0.6, 0.8);
  var sum = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var i = 0; i < OCTAVES; i++) {
    sum += amplitude * noise(q);
    q = turn * q * 2.03 + vec2f(1.7, 9.2);
    amplitude *= 0.5;
  }
  return sum;
}

/** Sharp crests where noise crosses zero, for mountain ranges. */
fn ridges(p: vec2f) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
    let crest = 1.0 - abs(noise(q));
    sum += amplitude * crest * crest;
    q = q * 2.1 + vec2f(3.1, 1.3);
    amplitude *= 0.5;
  }
  return sum;
}

/** Height of the land at a point, with sea level at zero. */
fn elevation(p: vec2f) -> f32 {
  // Bending the coordinates first makes coastlines wander.
  let warp = vec2f(noise(p * 0.21), noise(p * 0.21 + vec2f(5.2, 1.3))) * 1.6;
  let continents = fbm((p + warp) * 0.35) + 0.1;
  let mountains = ridges(p * 0.8) * smoothstep(0.0, 0.45, continents);
  return continents + mountains * 0.4 * view.relief - view.seaLevel;
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}
