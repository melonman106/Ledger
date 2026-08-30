import { commonCSS, themeInitScript, siteMeta, clerkHead } from '../lib/theme.js';
import { headerMarkup } from '../lib/auth.js';
import { icon } from '../lib/icons.js';

export function notFoundPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Page not found</title>${siteMeta("The page you're looking for doesn't exist.")}
<style>${commonCSS()}
.nf-wrap { min-height:80vh; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:40px; gap:18px; }
.nf-code { font-size:5rem; font-weight:800; color:var(--accent); letter-spacing:-2px; line-height:1; }
.nf-wrap p { color:var(--ink-soft); max-width:420px; }
</style></head><body>
${headerMarkup('Page not found', false)}
<div class="nf-wrap"><div class="nf-code">404</div><h1 style="font-weight:700;">This record isn't in the index</h1><p>The page you're looking for doesn't exist or may have moved.</p><a href="/" class="btn">Back to Index</a></div>
<script>
const ICON_SUN_NF = ${JSON.stringify(icon('sun'))};
const ICON_MOON_NF = ${JSON.stringify(icon('moon'))};
function applyNfThemeIcon() { const btn = document.getElementById('theme-toggle'); if (btn) btn.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? ICON_SUN_NF : ICON_MOON_NF; }
applyNfThemeIcon();
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) { document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('ledger-theme','light'); } catch {} }
  else { document.documentElement.setAttribute('data-theme','dark'); try { localStorage.setItem('ledger-theme','dark'); } catch {} }
  applyNfThemeIcon();
});
document.getElementById('header-right').innerHTML = '<a href="/" class="btn" style="padding:8px 16px;font-size:0.78rem;">Home</a>';
</script>
</body></html>`;
}
