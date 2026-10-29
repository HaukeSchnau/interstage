// The card as cloth: a grid of points that gravity and the wind push around (Verlet integration),
// held together by springs to their neighbors (relaxed in parallel, Jacobi style) and pinned at the
// top like a postcard on a line. World units are the card's CSS pixels, y up.

const WORKGROUP = 64;
const GRAVITY = vec3f(0.0, -1400.0, 0.0);
/** How far, in device pixels, a press may land from the nearest point and still grab the cloth. */
const REACH = 48u;

struct Physics {
  viewProjection: mat4x4f,
  inverseViewProjection: mat4x4f,
  /** The card's width and height. */
  size: vec2f,
  /** Points across and down. */
  grid: vec2u,
  canvas: vec2f,
  /** The pointer in normalized device coordinates. */
  pointer: vec2f,
  time: f32,
  dt: f32,
  wind: f32,
  /** 1 while the pointer holds the cloth. */
  holding: u32,
}

@group(0) @binding(0) var<uniform> physics: Physics;

@group(1) @binding(0) var<storage, read_write> points: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> relaxed: array<vec4f>;
@group(1) @binding(2) var<storage, read_write> previous: array<vec4f>;
/** The point nearest to a press: its distance in device pixels in the high bits, its index in the low 12. */
@group(1) @binding(3) var<storage, read_write> grab: atomic<u32>;

fn total() -> u32 {
  return physics.grid.x * physics.grid.y;
}

fn spacing() -> vec2f {
  return physics.size / vec2f(physics.grid - 1u);
}

fn rest(index: u32) -> vec3f {
  let at = vec2f(f32(index % physics.grid.x), f32(index / physics.grid.x)) * spacing();
  return vec3f(at.x - physics.size.x * 0.5, physics.size.y * 0.5 - at.y, 0.0);
}

/** Three clothespins along the top edge. */
fn pinned(index: u32) -> bool {
  let column = index % physics.grid.x;
  return index / physics.grid.x == 0u && (column == 0u || column == physics.grid.x - 1u || column == physics.grid.x / 2u);
}

fn windAt(p: vec3f) -> vec3f {
  let t = physics.time;
  let gust = 0.55 + 0.45 * sin(t * 0.63) * sin(t * 0.29 + 1.7);
  let swell = sin(p.x * 0.011 + t * 2.3) * cos(p.y * 0.015 - t * 1.4);
  return vec3f(120.0 * sin(t * 0.4), 40.0, 520.0 + 420.0 * swell) * gust * physics.wind;
}

@compute @workgroup_size(WORKGROUP)
fn hang(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= total()) {
    return;
  }
  let p = vec4f(rest(id.x), 0.0);
  points[id.x] = p;
  relaxed[id.x] = p;
  previous[id.x] = p;
}

@compute @workgroup_size(WORKGROUP)
fn pick(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= total()) {
    return;
  }
  let clip = physics.viewProjection * vec4f(points[id.x].xyz, 1.0);
  let offset = (clip.xy / clip.w - physics.pointer) * physics.canvas * 0.5;
  atomicMin(&grab, (min(u32(length(offset)), 1023u) << 12u) | id.x);
}

@compute @workgroup_size(WORKGROUP)
fn integrate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= total()) {
    return;
  }
  let index = id.x;
  if (pinned(index)) {
    points[index] = vec4f(rest(index), 0.0);
    previous[index] = points[index];
    return;
  }
  let p = points[index].xyz;
  let velocity = (p - previous[index].xyz) * 0.992;
  var moved = p + velocity + (GRAVITY + windAt(p)) * physics.dt * physics.dt;

  let held = atomicLoad(&grab);
  if (physics.holding == 1u && (held & 0xfffu) == index && (held >> 12u) < REACH) {
    // Follow the pointer's ray to the point's own depth.
    let near = physics.inverseViewProjection * vec4f(physics.pointer, 0.0, 1.0);
    let far = physics.inverseViewProjection * vec4f(physics.pointer, 1.0, 1.0);
    let origin = near.xyz / near.w;
    let toward = far.xyz / far.w - origin;
    moved = origin + toward * ((p.z - origin.z) / toward.z);
  }
  previous[index] = vec4f(p, 0.0);
  points[index] = vec4f(moved, 0.0);
}

/** Half of what it takes to bring `p` to `restLength` from `other`; the other point moves the other half. */
fn pull(p: vec3f, other: vec3f, restLength: f32) -> vec3f {
  let delta = other - p;
  let distance = max(length(delta), 0.0001);
  return delta * (1.0 - restLength / distance) * 0.5;
}

@compute @workgroup_size(WORKGROUP)
fn relax(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= total()) {
    return;
  }
  let index = id.x;
  let p = points[index].xyz;
  if (pinned(index)) {
    relaxed[index] = vec4f(p, 0.0);
    return;
  }
  let column = i32(index % physics.grid.x);
  let row = i32(index / physics.grid.x);
  let size = vec2i(physics.grid);
  let step = spacing();
  var correction = vec3f(0.0);
  var springs = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let reach = abs(dx) + abs(dy);
      // Neighbors, diagonals and the points two away, which resist folding.
      let straight = (reach == 1) || (reach == 2 && (dx == 0 || dy == 0));
      let diagonal = abs(dx) == 1 && abs(dy) == 1;
      let x = column + dx;
      let y = row + dy;
      if ((!straight && !diagonal) || x < 0 || y < 0 || x >= size.x || y >= size.y) {
        continue;
      }
      let stiffness = select(1.0, 0.35, reach == 2 && !diagonal);
      correction += pull(p, points[u32(y * size.x + x)].xyz, length(vec2f(f32(dx), f32(dy)) * step)) * stiffness;
      springs += stiffness;
    }
  }
  relaxed[index] = vec4f(p + correction / springs * 1.7, 0.0);
}
