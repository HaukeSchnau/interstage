// Draws the cloth from cloth-sim.wgsl's points: two triangles per square of the grid, the live
// page on the front and the back of the card on the reverse, lit by a lamp to the upper left.

/** The two triangles of a grid square, as offsets from its top-left point. */
const CORNERS = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));

struct Camera {
  viewProjection: mat4x4f,
  /** Points across and down. */
  grid: vec2u,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var page: texture_2d<f32>;
@group(0) @binding(2) var pageSampler: sampler;

@group(1) @binding(0) var<storage, read> points: array<vec4f>;

struct Fold {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
}

fn pointAt(column: u32, row: u32) -> vec3f {
  let x = min(column, camera.grid.x - 1u);
  let y = min(row, camera.grid.y - 1u);
  return points[y * camera.grid.x + x].xyz;
}

@vertex
fn foldVertex(@builtin(vertex_index) vertex: u32) -> Fold {
  let square = vertex / 6u;
  let corner = CORNERS[vertex % 6u];
  let column = square % (camera.grid.x - 1u) + corner.x;
  let row = square / (camera.grid.x - 1u) + corner.y;
  let across = pointAt(column + 1u, row) - pointAt(max(column, 1u) - 1u, row);
  let down = pointAt(column, row + 1u) - pointAt(column, max(row, 1u) - 1u);
  var fold: Fold;
  fold.position = camera.viewProjection * vec4f(pointAt(column, row), 1.0);
  fold.uv = vec2f(f32(column), f32(row)) / vec2f(camera.grid - 1u);
  fold.normal = normalize(cross(down, across));
  return fold;
}

@fragment
fn foldFragment(fold: Fold, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let normal = select(-fold.normal, fold.normal, front);
  let lamp = normalize(vec3f(-0.45, 0.55, 0.75));
  let diffuse = max(dot(normal, lamp), 0.0);
  let glint = pow(max(dot(normal, normalize(lamp + vec3f(0.0, 0.0, 1.0))), 0.0), 40.0) * 0.12;
  let print = textureSampleLevel(page, pageSampler, fold.uv, 0.0);
  // The card's rounded corners are transparent on the page.
  if (print.a < 0.5) {
    discard;
  }
  let printed = print.rgb;
  // The back of the card: plain paper with the print showing through, mirrored.
  let mirrored = textureSampleLevel(page, pageSampler, vec2f(1.0 - fold.uv.x, fold.uv.y), 0.0).rgb;
  let back = mix(vec3f(0.84, 0.83, 0.8), mirrored, 0.07);
  let paper = select(back, printed, front);
  return vec4f(paper * (0.5 + 0.6 * diffuse) + glint, 1.0);
}
