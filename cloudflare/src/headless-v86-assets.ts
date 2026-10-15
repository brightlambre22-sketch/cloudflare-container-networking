/**
 * Experimental Worker-compatible asset loading primitives for a future v86 port.
 *
 * This module is intentionally not wired into /v1/vm/exec: upstream v86 still
 * calls its own load_file() paths for disk images and other resources. These
 * helpers solve only the asset-fetch and WASM-initialization seams.
 */

export interface WorkerV86AssetOptions {
  /** Worker ASSETS binding, not the public Worker fetch handler. */
  assets: Fetcher;
  /** Absolute URL of the incoming request, used to resolve same-deployment assets. */
  requestUrl: string;
}

const V86_ASSET_LIMITS: Readonly<Record<string, number>> = {
  "/v86/v86.wasm": 8 * 1024 * 1024,
  "/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso": 24 * 1024 * 1024,
};

export async function fetchWorkerV86Asset(
  options: WorkerV86AssetOptions,
  path: string,
): Promise<ArrayBuffer> {
  const maxBytes = V86_ASSET_LIMITS[path];
  if (maxBytes === undefined) {
    throw new Error("v86_asset_path_not_allowlisted");
  }

  const url = new URL(path, options.requestUrl);
  const response = await options.assets.fetch(new Request(url.toString(), {
    method: "GET",
    headers: { "accept": "application/octet-stream" },
  }));

  if (!response.ok) {
    throw new Error("v86_asset_http_" + response.status);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new Error("v86_asset_size_limit_exceeded");
    }
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error("v86_asset_size_limit_exceeded");
  }

  return bytes;
}

/**
 * Shape expected by v86's V86Options.wasm_fn callback. This bypasses the
 * upstream default local-path loader for v86.wasm, but does not replace
 * load_file() for the guest ISO/disk and therefore is not a complete port.
 */
export function createWorkerV86WasmFn(
  options: WorkerV86AssetOptions,
): (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports> {
  return async (imports) => {
    const bytes = await fetchWorkerV86Asset(options, "/v86/v86.wasm");
    const result = await WebAssembly.instantiate(bytes, imports);
    return result.instance.exports;
  };
}
