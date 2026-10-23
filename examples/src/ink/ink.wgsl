// Ink in water: Jos Stam's stable fluids with vorticity confinement, on a grid of cells.
// Every pass reads its fields from the *In buffers and writes the *Out buffers; the host swaps
// them between passes.

const WORKGROUP = 8;

struct Params {
  size: vec2f,
  canvas: vec2f,
  pointer: vec2f,
  force: vec2f,
  color: vec3f,
  radius: f32,
  dt: f32,
  velocityDissipation: f32,
  dyeDissipation: f32,
  swirl: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

@group(1) @binding(0) var<storage, read> velocityIn: array<vec2f>;
@group(1) @binding(1) var<storage, read_write> velocityOut: array<vec2f>;
@group(1) @binding(2) var<storage, read> dyeIn: array<vec4f>;
@group(1) @binding(3) var<storage, read_write> dyeOut: array<vec4f>;
@group(1) @binding(4) var<storage, read> pressureIn: array<f32>;
@group(1) @binding(5) var<storage, read_write> pressureOut: array<f32>;
@group(1) @binding(6) var<storage, read_write> divergence: array<f32>;
@group(1) @binding(7) var<storage, read_write> curl: array<f32>;

fn index(cell: vec2i) -> u32 {
  let size = vec2i(params.size);
  let clamped = clamp(cell, vec2i(0), size - 1);
  return u32(clamped.y * size.x + clamped.x);
}

fn inside(id: vec3u) -> bool {
  return f32(id.x) < params.size.x && f32(id.y) < params.size.y;
}

/** Bilinear velocity at a position measured in cells. */
fn velocityAt(position: vec2f) -> vec2f {
  let p = position - 0.5;
  let base = vec2i(floor(p));
  let t = fract(p);
  let low = mix(velocityIn[index(base)], velocityIn[index(base + vec2i(1, 0))], t.x);
  let high = mix(velocityIn[index(base + vec2i(0, 1))], velocityIn[index(base + vec2i(1, 1))], t.x);
  return mix(low, high, t.y);
}

/** Bilinear dye at a position measured in cells. */
fn dyeAt(position: vec2f) -> vec4f {
  let p = position - 0.5;
  let base = vec2i(floor(p));
  let t = fract(p);
  let low = mix(dyeIn[index(base)], dyeIn[index(base + vec2i(1, 0))], t.x);
  let high = mix(dyeIn[index(base + vec2i(0, 1))], dyeIn[index(base + vec2i(1, 1))], t.x);
  return mix(low, high, t.y);
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn computeCurl(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let cell = vec2i(id.xy);
  let left = velocityIn[index(cell - vec2i(1, 0))].y;
  let right = velocityIn[index(cell + vec2i(1, 0))].y;
  let up = velocityIn[index(cell - vec2i(0, 1))].x;
  let down = velocityIn[index(cell + vec2i(0, 1))].x;
  curl[index(cell)] = 0.5 * ((right - left) - (down - up));
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn confineVorticity(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let cell = vec2i(id.xy);
  let here = index(cell);
  let left = abs(curl[index(cell - vec2i(1, 0))]);
  let right = abs(curl[index(cell + vec2i(1, 0))]);
  let up = abs(curl[index(cell - vec2i(0, 1))]);
  let down = abs(curl[index(cell + vec2i(0, 1))]);
  var push = 0.5 * vec2f(down - up, left - right);
  push = push / (length(push) + 1e-5) * params.swirl * curl[here];
  velocityOut[here] = velocityIn[here] + push * params.dt;
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn splat(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let here = index(vec2i(id.xy));
  let offset = vec2f(id.xy) + 0.5 - params.pointer;
  let weight = exp(-dot(offset, offset) / (params.radius * params.radius));
  velocityOut[here] = velocityIn[here] + params.force * weight;
  dyeOut[here] = dyeIn[here] + vec4f(params.color * weight, weight);
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn advectVelocity(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let here = index(vec2i(id.xy));
  let source = vec2f(id.xy) + 0.5 - params.dt * velocityIn[here];
  velocityOut[here] = velocityAt(source) / (1.0 + params.velocityDissipation * params.dt);
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn advectDye(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let here = index(vec2i(id.xy));
  let source = vec2f(id.xy) + 0.5 - params.dt * velocityIn[here];
  dyeOut[here] = dyeAt(source) / (1.0 + params.dyeDissipation * params.dt);
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn computeDivergence(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let cell = vec2i(id.xy);
  let here = index(cell);
  let left = velocityIn[index(cell - vec2i(1, 0))].x;
  let right = velocityIn[index(cell + vec2i(1, 0))].x;
  let up = velocityIn[index(cell - vec2i(0, 1))].y;
  let down = velocityIn[index(cell + vec2i(0, 1))].y;
  divergence[here] = 0.5 * (right - left + down - up);
  // Last frame's pressure, faded, is a good first guess for this frame's.
  pressureOut[here] = pressureIn[here] * 0.8;
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn relaxPressure(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let cell = vec2i(id.xy);
  let around = pressureIn[index(cell - vec2i(1, 0))] + pressureIn[index(cell + vec2i(1, 0))]
    + pressureIn[index(cell - vec2i(0, 1))] + pressureIn[index(cell + vec2i(0, 1))];
  pressureOut[index(cell)] = (around - divergence[index(cell)]) * 0.25;
}

@compute @workgroup_size(WORKGROUP, WORKGROUP)
fn project(@builtin(global_invocation_id) id: vec3u) {
  if (!inside(id)) {
    return;
  }
  let cell = vec2i(id.xy);
  let here = index(cell);
  let gradient = 0.5 * vec2f(
    pressureIn[index(cell + vec2i(1, 0))] - pressureIn[index(cell - vec2i(1, 0))],
    pressureIn[index(cell + vec2i(0, 1))] - pressureIn[index(cell - vec2i(0, 1))],
  );
  velocityOut[here] = velocityIn[here] - gradient;
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn render(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let cell = position.xy / params.canvas * params.size;
  let dye = dyeAt(cell).rgb;
  // Shade the ink by the slope of its density, as if it had thickness.
  let slope = vec2f(
    length(dyeAt(cell + vec2f(1.0, 0.0)).rgb) - length(dyeAt(cell - vec2f(1.0, 0.0)).rgb),
    length(dyeAt(cell + vec2f(0.0, 1.0)).rgb) - length(dyeAt(cell - vec2f(0.0, 1.0)).rgb),
  );
  let normal = normalize(vec3f(-slope * 2.0, 1.0));
  let light = clamp(dot(normal, normalize(vec3f(-0.5, -0.7, 1.0))), 0.0, 1.0);
  let ink = 1.0 - exp(-dye * 1.8);
  return vec4f(ink * (0.7 + 0.45 * light), 1.0);
}
