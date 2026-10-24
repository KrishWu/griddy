// Runs in the browser before the app hydrates, and before Next's dev overlay installs its
// own error handlers, so these listeners see each event first.  SHARED (foundation).
//
// A cancelled request (AbortError) is never a bug: MapLibre aborts in-flight tile requests
// whenever tiles leave the view or a source is removed (e.g. E's satellite overlay on every
// site change), and a cancellation that something on the page leaves unhandled would surface
// as "Runtime AbortError" in the dev overlay, in the middle of a demo. Mark only those as
// handled; every other error still reports as usual.
function isAbort(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

window.addEventListener("unhandledrejection", (event) => {
  if (!isAbort(event.reason)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
});

window.addEventListener("error", (event) => {
  if (!isAbort(event.error)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
});
