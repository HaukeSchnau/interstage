// A lava lamp. Edit anything: the preview, the types and main.ts follow.

const BLOBS = 7;
const AMBER = vec3f(0.95, 0.69, 0.21);
const BLUE = vec3f(0.5, 0.71, 1.0);

struct Lamp {
  size: vec2f,
  pointer: vec2f,
  time: f32,
  melt: f32,
}

@group(0) @binding(0) var<uniform> lamp: Lamp;

// A pixel, with the canvas's height running from -1 to 1.
fn place(pixel: vec2f) -> vec2f {
  return (pixel * 2.0 - lamp.size) / lamp.size.y;
}

fn drift(k: f32) -> vec2f {
  let t = lamp.time * (0.25 + 0.04 * k);
  let x = sin(t * 1.3 + k * 2.1);
  return vec2f(x, sin(t + k * 1.7)) * 0.75;
}

@vertex
fn fullscreen(@builtin(vertex_index) i: u32)
  -> @builtin(position) vec4f {
  let corner = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn glow(@builtin(position) pixel: vec4f)
  -> @location(0) vec4f {
  let p = place(pixel.xy);
  var field = 0.0;
  var color = vec3f(0.0);
  for (var i = 0; i <= BLOBS; i++) {
    // The last blob follows the pointer.
    var center = place(lamp.pointer);
    if (i < BLOBS) {
      center = drift(f32(i));
    }
    let r = p - center;
    let pull = lamp.melt * lamp.melt / dot(r, r);
    field += pull;
    color += pull * select(BLUE, AMBER, i % 2 == 0);
  }
  color /= field;
  let body = smoothstep(0.9, 1.15, field) * 0.8;
  let rim = exp(-abs(field - 1.0) * 5.0) * 0.7;
  return vec4f(color * (body + rim + min(field, 3.0) * 0.06), 1.0);
}
