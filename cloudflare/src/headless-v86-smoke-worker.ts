import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

export default {
  async fetch() {
    const wasm = getCompiledV86WasmInfo();
    let called = false;
    let instantiationError: string | undefined;
    const compiledWasmFn = createCompiledV86WasmFn();
    const wasmFn = async (imports: WebAssembly.Imports) => {
      try {
        const exports = await compiledWasmFn(imports);
        called = true;
        return exports;
      } catch (error) {
        instantiationError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        return {} as WebAssembly.Exports;
      }
    };

    let constructorError: string | undefined;
    try {
      new V86({
        wasm_fn: wasmFn,
        memory_size: 16 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
      } as ConstructorParameters<typeof V86>[0]);
    } catch (error) {
      constructorError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }

    await Promise.resolve();
    return new Response(JSON.stringify({
      probe: "headless-v86-static-instantiation",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      wasm_import_count: wasm.imports.length,
      wasm_export_count: wasm.exports.length,
      static_module_instantiated: called,
      guest_booted: false,
      ...(instantiationError ? { instantiation_error: instantiationError } : {}),
      ...(constructorError ? { constructor_error: constructorError } : {}),
      note: "Tests static WebAssembly.instantiate through v86's wasm_fn hook; does not restore a snapshot or boot Linux.",
    }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
