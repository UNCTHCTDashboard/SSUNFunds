(function () {
  'use strict';

  var D = window.FUNDS_DATA;
  var ORDER = D.order; // ["CERF","PBF","QIPs","RSRTF","SSHF","WPHF"] — alphabetical
  var META = D.meta;

  var SEQ_STEPS = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];
  var SEQ_NONE = '#eef2f7';

  // Shared "shading" legend (No presence / Low / Medium / High) used under every
  // choropleth map — one compact horizontal row of pill chips, not a stacked list.
  function shadingLegendHtml(title, titleId) {
    var steps = [
      { color: SEQ_NONE, label: 'No presence' },
      { color: SEQ_STEPS[0], label: 'Low' },
      { color: SEQ_STEPS[2], label: 'Medium' },
      { color: SEQ_STEPS[4], label: 'High' }
    ];
    return (
      '<div class="uf-map-legend-group">' +
        '<h4' + (titleId ? ' id="' + titleId + '"' : '') + '>' + title + '</h4>' +
        '<div class="row-inline">' + steps.map(function (s) {
          return '<span class="uf-legend-swatch-chip"><span class="uf-swatch" style="background:' + s.color + '"></span>' + s.label + '</span>';
        }).join('') + '</div>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------
  // County name normalization (dataset county names -> topojson ADM2_EN)
  // ---------------------------------------------------------------
  var NAME_ALIASES = {
    'abyei': 'abyei region'
  };

  function normalize(name) {
    var n = (name || '').trim().toLowerCase();
    n = n.replace(/\s*\/\s*/g, '/'); // "Luakpiny / Nasir" -> "luakpiny/nasir"
    n = n.replace(/\s+/g, ' ');
    if (NAME_ALIASES[n]) n = NAME_ALIASES[n];
    return n;
  }

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = {
    geo: null,              // FeatureCollection, all counties
    countyState: null,      // normName -> ADM1_EN (state), populated once geo loads
    statesList: null,       // sorted list of state (ADM1_EN) names with fund presence
    fundStatesList: null,   // fund -> sorted list of state names that fund reaches, populated once geo loads
    fundIndex: {},          // fund -> Map(normName -> row)
    combined: new Map(),    // normName -> {county, total, byFund:{}, partners:Set}
    selected: {},           // panelId -> normName currently selected
    allFilters: { state: 'All', county: 'All', fund: 'All', partner: 'All' }, // "All Funds" page slicers
    fundFilters: {},        // fund -> {state, county, partner} slicers for each fund's own page
    overlapFocus: {},        // fund -> null | otherFundName, isolates one overlapping fund when clicked in the legend
    metric: 'value'          // 'value' ($) or 'projects' (count) — shared toggle for maps/KPIs/tables/overlap everywhere
  };

  ORDER.forEach(function (fund) {
    var idx = new Map();
    (D.funds[fund] || []).forEach(function (row) {
      idx.set(normalize(row.county), row);
    });
    state.fundIndex[fund] = idx;
    state.fundFilters[fund] = { state: 'All', county: 'All', partner: 'All' };
    state.overlapFocus[fund] = null;
  });

  ORDER.forEach(function (fund) {
    (D.funds[fund] || []).forEach(function (row) {
      var key = normalize(row.county);
      if (!state.combined.has(key)) {
        state.combined.set(key, { county: row.county, total: 0, totalValue: 0, byFund: {}, byFundValue: {}, partners: new Set(), provisionalFunds: new Set(), projectIds: new Set() });
      }
      var entry = state.combined.get(key);
      entry.total += row.projects;
      entry.totalValue += (row.value || 0);
      entry.byFund[fund] = row.projects;
      entry.byFundValue[fund] = row.value || 0;
      row.partners.forEach(function (p) { entry.partners.add(p); });
      (row.projectIds || []).forEach(function (id) { entry.projectIds.add(id); });
      if (row.provisional) entry.provisionalFunds.add(fund);
    });
  });

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function byId(id) { return document.getElementById(id); }
  function fmt(n) { return n.toLocaleString(); }

  // Compact $ formatting for chart labels / glyphs ($1.2M, $850K, $4,200), and a
  // full-precision version for tables/KPIs/tooltips ($1,234,567).
  function fmtMoney(n) {
    return '$' + Math.round(n).toLocaleString();
  }
  function fmtMoneyCompact(n) {
    var abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(abs >= 10e6 ? 1 : 2).replace(/\.0+$/, '') + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(abs >= 10e3 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return '$' + Math.round(n).toLocaleString();
  }

  // ---------------------------------------------------------------
  // Projects / $ Value metric toggle — shared by every map, KPI grid,
  // table, tooltip and overlap chart across the "All Funds" and per-fund
  // panels. Defaults to $ value: the more relevant lens for a funding
  // complementarity conversation.
  // ---------------------------------------------------------------
  function metricOf(row) { return state.metric === 'value' ? (row.value || 0) : (row.projects || 0); }
  function metricOfEntry(entry) { return state.metric === 'value' ? (entry.totalValue || 0) : (entry.total || 0); }
  function metricByFund(entry, fund) { return state.metric === 'value' ? (entry.byFundValue[fund] || 0) : (entry.byFund[fund] || 0); }
  function fmtMetric(n) { return state.metric === 'value' ? fmtMoney(n) : fmt(n); }
  function fmtMetricCompact(n) { return state.metric === 'value' ? fmtMoneyCompact(n) : fmt(n); }
  function metricNoun(cap) {
    var s = state.metric === 'value' ? 'value' : 'projects';
    return cap ? (s === 'value' ? 'Value' : 'Projects') : s;
  }

  // A county's `projects` count means "how many projects touch this county" --
  // correct per county, but summing it across several counties double-counts
  // any project that spans more than one of them (true for PBF/CERF/RSRTF).
  // Every project carries a stable ID on every county row it touches, so the
  // deduplicated total for any set of rows is the size of the ID union, not
  // the sum of `projects`. Used wherever a project *count* is aggregated
  // across more than one county; per-county display values are unaffected.
  function distinctProjectCount(rows) {
    var ids = new Set();
    rows.forEach(function (r) { (r.projectIds || []).forEach(function (id) { ids.add(id); }); });
    return ids.size;
  }

  function metricToggleHtml(scopeId) {
    return (
      '<div class="uf-metric-toggle" role="group" aria-label="Shade / rank by">' +
        '<button type="button" class="uf-metric-btn' + (state.metric === 'value' ? ' active' : '') + '" data-metric="value" data-scope="' + scopeId + '">$ Value</button>' +
        '<button type="button" class="uf-metric-btn' + (state.metric === 'projects' ? ' active' : '') + '" data-metric="projects" data-scope="' + scopeId + '">Projects</button>' +
      '</div>'
    );
  }

  function partnerChips(partners) {
    var arr = Array.isArray(partners) ? partners : Array.from(partners);
    return arr.sort().map(function (p) {
      return '<span class="uf-chip">' + p + '</span>';
    }).join('');
  }

  function fundChips(byFund, byFundValue) {
    return ORDER.filter(function (f) { return byFund[f]; }).map(function (f) {
      var v = state.metric === 'value' ? fmtMoneyCompact((byFundValue || {})[f] || 0) : byFund[f];
      return '<span class="uf-chip"><span class="dot" style="background:' + META[f].color + '"></span>' + f + ' &middot; ' + v + '</span>';
    }).join('');
  }

  // Lightens a #rrggbb hex color by `amt` (0-255) per channel — used for bar-fill gradients.
  function lightenHex(hex, amt) {
    var num = parseInt(hex.replace('#', ''), 16);
    var r = Math.min(255, (num >> 16) + amt);
    var g = Math.min(255, ((num >> 8) & 0xff) + amt);
    var b = Math.min(255, (num & 0xff) + amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ---------------------------------------------------------------
  // PDF export (tables, charts, maps) — jsPDF + jspdf-autotable + html2canvas, all CDN
  // ---------------------------------------------------------------
  function pdfButtonHtml(type, targetId, title, filename) {
    return '<button type="button" class="uf-mini-btn uf-pdf-btn" data-pdf-type="' + type + '" data-pdf-target="' + targetId + '" data-pdf-title="' + title.replace(/"/g, '&quot;') + '" data-pdf-filename="' + filename + '">Download PDF</button>';
  }

  // A table cell's chips (fund/partner pills) run together with no separator in
  // plain textContent — read each chip's text individually and join with commas.
  function cellTextForPdf(td) {
    var chips = td.querySelectorAll('.uf-chip, .uf-legend-fund-chip');
    if (chips.length) {
      return Array.from(chips).map(function (c) { return c.textContent.trim(); }).join(', ');
    }
    return td.textContent.trim();
  }

  function exportTableToPdf(wrapEl, title, filename) {
    var table = wrapEl.querySelector('table');
    if (!table) {
      alert('Nothing to export yet — this table is empty under the current filters.');
      return;
    }
    var head = Array.from(table.querySelectorAll('thead th')).map(function (th) { return th.textContent.trim(); });
    var body = Array.from(table.querySelectorAll('tbody tr')).map(function (tr) {
      return Array.from(tr.querySelectorAll('td')).map(cellTextForPdf);
    });
    var doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(13);
    doc.text(title, 28, 28);
    doc.autoTable({
      head: [head], body: body, startY: 40,
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [20, 61, 89] },
      margin: { left: 28, right: 28 }
    });
    doc.save(filename + '.pdf');
  }

  function exportElementToPdf(el, title, filename) {
    // Scrollable inner lists (e.g. the overlap chart's county cards) would otherwise
    // only capture whatever happened to be scrolled into view — expand them first
    // so the export always contains the full content, then restore afterwards.
    var restoreScroll = [];
    el.querySelectorAll('.uf-overlap-bars').forEach(function (scrollEl) {
      restoreScroll.push({ el: scrollEl, maxHeight: scrollEl.style.maxHeight, overflowY: scrollEl.style.overflowY });
      scrollEl.style.maxHeight = 'none';
      scrollEl.style.overflowY = 'visible';
    });
    function restore() {
      restoreScroll.forEach(function (s) { s.el.style.maxHeight = s.maxHeight; s.el.style.overflowY = s.overflowY; });
    }

    window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true }).then(function (canvas) {
      restore();
      var orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
      var doc = new window.jspdf.jsPDF({ orientation: orientation, unit: 'pt', format: 'a4', compress: true });
      var margin = 28;
      doc.setFontSize(13);
      doc.text(title, margin, margin);
      addCanvasToPdfPaginated(doc, canvas, margin, margin * 1.6);
      doc.save(filename + '.pdf');
    }).catch(function (err) {
      restore();
      console.error('PDF export failed', err);
      alert('Sorry, the PDF export failed. Please try again.');
    });
  }

  // Places a (possibly very tall) canvas into a PDF at full print-legible scale,
  // splitting it across as many pages as needed instead of shrinking everything
  // down to fit a single page — a 19-row chart would otherwise render as unreadable
  // thumbnail text just to avoid a second page.
  function addCanvasToPdfPaginated(doc, canvas, margin, startY) {
    var pageWidth = doc.internal.pageSize.getWidth();
    var pageHeight = doc.internal.pageSize.getHeight();
    var maxW = pageWidth - margin * 2;
    var scale = maxW / canvas.width; // PDF points per source canvas pixel
    var firstPageMaxH = pageHeight - startY - margin;
    var laterPageMaxH = pageHeight - margin * 2;

    var totalImgH = canvas.height * scale;
    if (totalImgH <= firstPageMaxH) {
      doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', margin, startY, maxW, totalImgH);
      return;
    }

    var srcY = 0;
    var remainingPx = canvas.height;
    var isFirst = true;
    while (remainingPx > 0) {
      var pageMaxH = isFirst ? firstPageMaxH : laterPageMaxH;
      var sliceHeightPx = Math.min(remainingPx, Math.floor(pageMaxH / scale));
      var sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      var ctx = sliceCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      ctx.drawImage(canvas, 0, srcY, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);

      if (!isFirst) doc.addPage();
      doc.addImage(sliceCanvas.toDataURL('image/jpeg', 0.88), 'JPEG', margin, isFirst ? startY : margin, maxW, sliceHeightPx * scale);

      srcY += sliceHeightPx;
      remainingPx -= sliceHeightPx;
      isFirst = false;
    }
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  var TABS = [{ id: 'all', label: 'All Funds', icon: '🌐' }].concat(
    ORDER.map(function (f) { return { id: f, label: f, icon: null }; })
  );

  function renderTabs() {
    var wrap = byId('uf-tabs');
    wrap.innerHTML = TABS.map(function (t, i) {
      var dot = t.id === 'all' ? '' : '<span class="dot" style="background:' + META[t.id].color + '"></span>';
      return '<button class="uf-tab' + (i === 0 ? ' active' : '') + '" data-tab="' + t.id + '">' + dot + (t.icon ? t.icon + ' ' : '') + t.label + '</button>';
    }).join('');

    wrap.querySelectorAll('.uf-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { activateTab(btn.dataset.tab); });
    });
  }

  var renderedPanels = {};

  // The county-averaging disclaimer only applies to funds that actually use
  // that method (PBF, CERF, RSRTF) plus the combined "All Funds" view, since
  // that view can include their rows too -- SSHF/WPHF/QIPs pages never split
  // a project's value across counties, so the disclaimer would be noise there.
  var DISCLAIMER_TABS = ['all', 'PBF', 'CERF', 'RSRTF'];

  function updateDisclaimerVisibility(tabId) {
    var el = byId('uf-disclaimer');
    if (el) el.style.display = DISCLAIMER_TABS.indexOf(tabId) !== -1 ? '' : 'none';
  }

  function activateTab(tabId) {
    ensurePanelRendered(tabId);
    document.querySelectorAll('.uf-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.uf-panel').forEach(function (p) {
      p.classList.toggle('active', p.dataset.panel === tabId);
    });
    updateDisclaimerVisibility(tabId);
    // Map needs a laid-out (visible) container to measure size correctly.
    requestAnimationFrame(function () { drawMap(tabId); });
  }

  function ensurePanelRendered(tabId) {
    if (renderedPanels[tabId]) return;
    renderedPanels[tabId] = true;
    var panels = byId('uf-panels');
    var panel = tabId === 'all' ? buildAllFundsPanel() : buildFundPanel(tabId);
    panels.appendChild(panel);
    // KPIs/presence/table/filters all use getElementById, which only finds elements
    // once they're in the live document — so the first render has to happen after
    // appendChild, not inside the builder functions themselves.
    if (tabId === 'all') {
      // If geo (and therefore the state/county lists) already loaded before this panel
      // was built — e.g. the user landed on a fund tab via URL hash first — populate now.
      if (state.statesList) {
        populateStateFilterOptions();
        renderCountyFilterOptions();
      }
      renderAllMapChrome();
      renderAllKpis();
      renderAllPresenceChips();
      renderAllTable();
    } else {
      // Same deal for a fund tab: only populate its State/County lists here if geo
      // was already loaded (e.g. this tab was opened after "All Funds" was already visited).
      if (state.fundStatesList) {
        populateFundStateFilterOptions(tabId);
        renderFundCountyFilterOptions(tabId);
      }
      renderFundMapChrome(tabId);
      renderFundKpis(tabId);
      renderFundTable(tabId);
      if (OVERLAP_ENABLED_FUNDS.indexOf(tabId) !== -1) renderFundOverlap(tabId);
    }
  }

  // ---------------------------------------------------------------
  // "All Funds" panel
  // ---------------------------------------------------------------
  function buildAllFundsPanel() {
    var panel = el(
      '<section class="uf-panel active" data-panel="all">' +
        '<div class="uf-section-heading">' +
          '<div><div class="uf-kicker" style="color:#1f9ac4">Overview</div><h2>All UN Funds &mdash; combined county presence</h2>' +
          '<p>Every county with at least one funded project across ' + joinWords(ORDER, 'and') + '. Toggle the map below between $ value and project count; each marker shows the fund mix for that county.</p></div>' +
        '</div>' +

        '<div class="uf-card uf-filter-bar">' +
          '<div class="uf-filter-group"><label for="all-filter-state">State</label><select id="all-filter-state"><option value="All">All States</option></select></div>' +
          '<div class="uf-filter-group"><label for="all-filter-county">County</label><select id="all-filter-county"><option value="All">All Counties</option></select></div>' +
          '<div class="uf-filter-group"><label for="all-filter-fund">UN Fund</label><select id="all-filter-fund"><option value="All">All Funds</option>' +
            ORDER.map(function (f) { return '<option value="' + f + '">' + f + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="uf-filter-group"><label for="all-filter-partner">Partner Organisation</label><select id="all-filter-partner"><option value="All">All Partners</option>' +
            allPartnersList().map(function (p) { return '<option value="' + p + '">' + p + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="uf-filter-group"><label>Shade &amp; rank by</label>' + metricToggleHtml('all') + '</div>' +
          '<button type="button" id="all-filter-reset" class="uf-mini-btn">Reset filters</button>' +
        '</div>' +

        '<div class="uf-kpi-grid" id="all-kpi-grid"></div>' +

        '<div class="uf-card">' +
          '<div class="uf-card-header"><div><div class="uf-kicker" style="color:#1f9ac4">Presence</div><h3 id="all-presence-title">Counties covered, by fund</h3><p id="all-presence-note" style="display:none"></p></div></div>' +
          '<div class="uf-presence-row" id="all-presence-row"></div>' +
        '</div>' +

        '<div class="uf-card uf-map-card" id="all-map-card">' +
          '<div class="uf-card-header"><div><h3 id="all-map-title">South Sudan &mdash; combined funds presence map</h3><p id="all-map-desc">Counties are shaded by total number of funded projects. Each dot is a fund-mix marker, sized by total projects. Click a county for details.</p>' +
            '<p id="all-map-unattributed-note" class="uf-unattributed-note" style="display:none" data-html2canvas-ignore="true"></p></div>' +
            '<div class="uf-card-actions" data-html2canvas-ignore="true">' +
              '<button id="all-map-reset" class="uf-mini-btn">Reset map</button>' +
              pdfButtonHtml('image', 'all-map-card', 'South Sudan — All Funds map', 'all-funds-map') +
            '</div>' +
          '</div>' +
          '<div class="uf-map" id="map-all"></div>' +
          '<div class="uf-map-legend-row">' +
            '<div class="uf-map-legend-group">' +
              '<h4>Fund identity</h4>' +
              '<div class="row-inline" id="all-legend-funds">' + ORDER.map(function (f) {
                return '<span class="uf-legend-fund-chip" data-fund="' + f + '"><span class="dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:' + META[f].color + '"></span>' + f + '</span>';
              }).join('') + '</div>' +
            '</div>' +
            shadingLegendHtml('Total projects (shading)', 'all-legend-shading-title') +
          '</div>' +
        '</div>' +

        '<div class="uf-card">' +
          '<div class="uf-card-header"><div><h3 id="all-table-title">Counties ranked by total projects</h3><p id="all-table-desc">Combined totals across all six funds, with fund mix and unique partner organisations per county.</p></div>' +
            pdfButtonHtml('table', 'all-table-wrap', 'All Funds — Counties ranked by total projects', 'all-funds-counties-ranked') +
          '</div>' +
          '<div class="uf-table-wrap" id="all-table-wrap"></div>' +
        '</div>' +
      '</section>'
    );

    panel.querySelector('#all-map-reset').addEventListener('click', function () {
      state.selected['all'] = null;
      renderAllSelected(null);
      resetMapZoom('all');
      drawMap('all');
    });

    panel.querySelector('#all-filter-state').addEventListener('change', function (e) {
      state.allFilters.state = e.target.value;
      renderCountyFilterOptions();
      refreshAllFundsView();
    });
    panel.querySelector('#all-filter-county').addEventListener('change', function (e) {
      state.allFilters.county = e.target.value;
      refreshAllFundsView();
    });
    panel.querySelector('#all-filter-fund').addEventListener('change', function (e) {
      state.allFilters.fund = e.target.value;
      renderCountyFilterOptions();
      refreshAllFundsView();
    });
    panel.querySelector('#all-filter-partner').addEventListener('change', function (e) {
      state.allFilters.partner = e.target.value;
      renderCountyFilterOptions();
      refreshAllFundsView();
    });
    panel.querySelector('#all-filter-reset').addEventListener('click', function () {
      state.allFilters = { state: 'All', county: 'All', fund: 'All', partner: 'All' };
      panel.querySelector('#all-filter-state').value = 'All';
      panel.querySelector('#all-filter-fund').value = 'All';
      panel.querySelector('#all-filter-partner').value = 'All';
      renderCountyFilterOptions();
      refreshAllFundsView();
    });

    wireMetricToggle(panel);

    return panel;
  }

  // Shared by every panel's "$ Value / Projects" toggle: flips state.metric,
  // re-paints every toggle instance on the page (each panel has its own copy
  // of the control) and re-renders every panel that's already been built —
  // not just the one currently visible — so switching tabs afterwards shows
  // KPIs/tables/overlap charts that already match the new metric instead of
  // going stale until their next filter change.
  function wireMetricToggle(panel) {
    panel.querySelectorAll('.uf-metric-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (state.metric === btn.dataset.metric) return;
        state.metric = btn.dataset.metric;
        document.querySelectorAll('.uf-metric-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.metric === state.metric);
        });
        refreshAllRenderedPanels();
      });
    });
  }

  function refreshAllRenderedPanels() {
    if (renderedPanels['all']) refreshAllFundsView();
    ORDER.forEach(function (fund) {
      if (renderedPanels[fund]) refreshFundView(fund);
    });
  }

  // ---------------------------------------------------------------
  // "All Funds" slicers: State / County / UN Fund / Partner Organisation
  // ---------------------------------------------------------------
  function allPartnersList() {
    var s = new Set();
    ORDER.forEach(function (fund) {
      (D.funds[fund] || []).forEach(function (r) { r.partners.forEach(function (p) { s.add(p); }); });
    });
    return Array.from(s).sort();
  }

  // Partner set for a county under the currently-selected UN Fund slicer
  // (combined across funds when the fund slicer is "All", else that one fund's partners).
  function countyPartnersForCurrentFund(norm) {
    var fund = state.allFilters.fund;
    if (fund === 'All') {
      var e = state.combined.get(norm);
      return e ? Array.from(e.partners) : [];
    }
    var row = state.fundIndex[fund].get(norm);
    return row ? row.partners : [];
  }

  // State / UN Fund / Partner checks — everything except the County slicer itself,
  // reused by the County dropdown so it only ever lists counties still reachable.
  function countyMatchesNonCountyFilters(norm) {
    var f = state.allFilters;
    if (f.state !== 'All') {
      var adm1 = state.countyState && state.countyState.get(norm);
      if (adm1 !== f.state) return false;
    }
    if (f.fund !== 'All') {
      var row = state.fundIndex[f.fund].get(norm);
      if (!row || !row.projects) return false;
    }
    if (f.partner !== 'All' && countyPartnersForCurrentFund(norm).indexOf(f.partner) === -1) return false;
    return true;
  }

  function countyInScope(norm) {
    if (!countyMatchesNonCountyFilters(norm)) return false;
    if (state.allFilters.county !== 'All' && norm !== state.allFilters.county) return false;
    return true;
  }

  // Rows in scope of the current State/County/UN Fund filters, one per county.
  // Carries both raw counts (`projects`) and $ amounts (`dollarValue`) plus
  // `metric` — whichever of the two is active — so callers don't need to know
  // which lens is selected.
  function computeAllFilteredRows() {
    var fund = state.allFilters.fund;
    var out = [];
    state.combined.forEach(function (entry, norm) {
      if (!countyInScope(norm)) return;
      if (fund === 'All') {
        if (entry.total > 0) {
          out.push({ norm: norm, county: entry.county, projects: entry.total, dollarValue: entry.totalValue, metric: metricOfEntry(entry), byFund: entry.byFund, byFundValue: entry.byFundValue, partners: entry.partners, provisional: entry.provisionalFunds.size > 0, projectIds: Array.from(entry.projectIds) });
        }
      } else {
        var row = state.fundIndex[fund].get(norm);
        if (row && row.projects > 0) {
          var byFundSingle = {}, byFundValueSingle = {};
          byFundSingle[fund] = row.projects;
          byFundValueSingle[fund] = row.value || 0;
          out.push({ norm: norm, county: entry.county, projects: row.projects, dollarValue: row.value || 0, metric: metricOf(row), byFund: byFundSingle, byFundValue: byFundValueSingle, partners: new Set(row.partners), provisional: !!row.provisional, projectIds: row.projectIds || [] });
        }
      }
    });
    out.sort(function (a, b) { return b.metric - a.metric; });
    return out;
  }

  function populateStateFilterOptions() {
    var sel = byId('all-filter-state');
    if (!sel || !state.statesList) return;
    var current = state.allFilters.state;
    sel.innerHTML = '<option value="All">All States</option>' + state.statesList.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
  }

  function renderCountyFilterOptions() {
    var sel = byId('all-filter-county');
    if (!sel || !state.countyState) return;
    var f = state.allFilters;
    var items = [];
    state.combined.forEach(function (entry, norm) {
      if (!countyMatchesNonCountyFilters(norm)) return;
      items.push({ norm: norm, name: entry.county });
    });
    items.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var stillValid = items.some(function (i) { return i.norm === f.county; });
    if (!stillValid) f.county = 'All';
    sel.innerHTML = '<option value="All">All Counties</option>' + items.map(function (i) {
      return '<option value="' + i.norm + '"' + (i.norm === f.county ? ' selected' : '') + '>' + i.name + '</option>';
    }).join('');
  }

  function populateAllFilters() {
    state.countyState = new Map();
    state.geo.features.forEach(function (f) {
      state.countyState.set(normalize(f.properties.ADM2_EN), f.properties.ADM1_EN);
    });
    var statesSet = new Set();
    state.combined.forEach(function (entry, norm) {
      var adm1 = state.countyState.get(norm);
      if (adm1) statesSet.add(adm1);
    });
    state.statesList = Array.from(statesSet).sort();
    populateStateFilterOptions();
    renderCountyFilterOptions();

    ORDER.forEach(function (fund) {
      populateFundFilters(fund);
      renderFundKpis(fund); // "States covered" needs countyState, just populated above
    });
  }

  function refreshAllFundsView() {
    renderAllMapChrome();
    renderAllKpis();
    renderAllPresenceChips();
    renderAllTable();
    drawMap('all');
  }

  function renderAllMapChrome() {
    var fund = state.allFilters.fund;
    var titleEl = byId('all-map-title');
    var descEl = byId('all-map-desc');
    var shadingEl = byId('all-legend-shading-title');
    var noteEl = byId('all-map-unattributed-note');
    var metricWord = metricNoun(false);
    if (fund === 'All') {
      if (titleEl) titleEl.textContent = 'South Sudan — combined fund presence map';
      if (descEl) descEl.textContent = 'Counties are shaded by total ' + metricWord + '. Each dot is a fund-mix marker, sized by total ' + metricWord + '. Click a county for details.';
      if (shadingEl) shadingEl.textContent = 'Total ' + metricWord + ' (shading)';
    } else {
      if (titleEl) titleEl.textContent = 'South Sudan — ' + fund + ' presence map';
      if (descEl) descEl.textContent = 'Counties are shaded by ' + fund + '-funded ' + metricWord + '. Click a county for details.';
      if (shadingEl) shadingEl.textContent = fund + ' ' + metricWord + ' (shading)';
    }
    if (noteEl) {
      var unattr = fund !== 'All' && META[fund].unattributed;
      if (unattr) {
        noteEl.style.display = '';
        noteEl.innerHTML = '&#9888; ' + fmtMoney(unattr.value) + ' of ' + fund + '’s total is nationwide / multi-state / not-yet-geocoded and is <strong>not shown on this map</strong> (included in fund totals only): ' +
          unattr.items.map(function (it) { return it.label + ' (' + fmtMoney(it.value) + ')'; }).join(', ') + '.';
      } else {
        noteEl.style.display = 'none';
        noteEl.innerHTML = '';
      }
    }
    document.querySelectorAll('#all-legend-funds .uf-legend-fund-chip').forEach(function (chip) {
      chip.classList.toggle('muted', fund !== 'All' && chip.dataset.fund !== fund);
    });
  }

  function renderAllKpis() {
    var box = byId('all-kpi-grid');
    if (!box) return;
    var rows = computeAllFilteredRows();
    var counties = rows.length;
    var activeFundsCount = state.allFilters.fund === 'All'
      ? unique(rows.reduce(function (a, r) { return a.concat(Object.keys(r.byFund)); }, [])).length
      : 1;
    var partners = new Set();
    rows.forEach(function (r) { r.partners.forEach(function (p) { partners.add(p); }); });
    // A project spanning several counties would be summed once per county it
    // touches (true for PBF/CERF/RSRTF) -- $ value is safe to sum because
    // each project's value is already split across its counties, but project
    // *count* needs the ID-union dedup instead of a raw sum.
    var totalMetric = state.metric === 'value'
      ? rows.reduce(function (sum, r) { return sum + r.dollarValue; }, 0)
      : distinctProjectCount(rows);

    var filterNote = filterSummaryText();
    box.innerHTML =
      kpiTile(fmtMetric(totalMetric), metricNoun(true) + ' mapped', filterNote || 'Across counties shown on the map') +
      kpiTile(counties, 'Counties reached', filterNote || 'Out of 79 counties') +
      kpiTile(activeFundsCount, 'UN funds', state.allFilters.fund === 'All' ? ORDER.join(', ') : state.allFilters.fund + ' only') +
      kpiTile(partners.size, 'Partner organisations', 'Unique implementing &amp; response partners');
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  function filterSummaryText() {
    var f = state.allFilters;
    var parts = [];
    if (f.state !== 'All') parts.push(f.state);
    if (f.county !== 'All') {
      var entry = state.combined.get(f.county);
      parts.push(entry ? entry.county : f.county);
    }
    if (f.partner !== 'All') parts.push(f.partner);
    return parts.length ? 'Filtered to ' + parts.join(' &rsaquo; ') : '';
  }

  function renderAllPresenceChips() {
    var box = byId('all-presence-row');
    if (!box) return;
    var f = state.allFilters;
    var titleEl = byId('all-presence-title');
    var noteEl = byId('all-presence-note');
    var filterIsOn = f.fund !== 'All';

    if (titleEl) titleEl.textContent = filterIsOn ? 'Overlap with ' + f.fund : 'Counties covered';
    if (noteEl) {
      if (filterIsOn) {
        noteEl.textContent = 'Of the counties currently in view, how many each fund also reaches alongside ' + f.fund + '.';
        noteEl.style.display = '';
      } else {
        noteEl.style.display = 'none';
      }
    }

    box.innerHTML = ORDER.map(function (fund) {
      var count = 0;
      state.fundIndex[fund].forEach(function (row, norm) {
        if (countyInScope(norm)) count++;
      });
      var isSelectedFund = f.fund === fund;
      var label = filterIsOn
        ? (isSelectedFund ? fund + ' counties (selected)' : 'also in ' + fund)
        : fund + ' counties';
      return '<div class="uf-presence-chip' + (isSelectedFund ? ' active' : '') + '"><span class="swatch-dot" style="background:' + META[fund].color + '"></span><div><strong>' + count + '</strong><span>' + label + '</span></div></div>';
    }).join('');
  }

  function renderAllTable() {
    var wrap = byId('all-table-wrap');
    if (!wrap) return;
    var rows = computeAllFilteredRows();
    var fund = state.allFilters.fund;
    var titleEl = byId('all-table-title');
    var descEl = byId('all-table-desc');

    if (fund === 'All') {
      if (titleEl) titleEl.textContent = 'Counties ranked by total ' + metricNoun(false);
      if (descEl) descEl.textContent = 'Combined totals across all six funds, with fund mix and unique partner organisations per county.';
      var bodyAll = rows.map(function (r) {
        return '<tr><td>' + countyLabel(r) + '</td><td class="num">' + fmtMoney(r.dollarValue) + '</td><td class="num">' + r.projects + '</td><td>' + fundChips(r.byFund, r.byFundValue) + '</td><td class="num">' + r.partners.size + '</td></tr>';
      }).join('');
      wrap.innerHTML = rows.length
        ? '<table class="uf-table"><thead><tr><th>County</th><th class="num">$ Value</th><th class="num">Projects</th><th>Funds present</th><th class="num">Partner orgs</th></tr></thead><tbody>' + bodyAll + '</tbody></table>'
        : '<div class="uf-drawer-empty" style="padding:18px">No counties match the current filters.</div>';
    } else {
      if (titleEl) titleEl.textContent = 'Counties ranked by ' + fund + ' ' + metricNoun(false);
      if (descEl) descEl.textContent = 'Counties with at least one ' + fund + '-funded project, with implementing / response partners.';
      var bodyFund = rows.map(function (r) {
        return '<tr><td>' + countyLabel(r) + '</td><td class="num">' + fmtMoney(r.dollarValue) + '</td><td class="num">' + r.projects + '</td><td>' + partnerChips(r.partners) + '</td></tr>';
      }).join('');
      wrap.innerHTML = rows.length
        ? '<table class="uf-table"><thead><tr><th>County</th><th class="num">$ Value</th><th class="num">Projects</th><th>Partner organisations</th></tr></thead><tbody>' + bodyFund + '</tbody></table>'
        : '<div class="uf-drawer-empty" style="padding:18px">No counties match the current filters.</div>';
    }
  }

  // County name with a small "provisional" marker for rows built from an
  // estimated split (RSRTF's area->county mapping, CERF's even county split)
  // rather than a directly reported county-level figure.
  function countyLabel(r) {
    return r.county + (r.provisional ? ' <span class="uf-provisional-badge" title="Estimated split — pending confirmation">est.</span>' : '');
  }

  function renderAllSelected(entry) {
    if (!entry) { toggleDrawer('all', false); return; }
    var box = byId('all-selected');
    if (!box) return;
    var provisionalNote = entry.provisionalFunds.size
      ? '<div class="uf-mini-metric wide uf-provisional-note">&#9888; Includes provisional/estimated figures for ' + Array.from(entry.provisionalFunds).join(', ') + ' — pending confirmation.</div>'
      : '';
    box.innerHTML =
      '<div class="uf-mini-metric wide"><span>County</span><strong>' + entry.county + '</strong></div>' +
      '<div class="uf-mini-metric"><span>Total $ value</span><strong>' + fmtMoney(entry.totalValue) + '</strong></div>' +
      '<div class="uf-mini-metric"><span>Total projects</span><strong>' + entry.total + '</strong></div>' +
      '<div class="uf-mini-metric wide"><span>Funds present</span><strong style="font-size:.9rem">' + fundChips(entry.byFund, entry.byFundValue) + '</strong></div>' +
      '<div class="uf-mini-metric wide"><span>Partner organisations (' + entry.partners.size + ')</span><strong style="font-size:.9rem">' + partnerChips(entry.partners) + '</strong></div>' +
      provisionalNote;
    toggleDrawer('all', true);
  }

  // Drawer content for the "All Funds" map when the UN Fund slicer is set to one specific fund.
  function renderAllSelectedFund(fund, row) {
    if (!row) { toggleDrawer('all', false); return; }
    var box = byId('all-selected');
    if (!box) return;
    var provisionalNote = row.provisional
      ? '<div class="uf-mini-metric wide uf-provisional-note">&#9888; Estimated split — pending ' + fund + ' confirmation.</div>'
      : '';
    box.innerHTML =
      '<div class="uf-mini-metric wide"><span>County</span><strong>' + row.county + '</strong></div>' +
      '<div class="uf-mini-metric"><span>' + fund + ' $ value</span><strong>' + fmtMoney(row.value || 0) + '</strong></div>' +
      '<div class="uf-mini-metric"><span>' + fund + ' projects</span><strong>' + row.projects + '</strong></div>' +
      '<div class="uf-mini-metric wide"><span>Partner organisations</span><strong style="font-size:.9rem">' + partnerChips(row.partners) + '</strong></div>' +
      provisionalNote;
    toggleDrawer('all', true);
  }

  function toggleDrawer(tabId, open) {
    var drawer = byId(tabId + '-drawer');
    if (drawer) drawer.classList.toggle('open', !!open);
  }

  // ---------------------------------------------------------------
  // Per-fund panel
  // ---------------------------------------------------------------
  function kpiTile(value, label, sub) {
    return '<div class="uf-kpi"><div class="uf-kpi-label">' + label + '</div><div class="uf-kpi-value">' + value + '</div><div class="uf-kpi-sub">' + (sub || '') + '</div></div>';
  }

  function buildFundPanel(fund) {
    var m = META[fund];

    var panel = el(
      '<section class="uf-panel" data-panel="' + fund + '">' +
        '<div class="uf-fund-banner">' +
          '<div class="badge" style="background:' + m.color + '">' + fund + '</div>' +
          '<div><div class="type">' + m.type + '</div><h2>' + m.fullName + '</h2>' +
          (PROVISIONAL_SPLIT_FUNDS.indexOf(fund) !== -1 ?
            '<p class="uf-provisional-note" style="margin-top:6px">&#9888; ' + fund + '’s county-level breakdown below is a provisional estimate (even split of each project’s value across its described target counties), pending confirmation from ' + fund + '.</p>'
            : '') +
          '</div>' +
        '</div>' +

        '<div class="uf-card uf-filter-bar">' +
          '<div class="uf-filter-group"><label for="' + fund + '-filter-state">State</label><select id="' + fund + '-filter-state"><option value="All">All States</option></select></div>' +
          '<div class="uf-filter-group"><label for="' + fund + '-filter-county">County</label><select id="' + fund + '-filter-county"><option value="All">All Counties</option></select></div>' +
          '<div class="uf-filter-group"><label for="' + fund + '-filter-partner">Partner Organisation</label><select id="' + fund + '-filter-partner"><option value="All">All Partners</option>' +
            fundPartnersList(fund).map(function (p) { return '<option value="' + p + '">' + p + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="uf-filter-group"><label>Shade &amp; rank by</label>' + metricToggleHtml(fund) + '</div>' +
          '<button type="button" id="' + fund + '-filter-reset" class="uf-mini-btn">Reset filters</button>' +
        '</div>' +

        '<div class="uf-kpi-grid" id="' + fund + '-kpi-grid"></div>' +

        '<div class="uf-card uf-map-card" id="' + fund + '-map-card">' +
          '<div class="uf-card-header"><div><h3 id="' + fund + '-map-title">' + fund + ' &mdash; county presence map</h3><p id="' + fund + '-map-desc">Counties are shaded by number of ' + fund + '-funded projects. Click a county for details.</p>' +
            '<p id="' + fund + '-map-unattributed-note" class="uf-unattributed-note" style="display:none" data-html2canvas-ignore="true"></p></div>' +
            '<div class="uf-card-actions" data-html2canvas-ignore="true">' +
              '<button id="' + fund + '-map-reset" class="uf-mini-btn">Reset map</button>' +
              pdfButtonHtml('image', fund + '-map-card', fund + ' — county presence map', fund.toLowerCase() + '-county-map') +
            '</div>' +
          '</div>' +
          '<div class="uf-map" id="map-' + fund + '"></div>' +
          '<div class="uf-map-legend-row">' +
            shadingLegendHtml('Projects (shading)', fund + '-legend-shading-title') +
          '</div>' +
        '</div>' +

        (OVERLAP_ENABLED_FUNDS.indexOf(fund) !== -1 ?
          '<div class="uf-card" id="' + fund + '-overlap-card">' +
            '<div class="uf-card-header"><div><h3>' + fund + ' &mdash; overlap with other funds</h3><p id="' + fund + '-overlap-desc">Where ' + fund + ' is also reached by ' + joinWithOr(ORDER.filter(function (f) { return f !== fund; })) + ', and how much each of those funds contributes there. Ranked by amount.</p></div>' +
              '<div class="uf-card-actions" data-html2canvas-ignore="true">' +
                pdfButtonHtml('image', fund + '-overlap-card', fund + ' — overlap with other funds', fund.toLowerCase() + '-overlap-chart') +
              '</div>' +
            '</div>' +
            '<div id="' + fund + '-overlap-wrap"></div>' +
          '</div>'
        : '') +

        '<div class="uf-card">' +
          '<div class="uf-card-header"><div><h3 id="' + fund + '-table-title">Counties ranked by ' + fund + ' projects</h3><p>All counties with at least one ' + fund + '-funded project, with implementing / response partners.</p></div>' +
            pdfButtonHtml('table', fund + '-table-wrap', fund + ' — Counties ranked by projects', fund.toLowerCase() + '-counties-ranked') +
          '</div>' +
          '<div class="uf-table-wrap" id="' + fund + '-table-wrap"></div>' +
        '</div>' +
      '</section>'
    );

    panel.querySelector('#' + fund + '-map-reset').addEventListener('click', function () {
      state.selected[fund] = null;
      renderFundSelected(fund, null);
      resetMapZoom(fund);
      drawMap(fund);
    });

    panel.querySelector('#' + fund + '-filter-state').addEventListener('change', function (e) {
      state.fundFilters[fund].state = e.target.value;
      renderFundCountyFilterOptions(fund);
      refreshFundView(fund);
    });
    panel.querySelector('#' + fund + '-filter-county').addEventListener('change', function (e) {
      state.fundFilters[fund].county = e.target.value;
      refreshFundView(fund);
    });
    panel.querySelector('#' + fund + '-filter-partner').addEventListener('change', function (e) {
      state.fundFilters[fund].partner = e.target.value;
      renderFundCountyFilterOptions(fund);
      refreshFundView(fund);
    });
    panel.querySelector('#' + fund + '-filter-reset').addEventListener('click', function () {
      state.fundFilters[fund] = { state: 'All', county: 'All', partner: 'All' };
      panel.querySelector('#' + fund + '-filter-state').value = 'All';
      panel.querySelector('#' + fund + '-filter-partner').value = 'All';
      renderFundCountyFilterOptions(fund);
      refreshFundView(fund);
    });

    if (OVERLAP_ENABLED_FUNDS.indexOf(fund) !== -1) {
      // Event delegation: the legend chips are re-created on every renderFundOverlap()
      // call, but this wrapper element itself never is — so bind once, here.
      panel.querySelector('#' + fund + '-overlap-wrap').addEventListener('click', function (e) {
        var legendChip = e.target.closest('.uf-legend-fund-chip.clickable');
        if (legendChip) {
          var clickedFund = legendChip.dataset.fund;
          state.overlapFocus[fund] = (state.overlapFocus[fund] === clickedFund) ? null : clickedFund;
          renderFundOverlap(fund);
        }
      });
    }

    wireMetricToggle(panel);

    renderFundSelected(fund, null);
    return panel;
  }

  // ---------------------------------------------------------------
  // Per-fund page slicers: State / County / Partner Organisation
  // ---------------------------------------------------------------
  function fundPartnersList(fund) {
    var s = new Set();
    (D.funds[fund] || []).forEach(function (r) { r.partners.forEach(function (p) { s.add(p); }); });
    return Array.from(s).sort();
  }

  function fundCountyMatchesNonCountyFilters(fund, norm) {
    var f = state.fundFilters[fund];
    if (f.state !== 'All') {
      var adm1 = state.countyState && state.countyState.get(norm);
      if (adm1 !== f.state) return false;
    }
    if (f.partner !== 'All') {
      var row = state.fundIndex[fund].get(norm);
      var partners = row ? row.partners : [];
      if (partners.indexOf(f.partner) === -1) return false;
    }
    return true;
  }

  function fundCountyInScope(fund, norm) {
    if (!fundCountyMatchesNonCountyFilters(fund, norm)) return false;
    var county = state.fundFilters[fund].county;
    return county === 'All' || norm === county;
  }

  function computeFundFilteredRows(fund) {
    var out = [];
    state.fundIndex[fund].forEach(function (row, norm) {
      if (!fundCountyInScope(fund, norm)) return;
      out.push({ norm: norm, county: row.county, projects: row.projects, dollarValue: row.value || 0, metric: metricOf(row), partners: row.partners, provisional: !!row.provisional, projectIds: row.projectIds || [] });
    });
    out.sort(function (a, b) { return b.metric - a.metric; });
    return out;
  }

  function computeFundStatesList(fund) {
    var set = new Set();
    state.fundIndex[fund].forEach(function (row, norm) {
      var adm1 = state.countyState.get(norm);
      if (adm1) set.add(adm1);
    });
    return Array.from(set).sort();
  }

  function populateFundStateFilterOptions(fund) {
    var sel = byId(fund + '-filter-state');
    if (!sel || !state.fundStatesList) return;
    var list = state.fundStatesList[fund] || [];
    var current = state.fundFilters[fund].state;
    sel.innerHTML = '<option value="All">All States</option>' + list.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
  }

  function renderFundCountyFilterOptions(fund) {
    var sel = byId(fund + '-filter-county');
    if (!sel || !state.countyState) return;
    var f = state.fundFilters[fund];
    var items = [];
    state.fundIndex[fund].forEach(function (row, norm) {
      if (!fundCountyMatchesNonCountyFilters(fund, norm)) return;
      items.push({ norm: norm, name: row.county });
    });
    items.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var stillValid = items.some(function (i) { return i.norm === f.county; });
    if (!stillValid) f.county = 'All';
    sel.innerHTML = '<option value="All">All Counties</option>' + items.map(function (i) {
      return '<option value="' + i.norm + '"' + (i.norm === f.county ? ' selected' : '') + '>' + i.name + '</option>';
    }).join('');
  }

  function populateFundFilters(fund) {
    if (!state.fundStatesList) state.fundStatesList = {};
    state.fundStatesList[fund] = computeFundStatesList(fund);
    populateFundStateFilterOptions(fund);
    renderFundCountyFilterOptions(fund);
  }

  function fundFilterSummaryText(fund) {
    var f = state.fundFilters[fund];
    var parts = [];
    if (f.state !== 'All') parts.push(f.state);
    if (f.county !== 'All') {
      var row = state.fundIndex[fund].get(f.county);
      parts.push(row ? row.county : f.county);
    }
    if (f.partner !== 'All') parts.push(f.partner);
    return parts.length ? 'Filtered to ' + parts.join(' &rsaquo; ') : '';
  }

  function renderFundKpis(fund) {
    var box = byId(fund + '-kpi-grid');
    if (!box) return;
    var rows = computeFundFilteredRows(fund);
    var partners = new Set();
    var states = new Set();
    var mappedValue = 0;
    rows.forEach(function (r) {
      r.partners.forEach(function (p) { partners.add(p); });
      var adm1 = state.countyState && state.countyState.get(r.norm);
      if (adm1) states.add(adm1);
      mappedValue += r.dollarValue;
    });
    var mappedProjects = distinctProjectCount(rows);
    var top = rows.reduce(function (a, r) { return (!a || r.metric > a.metric) ? r : a; }, null);
    var note = fundFilterSummaryText(fund);
    var isFiltered = !!note;
    var u = META[fund].unattributed;

    // Unfiltered: headline = the true fund-wide total (ties exactly to Master
    // Data), with a note on how much of it isn't on the county map below.
    // Filtered (state/county/partner): meta-level totals aren't meaningful
    // under a filter, so fall back to the filtered/mapped sum instead —
    // unattributed amounts are never tied to a specific state/county anyway.
    var totalValue = isFiltered ? mappedValue : META[fund].totalValue;
    var totalProjects = isFiltered ? mappedProjects : META[fund].totalProjects;
    var valueSub = isFiltered ? note : (u ? (fmtMoney(u.value) + ' (' + u.projects + ' project' + (u.projects === 1 ? '' : 's') + ') not on county map below') : 'Out of 79 counties');
    var projectsSub = isFiltered ? note : (u ? (u.projects + ' of these not on county map below (nationwide/unmapped)') : 'All mapped to counties below');

    box.innerHTML =
      kpiTile(fmtMoney(totalValue), 'Total $ value', valueSub) +
      kpiTile(totalProjects, 'Total projects', projectsSub) +
      kpiTile(states.size, 'States covered', 'Out of 10 states') +
      kpiTile(partners.size, 'Partner organisations', 'Unique implementing partners') +
      kpiTile(top ? top.county : '&mdash;', 'Top county', top ? fmtMetric(top.metric) : '');
  }

  function renderFundTable(fund) {
    var wrap = byId(fund + '-table-wrap');
    if (!wrap) return;
    var rows = computeFundFilteredRows(fund);
    var titleEl = byId(fund + '-table-title');
    if (titleEl) titleEl.textContent = 'Counties ranked by ' + fund + ' ' + metricNoun(false);
    var body = rows.map(function (r) {
      return '<tr><td>' + countyLabel(r) + '</td><td class="num">' + fmtMoney(r.dollarValue) + '</td><td class="num">' + r.projects + '</td><td>' + partnerChips(r.partners) + '</td></tr>';
    }).join('');
    wrap.innerHTML = rows.length
      ? '<table class="uf-table"><thead><tr><th>County</th><th class="num">$ Value</th><th class="num">Projects</th><th>Partner organisations</th></tr></thead><tbody>' + body + '</tbody></table>'
      : '<div class="uf-drawer-empty" style="padding:18px">No counties match the current filters.</div>';
  }

  // Funds that show the cross-fund county-overlap chart on their own page.
  // Piloted on SSHF first, now rolled out to all funds.
  var OVERLAP_ENABLED_FUNDS = ORDER.slice();

  // Funds whose county-level $ figures are an even split across an estimated
  // set of target counties rather than a directly reported per-county amount —
  // RSRTF (project-phase labels mapped to counties from a provisional area
  // description) and CERF (each grant's prose county list split evenly).
  // Flagged in the UI wherever these funds' county data is shown.
  var PROVISIONAL_SPLIT_FUNDS = ['RSRTF', 'CERF'];

  // "CERF, PBF, RSRTF or WPHF" — comma-joined list with a trailing conjunction ("or"/"and").
  function joinWords(list, conjunction) {
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' ' + conjunction + ' ' + list[list.length - 1];
  }
  function joinWithOr(list) { return joinWords(list, 'or'); }

  // Counties where `fund` and another fund are both present, one group per county:
  // {label, selfMetric, overlaps:[{fund,metric}]}. Respects the page's own filters
  // and the active Projects/$ Value metric.
  function computeFundCountyOverlapGroups(fund) {
    var otherFunds = ORDER.filter(function (f) { return f !== fund; });
    var groups = [];
    computeFundFilteredRows(fund).forEach(function (r) {
      var overlaps = otherFunds.map(function (f) {
        var oRow = state.fundIndex[f].get(r.norm);
        return oRow && oRow.projects > 0 ? { fund: f, metric: metricOf(oRow) } : null;
      }).filter(function (o) { return o; });
      if (overlaps.length) groups.push({ label: r.county, selfMetric: r.metric, overlaps: overlaps });
    });
    return groups;
  }

  // Legend for the overlap chart: fund's own chip is static; every other fund that
  // appears anywhere in the (unfiltered-by-focus) data is clickable to isolate it.
  function overlapLegendHtml(fund, presentFunds, focusFund) {
    var chips = ['<span class="uf-legend-fund-chip"><span class="dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:' + META[fund].color + '"></span>' + fund + '</span>'].concat(
      presentFunds.map(function (f) {
        var isActive = focusFund === f;
        var classes = 'uf-legend-fund-chip clickable' + (isActive ? ' active' : (focusFund ? ' muted' : ''));
        return '<span class="' + classes + '" data-fund="' + f + '"><span class="dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:' + META[f].color + '"></span>' + f + '</span>';
      })
    );
    return '<div class="uf-overlap-legend">' + chips.join('') + '</div>';
  }

  function buildOverlapBarsHtml(fund, groups, emptyNote) {
    if (!groups.length) {
      return '<div class="uf-drawer-empty" style="padding:18px 0 4px">' + emptyNote + '</div>';
    }

    var sorted = groups.slice().sort(function (a, b) {
      var aMax = Math.max.apply(null, a.overlaps.map(function (o) { return o.metric; }));
      var bMax = Math.max.apply(null, b.overlaps.map(function (o) { return o.metric; }));
      return bMax - aMax || b.selfMetric - a.selfMetric;
    });

    var maxVal = sorted.reduce(function (m, g) {
      return Math.max(m, g.selfMetric, Math.max.apply(null, g.overlaps.map(function (o) { return o.metric; })));
    }, 1);

    // Scale into a fixed band (not 0-100%) so there's always room after the fill
    // for the value label to sit right at its tip — never a fixed right-hand column.
    function barRow(label, color, value) {
      var pct = 6 + (value / maxVal) * 80;
      var gradient = 'linear-gradient(90deg,' + lightenHex(color, 28) + ',' + color + ')';
      return (
        '<div class="uf-overlap-bar-row">' +
          '<span class="uf-overlap-bar-tag" style="background:' + color + '">' + label + '</span>' +
          '<div class="uf-overlap-bar-track">' +
            '<div class="uf-overlap-bar-fill" style="width:' + pct + '%;background:' + gradient + '"></div>' +
            '<span class="uf-overlap-bar-value">' + fmtMetricCompact(value) + '</span>' +
          '</div>' +
        '</div>'
      );
    }

    var groupsHtml = sorted.map(function (g) {
      var rows = barRow(fund, META[fund].color, g.selfMetric) +
        g.overlaps.map(function (o) { return barRow(o.fund, META[o.fund].color, o.metric); }).join('');
      return '<div class="uf-overlap-group"><div class="uf-overlap-group-label">' + g.label + '</div>' + rows + '</div>';
    }).join('');

    return '<div class="uf-overlap-bars">' + groupsHtml + '</div>';
  }

  // Restricts each group's overlaps to just the focused fund (dropping groups left
  // with none) — used when a legend chip is clicked to isolate one fund's comparison.
  function applyOverlapFocus(groups, focusFund) {
    if (!focusFund) return groups;
    return groups.map(function (g) {
      var overlaps = g.overlaps.filter(function (o) { return o.fund === focusFund; });
      return overlaps.length ? { label: g.label, selfProjects: g.selfProjects, overlaps: overlaps } : null;
    }).filter(function (g) { return g; });
  }

  function renderFundOverlap(fund) {
    var box = byId(fund + '-overlap-wrap');
    if (!box) return;

    var descEl = byId(fund + '-overlap-desc');
    if (descEl) {
      descEl.textContent = 'Where ' + fund + ' is also reached by ' + joinWithOr(ORDER.filter(function (f) { return f !== fund; })) + ', and how much each of those funds contributes there (' + metricNoun(false) + '). Ranked by amount.';
    }

    // County-level only: a project can span multiple counties within the same state,
    // so summing county counts up to a state total would double-count it — the same
    // reason "Total projects" was dropped as a KPI. County totals don't have that problem.
    var rawGroups = computeFundCountyOverlapGroups(fund);

    // Legend lists every fund present in the *unfiltered* data, so a focused-away
    // fund's chip stays visible and clickable to switch focus or clear it.
    var presentFunds = [];
    rawGroups.forEach(function (g) { g.overlaps.forEach(function (o) { if (presentFunds.indexOf(o.fund) === -1) presentFunds.push(o.fund); }); });
    presentFunds = ORDER.filter(function (f) { return presentFunds.indexOf(f) !== -1; });
    var focus = state.overlapFocus[fund];
    if (focus && presentFunds.indexOf(focus) === -1) focus = state.overlapFocus[fund] = null; // focus fund no longer present under current filters
    var legend = overlapLegendHtml(fund, presentFunds, focus);

    var displayGroups = applyOverlapFocus(rawGroups, focus);
    var filterNote = fundFilterSummaryText(fund) ? ' under the current filters' : '';
    var against = focus ? focus : 'another fund';
    var emptyNote = 'No counties currently show overlap between ' + fund + ' and ' + against + filterNote + '.';

    box.innerHTML = legend + buildOverlapBarsHtml(fund, displayGroups, emptyNote);
  }

  function renderFundMapChrome(fund) {
    var titleEl = byId(fund + '-map-title');
    var descEl = byId(fund + '-map-desc');
    var shadingEl = byId(fund + '-legend-shading-title');
    var noteEl = byId(fund + '-map-unattributed-note');
    var metricWord = metricNoun(false);
    if (titleEl) titleEl.textContent = fund + ' — county presence map';
    if (descEl) descEl.textContent = 'Counties are shaded by ' + fund + '-funded ' + metricWord + '. Click a county for details.';
    if (shadingEl) shadingEl.textContent = metricNoun(true) + ' (shading)';
    if (noteEl) {
      var unattr = META[fund].unattributed;
      if (unattr) {
        noteEl.style.display = '';
        noteEl.innerHTML = '&#9888; ' + fmtMoney(unattr.value) + ' of ' + fund + '’s total is nationwide / multi-state / not-yet-geocoded and is <strong>not shown on this map</strong> (included in the KPI/fund totals only): ' +
          unattr.items.map(function (it) { return it.label + ' (' + fmtMoney(it.value) + ')'; }).join(', ') + '.';
      } else {
        noteEl.style.display = 'none';
        noteEl.innerHTML = '';
      }
    }
  }

  function refreshFundView(fund) {
    renderFundMapChrome(fund);
    renderFundKpis(fund);
    renderFundTable(fund);
    if (OVERLAP_ENABLED_FUNDS.indexOf(fund) !== -1) renderFundOverlap(fund);
    drawMap(fund);
  }

  function renderFundSelected(fund, row) {
    if (!row) { toggleDrawer(fund, false); return; }
    var box = byId(fund + '-selected');
    if (!box) return;
    var provisionalNote = row.provisional
      ? '<div class="uf-mini-metric wide uf-provisional-note">&#9888; Estimated split — pending ' + fund + ' confirmation.</div>'
      : '';
    box.innerHTML =
      '<div class="uf-mini-metric wide"><span>County</span><strong>' + row.county + '</strong></div>' +
      '<div class="uf-mini-metric"><span>' + fund + ' $ value</span><strong>' + fmtMoney(row.value || 0) + '</strong></div>' +
      '<div class="uf-mini-metric"><span>' + fund + ' projects</span><strong>' + row.projects + '</strong></div>' +
      '<div class="uf-mini-metric wide"><span>Partner organisations</span><strong style="font-size:.9rem">' + partnerChips(row.partners) + '</strong></div>' +
      provisionalNote;
    toggleDrawer(fund, true);
  }

  // ---------------------------------------------------------------
  // Map rendering (shared, d3 + topojson)
  // ---------------------------------------------------------------
  function seqColor(value, maxVal) {
    if (!value) return SEQ_NONE;
    if (maxVal <= 0) return SEQ_NONE;
    var scale = d3.scaleQuantize().domain([1, maxVal]).range(SEQ_STEPS);
    return scale(value);
  }

  function drawMap(tabId) {
    if (!state.geo) return;
    var containerId = tabId === 'all' ? 'map-all' : 'map-' + tabId;
    var container = byId(containerId);
    if (!container) return;

    if (!container.querySelector('svg')) {
      container.innerHTML =
        '<svg class="uf-shape-map" role="img" aria-label="South Sudan county map"><g class="uf-zoom-layer"></g></svg>' +
        '<div class="uf-map-tooltip"></div>' +
        '<div class="uf-map-zoom-controls" data-html2canvas-ignore="true">' +
          '<button type="button" class="uf-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>' +
          '<button type="button" class="uf-zoom-btn" data-zoom="out" aria-label="Zoom out">&minus;</button>' +
        '</div>' +
        '<aside class="uf-drawer" id="' + tabId + '-drawer">' +
          '<button type="button" class="uf-drawer-close" aria-label="Close county detail">&times;</button>' +
          '<h3>Selected county</h3>' +
          '<div class="uf-mini-metrics" id="' + tabId + '-selected"><p class="uf-drawer-empty">Click a county on the map to see its detail.</p></div>' +
        '</aside>';

      var drawerCloseBtn = container.querySelector('.uf-drawer-close');
      drawerCloseBtn.addEventListener('click', function () {
        state.selected[tabId] = null;
        if (tabId === 'all') { renderAllSelected(null); } else { renderFundSelected(tabId, null); }
        drawMap(tabId);
      });

      // Scroll-to-zoom / drag-to-pan on a dedicated group, so re-rendering the map's
      // paths/labels (on every filter change) never disturbs the current zoom state.
      var svgSelSetup = d3.select(container).select('svg');
      var zoomLayerSetup = svgSelSetup.select('g.uf-zoom-layer');
      var zoomBehavior = d3.zoom()
        .scaleExtent([1, 8])
        .on('zoom', function (event) { zoomLayerSetup.attr('transform', event.transform); });
      svgSelSetup.call(zoomBehavior);
      container.__zoom = { behavior: zoomBehavior, svgSel: svgSelSetup };

      container.querySelectorAll('.uf-zoom-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var factor = btn.dataset.zoom === 'in' ? 1.4 : 1 / 1.4;
          svgSelSetup.transition().duration(200).call(zoomBehavior.scaleBy, factor);
        });
      });
    }

    var width = Math.max(container.clientWidth || 700, 320);
    var height = Math.max(container.clientHeight || 520, 320);
    var svg = d3.select(container).select('svg').attr('viewBox', '0 0 ' + width + ' ' + height);
    var g = svg.select('g.uf-zoom-layer');
    var projection = d3.geoMercator().fitExtent([[14, 14], [width - 14, height - 14]], state.geo);
    var path = d3.geoPath(projection);
    var tooltip = container.querySelector('.uf-map-tooltip');

    // value + lookup per county for this tab (the "All Funds" tab also respects the State/County/UN Fund slicers)
    var allFund = tabId === 'all' ? state.allFilters.fund : null;
    var valueFor = function (normName) {
      if (tabId === 'all') {
        if (allFund !== 'All') {
          var fundRow = state.fundIndex[allFund].get(normName);
          return fundRow ? metricOf(fundRow) : 0;
        }
        var e = state.combined.get(normName);
        return e ? metricOfEntry(e) : 0;
      }
      var row = state.fundIndex[tabId].get(normName);
      return row ? metricOf(row) : 0;
    };
    var inScope = function (normName) {
      return tabId === 'all' ? countyInScope(normName) : fundCountyInScope(tabId, normName);
    };
    var maxVal = 0;
    state.geo.features.forEach(function (f) {
      var norm = normalize(f.properties.ADM2_EN);
      if (!inScope(norm)) return;
      var v = valueFor(norm);
      if (v > maxVal) maxVal = v;
    });

    var selectedName = state.selected[tabId] || null;

    var paths = g.selectAll('path.uf-county-shape').data(state.geo.features, function (d) { return d.properties.ADM2_PCODE; });
    paths.join(
      function (enter) { return enter.append('path').attr('class', 'uf-county-shape'); },
      function (update) { return update; },
      function (exit) { return exit.remove(); }
    )
      .attr('d', path)
      .attr('fill', function (d) {
        var norm = normalize(d.properties.ADM2_EN);
        if (!inScope(norm)) return '#f2f4f7';
        return seqColor(valueFor(norm), maxVal);
      })
      .attr('stroke', function (d) {
        var norm = normalize(d.properties.ADM2_EN);
        if (selectedName && norm === selectedName) return '#062f46';
        if (!inScope(norm)) return '#e3e7ee';
        var v = valueFor(norm);
        return v > 0 ? '#ffffff' : '#c9d4e0';
      })
      .attr('stroke-width', function (d) {
        var norm = normalize(d.properties.ADM2_EN);
        if (selectedName && norm === selectedName) return 2.4;
        if (!inScope(norm)) return 0.8;
        return valueFor(norm) > 0 ? 1 : 0.8;
      })
      .attr('stroke-dasharray', function (d) {
        var norm = normalize(d.properties.ADM2_EN);
        if (selectedName && norm === selectedName) return null;
        if (!inScope(norm)) return null;
        return valueFor(norm) > 0 ? null : '4 3';
      })
      .attr('opacity', function (d) {
        return inScope(normalize(d.properties.ADM2_EN)) ? 1 : .45;
      })
      .style('cursor', 'pointer')
      .on('mousemove', function (event, d) {
        if (!tooltip) return;
        var name = d.properties.ADM2_EN;
        var norm = normalize(name);
        tooltip.style.display = 'block';
        tooltip.innerHTML = tooltipHtml(tabId, name, norm);
        positionTooltip(tooltip, event, container);
      })
      .on('mouseleave', function () { if (tooltip) tooltip.style.display = 'none'; })
      .on('click', function (event, d) {
        selectCounty(tabId, normalize(d.properties.ADM2_EN));
      });

    // Every map now shows a value marker per county (a multi-color pie for the
    // combined "All Funds" view, a solid single-color circle for one specific fund) —
    // sized on its own scale, with the county name pushed clear of its own marker so
    // text never sits behind the circle.
    var effectiveFund = tabId === 'all' ? allFund : tabId;
    var glyphRadius = effectiveFund === 'All' ? pieRadiusScale() : d3.scaleSqrt().domain([1, maxVal || 1]).range([6, 22]);
    var labelData = state.geo.features
      .map(function (f) {
        var norm = normalize(f.properties.ADM2_EN);
        var v = valueFor(norm);
        var r = v > 0 ? glyphRadius(v) : 0;
        var name = f.properties.ADM2_EN;
        var c = path.centroid(f);
        return { name: name, norm: norm, v: v, r: r, cx: c[0], cy: c[1], x: c[0], y: c[1] - r - 7 };
      })
      .filter(function (d) { return d.v > 0 && inScope(d.norm) && !isNaN(d.x) && !isNaN(d.y); });

    // Every marker is a solid obstacle too — not just other labels — so a small
    // county's name never gets swallowed by a large neighboring county's marker.
    var glyphObstacles = labelData.filter(function (d) { return d.r > 0; });
    var visibleLabels = declutterLabels(labelData, glyphObstacles);

    g.selectAll('text.uf-county-label').data(visibleLabels, function (d) { return d.name; }).join('text')
      .attr('class', 'uf-county-label')
      .attr('x', function (d) { return d.x; })
      .attr('y', function (d) { return d.y; })
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'auto')
      .text(function (d) { return d.name; });

    if (effectiveFund === 'All') {
      g.selectAll('g.uf-value-glyph').remove();
      drawPieGlyphs(g, path, glyphRadius);
    } else {
      g.selectAll('g.uf-pie-glyph').remove();
      drawValueGlyphs(g, path, effectiveFund, valueFor, glyphRadius, inScope, tabId);
    }
  }

  // Greedy label decluttering: place the highest-value counties' names first, and
  // drop any label whose estimated bounding box would overlap one already placed.
  // Dropped labels are still reachable via hover/click — this only avoids garbled text.
  var LABEL_FONT_SIZE = 8.6;
  var LABEL_CHAR_WIDTH = 0.62; // approx average glyph width for the bold condensed label font
  var LABEL_PAD = 3;

  function boxOverlapsBox(box, p) {
    return !(box.x2 + LABEL_PAD < p.x1 || box.x1 - LABEL_PAD > p.x2 || box.y2 + LABEL_PAD < p.y1 || box.y1 - LABEL_PAD > p.y2);
  }

  function circleOverlapsBox(cx, cy, r, box) {
    var closestX = Math.max(box.x1, Math.min(cx, box.x2));
    var closestY = Math.max(box.y1, Math.min(cy, box.y2));
    var dx = cx - closestX, dy = cy - closestY;
    return (dx * dx + dy * dy) < (r + LABEL_PAD) * (r + LABEL_PAD);
  }

  function declutterLabels(items, obstacleCircles) {
    var sorted = items.slice().sort(function (a, b) { return b.v - a.v; });
    var placed = [];
    var kept = [];
    sorted.forEach(function (d) {
      var w = d.name.length * LABEL_FONT_SIZE * LABEL_CHAR_WIDTH;
      var h = LABEL_FONT_SIZE * 1.3;
      var box = { x1: d.x - w / 2, x2: d.x + w / 2, y1: d.y - h / 2, y2: d.y + h / 2 };

      var overlapsLabel = placed.some(function (p) { return boxOverlapsBox(box, p); });
      var overlapsGlyph = (obstacleCircles || []).some(function (o) {
        return o.norm !== d.norm && circleOverlapsBox(o.cx, o.cy, o.r, box);
      });

      if (!overlapsLabel && !overlapsGlyph) {
        placed.push(box);
        kept.push(d);
      }
    });
    return kept;
  }

  // Shared sqrt scale so the pie-glyph size (drawn) and label offset (positioned
  // clear of that glyph) always agree with each other.
  function pieRadiusScale() {
    var maxTotal = 0;
    state.combined.forEach(function (e) { var m = metricOfEntry(e); if (m > maxTotal) maxTotal = m; });
    return d3.scaleSqrt().domain([1, maxTotal || 1]).range([6, 24]);
  }

  function drawPieGlyphs(svg, path, radiusScale) {
    var arcGen = d3.arc();
    var pieGen = d3.pie().value(function (d) { return d.value; }).sort(null);

    var glyphData = [];
    state.geo.features.forEach(function (f) {
      var norm = normalize(f.properties.ADM2_EN);
      var entry = state.combined.get(norm);
      if (!entry || !metricOfEntry(entry)) return;
      if (!countyInScope(norm)) return;
      var c = path.centroid(f);
      if (isNaN(c[0]) || isNaN(c[1])) return;
      glyphData.push({ key: f.properties.ADM2_PCODE, name: f.properties.ADM2_EN, norm: norm, entry: entry, c: c });
    });

    var groups = svg.selectAll('g.uf-pie-glyph').data(glyphData, function (d) { return d.key; });
    var groupsEnter = groups.enter().append('g').attr('class', 'uf-pie-glyph');
    groups.exit().remove();
    var allGroups = groupsEnter.merge(groups);

    allGroups.attr('transform', function (d) { return 'translate(' + d.c[0] + ',' + d.c[1] + ')'; })
      .style('cursor', 'pointer')
      .each(function (d) {
        var g = d3.select(this);
        var r = radiusScale(metricOfEntry(d.entry));
        arcGen.innerRadius(0).outerRadius(r);
        var arcs = pieGen(ORDER.filter(function (f) { return d.entry.byFund[f]; }).map(function (f) {
          return { fund: f, value: metricByFund(d.entry, f) };
        }));

        var slices = g.selectAll('path.uf-pie-arc').data(arcs, function (a) { return a.data.fund; });
        slices.enter().append('path').attr('class', 'uf-pie-arc').merge(slices)
          .attr('d', arcGen)
          .attr('fill', function (a) { return META[a.data.fund].color; });
        slices.exit().remove();

        var label = g.selectAll('text.uf-pie-total-label').data([metricOfEntry(d.entry)]);
        label.enter().append('text').attr('class', 'uf-pie-total-label').merge(label)
          .text(function (v) { return fmtMetricCompact(v); });
        label.exit().remove();
      })
      .on('mousemove', function (event, d) {
        var container = this.closest('.uf-map');
        var tooltip = container && container.querySelector('.uf-map-tooltip');
        if (!tooltip) return;
        tooltip.style.display = 'block';
        tooltip.innerHTML = tooltipHtml('all', d.name, d.norm);
        positionTooltip(tooltip, event, container);
      })
      .on('mouseleave', function () {
        var container = this.closest('.uf-map');
        var tooltip = container && container.querySelector('.uf-map-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      })
      .on('click', function (event, d) {
        selectCounty('all', d.norm);
      });
  }

  // Solid single-color circle + value, used on every map that isn't the combined
  // multi-fund pie view (a specific fund tab, or "All Funds" filtered to one fund).
  function drawValueGlyphs(layer, path, fund, valueFor, radiusScale, inScope, tabId) {
    var color = META[fund].color;
    var glyphData = [];
    state.geo.features.forEach(function (f) {
      var norm = normalize(f.properties.ADM2_EN);
      var v = valueFor(norm);
      if (!v || !inScope(norm)) return;
      var c = path.centroid(f);
      if (isNaN(c[0]) || isNaN(c[1])) return;
      glyphData.push({ key: f.properties.ADM2_PCODE, name: f.properties.ADM2_EN, norm: norm, v: v, c: c });
    });

    var groups = layer.selectAll('g.uf-value-glyph').data(glyphData, function (d) { return d.key; });
    var groupsEnter = groups.enter().append('g').attr('class', 'uf-value-glyph');
    groups.exit().remove();
    var allGroups = groupsEnter.merge(groups);

    allGroups.attr('transform', function (d) { return 'translate(' + d.c[0] + ',' + d.c[1] + ')'; })
      .style('cursor', 'pointer')
      .each(function (d) {
        var g = d3.select(this);
        var circle = g.selectAll('circle.uf-value-glyph-circle').data([d.v]);
        circle.enter().append('circle').attr('class', 'uf-value-glyph-circle').merge(circle)
          .attr('r', radiusScale(d.v))
          .attr('fill', color);
        circle.exit().remove();

        var label = g.selectAll('text.uf-pie-total-label').data([d.v]);
        label.enter().append('text').attr('class', 'uf-pie-total-label').merge(label)
          .text(function (v) { return fmtMetricCompact(v); });
        label.exit().remove();
      })
      .on('mousemove', function (event, d) {
        var container = this.closest('.uf-map');
        var tooltip = container && container.querySelector('.uf-map-tooltip');
        if (!tooltip) return;
        tooltip.style.display = 'block';
        tooltip.innerHTML = tooltipHtml(tabId, d.name, d.norm);
        positionTooltip(tooltip, event, container);
      })
      .on('mouseleave', function () {
        var container = this.closest('.uf-map');
        var tooltip = container && container.querySelector('.uf-map-tooltip');
        if (tooltip) tooltip.style.display = 'none';
      })
      .on('click', function (event, d) {
        selectCounty(tabId, d.norm);
      });
  }

  function tooltipHtml(tabId, name, norm) {
    var effectiveFund = tabId === 'all' ? state.allFilters.fund : tabId;
    var provisionalLine = '<div class="tt-row" style="color:#ffd88a">&#9888; estimated split, pending confirmation</div>';
    if (effectiveFund === 'All') {
      var e = state.combined.get(norm);
      if (!e) return '<strong>' + name + '</strong><br>No funded projects reported.';
      var rowsHtml = ORDER.filter(function (f) { return e.byFund[f]; }).map(function (f) {
        return '<div class="tt-row"><span><span class="tt-dot" style="background:' + META[f].color + '"></span>' + f + '</span><span>' + fmtMoneyCompact(e.byFundValue[f]) + ' &middot; ' + e.byFund[f] + '</span></div>';
      }).join('');
      return '<strong>📍 ' + name + '</strong>' +
        '<div class="tt-row"><span>Total $ value</span><span>' + fmtMoney(e.totalValue) + '</span></div>' +
        '<div class="tt-row"><span>Total projects</span><span>' + e.total + '</span></div>' +
        rowsHtml +
        '<div class="tt-row"><span>Partner orgs</span><span>' + e.partners.size + '</span></div>' +
        (e.provisionalFunds.size ? provisionalLine : '');
    }
    var row = state.fundIndex[effectiveFund].get(norm);
    if (!row) return '<strong>' + name + '</strong><br>No ' + effectiveFund + ' projects reported.';
    return '<strong>📍 ' + name + '</strong>' +
      '<div class="tt-row"><span>' + effectiveFund + ' $ value</span><span>' + fmtMoney(row.value || 0) + '</span></div>' +
      '<div class="tt-row"><span>' + effectiveFund + ' projects</span><span>' + row.projects + '</span></div>' +
      '<div class="tt-row"><span>Partner orgs</span><span>' + row.partners.length + '</span></div>' +
      (row.provisional ? provisionalLine : '');
  }

  function positionTooltip(tooltip, event, container) {
    var pad = 12, offset = 16;
    var cw = container.clientWidth || 0, ch = container.clientHeight || 0;
    var left = event.offsetX + offset, top = event.offsetY + offset;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    var rect = tooltip.getBoundingClientRect();
    var tw = rect.width || 260, th = rect.height || 140;
    if (cw && left + tw + pad > cw) left = Math.max(pad, event.offsetX - tw - offset);
    if (ch && top + th + pad > ch) top = Math.max(pad, event.offsetY - th - offset);
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function selectCounty(tabId, norm) {
    state.selected[tabId] = norm;
    if (tabId === 'all') {
      if (state.allFilters.fund === 'All') {
        renderAllSelected(state.combined.get(norm) || null);
      } else {
        renderAllSelectedFund(state.allFilters.fund, state.fundIndex[state.allFilters.fund].get(norm) || null);
      }
    } else {
      renderFundSelected(tabId, state.fundIndex[tabId].get(norm) || null);
    }
    drawMap(tabId);
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function init() {
    renderTabs();

    // One delegated listener handles every "Download PDF" button on the page —
    // tables, charts and maps alike — instead of wiring each one individually.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.uf-pdf-btn');
      if (!btn) return;
      var targetEl = byId(btn.dataset.pdfTarget);
      if (!targetEl) return;
      var title = btn.dataset.pdfTitle || document.title;
      var filename = btn.dataset.pdfFilename || 'export';
      if (btn.dataset.pdfType === 'table') {
        exportTableToPdf(targetEl, title, filename);
      } else {
        exportElementToPdf(targetEl, title, filename);
      }
    });

    var initialTab = (location.hash || '').replace('#', '');
    var validTabs = TABS.map(function (t) { return t.id; });
    if (initialTab && validTabs.indexOf(initialTab) !== -1 && initialTab !== 'all') {
      activateTab(initialTab);
    } else {
      ensurePanelRendered('all');
      updateDisclaimerVisibility('all');
    }

    fetch('data/counties.json').then(function (r) { return r.json(); }).then(function (topo) {
      var objKey = Object.keys(topo.objects)[0];
      var geo = topojson.feature(topo, topo.objects[objKey]);
      state.geo = geo;
      populateAllFilters();
      requestAnimationFrame(function () {
        var activePanel = document.querySelector('.uf-panel.active');
        drawMap(activePanel ? activePanel.dataset.panel : 'all');
      });
    }).catch(function (err) {
      byId('map-all').innerHTML = '<div style="padding:18px">Unable to load South Sudan county map.</div>';
      console.error(err);
    });

    window.addEventListener('resize', debounce(function () {
      document.querySelectorAll('.uf-panel.active').forEach(function (p) {
        // A resize changes the base projection scale, so a stale zoom transform on
        // top of it would look wrong — reset before redrawing at the new size.
        resetMapZoom(p.dataset.panel);
        drawMap(p.dataset.panel);
      });
    }, 200));
  }

  function resetMapZoom(tabId) {
    var containerId = tabId === 'all' ? 'map-all' : 'map-' + tabId;
    var container = byId(containerId);
    if (container && container.__zoom) {
      container.__zoom.svgSel.transition().duration(300).call(container.__zoom.behavior.transform, d3.zoomIdentity);
    }
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments;
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
