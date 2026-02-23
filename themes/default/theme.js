// SDOC Slides — Default Theme Runtime
// Keyboard navigation, click navigation, touch swipe, URL hash, nav indicators.

(function () {
  const slides = document.querySelectorAll(".slide");
  let current = 0;

  function show(n) {
    slides[current].classList.remove("active");
    current = Math.max(0, Math.min(n, slides.length - 1));
    slides[current].classList.add("active");
    // Update nav indicators on all slides
    slides.forEach(function (slide, i) {
      var prev = slide.querySelector(".nav-prev");
      var next = slide.querySelector(".nav-next");
      if (prev) prev.style.visibility = i > 0 ? "visible" : "hidden";
      if (next) next.style.visibility = i < slides.length - 1 ? "visible" : "hidden";
    });
    // Update URL hash without triggering hashchange
    history.replaceState(null, "", "#" + (current + 1));
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

  // Click navigation — right half forward, left half back
  document.addEventListener("click", function (e) {
    // Ignore clicks on links, buttons, or interactive elements
    if (e.target.closest("a, button, input, textarea, select")) return;
    if (e.clientX > window.innerWidth / 2) {
      show(current + 1);
    } else {
      show(current - 1);
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

  // Read initial slide from URL hash
  var startSlide = 0;
  var hash = window.location.hash;
  if (hash && hash.match(/^#\d+$/)) {
    startSlide = parseInt(hash.substring(1), 10) - 1;
  }
  show(startSlide);

  // Handle back/forward browser navigation
  window.addEventListener("hashchange", function () {
    var h = window.location.hash;
    if (h && h.match(/^#\d+$/)) {
      show(parseInt(h.substring(1), 10) - 1);
    }
  });
})();
