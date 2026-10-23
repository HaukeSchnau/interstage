struct Light {
  color: vec3f,
  intensity: f32,
}

@group(0) @binding(0) var<uniform> light: Light;

fn brightness() -> f32 {
  return light.color * light.intensity;
}
