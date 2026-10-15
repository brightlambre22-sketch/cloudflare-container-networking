import V86 from "../dist/headless-v86-bundle.js";
import { getCompiledV86WasmInfo } from "./headless-v86-wasm";

export default {
  fetch() {
    const wasm = getCompiledV86WasmInfo();
    return new Response(JSON.stringify({
      probe: "headless-v86-workerd-import",
      runtime: "workerd",
      module_loaded: typeof V86 === "function",
      wasm_module_loaded: wasm.module_loaded,
      wasm_import_count: wasm.imports.length,
      wasm_export_count: wasm.exports.length,
      guest_booted: false,
      note: "This verifies static CompiledWasm loading and v86 module initialization; it does not boot a guest.",
    }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
