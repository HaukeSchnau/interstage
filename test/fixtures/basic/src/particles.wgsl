// A small particle system: one compute pass, one instanced render pass.
const COUNT = 4096;
const WORKGROUP: u32 = 64u;
const UP = vec2f(0.0, 1.0);
const CORNERS = array<vec2f, 4>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, 1));

struct Particle {
  position: vec2f,
  velocity: vec2f,
  @align(16) age: f32,
}

struct Params {
  dt: f32,
  gravity: vec2f,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) @interpolate(flat) id: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;
// The vertex stage can't use read_write storage, so rendering reads the particles through a second group.
@group(1) @binding(0) var<storage, read> particlesIn: array<Particle>;

fn wrap(p: vec2f) -> vec2f {
  return fract(p * 0.5 + 0.5) * 2.0 - 1.0;
}

@compute @workgroup_size(WORKGROUP)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= COUNT) { return; }
  var particle = particles[id.x];
  particle.velocity += params.gravity * params.dt + UP * 0.0;
  particle.position = wrap(particle.position + particle.velocity * params.dt);
  particle.age += params.dt;
  particles[id.x] = particle;
}

@vertex
fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let particle = particlesIn[instance];
  var out: VertexOut;
  out.position = vec4f(particle.position + CORNERS[corner] * 0.01, 0.0, 1.0);
  out.color = vec3f(0.5 + 0.5 * sin(particle.age), 0.6, 1.0);
  out.id = instance;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
