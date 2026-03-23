/* ═══════════════════════════════════════════════════════
   GEO-VISUALIZADOR INMOBILIARIO — MALINALCO
   script.js
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ─── 1. GOOGLE SHEETS DATA SOURCE ─── */
// 👉 Pega aquí la URL pública CSV de tu Google Sheet
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRpG0f4UXjuNuA8g_Z2TWYBdU04v2jNXw9DP8-yz1ZkE3wuYAEqa9A7kHfJ-ADA4azwHQrEQ0fRzZVK/pub?gid=0&single=true&output=csv';

let properties = [];

/**
 * Parsea el texto CSV del Sheet y retorna un array de objetos property.
 * Formato de columnas esperado (fila 1 = encabezados):
 * id | tipo | precioMXN | coords | areaM2 | construccionM2 | recamaras | baños | antiguedad | normativa | imagenes | status
 */
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  return lines.slice(1).map(line => {
    // Soporte para comas dentro de comillas (GeoJSON en campo coords)
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { cols.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    cols.push(current.trim()); // última columna

    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });

    // Conversión de tipos
    const coordRaw = obj.coords || '';
    let coords;
    if (coordRaw.startsWith('[')) {
      // Terreno: array de coordenadas GeoJSON
      coords = { type: 'Polygon', coordinates: [JSON.parse(coordRaw)] };
    } else {
      // Casa/Depto: "lat,lng"
      const [lat, lng] = coordRaw.split(',').map(Number);
      coords = { lat, lng };
    }

    // Normalización de tipo: acepta abreviaturas o nombre completo
    const TIPO_MAP = { 'Terr': 'Terreno', 'Cas': 'Casa', 'Dep': 'Departamento' };
    const tipoRaw = (obj.tipo || '').trim();
    const tipo = TIPO_MAP[tipoRaw] || tipoRaw;

    return {
      id:              (obj.id || '').trim(),
      tipo,                                              // Terreno / Casa / Departamento
      precioMXN:       Number(obj.precioMXN || obj.precio || 0),

      coords,
      areaM2:          Number(obj.areaM2    || obj.area         || 0),
      construccionM2:  Number(obj.construccionM2 || obj.construccion || 0),
      recamaras:       Number(obj.recamaras || 0),
      baños:           Number(obj.baños     || obj.banos || 0),
      antiguedad:      Number(obj.antiguedad || 0),
      normativa:       obj.normativa || null,
      imagenes:        obj.imagenes ? obj.imagenes.split('|').map(u => u.trim()) : [],
      status:          (obj.status || 'disponible').toLowerCase().trim()
    };
  }).filter(p => p.id); // descarta filas vacías

}

/** Carga las propiedades desde Google Sheets y arranca el mapa */
async function loadProperties() {
  const loader = document.getElementById('map-loader');
  if (loader) loader.classList.remove('hidden');

  try {
    const res = await fetch(SHEET_CSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csvText = await res.text();
    properties = parseCSV(csvText);
  } catch (err) {
    console.error('Error al cargar propiedades desde Sheets:', err);
    // Fallback: muestra mensaje en el mapa
    const mapEl = document.getElementById('map');
    if (mapEl) {
      const msg = document.createElement('div');
      msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.75);color:#fff;padding:16px 24px;border-radius:8px;z-index:9999;font-size:14px;text-align:center;';
      msg.innerHTML = '⚠️ No se pudieron cargar las propiedades.<br>Verifica la URL del Sheet o tu conexión.';
      mapEl.style.position = 'relative';
      mapEl.appendChild(msg);
    }
  } finally {
    if (loader) loader.classList.add('hidden');
    refreshMap();
  }
}

/* ─── 2. STATE ─── */
let activeFilters = {
  type: 'all',
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  bedrooms: 0,
  bathrooms: 0
};
let mapLayers = [];
let currentSlide = 0;
let currentPropId = null;

/* ─── 3. MAP INITIALIZATION ─── */
// Mapa Base (Estándar y colorido - OpenStreetMap)
const baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});
// Satélite Base (Google)
const satelliteLayer = L.tileLayer('http://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
  maxZoom: 20,
  subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
  attribution: 'Map data &copy; Google'
});

