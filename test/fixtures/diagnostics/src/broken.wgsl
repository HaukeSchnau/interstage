// Each declaration below has one mistake, except for Light.
struct Light {
  position: vec3f,
  color: vec3f,
}

override STRENGTH: f32 = 1.0;

@group(0) @binding(0) var<uniform> light: Light;
@group(0) @binding(0) var<uniform> spare: Light;

const BROKEN = ;

struct Tall {
  m: mat2x3f,
}

const SIZE = 4;
const DATA = array<f32, SIZE / 3.0>();

const LIMIT = 8;
fn limited(x: i32) -> i32 {
  if (x > LIMIT) {
    let LIMIT = 4;
    return LIMIT;
  }
  return x;
}

@fragment
fn shade(color: vec4f) -> @location(0) vec4f {
  return color;
}
