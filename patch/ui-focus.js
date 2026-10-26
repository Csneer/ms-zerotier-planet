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

  // Keep server-rendered disclosures as a usable no-JS / older-browser fallback.
  // Move nodes (rather than clone HTML) so form values and event handlers survive.
  const dialogs = new Map();
  if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.showModal) {
    document.querySelectorAll('details[data-dialog]').forEach(function (details, index) {
      const summary = details.querySelector(':scope > summary');
      if (!summary) return;
      if (!details.id) details.id = 'ui-details-' + index;
      const dialog = document.createElement('dialog');
      dialog.id = details.id + '-dialog';
      dialog.className = 'app-dialog';
      const header = document.createElement('header');
      header.className = 'app-dialog-header';
      const title = document.createElement('h2');
      title.id = dialog.id + '-title';
      title.textContent = details.dataset.dialogTitle || summary.textContent.trim();
      dialog.setAttribute('aria-labelledby', title.id);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'app-dialog-close';
      close.textContent = '\u00d7';
      close.setAttribute('aria-label', document.body.dataset.dialogClose || 'Close');
      header.append(title, close);
      const body = document.createElement('div');
      body.className = 'app-dialog-body';
      Array.from(details.childNodes).forEach(node => { if (node !== summary) body.appendChild(node); });
      dialog.append(header, body);
      document.body.appendChild(dialog);
      details.open = false;
      details.classList.add('dialog-launcher');
      summary.setAttribute('aria-haspopup', 'dialog');
      summary.setAttribute('aria-controls', dialog.id);
      let opener = summary;
      function open(trigger) {
        if (dialog.open) return;
        opener = trigger || summary;
        dialog.showModal();
        document.documentElement.classList.add('app-dialog-open');
        body.scrollTop = 0;
        close.focus({preventScroll: true});
      }
      dialogs.set(details.id, {dialog, open});
      summary.addEventListener('click', function (event) { event.preventDefault(); open(summary); });
      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', function () {
        if (!document.querySelector('dialog.app-dialog[open]')) document.documentElement.classList.remove('app-dialog-open');
        const list = details.closest('[data-list]');
        const fallback = list && list.querySelector('[data-list-search]');
        const returnTo = opener && opener.isConnected && opener.getClientRects().length ? opener : fallback;
        if (returnTo) returnTo.focus({preventScroll: true});
      });
      let backdropStart = false;
      function outside(event) {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      }
      dialog.addEventListener('pointerdown', event => { backdropStart = outside(event); });
      dialog.addEventListener('click', event => { if (backdropStart && outside(event)) dialog.close(); backdropStart = false; });
      dialog.addEventListener('keydown', function (event) {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]'))
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    });
  }

  function revealTarget(id, trigger) {
    const entry = dialogs.get(id);
    if (entry) { entry.open(trigger); return true; }
    const target = document.getElementById(id);
    if (!target) return false;
    const parentDialog = target.closest('dialog');
    if (parentDialog) {
      for (const value of dialogs.values()) if (value.dialog === parentDialog) value.open(trigger);
    }
    let parent = target;
    while (parent) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
    target.scrollIntoView({block: 'nearest'});
    return true;
  }
  // Also handle repeated clicks on the same hash; hashchange alone misses them.
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = event.target.closest('[data-dialog-open], a[href^="#"]');
    if (!trigger) return;
    let id;
    try { id = trigger.dataset.dialogOpen || decodeURIComponent((trigger.getAttribute('href') || '').slice(1)); } catch (_) { return; }
    const target = document.getElementById(id);
    if (dialogs.has(id) || (target && target.closest('dialog'))) {
      event.preventDefault();
      revealTarget(id, trigger);
    }
  });

  function revealAnchor() {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    revealTarget(id);
  }
  window.addEventListener('hashchange', revealAnchor);
  revealAnchor();

  const tooltip = document.createElement('div');
  tooltip.id = 'app-tooltip';
  tooltip.className = 'app-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  let tooltipOwner;
  let tooltipTimer;
  function hideTooltip() {
    clearTimeout(tooltipTimer);
    if (tooltipOwner) {
      const ids = (tooltipOwner.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== tooltip.id);
      if (ids.length) tooltipOwner.setAttribute('aria-describedby', ids.join(' '));
      else tooltipOwner.removeAttribute('aria-describedby');
    }
    tooltipOwner = null;
    tooltip.hidden = true;
  }
  function deferTooltipHide() { tooltipTimer = setTimeout(hideTooltip, 150); }
  function positionTooltip() {
    const rect = tooltipOwner.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) { hideTooltip(); return; }
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12)) + 'px';
    tooltip.style.top = Math.max(12, rect.bottom + box.height + 12 < window.innerHeight ? rect.bottom + 8 : rect.top - box.height - 8) + 'px';
  }
  function showTooltip(owner) {
    hideTooltip();
    tooltipOwner = owner;
    tooltip.textContent = owner.dataset.tooltip;
    tooltip.hidden = false;
    owner.setAttribute('aria-describedby', ((owner.getAttribute('aria-describedby') || '') + ' ' + tooltip.id).trim());
    positionTooltip();
  }
  document.querySelectorAll('[data-tooltip]').forEach(function (owner) {
    owner.addEventListener('mouseenter', () => showTooltip(owner));
    owner.addEventListener('focus', () => showTooltip(owner));
    owner.addEventListener('mouseleave', deferTooltipHide);
    owner.addEventListener('blur', hideTooltip);
    owner.addEventListener('click', hideTooltip);
  });
  tooltip.addEventListener('mouseenter', () => clearTimeout(tooltipTimer));
  tooltip.addEventListener('mouseleave', deferTooltipHide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
  document.addEventListener('scroll', () => { if (tooltipOwner) positionTooltip(); }, true);
  window.addEventListener('resize', hideTooltip);
});
