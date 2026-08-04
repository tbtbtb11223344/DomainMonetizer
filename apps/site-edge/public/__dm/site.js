(() => {
  const releaseId = document.body.dataset.release;
  let sent = false;
  const send = () => {
    if (sent || !releaseId) return;
    sent = true;
    navigator.sendBeacon("/events/engaged", new Blob([JSON.stringify({ releaseId })], { type: "application/json" }));
  };
  window.setTimeout(send, 10000);
  window.addEventListener("scroll", () => {
    if (window.scrollY > window.innerHeight * 0.5) send();
  }, { passive: true, once: true });
})();
