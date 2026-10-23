# Design

interstage makes a `.wgsl` file importable from TypeScript as a TypeGPU module. This file records
why it works the way it does.

## One module, three hosts

`compile()` (`src/compile.ts`) turns WGSL source into a TypeScript module that is also valid
JavaScript. TypeGPU's own types do the typing: the module calls `d.struct`, `tgpu.fn` and friends,
and TypeScript infers the rest, so interstage never writes a type by hand and follows TypeGPU as it
changes.

- The content mapper (`src/mapper.ts`) gives `tsc` and the language server that module, with span
  mappings back into the WGSL.
- The Vite plugin (`src/vite.ts`) and the Node loader (`src/register.ts`) serve the same text at
  runtime.

The parser (`src/parser.ts`) reads only module-scope declarations and keeps every span. Function
bodies stay token ranges: TypeGPU takes them as WGSL text.

## How declarations map

- **Structs and aliases** become schemas, sorted so that each comes after what it uses. IO
  attributes become TypeGPU decorators.
- **Constants** are evaluated (`src/evaluate.ts`) and exported as JavaScript values, so host code
  can do arithmetic with them. In shader code an untyped scalar is inlined, which keeps WGSL's
  abstract numbers abstract (`id.x < N` must work with a u32 `id.x`). Typed and composite constants
  become `tgpu.const`. A constant the evaluator can't handle is inlined as written through
  `rawCodeSnippet` and not exported.
- **Bindings** become one layout per `@group`, `layout<N>`, with `$idx(N)` and null entries for
  skipped binding numbers. Functions reach them through getters in `$uses`, because a layout's `$`
  accessors only work during resolution.
- **Functions** get `$uses` after every declaration, so their order in the file doesn't matter.
- **Entry points** become TypeGPU entry functions. TypeGPU hands builtins to the body as
  parameters of the same name, and vertex inputs too, so most bodies run unchanged. A struct
  parameter is rebuilt in a prologue, `let input = VertexOut(position, in.color);`. A struct
  return type is renamed to `Out`, TypeGPU's name for the output struct it generates, and a bare
  `@builtin` return is wrapped as `return Out(…);`.

## Editor navigation

Declarations are mapped verbatim (same text, same length), which lets the language server rename
through them. The mapper also appends a statement that lists every module-scope reference inside
function bodies, each mapped to its place in the shader, so that references and rename reach into
shader code. Member accesses are included when exactly one struct in the module has a member of
that name and the name can't be a swizzle or a field of a builtin's result. Within one module that
is unambiguous.

## Validation

With `validate`, the mapper compiles each shader with Tint through Dawn (the `webgpu` package) and
reports its errors at their offsets, which are already positions in the original source. Dawn shuts
down when the object `create()` returns is garbage collected, so the validator holds on to it.

## Facts this relies on

Checked against `typescript@7.1.0-beta` and `typegpu@0.12.8`:

- `tsc` needs `--runExternalCode`; the language server takes `initializationOptions.runExternalCode`.
- A mapper's diagnostics count as syntax errors, and `tsc` reports no semantic errors in a program
  that has syntax errors.
- The DOM library in TypeScript 7.1 includes WebGPU, so `@webgpu/types` conflicts with it, and
  TypeGPU's declarations need `skipLibCheck`.
- TypeGPU keeps getters in `$uses` lazy and replaces external names in WGSL text by pattern, not
  by scope. That is why a local that hides an inlined constant is reported.

## Known upstream issues

- TypeGPU warns `external-omitted` when a raw WGSL fragment function reads a non-builtin input
  through `in`, because its `in` external lists only builtins. The shader is correct.
- Headless Chrome on Linux destroys a WebGPU device as soon as it presents to a canvas, so the
  examples' check renders into a texture (`?capture=N`).
