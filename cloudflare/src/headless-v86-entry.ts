/**
 * Candidate entry for a Worker-compatible v86 build.
 *
 * Importing the published bundle is a known failing approach because it
 * contains Node-specific loader branches. This entry is kept as a build probe
 * until the upstream source loader can be replaced safely.
 */
import V86 from "v86";

export { V86 };
export default V86;
