// Interactive Toronto travel-time map. No server-side routing: all times were precomputed by precompute_tor.py.
// Data layout: <mode>.bin is a uint8 matrix, byte index = destination_id * n + origin_id, 255 = unreachable.
//   walk_transit.bin = transit minutes
//   bike.bin         = bike minutes

const START_LNGLAT = [-79.3807, 43.6453];    // initial destination: Union Station (nearest cell is picked)
const UNREACHABLE_COLOR = '#bdbdbd';

// ===== STARTING VIEW WHEN THE PAGE LOADS: edit these two lines =====
const START_CENTER = [-79.3800, 43.7200];    // [longitude, latitude] of the middle of the screen
const START_ZOOM = 10.5;                     // bigger number = more zoomed in (Toronto-wide is about 10 to 11)

// ---- basemap (MapTiler) ---------------------------------------------------
// Paste your MapTiler key here. Until you do, a free CARTO light basemap is used instead.
const MAPTILER_KEY = 'OSMCSRe7QkopvhJnIYit';
const MAPTILER_STYLE = 'dataviz-v4';      // other options: 'basic-v2-light', 'streets-v2-light', 'backdrop-light'

function baseStyle() {
  if (MAPTILER_KEY && MAPTILER_KEY !== 'YOUR_MAPTILER_KEY') {
    return `https://api.maptiler.com/maps/${MAPTILER_STYLE}/style.json?key=${MAPTILER_KEY}`;
  }
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ---- colour scales --------------------------------------------------------
// Difference map: same palette as the QGIS map (green = faster by bike, pink = faster by transit).
const TIE_MIN = 5;      // within this many minutes counts as "about the same"
const BIG_MIN = 15;     // beyond this many minutes = the strongest colour
const DIFF_COLORS = {
  bikeBig:     '#16803C',
  bikeSmall:   '#6CC26A',
  tie:         '#B5AEA3',
  transitSmall:'#EE82BE',
  transitBig:  '#A90B72',
};
const DIFF_LEGEND = [
  [DIFF_COLORS.bikeBig,      'Bike faster by 15+ min'],
  [DIFF_COLORS.bikeSmall,    'Bike faster by 5 to 15'],
  [DIFF_COLORS.tie,          'About the same (within 5 min)'],
  [DIFF_COLORS.transitSmall, 'Transit faster by 5 to 15'],
  [DIFF_COLORS.transitBig,   'Transit faster by 15+ min'],
];

// Single-mode maps (minutes to the destination)
const TIME_BINS = [
  { max: 10,       color: '#ffffcc', label: 'Under 10' },
  { max: 20,       color: '#c7e9b4', label: '10 to 19' },
  { max: 30,       color: '#7fcdbb', label: '20 to 29' },
  { max: 45,       color: '#41b6c4', label: '30 to 44' },
  { max: 60,       color: '#2c7fb8', label: '45 to 59' },
  { max: 90,       color: '#253494', label: '60 to 89' },
  { max: Infinity, color: '#081d58', label: '90 or more' },
];

function binColor(bins, v) {
  for (const b of bins) if (v < b.max) return b.color;
  return bins[bins.length - 1].color;
}

// d = transit minutes - bike minutes, so positive means the bike is faster
function diffColor(d) {
  if (d >= BIG_MIN) return DIFF_COLORS.bikeBig;
  if (d > TIE_MIN) return DIFF_COLORS.bikeSmall;
  if (d >= -TIE_MIN) return DIFF_COLORS.tie;
  if (d > -BIG_MIN) return DIFF_COLORS.transitSmall;
  return DIFF_COLORS.transitBig;
}

// ---- modes ----------------------------------------------------------------
// The button keys (data-mode in index.html) are kept as: 'saved' = difference map, 'walk' = transit, 'bike' = bike.
const MODE_DIFF = 'saved';
const MODE_LABELS = { saved: 'Bike vs Transit', walk: 'Transit', bike: 'Bike' };

// ---- state ----------------------------------------------------------------
// S.transit = transit matrix, S.bike = bike matrix
const S = { meta: null, grid: null, n: 0, transit: null, bike: null, mode: MODE_DIFF, dest: 0, centroids: [] };
const $ = (id) => document.getElementById(id);

function fail(msg) {
  const el = $('status');
  el.classList.remove('hidden');
  el.innerHTML = msg;
}

async function loadAll() {
  const get = async (name, kind) => {
    const r = await fetch('data/' + name);
    if (!r.ok) throw new Error(name + ' (' + r.status + ')');
    return kind === 'json' ? r.json() : r.arrayBuffer();
  };
  const meta = await get('meta.json', 'json');
  const grid = await get('grid.geojson', 'json');
  const roads = await get('roads.geojson', 'json');

  // look the matrices up by key, so the order of meta.modes doesn't matter
  const mats = {};
  await Promise.all(meta.modes.map(async (m) => { mats[m.key] = new Uint8Array(await get(m.file)); }));
  const transit = mats.walk;
  const bike = mats.bike;
  if (!transit || !bike) throw new Error('meta.json must list modes with keys "walk" and "bike"');

  const n = meta.n;
  if (grid.features.length !== n) throw new Error(`grid has ${grid.features.length} cells but meta.json says ${n}`);
  if (transit.length !== n * n || bike.length !== n * n) throw new Error('matrix size does not match the number of cells');
  return { meta, grid, roads, transit, bike, n };
}

function ringCentroid(feature) {
  const g = feature.geometry;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
  let x = 0, y = 0;
  const k = ring.length - 1;
  for (let i = 0; i < k; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / k, y / k];
}

function nearestCell(lngLat) {
  let best = 0, bd = Infinity;
  S.centroids.forEach((c, i) => {
    const dx = (c[0] - lngLat[0]) * Math.cos(lngLat[1] * Math.PI / 180), dy = c[1] - lngLat[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// ---- values ---------------------------------------------------------------
// t = transit minutes from every cell to the destination, b = bike minutes
function rows(d) {
  const n = S.n;
  return { t: S.transit.subarray(d * n, (d + 1) * n), b: S.bike.subarray(d * n, (d + 1) * n) };
}

function colorFor(mode, t, b) {
  const U = S.meta.unreachable;
  if (mode === 'walk') return t === U ? UNREACHABLE_COLOR : binColor(TIME_BINS, t);
  if (mode === 'bike') return b === U ? UNREACHABLE_COLOR : binColor(TIME_BINS, b);
  // difference map
  if (t === U && b === U) return UNREACHABLE_COLOR;
  if (t === U) return DIFF_COLORS.bikeBig;       // only the bike gets there
  if (b === U) return DIFF_COLORS.transitBig;    // only transit gets there
  return diffColor(t - b);
}

function fmt(v) { return v === S.meta.unreachable ? 'not reachable within 180 min' : v + ' min'; }

// ---- map ------------------------------------------------------------------
let map;
let hoverId = null;

function refresh() {
  const { t, b } = rows(S.dest);

  // group cell ids by colour, then build one match expression
  const byColor = {};
  for (let i = 0; i < S.n; i++) {
    const c = colorFor(S.mode, t[i], b[i]);
    (byColor[c] = byColor[c] || []).push(i);
  }
  const expr = ['match', ['to-number', ['get', 'cell']]];
  for (const [color, ids] of Object.entries(byColor)) expr.push(ids, color);
  expr.push(UNREACHABLE_COLOR);                       // fallback
  map.setPaintProperty('roads', 'line-color', expr);

  map.setFilter('dest', ['==', ['get', 'id'], S.dest]);
  map.getSource('dest-point').setData({ type: 'Point', coordinates: S.centroids[S.dest] });
  renderLegend();
  fitLegendUnit();
  // renderStats(t, b);
}

// use "minutes" if it fits inside the legend, otherwise fall back to "min"
function fitLegendUnit() {
  const unit = document.querySelector('#legend .unit');
  if (!unit) return;
  unit.textContent = 'minutes';
  if (unit.getBoundingClientRect().right > $('legend').getBoundingClientRect().right) unit.textContent = 'min';
}

function renderLegend() {
  let title, colors, labels, above = '';
  if (S.mode === MODE_DIFF) {
    title = '';
    colors = [DIFF_COLORS.bikeBig, DIFF_COLORS.bikeSmall, DIFF_COLORS.tie, DIFF_COLORS.transitSmall, DIFF_COLORS.transitBig];
    labels = [BIG_MIN, TIE_MIN, TIE_MIN, BIG_MIN].map(String);   // numbers sit between the boxes
    above = '<div class="scale-above"><span>faster by bike</span><span class="tick"></span><span>faster by transit</span></div>';
  } else {
    title = S.mode === 'bike' ? 'Minutes to destination' : 'Minutes to destination';
    colors = TIME_BINS.map((b) => b.color);
    labels = TIME_BINS.slice(0, -1).map((b) => String(b.max));
  }
  const n = colors.length;
  const boxes = colors.map((c) => `<i style="background:${c}"></i>`).join('');
  // the last number gets a "minutes" tag that hangs off its right side, so only the number is centred on the gap
  const nums = labels.map((l, i) =>
    `<span style="left:${100 * (i + 1) / n}%">${l}${i === labels.length - 1 ? '<span class="unit">minutes</span>' : ''}</span>`).join('');
  $('legend-title').textContent = title;
  $('legend-title').style.display = title ? '' : 'none';   // no empty title block in the difference view
  $('legend').innerHTML =
    above +
    `<div class="scale">${boxes}</div>` +
    `<div class="scale-labels">${nums}</div>` 
    // +
    // `<div class="unreach"><i style="background:${UNREACHABLE_COLOR}"></i>Not reachable</div>`;
}

// share of other cells that can reach the destination within 30 minutes
// function renderStats(t, b) {
//   const U = S.meta.unreachable;
//   let ct = 0, cb = 0, k = 0;
//   for (let i = 0; i < S.n; i++) {
//     if (i === S.dest) continue;
//     k++;
//     if (t[i] !== U && t[i] <= 30) ct++;
//     if (b[i] !== U && b[i] <= 30) cb++;
//   }
//   $('s-walk').textContent = Math.round(100 * ct / k) + '% of cells';
//   $('s-bike').textContent = Math.round(100 * cb / k) + '% of cells';
// }

function syncButtons() {
  document.querySelectorAll('.modes button').forEach((btn) =>
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === S.mode)));
}

function setMode(mode) {
  S.mode = mode;
  syncButtons();
  refresh();
}

function setDest(id) {
  S.dest = id;
  refresh();
}

function startMap() {
  map = new maplibregl.Map({
    container: 'map',
    center: START_CENTER,
    zoom: START_ZOOM,
    minZoom: 9,
    style: baseStyle(),
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    // put the coloured cells under the basemap's labels when the style has them
    const firstSymbol = (map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;

    map.addSource('grid', { type: 'geojson', data: S.grid, promoteId: 'id' });
    map.addSource('dest-point', { type: 'geojson', data: { type: 'Point', coordinates: START_LNGLAT } });

    map.addLayer({
      id: 'cells', type: 'fill', source: 'grid',
      paint: {
        'fill-color': ['coalesce', ['feature-state', 'color'], UNREACHABLE_COLOR],
        'fill-opacity': 0.0,
      },
    }, firstSymbol);
    map.addLayer({
      id: 'cell-lines', type: 'line', source: 'grid',
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.0, 'line-width': 0.5 },
    }, firstSymbol);

    map.addSource('roads', { type: 'geojson', data: S.roads });
    map.addLayer({
      id: 'roads', type: 'line', source: 'roads',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': UNREACHABLE_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 13, 1.2, 16, 3.5],
      },
    }, firstSymbol);

    map.addLayer({
      id: 'hover', type: 'line', source: 'grid', filter: ['==', ['get', 'id'], -1],
      paint: { 'line-color': '#1c2330', 'line-width': 1.5 },
    });
    map.addLayer({
      id: 'dest', type: 'line', source: 'grid', filter: ['==', ['get', 'id'], S.dest],
      paint: { 'line-color': '#000000', 'line-width': 2 },
    });
    // white dot with a black ring, like the destination marker on the QGIS map
    map.addLayer({
      id: 'dest-marker', type: 'circle', source: 'dest-point',
      paint: {
        'circle-radius': 10,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 3,
      },
    });

    map.on('click', 'cells', (e) => { if (e.features.length) setDest(Number(e.features[0].properties.id)); });
    map.on('mousemove', 'cells', onHover);
    map.on('mouseleave', 'cells', () => {
      map.getCanvas().style.cursor = '';
      hoverId = null;
      map.setFilter('hover', ['==', ['get', 'id'], -1]);
      $('tip').style.display = 'none';
    });

    // (the old auto-fit to the whole grid was here and overrode the zoom; it is disabled so START_CENTER / START_ZOOM are used)
    // const bounds = new maplibregl.LngLatBounds();
    // S.centroids.forEach((c) => bounds.extend(c));
    // map.fitBounds(bounds, { padding: { top: 30, bottom: 30, left: 30, right: 30 }, duration: 0 });

    S.dest = nearestCell(START_LNGLAT);
    refresh();
    $('status').classList.add('hidden');
  });
}

// ---- tooltip --------------------------------------------------------------
const TRANSIT_INK = DIFF_COLORS.transitBig;   // pink
const BIKE_INK = DIFF_COLORS.bikeBig;         // green

// Transit-only or bike-only tip: big centred time, coloured label underneath
function singleTip(kind, v, note) {
  const color = kind === 'bike' ? BIKE_INK : TRANSIT_INK;
  const name = kind === 'bike' ? 'Bike' : 'Transit';
  const big = v === S.meta.unreachable
    ? '<div class="tip-big tip-none">Not reachable</div>'
    : `<div class="tip-big">${v}<span class="tip-unit"> min</span></div>`;
  return `<div class="tip-single">${big}<div class="tip-kind" style="color:${color}">${name}</div>` +
         (note ? `<div class="tip-note">${note}</div>` : '') + '</div>';
}

// Bike vs Transit tip: horizontal dumbbell. The dots are centred in the tip and the gap between them is always
// PX_PER_MIN pixels per minute of difference (capped at MAX_GAP_MIN), so gap sizes are comparable between cells.
const PX_PER_MIN = 4;
const MAX_GAP_MIN = 60;
const MIN_TIP_W = 100;   // narrowest the tip gets (room for the "faster by transit" text)
const PAD_X = 26;        // space left and right of the dots (room for the time labels)

function dumbbellTip(t, b) {
  const U = S.meta.unreachable;
  if (t === U && b === U) return '<div class="tip-single"><div class="tip-big tip-none">Not reachable</div></div>';
  if (t === U) return singleTip('bike', b, 'only the bike gets there within 180 min');
  if (b === U) return singleTip('transit', t, 'only transit gets here within 180 min');

  const d = t - b;                                  // positive = bike faster
  const gap = Math.abs(d);
  const H = 78, y = 46, len = Math.min(gap, MAX_GAP_MIN) * PX_PER_MIN;
  const W = Math.max(MIN_TIP_W, len + PAD_X * 2);   // tip is only as wide as it needs to be
  const xl = (W - len) / 2, xr = xl + len, mid = W / 2;
  const gapColor = diffColor(d);                    // same colour as the legend bucket
  const gapText = d === 0 ? 'same' : `+${gap} min`;
  const faster = d > 0 ? 'faster by bike' : 'faster by transit';
  const leftIsBike = b <= t;                        // faster mode on the left
  const close = len < 46;                           // labels would collide: push them apart around the midpoint
  const label = (x, m, color, isLeft) => {
    const lx = close ? (isLeft ? mid - 3 : mid + 3) : x;
    const anchor = close ? (isLeft ? 'end' : 'start') : 'middle';
    return `<text x="${lx}" y="${H - 6}" text-anchor="${anchor}" font-size="10" font-weight="700" fill="${color}">${m} min</text>`;
  };
  const bike = { x: leftIsBike ? xl : xr, v: b }, transit = { x: leftIsBike ? xr : xl, v: t };
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">` +
    `<text x="${mid}" y="14" text-anchor="middle" font-size="16" font-weight="700" fill="${gapColor}">${gapText}</text>` +
    (d === 0 ? '' : `<text x="${mid}" y="28" text-anchor="middle" font-size="11" font-style="italic" fill="#5f6b7a">${faster}</text>`) +
    `<line x1="${xl}" y1="${y}" x2="${xr}" y2="${y}" stroke="#c9d0d8" stroke-width="3" stroke-linecap="round"/>` +
    `<circle cx="${transit.x}" cy="${y}" r="6" fill="${TRANSIT_INK}"/>` +
    `<circle cx="${bike.x}" cy="${y}" r="6" fill="${BIKE_INK}"/>` +
    label(bike.x, bike.v, BIKE_INK, leftIsBike) + label(transit.x, transit.v, TRANSIT_INK, !leftIsBike) + '</svg>';
}

function onHover(e) {
  if (!e.features.length) return;
  map.getCanvas().style.cursor = 'pointer';
  const id = Number(e.features[0].properties.id);
  if (id !== hoverId) {
    hoverId = id;
    map.setFilter('hover', ['==', ['get', 'id'], id]);
  }
  const { t, b } = rows(S.dest);
  const tip = $('tip');
  tip.innerHTML = S.mode === MODE_DIFF
    ? dumbbellTip(t[id], b[id])
    : S.mode === 'bike' ? singleTip('bike', b[id]) : singleTip('transit', t[id]);
  tip.style.display = 'block';
  const pad = 14, r = tip.getBoundingClientRect();
  let x = e.point.x + pad, y = e.point.y + pad;
  if (x + r.width > window.innerWidth - 8) x = e.point.x - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.point.y - r.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

// ---- boot -----------------------------------------------------------------
(async function boot() {
  if (typeof maplibregl === 'undefined') {
    return fail('The map library did not load. Check your internet connection (it is fetched from unpkg.com).');
  }
  try {
    const d = await loadAll();
    Object.assign(S, d);
    S.centroids = S.grid.features.map(ringCentroid);

    const dep = new Date(S.meta.departure);
    const when = dep.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
    // $('note').textContent =
    //   `Click any cell to set it as the destination. Transit leaves around ${when}. Bike goes door to door. ` +
    //   `Differences within ${TIE_MIN} minutes count as about the same. Cells are ${S.meta.cell_size_m} m.`;

    // label the mode buttons to match what the data now contains
    document.querySelectorAll('.modes button').forEach((btn) => {
      if (MODE_LABELS[btn.dataset.mode]) btn.textContent = MODE_LABELS[btn.dataset.mode];
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    syncButtons();
    startMap();
  } catch (err) {
    fail('Could not load the data files in <code>web/data/</code>.<br><br>' + String(err.message || err) +
         '<br><br>Run <code>precompute_tor.py</code> first, and open this page through a local server ' +
         '(<code>python3 -m http.server</code>), not by double-clicking the file.');
  }
})();