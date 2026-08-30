import { icon } from './icons.js';

export function commonAuthJS() {
  return `
const ICON_USER = ${JSON.stringify(icon('user'))};
const ICON_LOGOUT = ${JSON.stringify(icon('logout'))};
const ICON_SUN = ${JSON.stringify(icon('sun'))};
const ICON_MOON = ${JSON.stringify(icon('moon'))};
let clerkReady = false;
function doOpenSignIn() { if (window.Clerk) { try { Clerk.openSignIn(); } catch {} } }
function doOpenSignUp() { if (window.Clerk) { try { Clerk.openSignUp(); } catch {} } }
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function applyThemeIcon() { const btn = document.getElementById('theme-toggle'); if (btn) btn.innerHTML = currentTheme() === 'dark' ? ICON_SUN : ICON_MOON; }
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('ledger-theme', next); } catch {}
  applyThemeIcon();
}
function attachGateButtons() {
  const si = document.getElementById('gate-signin');
  const su = document.getElementById('gate-signup');
  if (si) si.addEventListener('click', doOpenSignIn);
  if (su) su.addEventListener('click', doOpenSignUp);
  const tt = document.getElementById('theme-toggle');
  if (tt) { applyThemeIcon(); tt.addEventListener('click', toggleTheme); }
  const pill = document.getElementById('profile-pill');
  const menu = document.getElementById('profile-menu');
  if (pill && menu) {
    pill.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    const soBtn2 = document.getElementById('menu-signout');
    if (soBtn2) soBtn2.addEventListener('click', () => { if (window.Clerk) Clerk.signOut(); });
    const profBtn = document.getElementById('menu-profile');
    if (profBtn) profBtn.addEventListener('click', () => { if (window.Clerk) { try { Clerk.openUserProfile(); } catch {} } });
  }
}
function initClerk() {
  if (clerkReady || !window.Clerk) return;
  clerkReady = true;
  Clerk.load().then(() => { onClerkState(); Clerk.addListener(() => onClerkState()); }).catch(() => {
    const headerRight = document.getElementById('header-right');
    if (headerRight) headerRight.innerHTML = '<span class="loading">Sign in to continue</span>';
  });
}
function initials(name) { return String(name || 'U').trim().split(/\\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase(); }
function onClerkState() {
  const headerRight = document.getElementById('header-right');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  if (Clerk.user) {
    if (authGate) authGate.style.display = 'none';
    if (app) app.classList.add('active');
    if (headerRight) {
      const name = Clerk.user.username || Clerk.user.firstName || 'User';
      const img = Clerk.user.imageUrl;
      const avatarInner = img ? '<img src="' + img + '" alt="' + name + '">' : initials(name);
      headerRight.innerHTML = '<div class="profile-wrap"><button class="profile-pill" id="profile-pill"><span class="profile-avatar">' + avatarInner + '</span><span class="user-name">' + name + '</span></button><div class="profile-menu" id="profile-menu"><button id="menu-profile">' + ICON_USER + ' Profile</button><button id="menu-signout">' + ICON_LOGOUT + ' Sign Out</button></div></div>';
      const pill = document.getElementById('profile-pill');
      const menu = document.getElementById('profile-menu');
      pill.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
      document.addEventListener('click', () => menu.classList.remove('open'));
      document.getElementById('menu-signout').addEventListener('click', () => Clerk.signOut());
      document.getElementById('menu-profile').addEventListener('click', () => { try { Clerk.openUserProfile(); } catch {} });
    }
    if (typeof onAuthenticated === 'function') onAuthenticated();
  } else {
    if (authGate) authGate.style.display = 'flex';
    if (app) app.classList.remove('active');
    if (headerRight) headerRight.innerHTML = '<span class="loading">Sign in to continue</span>';
  }
}
const clerkInterval = setInterval(() => { if (window.Clerk) { clearInterval(clerkInterval); initClerk(); } }, 100);
document.addEventListener('DOMContentLoaded', attachGateButtons);
`;
}

export function headerMarkup(tagline, withSearch) {
  const search = withSearch ? `<div class="header-search"><span class="search-icon">${icon('search')}</span><input type="text" id="header-search-input" placeholder="Search anime or manga..." autocomplete="off"><div class="search-suggest" id="search-suggest"></div></div>` : '';
  const nav = withSearch ? `<nav class="sections" id="nav-sections"><button class="active" data-mode="home">Home</button><button data-mode="random">Random Pull</button><button data-mode="seasonal">This Season</button><button data-mode="upcoming">On the Horizon</button><button data-mode="manga">Top Manga</button><button data-mode="search">Search Index</button></nav>` : '';
  return `<header><div class="header-left"><div class="header-brand"><h1>The Ledger</h1><div class="tagline">${tagline}</div></div>${search}${nav}</div><div class="header-controls"><button class="theme-toggle" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme"></button><div id="header-right"><span class="loading">Loading…</span></div></div></header>`;
}