const map = L.map('map', {
  center: [18.950, -99.495],
  zoom: 14,
  zoomControl: false,
  layers: [baseLayer] // Por defecto
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Control de capas (arriba izquierda)
L.control.layers(
  { 'Base': baseLayer, 'Satélite': satelliteLayer },
  {},
  { position: 'topleft' }
).addTo(map);

/* ─── 4. HELPERS ─── */
const fmtPrice = n => '$' + n.toLocaleString('es-MX');

const getCentroid = coords => {
  if (!coords.type) return [coords.lat, coords.lng];
  const lngs = coords.coordinates[0].map(c => c[0]);
  const lats = coords.coordinates[0].map(c => c[1]);
  return [
    lats.reduce((a, b) => a + b, 0) / lats.length,
    lngs.reduce((a, b) => a + b, 0) / lngs.length
  ];
};

const getTypeClass = tipo => ({
  Terreno: 'tag-type-terreno',
  Casa: 'tag-type-casa',
  Departamento: 'tag-type-depto'
}[tipo] || '');

/* ─── 5. CUSTOM MARKER ICONS ─── */
const createIcon = tipo => {
  const cls = tipo === 'Casa' ? 'casa' : 'departamento';
  const icon = tipo === 'Casa' ? 'home' : 'apartment';
  return L.divIcon({
    className: '',
    html: `<div class="custom-marker ${cls}"><span class="material-icons inner">${icon}</span></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 38],
    popupAnchor: [0, -40]
  });
};

// Icono gris para propiedades vendidas -> Ahora color original pero oscuro/transparente y más pequeño
const createSoldIcon = tipo => {
  const cls = tipo === 'Casa' ? 'casa' : 'departamento';
  const icon = tipo === 'Casa' ? 'home' : 'apartment';
  // Reducimos tamaño de 38x38 a 28x28, fuente a 14px
  return L.divIcon({
    className: '',
    html: `<div class="custom-marker ${cls} sold-marker"><span class="material-icons inner">${icon}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -30]
  });
};

// 👉 AQUÍ SE CAMBIAN LOS COLORES DE LOS TERRENOS DISPONIBLES
const terrainStyle = {
  color: '#dc2626',      // Color del borde (Rojo intenso)
  weight: 3,             // Grosor del borde
  fillColor: '#ef4444',  // Color de relleno (Rojo brillante)
  fillOpacity: 0.6       // Opacidad (0.0 a 1.0, subido para que se vea más en satélite)
};

// Estilo para terrenos vendidos (casi gris, manteniéndose muy desaturado y transparente)
const terrainSoldStyle = {
  color: '#78716c', // outline gris cálido oscuro
  weight: 2,
  fillColor: '#a8a29e', // relleno gris cálido
  fillOpacity: 0.2 // muy transparente
};

/* ─── 6. RENDER PROPERTIES ON MAP ─── */
function renderProperties(list) {
  // Clear previous layers
  mapLayers.forEach(l => map.removeLayer(l));
  mapLayers = [];

  list.forEach(prop => {
    try {
      let layer;
      const vendida = prop.status === 'vendido';

      // Tooltip: precio si disponible, "Vendida" si vendida
      const tooltipContent = vendida
        ? `<span style="color:#9ca3af;font-style:italic;">Vendida</span>`
        : `<span>${fmtPrice(prop.precioMXN)}</span>`;

      const tooltip = L.tooltip({
        permanent: false,
        direction: 'top',
        className: 'prop-tooltip'
      }).setContent(tooltipContent);

      if (prop.tipo === 'Terreno') {
        // Validación: el polígono necesita coords.coordinates
        if (!prop.coords || !prop.coords.coordinates) {
          console.warn(`[MAL] Propiedad ${prop.id} (Terreno) sin coordenadas válidas — omitida.`);
          return;
        }
        // Polygon
        const latlngs = prop.coords.coordinates[0].map(c => [c[1], c[0]]);
        const style = vendida ? terrainSoldStyle : terrainStyle;
        layer = L.polygon(latlngs, style).bindTooltip(tooltip);

        if (!vendida) {
          layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.7, weight: 3 }));
          layer.on('mouseout',  () => layer.setStyle(terrainStyle));
          layer.on('click', () => openModal(prop.id));
        } else {
          layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.55 }));
          layer.on('mouseout',  () => layer.setStyle(terrainSoldStyle));
        }
      } else {
        // Validación: el punto necesita lat/lng válidos
        const [lat, lng] = getCentroid(prop.coords);
        if (isNaN(lat) || isNaN(lng)) {
          console.warn(`[MAL] Propiedad ${prop.id} sin coordenadas válidas — omitida.`);
          return;
        }
        // Marker
        const icon = vendida ? createSoldIcon(prop.tipo) : createIcon(prop.tipo);
        layer = L.marker([lat, lng], { icon }).bindTooltip(tooltip);
        if (!vendida) {
          layer.on('click', () => openModal(prop.id));
        }
      }

      layer.addTo(map);
      mapLayers.push(layer);

    } catch (err) {
      console.warn(`[MAL] Error al renderizar propiedad ${prop.id}:`, err);
    }
  });


  // Update results counter (solo cuenta los que realmente se pintaron en el mapa)
  document.getElementById('results-count').textContent = mapLayers.length;
}

