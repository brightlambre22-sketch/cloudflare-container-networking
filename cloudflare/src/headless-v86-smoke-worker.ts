import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

type InstantiationOutcome = { instantiated: boolean; error?: string };

export default {
  async fetch() {
    const wasm = getCompiledV86WasmInfo();
    let finish!: (value: InstantiationOutcome) => void;
    const observed = new Promise<InstantiationOutcome>((resolve) => { finish = resolve; });
    const compiledWasmFn = createCompiledV86WasmFn();
    const wasmFn = async (imports: WebAssembly.Imports) => {
      try {
        const exports = await compiledWasmFn(imports);
        finish({ instantiated: true });
        return exports;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        finish({ instantiated: false, error: message });
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
      finish({ instantiated: false, error: constructorError });
    }

    const outcome = await Promise.race<InstantiationOutcome>([
      observed,
      new Promise<InstantiationOutcome>((resolve) => setTimeout(() => resolve({
        instantiated: false,
        error: "v86_did_not_call_wasm_fn_within_5000ms",
      }), 5000)),
    ]);

    return new Response(JSON.stringify({
      probe: "headless-v86-static-instantiation",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      wasm_import_count: wasm.imports.length,
      wasm_export_count: wasm.exports.length,
      static_module_instantiated: outcome.instantiated,
      guest_booted: false,
      ...(outcome.error ? { instantiation_error: outcome.error } : {}),
      ...(constructorError ? { constructor_error: constructorError } : {}),
      note: "Tests static WebAssembly.instantiate through v86's wasm_fn hook; does not restore a snapshot or boot Linux.",
    }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
