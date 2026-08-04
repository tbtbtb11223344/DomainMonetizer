(() => {
  document.documentElement.classList.add("js");
  requestAnimationFrame(() => document.documentElement.classList.add("ready"));

  const reveal = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
    reveal.forEach((element) => observer.observe(element));
  } else {
    reveal.forEach((element) => element.classList.add("visible"));
  }

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
