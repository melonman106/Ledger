export function skeletonRail(count) {
  let cards = '';
  for (let i = 0; i < count; i++) { cards += `<div class="skel-card"><div class="skel skel-img"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>`; }
  return `<div class="skel-rail-track">${cards}</div>`;
}

export function skeletonHero() {
  return `<div class="skel-hero"><div class="skel skel-cover"></div><div class="skel-hero-info"><div class="skel skel-line"></div><div class="skel skel-line sm"></div><div><div class="skel skel-line stat"></div><div class="skel skel-line stat"></div><div class="skel skel-line stat"></div></div></div></div><div class="skel-desc"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:60%"></div></div>`;
}

export function skeletonEpGrid() {
  let btns = ''; for (let i = 0; i < 24; i++) btns += '<div class="skel" style="height:30px;"></div>';
  return `<div class="ep-grid">${btns}</div>`;
}

export function skeletonChapterList() {
  let rows = ''; for (let i = 0; i < 10; i++) rows += '<div class="skel" style="height:34px;margin-bottom:4px;"></div>';
  return rows;
}
