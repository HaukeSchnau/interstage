// The vertex stage returns a struct that the fragment stage takes as its parameter.
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

const TINT = vec3f(1.0, 0.5, 0.25);

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VertexOut;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.color = TINT;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