/* ─── 7. FILTER LOGIC ─── */
function applyFilters() {
  return properties.filter(p => {
    if (activeFilters.type !== 'all' && p.tipo !== activeFilters.type) return false;
    if (activeFilters.priceMin !== null && p.precioMXN < activeFilters.priceMin) return false;
    if (activeFilters.priceMax !== null && p.precioMXN > activeFilters.priceMax) return false;
    if (activeFilters.areaMin !== null && p.areaM2 < activeFilters.areaMin) return false;
    if (activeFilters.areaMax !== null && p.areaM2 > activeFilters.areaMax) return false;
    if (activeFilters.bedrooms > 0 && p.recamaras < activeFilters.bedrooms) return false;
    if (activeFilters.bathrooms > 0 && p.baños < activeFilters.bathrooms) return false;
    return true;
  });
}

function refreshMap() {
  const filtered = applyFilters();
  renderProperties(filtered);
  updateFilterBadge();

  // Auto-Zoom a las propiedades filtradas
  if (mapLayers.length > 0) {
    const group = new L.featureGroup(mapLayers);
    map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 17 });
  }
}

function updateFilterBadge() {
  const hasAdvanced = (
    activeFilters.priceMin !== null ||
    activeFilters.priceMax !== null ||
    activeFilters.areaMin !== null ||
    activeFilters.areaMax !== null ||
    activeFilters.bedrooms > 0 ||
    activeFilters.bathrooms > 0
  );
  document.getElementById('filter-badge').classList.toggle('hidden', !hasAdvanced);
}

/* ─── 8. HEADER QUICK FILTERS ─── */
function resetNumericAndChipFilters() {
  activeFilters.priceMin  = null;
  activeFilters.priceMax  = null;
  activeFilters.areaMin   = null;
  activeFilters.areaMax   = null;
  activeFilters.bedrooms  = 0;
  activeFilters.bathrooms = 0;
  
  document.getElementById('f-price-min').value = '';
  document.getElementById('f-price-max').value = '';
  document.getElementById('f-area-min').value  = '';
  document.getElementById('f-area-max').value  = '';
  
  document.querySelectorAll('#f-bedrooms .chip, #f-bathrooms .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.val === '0');
  });
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // 1. Limpiar filtros numéricos y campos del drawer
    resetNumericAndChipFilters();

    // 2. Aplicar el tipo seleccionado
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const val = btn.dataset.type;
    syncTipoChips(val);
    activeFilters.type = val;

    // 3. Recargar el mapa con Auto-Zoom a ese tipo
    refreshMap();
  });
});

/* ─── 9. FILTER DRAWER ─── */
const filterDrawer  = document.getElementById('filter-drawer');
const filterOverlay = document.getElementById('filter-overlay');

function openDrawer() {
  filterDrawer.classList.remove('hidden');
  filterOverlay.classList.remove('hidden');
}
function closeDrawer() {
  filterDrawer.classList.add('hidden');
  filterOverlay.classList.add('hidden');
}

document.getElementById('open-filter-btn').addEventListener('click', openDrawer);
document.getElementById('close-filter-btn').addEventListener('click', closeDrawer);
document.getElementById('custom-search-btn').addEventListener('click', openDrawer);
filterOverlay.addEventListener('click', closeDrawer);

// Chips numéricos genéricos (recámaras, baños)
function setupChips(groupId, stateKey) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilters[stateKey] = parseInt(chip.dataset.val, 10);
    });
  });
}
setupChips('f-bedrooms', 'bedrooms');
setupChips('f-bathrooms', 'bathrooms');

