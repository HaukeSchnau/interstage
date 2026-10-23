// The vertex stage returns a bare builtin, and the fragment stage reads a builtin and a location.
@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(position.x / 4.0, position.y / 4.0, 1.0, 1.0);
}
