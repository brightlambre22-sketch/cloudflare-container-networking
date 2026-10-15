/**
 * Build-only probe: bundle the upstream v86 constructor as a candidate Worker
 * module. This is not wired into the request handler and does not claim that
 * the upstream loader or DOM-dependent paths are Worker-compatible.
 */
import V86 from "v86";

export { V86 };
export default V86;
