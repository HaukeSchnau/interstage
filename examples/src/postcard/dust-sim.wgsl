// The card as dust: one mote per small square of the page. Scattering, each mote lets go in a
// sweep from left to right and rides a curl-noise breeze; returning, a spring pulls it home.

const WORKGROUP = 256;

struct Breeze {
  /** The card's rectangle in device pixels: x, y, width, height. */
  card: vec4f,
  /** Motes across and down. */
  grid: vec2u,
  /** Seconds since the motes started scattering, or returning. */
  time: f32,
  dt: f32,
  /** 1 while the motes fly home. */
  returning: u32,
  /** Device pixels per CSS pixel of the card. */
  scale: f32,
}

struct Mote {
  position: vec2f,
  velocity: vec2f,
  /** Seconds after the start before the mote lets go. */
  delay: f32,
  seed: f32,
}

@group(0) @binding(0) var<uniform> breeze: Breeze;

@group(1) @binding(0) var<storage, read_write> motes: array<Mote>;

fn home(index: u32) -> vec2f {
  let at = vec2f(f32(index % breeze.grid.x), f32(index / breeze.grid.x)) + 0.5;
  return breeze.card.xy + at * breeze.card.zw / vec2f(breeze.grid);
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2f(1.0, 0.0)), u.x), mix(hash(cell + vec2f(0.0, 1.0)), hash(cell + vec2f(1.0, 1.0)), u.x), u.y);
}

/** A swirling, divergence-free flow: the noise's gradient turned a quarter. */
fn curl(p: vec2f) -> vec2f {
  let e = 0.01;
  let dx = noise(p + vec2f(e, 0.0)) - noise(p - vec2f(e, 0.0));
  let dy = noise(p + vec2f(0.0, e)) - noise(p - vec2f(0.0, e));
  return vec2f(dy, -dx) / (2.0 * e);
}

@compute @workgroup_size(WORKGROUP)
fn gather(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= breeze.grid.x * breeze.grid.y) {
    return;
  }
  let at = home(id.x);
  let seed = hash(at * 0.37);
  let across = (at.x - breeze.card.x) / breeze.card.z;
  var mote: Mote;
  mote.position = at;
  mote.velocity = vec2f(0.0);
  mote.delay = across * 1.1 + seed * 0.35;
  mote.seed = seed;
  motes[id.x] = mote;
}

@compute @workgroup_size(WORKGROUP)
fn drift(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= breeze.grid.x * breeze.grid.y) {
    return;
  }
  var mote = motes[id.x];
  let at = home(id.x);
  let dt = breeze.dt;
  if (breeze.returning == 0u) {
    if (breeze.time < mote.delay) {
      mote.position = at;
      motes[id.x] = mote;
      return;
    }
    let swirl = curl(mote.position / (180.0 * breeze.scale) + vec2f(breeze.time * 0.15, mote.seed * 3.0));
    let lift = vec2f(260.0, -120.0 - 80.0 * mote.seed);
    mote.velocity = (mote.velocity + (swirl * 320.0 + lift) * breeze.scale * dt) * 0.985;
  } else {
    // A critically damped spring: home within about a second, without overshooting.
    let pull = clamp(breeze.time * 1.4 - mote.delay * 0.7, 0.0, 1.0);
    let stiffness = 60.0 * pull;
    let toHome = at - mote.position;
    let swirl = curl(mote.position / (180.0 * breeze.scale) + vec2f(mote.seed * 3.0, 0.0)) * min(length(toHome), 200.0 * breeze.scale);
    mote.velocity += (toHome * stiffness - mote.velocity * 2.0 * sqrt(stiffness) + swirl * (1.0 - pull) * 2.0) * dt;
    if (pull >= 1.0 && length(toHome) < 0.5 * breeze.scale) {
      mote.position = at;
      mote.velocity = vec2f(0.0);
    }
  }
  mote.position += mote.velocity * dt;
  motes[id.x] = mote;
}
