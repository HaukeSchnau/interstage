// Constants of every kind, a helper function and a compute entry point.
const N = 64;
const SCALE: f32 = 0.5;
const OFFSETS = array<vec2f, 2>(vec2f(1.0, 2.0), vec2f(3.0, 4.0));
const HALF_N = N / 2;

struct Item {
  value: f32,
  doubled: f32,
}

@group(0) @binding(0) var<storage, read_write> items: array<Item>;

fn twice(x: f32) -> f32 {
  let N = 2.0;
  return x * N;
}

@compute @workgroup_size(HALF_N)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N) { return; }
  let value = f32(id.x) * SCALE + OFFSETS[id.x % 2u].y;
  items[id.x] = Item(value, twice(value));
}