// Chips de tipo de propiedad en el drawer (sincronización bidireccional)
function syncTipoChips(val) {
  document.querySelectorAll('#f-tipo .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.val === val);
  });
}
document.querySelectorAll('#f-tipo .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const val = chip.dataset.val;
    syncTipoChips(val);
    activeFilters.type = val;
    // Sincroniza botones rápidos del header
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.type === val);
    });
  });
});
// Al abrir el drawer, refleja el tipo activo
document.getElementById('open-filter-btn').addEventListener('click', () => syncTipoChips(activeFilters.type));
document.getElementById('custom-search-btn').addEventListener('click', () => syncTipoChips(activeFilters.type));


document.getElementById('apply-filters-btn').addEventListener('click', () => {
  const pMin = document.getElementById('f-price-min').value;
  const pMax = document.getElementById('f-price-max').value;
  const aMin = document.getElementById('f-area-min').value;
  const aMax = document.getElementById('f-area-max').value;
  activeFilters.priceMin = pMin ? Number(pMin) : null;
  activeFilters.priceMax = pMax ? Number(pMax) : null;
  activeFilters.areaMin  = aMin ? Number(aMin) : null;
  activeFilters.areaMax  = aMax ? Number(aMax) : null;
  // Lee el tipo activo del drawer y sincroniza el header
  const tipoActivo = document.querySelector('#f-tipo .chip.active')?.dataset.val || 'all';
  activeFilters.type = tipoActivo;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === tipoActivo);
  });
  refreshMap();
  closeDrawer();
});



document.getElementById('clear-filters-btn').addEventListener('click', () => {
  resetNumericAndChipFilters();
  refreshMap();
});

/* ─── 10. PROPERTY MODAL ─── */
function openModal(id) {
  const prop = properties.find(p => p.id === id);
  if (!prop) return;
  currentPropId = id;

  const modal = document.getElementById('prop-modal');

  /* Tags */
  const tagsEl = document.getElementById('modal-tags');
  tagsEl.innerHTML = `
    <span class="tag ${getTypeClass(prop.tipo)}">${prop.tipo}</span>
    <span class="tag tag-id">#${prop.id}</span>
  `;

  /* Title & Price */
  document.getElementById('modal-title').textContent =
    `${prop.tipo} en Malinalco`;
  document.getElementById('modal-price').textContent = fmtPrice(prop.precioMXN);

  /* Spec grid */
  const specs = [
    { icon: 'square_foot',    label: 'Superficie',   val: `${prop.areaM2.toLocaleString()} m²` },
    ...(prop.construccionM2 > 0 ? [{ icon: 'foundation', label: 'Construcción', val: `${prop.construccionM2.toLocaleString()} m²` }] : []),
    ...(prop.recamaras > 0 ? [{ icon: 'bed',         label: 'Recámaras',   val: prop.recamaras }] : []),
    ...(prop.baños > 0     ? [{ icon: 'bathtub',     label: 'Baños',       val: prop.baños }]     : []),
    ...(prop.antiguedad > 0 ? [{ icon: 'history',    label: 'Antigüedad',  val: `${prop.antiguedad} años` }] : []),
    { icon: 'sell',          label: 'Precio/m²',    val: `$${Math.round(prop.precioMXN / prop.areaM2).toLocaleString('es-MX')}` }
  ];

  document.getElementById('spec-grid').innerHTML = specs.map(s => `
    <div class="spec-item">
      <span class="material-icons">${s.icon}</span>
      <div class="spec-item-info">
        <span>${s.label}</span>
        <strong>${s.val}</strong>
      </div>
    </div>
  `).join('');

  /* Normativa */
  const normBox = document.getElementById('normativa-box');
  if (prop.normativa) {
    normBox.classList.remove('hidden');
    document.getElementById('normativa-text').textContent = prop.normativa;
  } else {
    normBox.classList.add('hidden');
  }

  /* WhatsApp */
  const [lat, lng] = getCentroid(prop.coords);
  const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
  const msg = encodeURIComponent(
    `Hola, me interesa esta propiedad:\n- ${prop.tipo} en Malinalco\n- Precio: ${fmtPrice(prop.precioMXN)}\n- Superficie: ${prop.areaM2} m²\n- Ubicación: ${mapsLink}\n\n¿Podrían darme más información?`
  );
  document.getElementById('whatsapp-btn').href =
    `https://wa.me/5521916202?text=${msg}`;

  /* Image Slider */
  buildSlider(prop.imagenes);

  /* Similar */
  buildSimilar(prop);

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

document.getElementById('modal-close-btn').addEventListener('click', closeModal);
document.getElementById('prop-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('lightbox-modal').classList.contains('hidden')) {
      closeLightbox();
    } else {
      closeModal();
    }
  }
});

