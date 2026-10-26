'use strict';

// Progressive enhancement: without JS every server-rendered row stays visible.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-list]').forEach(function (list) {
    const rows = Array.from(list.querySelectorAll('[data-list-row]'));
    const search = list.querySelector('[data-list-search]');
    const previous = list.querySelector('[data-list-prev]');
    const next = list.querySelector('[data-list-next]');
    const count = list.querySelector('[data-list-count]');
    const empty = list.querySelector('[data-list-empty]');
    if (!rows.length || !search || !previous || !next || !count || !empty) return;
    const pageSize = 10;
    let page = 0;

    function update() {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = rows.filter(function (row) {
        // Read live input values so saved device aliases remain searchable.
        const values = Array.from(row.querySelectorAll('input[type="text"]')).map(input => input.value).join(' ');
        return ((row.dataset.search || '') + ' ' + values).toLocaleLowerCase().includes(query);
      });
      page = Math.max(0, Math.min(page, Math.ceil(matches.length / pageSize) - 1));
      const start = page * pageSize;
      const shown = new Set(matches.slice(start, start + pageSize));
      rows.forEach(row => { row.hidden = !shown.has(row); });
      previous.disabled = page === 0;
      next.disabled = start + pageSize >= matches.length;
      empty.hidden = matches.length !== 0;
      count.textContent = list.dataset.listSummary
        .replace('{start}', matches.length ? start + 1 : 0)
        .replace('{end}', Math.min(start + pageSize, matches.length))
        .replace('{total}', matches.length);
    }
    search.addEventListener('input', function () { page = 0; update(); });
    previous.addEventListener('click', function () { page--; update(); });
    next.addEventListener('click', function () { page++; update(); });
    list.querySelectorAll('[data-list-controls]').forEach(control => { control.hidden = false; });
    update();
  });

  function revealAnchor() {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    const target = document.getElementById(id);
    if (!target) return;
    let parent = target;
    while (parent) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
    target.scrollIntoView({block: 'start'});
  }
  window.addEventListener('hashchange', revealAnchor);
  revealAnchor();
});
