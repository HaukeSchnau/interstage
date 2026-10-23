// A sphere hollowed into a gyroid lattice, with three drops of the same material orbiting it.
// Everything is a signed distance function, drawn by marching a ray per pixel.

const STEPS = 112;
const FAR = 30.0;
const SURFACE = 0.0008;

struct Scene {
  resolution: vec2f,
  time: f32,
  yaw: f32,
  pitch: f32,
  distance: f32,
  blend: f32,
  lattice: f32,
  thickness: f32,
  hue: f32,
}

@group(0) @binding(0) var<uniform> scene: Scene;

/** Smooth minimum: blends two distances over a band `k` wide. */
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn rotateY(p: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

fn gyroid(p: vec3f) -> f32 {
  return dot(sin(p), cos(p.zxy));
}

/** Distance to the sculpture. */
fn sculpture(p: vec3f) -> f32 {
  let q = rotateY(p, scene.time * 0.25);
  let shell = length(q) - 1.35;
  let lattice = abs(gyroid(q * scene.lattice)) / scene.lattice - scene.thickness;
  var d = max(shell, lattice);
  for (var i = 0; i < 3; i++) {
    let angle = scene.time * 0.6 + f32(i) * 2.0944;
    let orbit = vec3f(cos(angle) * 1.9, sin(scene.time * 0.9 + f32(i)) * 0.55, sin(angle) * 1.9);
    d = smin(d, length(p - orbit) - 0.38, scene.blend);
  }
  return d;
}

fn floorDistance(p: vec3f) -> f32 {
  return p.y + 1.75;
}

fn world(p: vec3f) -> f32 {
  return min(sculpture(p), floorDistance(p));
}

fn normalAt(p: vec3f) -> vec3f {
  let e = vec2f(0.0007, 0.0);
  return normalize(vec3f(
    world(p + e.xyy) - world(p - e.xyy),
    world(p + e.yxy) - world(p - e.yxy),
    world(p + e.yyx) - world(p - e.yyx),
  ));
}

fn march(origin: vec3f, direction: vec3f) -> f32 {
  var t = 0.0;
  for (var i = 0; i < STEPS; i++) {
    let d = world(origin + direction * t);
    if (d < SURFACE * t || t > FAR) {
      break;
    }
    t += d * 0.9;
  }
  return t;
}

fn softShadow(origin: vec3f, direction: vec3f) -> f32 {
  var light = 1.0;
  var t = 0.02;
  for (var i = 0; i < 40; i++) {
    let d = world(origin + direction * t);
    light = min(light, 10.0 * d / t);
    t += clamp(d, 0.02, 0.25);
    if (light < 0.01 || t > 8.0) {
      break;
    }
  }
  return clamp(light, 0.0, 1.0);
}

fn occlusion(p: vec3f, n: vec3f) -> f32 {
  var occluded = 0.0;
  var weight = 1.0;
  for (var i = 1; i <= 5; i++) {
    let h = 0.03 * f32(i * i);
    occluded += (h - world(p + n * h)) * weight;
    weight *= 0.7;
  }
  return clamp(1.0 - 2.5 * occluded, 0.0, 1.0);
}

/** Inigo Quilez's cosine palette, turned by the hue setting. */
fn palette(t: f32) -> vec3f {
  return 0.5 + 0.5 * cos(6.28318 * (t + scene.hue + vec3f(0.0, 0.33, 0.67)));
}

@vertex
fn fullscreen(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn shade(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = (position.xy * 2.0 - scene.resolution) / scene.resolution.y * vec2f(1.0, -1.0);
  let eye = vec3f(
    cos(scene.pitch) * sin(scene.yaw),
    sin(scene.pitch),
    cos(scene.pitch) * cos(scene.yaw),
  ) * scene.distance;
  let forward = normalize(-eye);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let ray = normalize(forward * 1.8 + right * uv.x + up * uv.y);

  let sky = mix(vec3f(0.02, 0.02, 0.03), vec3f(0.09, 0.08, 0.12), uv.y * 0.5 + 0.5);
  let t = march(eye, ray);
  if (t > FAR) {
    return vec4f(sky, 1.0);
  }

  let p = eye + ray * t;
  let n = normalAt(p);
  let sun = normalize(vec3f(0.6, 0.9, 0.4));
  let shadow = softShadow(p + n * 0.003, sun);
  let ao = occlusion(p, n);
  let facing = clamp(dot(n, -ray), 0.0, 1.0);
  let diffuse = clamp(dot(n, sun), 0.0, 1.0) * shadow;
  let specular = pow(clamp(dot(reflect(ray, n), sun), 0.0, 1.0), 48.0) * shadow;

  var color: vec3f;
  if (sculpture(p) < floorDistance(p)) {
    // Thin-film colors that shift with the viewing angle.
    let film = palette(facing * 0.8 + p.y * 0.15);
    color = film * (0.15 + 0.85 * diffuse) * ao + specular * 1.2 + pow(1.0 - facing, 3.0) * film * 0.6;
  } else {
    let grid = smoothstep(0.03, 0.0, abs(fract(p.x * 0.5) - 0.5)) + smoothstep(0.03, 0.0, abs(fract(p.z * 0.5) - 0.5));
    color = vec3f(0.018, 0.018, 0.022) * (0.3 + 0.7 * shadow) * ao + grid * 0.02;
  }
  let fog = exp(-0.012 * t * t);
  color = mix(sky, color, fog);
  return vec4f(pow(color, vec3f(1.0 / 2.2)), 1.0);
}
