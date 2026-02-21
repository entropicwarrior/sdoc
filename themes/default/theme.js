// SDOC Slides — Default Theme Runtime
// Keyboard navigation, touch swipe, slide counter.

(function () {
  const slides = document.querySelectorAll(".slide");
  let current = 0;

  function show(n) {
    slides[current].classList.remove("active");
    current = Math.max(0, Math.min(n, slides.length - 1));
    slides[current].classList.add("active");
    const counter = document.getElementById("counter");
    if (counter) {
      counter.textContent = (current + 1) + " / " + slides.length;
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      show(current + 1);
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      show(current - 1);
    }
    if (e.key === "Home") {
      e.preventDefault();
      show(0);
    }
    if (e.key === "End") {
      e.preventDefault();
      show(slides.length - 1);
    }
  });

  // Touch swipe support
  var touchStartX = 0;
  document.addEventListener("touchstart", function (e) {
    touchStartX = e.touches[0].clientX;
  });
  document.addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (dx < -50) show(current + 1);
    if (dx > 50) show(current - 1);
  });

  // Activate first slide
  show(0);
})();
