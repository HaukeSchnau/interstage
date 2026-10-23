# interstage

Import WGSL shaders into TypeScript as typed [TypeGPU](https://typegpu.com) modules.

```wgsl
// particles.wgsl
struct Params {
  dt: f32,
  gravity: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec2f>;

@compute @workgroup_size(64)
fn fall(@builtin(global_invocation_id) id: vec3u) {
  velocities[id.x] += params.gravity * params.dt;
}
```

```ts
import { d, tgpu } from 'typegpu'
import { Params, layout0, fall } from './particles.wgsl'

const root = await tgpu.init()
const params = root.createBuffer(Params, { dt: 1 / 60, gravity: d.vec2f(0, -9.8) }).$usage('uniform')
const velocities = root.createBuffer(d.arrayOf(d.vec2f, 1024)).$usage('storage')
const bindGroup = root.createBindGroup(layout0, { params, velocities })

root.createComputePipeline({ compute: fall }).with(bindGroup).dispatchWorkgroups(1024 / 64)
```

interstage is a [TypeScript 7.1 content mapper](https://github.com/microsoft/typescript-go/pull/4712) and a Vite plugin. The mapper shows `tsc` and your editor each `.wgsl` file as the TypeGPU module it becomes: structs turn into schemas, each `@group` into a bind group layout, functions into typed functions and entry points into pipeline stages. The Vite plugin serves the same module at runtime. Nothing is generated on disk, so nothing can drift out of sync with the shader.

![The slime mold example](examples/public/posters/slime.webp)

## What it catches

Change `speed: f32` to `speed: vec2f` in the shader, and the TypeScript that writes a number into it stops compiling:

```
src/slime/main.ts(40,66): error TS2345: Argument of type '{ decay: number; sensorAngle: number; … speed: number; … }' is not assignable to parameter of type 'Behaviour'.
  Types of property 'speed' are incompatible.
    Type 'number' is not assignable to type 'v2f'.
```

Bind a buffer without uniform usage where the shader declares `var<uniform>`, bind an array of the wrong struct, or pass a `vec3f` to a WGSL function that takes a `vec2f`, and TypeGPU's own types reject it, because they now come from the shader.

Mistakes in the shader itself are reported in the `.wgsl` file. With the `validate` option, every shader is also compiled by Tint, the WGSL compiler inside Chrome:

```
src/slime/slime.wgsl(116,9): error wgsl100: 'target' is a reserved keyword
```

In the editor, the TypeScript language server goes to the WGSL declaration of an imported struct, finds the references to a WGSL function or binding in other shader functions and in TypeScript, and renames across both languages.

## Set it up

1. Install interstage next to TypeScript 7.1 and TypeGPU:

   ```sh
   pnpm add -D interstage typescript@beta
   pnpm add typegpu
   ```

2. Register the content mapper in `tsconfig.json`. TypeGPU's declarations need `skipLibCheck` under TypeScript 7.

   ```jsonc
   {
     "compilerOptions": { "skipLibCheck": true },
     "contentMappers": [{ "package": "interstage", "extensions": [".wgsl"], "options": { "validate": true } }],
   }
   ```

   `validate` is optional. It needs the [`webgpu`](https://www.npmjs.com/package/webgpu) package (`pnpm add -D webgpu`), which runs Dawn in Node: Metal on macOS, D3D on Windows and Vulkan on Linux. Without a GPU on Linux, point `VK_ICD_FILENAMES` at Mesa's lavapipe.

3. Load `.wgsl` files as modules in Vite:

   ```ts
   import interstage from 'interstage/vite'

   export default defineConfig({ plugins: [interstage()] })
   ```

   To import shaders in Node, for TypeGPU on Dawn, run `node --import interstage/register`.

4. Type-check with permission to start the mapper:

   ```sh
   tsc --noEmit --runExternalCode
   ```

   VS Code's TypeScript 7 extension starts content mappers in trusted workspaces.

## How a shader becomes a module

| WGSL | Export | TypeGPU |
| --- | --- | --- |
| `struct Particle { … }` | `Particle` | `d.struct({ … })`, with `@align`, `@size`, `@location`, `@interpolate` and `@builtin` as decorators |
| `alias Color = vec3f;` | `Color` | the aliased schema |
| `const COUNT = 4096;` | `COUNT` | a JavaScript value: `4096` with the literal type `4096`, a `d.vec3f`, an array or an object |
| `@group(1) @binding(0) var<storage, read_write> particles: array<Particle>;` | `layout1` | `tgpu.bindGroupLayout({ particles: { storage: d.arrayOf(Particle), access: 'mutable' } }).$idx(1)` |
| `var<workgroup> tile: array<f32, 64>;` | `tile` | `tgpu.workgroupVar(…)`, and `tgpu.privateVar` for `var<private>` |
| `fn wrap(p: vec2f) -> vec2f { … }` | `wrap` | `tgpu.fn([d.vec2f], d.vec2f)`, callable from TypeScript shaders |
| `@compute @workgroup_size(64) fn step(…)` | `step` | `tgpu.computeFn`, and `tgpu.vertexFn` and `tgpu.fragmentFn` for the other stages |

Constants are values on the CPU side, so `dispatchWorkgroups(COUNT / WORKGROUP)` reads them straight from the shader. Inside the shader, an untyped constant stays abstract, as WGSL defines it, and a typed one becomes a `const` declaration.

Function bodies stay as written. TypeGPU links them: it includes what each entry point uses, renames on conflicts and assigns the bind group indices that the shader declares.

## Examples

Try them at [interstage.schnau.dev](https://interstage.schnau.dev): a slime mold simulation, ink in water, a raymarched sculpture and a topographic atlas whose fragment shader is TypeScript calling WGSL. Each has a drawer that shows its shader next to the declarations `tsc` emits for it. They live in [`examples/`](examples):

```sh
pnpm install
pnpm --dir examples dev
```

## Limits

- `override` declarations are reported as unsupported. Use `const`.
- A runtime-sized array works as a whole storage binding, not as the last member of a struct.
- TypeGPU has square f32 matrices only, so `mat2x3f` and `f16` matrices are reported.
- WGSL modules can't import each other yet. TypeScript can import several shaders and combine them.
- A local variable that hides a module-scope constant is reported when the same function also uses the constant, because TypeGPU replaces names in function bodies textually.
- TypeGPU logs an `external-omitted` warning when a raw WGSL fragment shader reads a non-builtin input through `in`. The shader still works.
- Content mappers are new in TypeScript 7.1 and their protocol may change.

## Development

```sh
pnpm install
pnpm test                     # builds, then runs the tests in test/
pnpm --dir examples typecheck
pnpm --dir examples build && pnpm --dir examples check
```

The tests compile shaders with Tint and run them on Dawn, so they need a WebGPU adapter, like the `validate` option. `examples/check` loads every demo in Chromium (set `CHROME` to its path) and fails on WebGPU errors or blank frames. `nix develop` gives a shell with Node, pnpm, Chromium and Mesa's software Vulkan driver, in which all of it runs without a GPU.

[Calder](https://calder.schnau.dev) runs these checks on every push and pull request (`.calder/ci.ts`). A pull request gets a preview of the examples, and `main` deploys them to interstage.schnau.dev. A commit that raises the version in `package.json` stages that version on npm, where a maintainer approves it with 2FA (`npm stage approve <id>`).

## License

MIT
