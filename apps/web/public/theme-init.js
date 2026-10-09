// Applies the saved theme before first paint (no flash). Kept external so the CSP can forbid inline scripts.
try {
  var t = localStorage.getItem('draxmax-theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch (e) {}
