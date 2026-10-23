// Physarum polycephalum, the slime mold. Each agent smells the trail ahead of it, turns toward
// its own species and away from the others, moves, and leaves trail behind. The trail spreads
// and fades, and networks emerge.

const PI = 3.14159265;
const TAU = 2.0 * PI;
const WORKGROUP = 256;
const TILE = 16;

struct Agent {
  position: vec2f,
  angle: f32,
  species: u32,
}

struct Params {
  size: vec2f,
  canvas: vec2f,
  pointer: vec2f,
  time: f32,
  dt: f32,
  speed: f32,
  sensorAngle: f32,
  sensorDistance: f32,
  turnSpeed: f32,
  deposit: f32,
  decay: f32,
  pointerForce: f32,
  agentCount: u32,
  speciesCount: u32,
}

@group(0) @binding(0) var<uniform> params: Params;

@group(1) @binding(0) var<storage, read_write> agents: array<Agent>;
@group(1) @binding(1) var<storage, read_write> trail: array<vec4f>;
@group(1) @binding(2) var<storage, read_write> trailNext: array<vec4f>;

fn hash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn random(seed: u32) -> f32 {
  return f32(hash(seed)) / 4294967295.0;
}

/** The trail cell under a position, wrapping around the edges. */
fn cell(position: vec2i) -> u32 {
  let size = vec2i(params.size);
  let wrapped = (position % size + size) % size;
  return u32(wrapped.y * size.x + wrapped.x);
}

/** How attractive a trail is to a species: its own channel pulls, the others push. */
fn preference(species: u32) -> vec4f {
  var weights = vec4f(-0.7, -0.7, -0.7, 0.0);
  weights[species] = 1.0;
  return weights;
}

fn sense(agent: Agent, offset: f32) -> f32 {
  let angle = agent.angle + offset;
  let probe = agent.position + vec2f(cos(angle), sin(angle)) * params.sensorDistance;
  return dot(trail[cell(vec2i(probe))], preference(agent.species));
}

@compute @workgroup_size(WORKGROUP)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.agentCount) {
    return;
  }
  let seed = id.x * 3u + u32(params.time * 9973.0);
  let radius = sqrt(random(seed)) * min(params.size.x, params.size.y) * 0.4;
  let theta = random(seed + 1u) * TAU;
  var agent: Agent;
  agent.position = params.size * 0.5 + vec2f(cos(theta), sin(theta)) * radius;
  agent.angle = theta + PI;
  agent.species = id.x % params.speciesCount;
  agents[id.x] = agent;
}

@compute @workgroup_size(TILE, TILE)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= params.size.x || f32(id.y) >= params.size.y) {
    return;
  }
  trail[cell(vec2i(id.xy))] = vec4f(0.0);
  trailNext[cell(vec2i(id.xy))] = vec4f(0.0);
}

@compute @workgroup_size(WORKGROUP)
fn step(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.agentCount) {
    return;
  }
  var agent = agents[id.x];
  let ahead = sense(agent, 0.0);
  let left = sense(agent, params.sensorAngle);
  let right = sense(agent, -params.sensorAngle);
  let jitter = random(id.x * 7919u + u32(params.time * 1000.0));
  let turn = params.turnSpeed * params.dt;

  if (ahead < left && ahead < right) {
    agent.angle += (jitter - 0.5) * 2.0 * turn;
  } else if (left > right) {
    agent.angle += jitter * turn;
  } else if (right > left) {
    agent.angle -= jitter * turn;
  }

  let toPointer = params.pointer - agent.position;
  let distance = length(toPointer);
  if (params.pointerForce > 0.0 && distance > 1.0 && distance < params.size.y * 0.3) {
    let heading = atan2(toPointer.y, toPointer.x);
    agent.angle += atan2(sin(heading - agent.angle), cos(heading - agent.angle)) * params.pointerForce * params.dt;
  }

  agent.position += vec2f(cos(agent.angle), sin(agent.angle)) * params.speed * params.dt;
  agent.position = (agent.position + params.size) % params.size;
  agents[id.x] = agent;

  var laid = vec4f(0.0);
  laid[agent.species] = params.deposit * params.dt;
  let here = cell(vec2i(agent.position));
  trail[here] = min(trail[here] + laid, vec4f(1.0));
}

@compute @workgroup_size(TILE, TILE)
fn diffuse(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= params.size.x || f32(id.y) >= params.size.y) {
    return;
  }
  let center = vec2i(id.xy);
  var sum = vec4f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      sum += trail[cell(center + vec2i(dx, dy))];
    }
  }
  trailNext[cell(center)] = max(sum / 9.0 - params.decay * params.dt, vec4f(0.0));
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn render(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let density = trail[cell(vec2i(position.xy / params.canvas * params.size))];
  let ember = vec3f(1.0, 0.36, 0.16);
  let tide = vec3f(0.16, 0.62, 1.0);
  let pollen = vec3f(0.98, 0.86, 0.32);
  let light = density.r * ember + density.g * tide + density.b * pollen;
  return vec4f(1.0 - exp(-light * 1.7), 1.0);
}
