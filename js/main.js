// ===== Smooth Page Load =====
document.addEventListener('DOMContentLoaded', () => {
  // Add smooth transition after page load
  setTimeout(() => {
    document.body.style.transition = 'background 0.3s ease, color 0.3s ease';
  }, 100);
});