function closeModal() {
  document.getElementById('prop-modal').classList.add('hidden');
  document.body.style.overflow = '';
  currentPropId = null;
}

/* ─── 11. IMAGE SLIDER ─── */
function buildSlider(images) {
  currentSlide = 0;
  const track = document.getElementById('slider-track');
  const dots  = document.getElementById('slider-dots');

  track.innerHTML = images.map((src, i) =>
    `<img src="${src}" alt="Imagen ${i+1}" loading="lazy" data-idx="${i}" />`
  ).join('');

  dots.innerHTML = images.map((_, i) =>
    `<div class="dot ${i === 0 ? 'active' : ''}" data-idx="${i}"></div>`
  ).join('');

  // Clic en foto del slider -> abrir lightbox
  track.querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => openLightbox(images, parseInt(img.dataset.idx, 10)));
  });

  dots.querySelectorAll('.dot').forEach(dot => {
    dot.addEventListener('click', () => goToSlide(parseInt(dot.dataset.idx, 10)));
  });

  updateSlider(images.length);
}

function goToSlide(idx) {
  const track  = document.getElementById('slider-track');
  const imgs   = track.querySelectorAll('img');
  const dots   = document.getElementById('slider-dots').querySelectorAll('.dot');
  currentSlide = (idx + imgs.length) % imgs.length;
  track.style.transform = `translateX(-${currentSlide * 100}%)`;
  dots.forEach((d, i) => d.classList.toggle('active', i === currentSlide));
}

function updateSlider(count) {
  document.getElementById('slider-prev').onclick = () => goToSlide(currentSlide - 1);
  document.getElementById('slider-next').onclick = () => goToSlide(currentSlide + 1);

  // Hide arrows if single image
  const hide = count <= 1;
  document.getElementById('slider-prev').style.display = hide ? 'none' : '';
  document.getElementById('slider-next').style.display = hide ? 'none' : '';
}

/* ─── 12. LIGHTBOX (PANTALLA COMPLETA) ─── */
let lbImages = [];
let lbCurrent = 0;

function openLightbox(images, index) {
  lbImages = images;
  lbCurrent = index;
  document.getElementById('lightbox-modal').classList.remove('hidden');
  updateLightbox();
}

function closeLightbox() {
  document.getElementById('lightbox-modal').classList.add('hidden');
}

function updateLightbox() {
  const imgEl = document.getElementById('lightbox-img');
  const counter = document.getElementById('lightbox-counter');
  
  imgEl.src = lbImages[lbCurrent];
  counter.textContent = `${lbCurrent + 1} / ${lbImages.length}`;

  const hideArrows = lbImages.length <= 1;
  document.getElementById('lightbox-prev').style.display = hideArrows ? 'none' : '';
  document.getElementById('lightbox-next').style.display = hideArrows ? 'none' : '';
}

document.getElementById('lightbox-close-btn').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', () => {
  lbCurrent = (lbCurrent - 1 + lbImages.length) % lbImages.length;
  updateLightbox();
});
document.getElementById('lightbox-next').addEventListener('click', () => {
  lbCurrent = (lbCurrent + 1) % lbImages.length;
  updateLightbox();
});
document.getElementById('lightbox-modal').addEventListener('click', function(e) {
  if (e.target === this) closeLightbox(); // Clic fuera de la imagen cierra el lightbox
});

/* ─── 13. SIMILAR PROPERTIES ─── */
function buildSimilar(prop) {
  const similar = properties
    .filter(p => p.tipo === prop.tipo && p.id !== prop.id && p.status !== 'vendido')
    .slice(0, 4);

  const grid = document.getElementById('similar-grid');
  if (!similar.length) {
    grid.innerHTML = '<p style="color:var(--neutral-500);font-size:13px;">Sin propiedades similares disponibles.</p>';
    return;
  }

  grid.innerHTML = similar.map(p => {
    const thumb = p.imagenes[0];
    return `
      <div class="similar-card" data-id="${p.id}" title="${p.tipo} · ${fmtPrice(p.precioMXN)}">
        <img src="${thumb}" alt="Thumbnail ${p.id}" loading="lazy" />
        <div class="similar-card-info">
          <div class="sc-price">${fmtPrice(p.precioMXN)}</div>
          <div class="sc-name">${p.tipo} · ${p.areaM2} m²</div>
          <div class="sc-area">#${p.id}</div>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.similar-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id));
  });
}

/* ─── 14. INITIAL RENDER ─── */
loadProperties();
