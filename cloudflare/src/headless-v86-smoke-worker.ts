import V86 from "../dist/headless-v86-bundle.js";

export default {
  fetch() {
    return new Response(JSON.stringify({
      probe: "headless-v86-workerd-import",
      runtime: "workerd",
      module_loaded: typeof V86 === "function",
      guest_booted: false,
      note: "This verifies module initialization in the Worker runtime only; it does not boot a guest.",
    }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
