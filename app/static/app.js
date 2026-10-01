/* Ton-Carburant — interface (vanilla JS + Leaflet, sans étape de build). */
(() => {
  "use strict";

  const FUEL_LABELS = { Gazole: "Gazole", SP95: "SP95", SP98: "SP98", E10: "E10", E85: "E85", GPLc: "GPL" };
  const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
  const PLACE_TYPES = { municipality: "Commune", street: "Voie", housenumber: "Adresse", locality: "Lieu-dit" };
  const MAX_MARKERS = 600;   // au-delà, la carte devient lourde sans rien apporter
  const LIST_PAGE = 40;
  const STALE_PRICE_DAYS = 3;
  const TANK_LITRES = 50;
  const RECENTS_MAX = 6;

  const ICONS = {
    pin: '<svg class="sugg__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    city: '<svg class="sugg__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V8l6-4v17M19 21V12l-8-4"/><path d="M8 11h.01M8 15h.01M15 14h.01M15 17h.01"/></svg>',
    area: '<svg class="sugg__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4 6 2.5L21 4v14l-6 2.5L9 18l-6 2.5V6.5L9 4Z"/><path d="M9 4v14M15 6.5v14"/></svg>',
    clock: '<svg class="sugg__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  // Domaine officiel des enseignes les plus fréquentes, pour aller chercher leur favicon
  // (pas de logo dans les données open data : on l'approxime via le favicon du site de la marque).
  const BRAND_LOGO_DOMAINS = {
    carrefour: "carrefour.fr", carrefourmarket: "carrefour.fr", carrefourcontact: "carrefour.fr",
    total: "totalenergies.fr", totalenergies: "totalenergies.fr", totalaccess: "totalenergies.fr", totalcontact: "totalenergies.fr",
    eleclerc: "e.leclerc",
    intermarche: "mousquetaires.com",
    avia: "avia-france.com",
    esso: "esso.fr", essoexpress: "esso.fr",
    systemeu: "magasins-u.com", superu: "magasins-u.com", u: "magasins-u.com",
    stationu: "magasins-u.com", lastationu: "magasins-u.com", uexpress: "magasins-u.com",
    auchan: "auchan.fr",
    eni: "eni.com",
    netto: "netto.fr",
    bp: "www.bp.com",
    shell: "shell.fr",
    dyneff: "dyneff.fr",
    casino: "casino.fr",
    dats24: "dats24.be",
    spar: "spar.fr",
    g20: "g20.fr",
    gulf: "gulfoil.com",
  };

  function brandLogoUrl(brand, size) {
    const key = (brand || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
    const domain = BRAND_LOGO_DOMAINS[key];
    return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}` : null;
  }

  // Logo si la marque est reconnue, sinon repli sur le nom en texte (jamais les deux à la fois :
  // si le logo échoue à charger, le onerror bascule sur le texte au lieu de laisser une image cassée).
  function brandMark(brand, size, textClass) {
    if (!brand) return "";
    const logoUrl = brandLogoUrl(brand, size);
    if (!logoUrl) return `<span class="${textClass}">${escapeHtml(brand)}</span>`;
    return `<span class="brand-mark">
      <img class="brand-mark__logo" src="${logoUrl}" width="${size}" height="${size}" alt="${escapeHtml(brand)}" title="${escapeHtml(brand)}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false">
      <span class="${textClass}" hidden>${escapeHtml(brand)}</span>
    </span>`;
  }

  const $ = (sel) => document.querySelector(sel);
  const el = {
    topbar: $("#topbar"), form: $("#search-form"), input: $("#search-input"), suggestions: $("#suggestions"),
    locate: $("#locate-btn"), fuels: $("#fuels"), radius: $("#radius"), radiusWrap: $("#radius-wrap"),
    message: $("#message"), welcome: $("#welcome"), recents: $("#recents"), recentsList: $("#recents-list"),
    toolbar: $("#toolbar"), summary: $("#summary"), sort: $("#sort"), openNow: $("#open-now"),
    results: $("#results"), resultsStatus: $("#results-status"), freshness: $("#freshness"),
    detail: $("#detail"), detailBar: $("#detail-bar"), detailBody: $("#detail-body"), backdrop: $("#backdrop"),
    mapToggle: $("#map-toggle"), panel: $("#panel"),
  };

  const state = {
    config: null, fuel: "Gazole", radius: 10, place: null, data: null,
    visible: [], mapOrder: [], scale: { lo: 0, hi: 0 },
    sort: "price", openOnly: false, shown: LIST_PAGE,
    selectedId: null, pendingStation: null, hoverId: null, suggestions: [], active: -1, searchSeq: 0, recents: [],
  };

  /* ================= Utilitaires ================= */
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* stockage indisponible */ } },
  };
  const nf3 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const nf2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
  const fmtPrice = (price) => nf3.format(price);
  const fmtDistance = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${nf1.format(km)} km`);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ageDays = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function fmtAge(iso) {
    if (!iso) return "date inconnue";
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.round(hours / 24);
    if (days <= 30) return `il y a ${days} j`;
    return `le ${new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}`;
  }
  const fmtDate = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

  async function api(path, params = {}, signal) {
    const url = new URL(path, window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      let detail = `erreur ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") detail = body.detail;
      } catch { /* corps non JSON */ }
      throw new Error(detail);
    }
    return response.json();
  }

  function showMessage(text, kind = "info") {
    el.message.textContent = text;
    el.message.className = `message message--${kind}`;
    el.message.hidden = false;
  }
  const hideMessage = () => { el.message.hidden = true; };

  /* ================= Couleurs de prix ================= */
  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const low = Math.floor(pos);
    const high = Math.ceil(pos);
    return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
  }
  function computeScale(stations) {
    const prices = stations.filter((s) => s.status === "ok").map((s) => s.price).sort((a, b) => a - b);
    // Déciles 10–90 % : une station d'autoroute très chère n'écrase pas le dégradé.
    state.scale = prices.length ? { lo: quantile(prices, 0.1), hi: quantile(prices, 0.9) } : { lo: 0, hi: 0 };
  }
  function priceHue(price) {
    const { lo, hi } = state.scale;
    const t = hi > lo ? clamp((price - lo) / (hi - lo), 0, 1) : 0;
    return Math.round(135 * (1 - t)); // 135 = vert, 0 = rouge
  }

  /* ================= Carte ================= */
  let map;
  let areaLayer;
  let stationLayer;
  const markers = new Map();

  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([46.7, 2.4], 6);
    L.tileLayer(state.config.tile_url, {
      maxZoom: state.config.tile_max_zoom,
      attribution: state.config.tile_attribution,
    }).addTo(map);
    areaLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);

    const legend = L.control({ position: "bottomleft" });
    legend.onAdd = () => {
      const box = L.DomUtil.create("div", "legend");
      box.innerHTML = '<span>moins cher</span><span class="legend__bar"></span><span>plus cher</span>';
      return box;
    };
    legend.addTo(map);

    let frame = 0;
    const relayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layoutPins);
    };
    map.on("zoomend moveend resize", relayout);
  }

  function pinIcon(station, selected) {
    const out = station.status !== "ok";
    const classes = `pin${out ? " pin--out" : ""}${selected ? " is-selected" : ""}`;
    const style = out ? "" : ` style="--h:${priceHue(station.price)}"`;
    const text = out ? "Rupture" : fmtPrice(station.price);
    return L.divIcon({ className: "pin-wrap", html: `<span class="${classes}"${style}>${text}</span>`, iconSize: null, iconAnchor: [0, 0] });
  }
  function dotIcon(station, selected) {
    const out = station.status !== "ok";
    const classes = `pin-dot${out ? " pin-dot--out" : ""}${selected ? " is-selected" : ""}`;
    const style = out ? "" : ` style="--h:${priceHue(station.price)}"`;
    return L.divIcon({ className: "pin-dot-wrap", html: `<span class="${classes}"${style}></span>`, iconSize: [13, 13], iconAnchor: [7, 7] });
  }

  function setMarkerMode(marker, station, mode, selected) {
    const key = `${mode}|${selected}`;
    if (marker._mode === key) return;
    marker._mode = key;
    marker.setIcon(mode === "pin" ? pinIcon(station, selected) : dotIcon(station, selected));
    marker.setZIndexOffset(selected ? 100000 : mode === "pin" ? 1000 : 0);
  }

  /* Étiquettes de prix sans chevauchement : les moins chères sont posées en
     premier, celles qui n'ont plus la place deviennent de simples points. */
  function layoutPins() {
    if (!map || !state.mapOrder.length) return;
    const placed = [];
    const bounds = map.getBounds();
    for (const station of state.mapOrder) {
      const marker = markers.get(station.id);
      if (!marker) continue;
      const selected = station.id === state.selectedId;
      let mode = "dot";
      if (bounds.contains(marker.getLatLng())) {
        const point = map.latLngToContainerPoint(marker.getLatLng());
        const width = station.status === "ok" ? 62 : 72;
        const box = { x1: point.x - width / 2, y1: point.y - 38, x2: point.x + width / 2, y2: point.y - 4 };
        const collides = placed.some((other) => other.x1 < box.x2 && box.x1 < other.x2 && other.y1 < box.y2 && box.y1 < other.y2);
        if (selected || !collides) {
          placed.push(box);
          mode = "pin";
        }
      }
      setMarkerMode(marker, station, mode, selected);
    }
  }

  function renderMap(fit) {
    if (!map) return;
    areaLayer.clearLayers();
    stationLayer.clearLayers();
    markers.clear();
    map.invalidateSize();

    const { data } = state;
    const bounds = L.latLngBounds([]);
    if (data.center) {
      const circle = L.circle([data.center.lat, data.center.lon], {
        radius: data.radius_km * 1000, color: "#2563eb", weight: 1.5, fillOpacity: 0.05, interactive: false,
      }).addTo(areaLayer);
      L.circleMarker([data.center.lat, data.center.lon], {
        radius: 6, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1, interactive: false,
      }).addTo(areaLayer);
      bounds.extend(circle.getBounds());
    }

    for (const station of state.mapOrder) {
      const marker = L.marker([station.lat, station.lon], {
        icon: dotIcon(station, false), keyboard: true, title: `${station.address}, ${station.city}`,
      });
      marker._mode = "dot|false";
      marker.on("click", () => selectStation(station.id, { fromMap: true }));
      marker.on("mouseover", () => setHover(station.id));
      marker.on("mouseout", () => setHover(null));
      marker.addTo(stationLayer);
      markers.set(station.id, marker);
      if (!data.center) bounds.extend([station.lat, station.lon]);
    }

    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [26, 26], maxZoom: 14 });
    layoutPins();
  }

  function markerElement(id) {
    return markers.get(id)?.getElement()?.firstElementChild ?? null;
  }
  function setHover(id) {
    if (state.hoverId === id) return;
    markerElement(state.hoverId)?.classList.remove("is-hover");
    state.hoverId = id;
    markerElement(id)?.classList.add("is-hover");
  }

  /* ================= Filtres ================= */
  function buildFilters() {
    el.fuels.insertAdjacentHTML("beforeend", state.config.fuels.map((fuel) => `
      <label class="chip">
        <input type="radio" name="fuel" value="${escapeHtml(fuel.code)}"${fuel.code === state.fuel ? " checked" : ""}>
        <span>${escapeHtml(fuel.label)}</span>
      </label>`).join(""));

    const options = [...new Set([...state.config.radius_options_km, state.radius])].sort((a, b) => a - b);
    el.radius.innerHTML = options.map((km) => `<option value="${km}"${km === state.radius ? " selected" : ""}>${nf1.format(km)} km</option>`).join("");

    el.sort.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sort === state.sort);
    });
    el.openNow.checked = state.openOnly;

    el.fuels.addEventListener("change", (event) => {
      state.fuel = event.target.value;
      storage.set("fuel", state.fuel);
      runSearch();
    });
    el.radius.addEventListener("change", () => {
      setRadius(Number(el.radius.value));
      runSearch();
    });
    el.sort.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-sort]");
      if (!button || button.dataset.sort === state.sort) return;
      state.sort = button.dataset.sort;
      storage.set("sort", state.sort);
      el.sort.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
      render();
    });
    el.openNow.addEventListener("change", () => {
      state.openOnly = el.openNow.checked;
      storage.set("openOnly", state.openOnly ? "1" : "0");
      render();
    });
    updateFuelsMask();
    window.addEventListener("resize", updateFuelsMask);
  }

  function updateFuelsMask() {
    el.fuels.classList.toggle("is-scrollable", el.fuels.scrollWidth > el.fuels.clientWidth + 4);
  }
  function setRadius(km) {
    state.radius = km;
    el.radius.value = String(km);
    storage.set("radius", String(km));
  }

  /* ================= Recherches récentes ================= */
  function loadRecents() {
    try { state.recents = JSON.parse(storage.get("recents") || "[]").slice(0, RECENTS_MAX); } catch { state.recents = []; }
  }
  function rememberPlace(place) {
    const key = (item) => item.area || `${item.lat},${item.lon}`;
    state.recents = [place, ...state.recents.filter((item) => key(item) !== key(place))].slice(0, RECENTS_MAX);
    storage.set("recents", JSON.stringify(state.recents));
    renderRecents();
  }
  function renderRecents() {
    el.recents.hidden = state.recents.length === 0;
    el.recentsList.innerHTML = state.recents.map((place, index) => `
      <button type="button" class="recent" data-recent="${index}">${ICONS.clock}${escapeHtml(place.label)}</button>`).join("");
  }

  /* ================= Suggestions de lieux ================= */
  let suggestTimer;
  let suggestController;

  function suggestionIcon(result) {
    if (result.recent) return ICONS.clock;
    if (result.area) return ICONS.area;
    return result.type === "municipality" ? ICONS.city : ICONS.pin;
  }
  function suggestionContext(result) {
    if (result.recent) return "Recherche récente";
    if (result.area) return result.context;
    return [PLACE_TYPES[result.type] || "Lieu", result.context].filter(Boolean).join(" · ");
  }

  function renderSuggestions() {
    if (!state.suggestions.length) return hideSuggestions();
    el.suggestions.innerHTML = state.suggestions.map((result, index) => `
      <li role="option" id="sugg-${index}" data-index="${index}" class="${index === state.active ? "is-active" : ""}" aria-selected="${index === state.active}">
        ${suggestionIcon(result)}
        <span>
          <span class="sugg__label">${escapeHtml(result.label)}</span>
          <span class="sugg__ctx">${escapeHtml(suggestionContext(result))}</span>
        </span>
      </li>`).join("");
    el.suggestions.hidden = false;
    el.input.setAttribute("aria-expanded", "true");
    if (state.active >= 0) el.input.setAttribute("aria-activedescendant", `sugg-${state.active}`);
    else el.input.removeAttribute("aria-activedescendant");
  }

  function hideSuggestions() {
    el.suggestions.hidden = true;
    el.input.setAttribute("aria-expanded", "false");
    el.input.removeAttribute("aria-activedescendant");
    state.active = -1;
  }

  async function loadSuggestions(query) {
    suggestController?.abort();
    suggestController = new AbortController();
    try {
      const { results } = await api("api/geocode", { q: query }, suggestController.signal);
      if (el.input.value.trim() !== query) return;
      state.suggestions = results;
      state.active = -1;
      renderSuggestions();
    } catch (error) {
      if (error.name !== "AbortError") hideSuggestions();
    }
  }

  function showRecentSuggestions() {
    if (!state.recents.length) return;
    state.suggestions = state.recents.map((place) => ({ ...place, recent: true }));
    state.active = -1;
    renderSuggestions();
  }

  function choosePlace(result, { remember = true } = {}) {
    state.place = result.area
      ? { label: result.label, area: result.area }
      : { label: result.label, lat: result.lat, lon: result.lon };
    el.input.value = result.label;
    hideSuggestions();
    el.input.blur(); // referme le clavier sur mobile
    if (remember) rememberPlace(state.place);
    runSearch();
  }

  async function searchQuery(query) {
    el.input.value = query;
    hideSuggestions();
    document.body.classList.add("is-loading");
    try {
      const { results } = await api("api/geocode", { q: query });
      if (!results.length) {
        showMessage(`Aucun lieu trouvé pour « ${query} ». Essayez une ville, un code postal ou un département.`, "error");
        return;
      }
      choosePlace(results[0]);
    } catch (error) {
      showMessage(`Recherche impossible : ${error.message}`, "error");
    } finally {
      document.body.classList.remove("is-loading");
    }
  }

  el.input.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const query = el.input.value.trim();
    if (query.length < 2) {
      state.suggestions = [];
      hideSuggestions();
      if (!query) showRecentSuggestions();
      return;
    }
    suggestTimer = setTimeout(() => loadSuggestions(query), 180);
  });
  el.input.addEventListener("focus", () => {
    if (!el.input.value.trim()) showRecentSuggestions();
  });
  el.input.addEventListener("keydown", (event) => {
    if (el.suggestions.hidden) return;
    const count = state.suggestions.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      state.active = (state.active + step + count + 1) % (count + 1);
      if (state.active === count) state.active = -1;
      renderSuggestions();
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });
  el.input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));
  el.suggestions.addEventListener("mousedown", (event) => {
    const item = event.target.closest("li[data-index]");
    if (!item) return;
    event.preventDefault();
    choosePlace(state.suggestions[Number(item.dataset.index)]);
  });

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(suggestTimer);
    if (state.active >= 0 && state.suggestions[state.active]) return choosePlace(state.suggestions[state.active]);
    const query = el.input.value.trim();
    if (!query) return el.input.focus();
    if (state.place && state.place.label === query) return runSearch();
    searchQuery(query);
  });

  function locate() {
    if (!("geolocation" in navigator)) {
      showMessage("La géolocalisation n'est pas disponible sur cet appareil.", "error");
      return;
    }
    el.locate.classList.add("is-busy");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        el.locate.classList.remove("is-busy");
        choosePlace({ label: "Ma position", lat: position.coords.latitude, lon: position.coords.longitude }, { remember: false });
      },
      (error) => {
        el.locate.classList.remove("is-busy");
        showMessage(error.code === 1
          ? "Autorisez l'accès à la position pour chercher autour de vous, ou tapez une ville."
          : "Position introuvable pour le moment : tapez plutôt une ville ou un code postal.", "error");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }
  el.locate.addEventListener("click", locate);

  /* ================= Recherche de stations ================= */
  function updateUrl() {
    const { place } = state;
    if (!place) return;
    const params = new URLSearchParams({ q: place.label, fuel: state.fuel });
    if (place.area) {
      params.set("area", place.area);
    } else {
      params.set("lat", place.lat.toFixed(5));
      params.set("lon", place.lon.toFixed(5));
      params.set("r", String(state.radius));
    }
    if (state.selectedId) params.set("station", String(state.selectedId)); // lien direct vers une station
    history.replaceState(null, "", `?${params}`);
  }

  function restoreFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const fuel = params.get("fuel");
    if (fuel && FUEL_LABELS[fuel]) state.fuel = fuel;
    const radius = Number(params.get("r"));
    if (radius > 0) state.radius = Math.min(radius, state.config.max_radius_km);
    const label = params.get("q") || "";
    const lat = Number(params.get("lat"));
    const lon = Number(params.get("lon"));
    if (params.get("area")) state.place = { label: label || "Zone", area: params.get("area") };
    else if (params.has("lat") && Number.isFinite(lat) && Number.isFinite(lon)) state.place = { label: label || "Position", lat, lon };
    const station = Number(params.get("station"));
    if (Number.isInteger(station) && station > 0) state.pendingStation = station;
  }

  function renderSkeleton() {
    el.toolbar.hidden = true;
    el.welcome.hidden = true;
    el.results.innerHTML = Array.from({ length: 6 }, () => '<li class="skeleton"></li>').join("");
  }

  async function runSearch() {
    if (!state.place) return;
    const seq = ++state.searchSeq;
    const { place } = state;
    const params = { fuel: state.fuel };
    if (place.area) params.area = place.area;
    else Object.assign(params, { lat: place.lat, lon: place.lon, radius_km: state.radius });

    el.radiusWrap.hidden = Boolean(place.area);
    document.body.classList.add("is-loading");
    closeDetail();
    hideMessage();
    renderSkeleton();
    updateUrl();
    try {
      const data = await api("api/stations", params);
      if (seq !== state.searchSeq) return;
      state.data = data;
      state.shown = LIST_PAGE;
      computeScale(data.stations);
      document.body.classList.add("has-results");
      render(true);
      if (state.pendingStation) {
        const pending = state.pendingStation;
        state.pendingStation = null;
        selectStation(pending);
      }
    } catch (error) {
      if (seq !== state.searchSeq) return;
      el.results.innerHTML = "";
      showMessage(`Recherche impossible : ${error.message}`, "error");
    } finally {
      if (seq === state.searchSeq) document.body.classList.remove("is-loading");
    }
  }

  /* ================= Rendu ================= */
  function computeVisible() {
    const byStatus = (station) => (station.status === "ok" ? 0 : 1);
    let list = state.data.stations;
    if (state.openOnly) list = list.filter((station) => station.open_now !== false);
    list = list.slice().sort((a, b) => byStatus(a) - byStatus(b) || (state.sort === "distance"
      ? (a.distance_km ?? 0) - (b.distance_km ?? 0) || (a.price ?? Infinity) - (b.price ?? Infinity)
      : (a.price ?? Infinity) - (b.price ?? Infinity) || (a.distance_km ?? 0) - (b.distance_km ?? 0)));
    state.visible = list;
    state.mapOrder = list
      .slice()
      .sort((a, b) => byStatus(a) - byStatus(b) || (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, MAX_MARKERS);
  }

  function render(fit = false) {
    if (!state.data) return;
    computeVisible();
    renderToolbar();
    renderList();
    renderMap(fit);
  }

  function scopeText() {
    const { data, place } = state;
    if (data.area) return `en ${data.area.label}`;
    return `à moins de ${nf1.format(data.radius_km)} km de ${place.label}`;
  }

  function renderToolbar() {
    const { data } = state;
    const fuel = FUEL_LABELS[data.fuel];
    const shown = state.visible.filter((station) => station.status === "ok").length;
    const hiddenByFilter = data.count - shown;

    const details = [];
    if (hiddenByFilter > 0) details.push(`${hiddenByFilter} masquée${hiddenByFilter > 1 ? "s" : ""} (fermées)`);
    if (data.rupture_count) details.push(`${data.rupture_count} en rupture`);
    if (data.absent_count) details.push(`${data.absent_count} sans ${fuel} déclaré`);

    el.summary.innerHTML = `
      <h2 class="summary__title">${shown} station${shown > 1 ? "s" : ""} · ${escapeHtml(fuel)}</h2>
      <p class="summary__sub">${escapeHtml(scopeText())}${details.length ? ` · ${escapeHtml(details.join(" · "))}` : ""}</p>`;
    el.toolbar.hidden = false;
    el.sort.hidden = Boolean(data.area); // sans point de départ, trier par distance n'a pas de sens
    el.resultsStatus.textContent = `${shown} stations avec ${fuel} ${scopeText()}.`;
  }

  const isStale = (station) => station.status === "ok" && ageDays(station.price_updated_at) > STALE_PRICE_DAYS;

  function stationTags(station) {
    const tags = [];
    if (station.open_now === true) tags.push('<span class="tag tag--open">Ouvert</span>');
    else if (station.open_now === false) tags.push('<span class="tag tag--closed">Fermé</span>');
    if (station.automate_24_24) tags.push('<span class="tag">24/24</span>');
    if (station.highway) tags.push('<span class="tag">Autoroute</span>');
    if (isStale(station)) tags.push(`<span class="tag tag--warn">prix ${fmtAge(station.price_updated_at)}</span>`);
    if (station.status === "rupture") tags.push(`<span class="tag tag--out">rupture ${fmtAge(station.rupture_since)}</span>`);
    return tags.length ? `<span class="card__tags">${tags.join("")}</span>` : "";
  }

  function stationCard(station, rank, cheapest) {
    const ok = station.status === "ok";
    const meta = [escapeHtml(station.city)];
    if (station.distance_km != null) meta.push(fmtDistance(station.distance_km));
    // Un prix ancien est déjà signalé par un badge : inutile de répéter la date ici.
    if (ok && !isStale(station)) meta.push(`maj ${fmtAge(station.price_updated_at)}`);

    const gap = ok && cheapest != null ? station.price - cheapest : 0;
    const delta = gap >= 0.005 ? `<span class="card__delta">+${nf3.format(gap)} €</span>` : "";
    const price = ok
      ? `<span class="price" style="--h:${priceHue(station.price)}">${fmtPrice(station.price)}<small>€/L</small></span>${delta}`
      : '<span class="price">Rupture</span>';

    const brand = brandMark(station.brand, 20, "card__brand");

    return `
      <li><button type="button" class="card card--${station.status}${station.id === state.selectedId ? " is-selected" : ""}" data-id="${station.id}">
        <span class="card__rank">${ok ? rank : "—"}</span>
        <span>
          ${brand}
          <span class="card__title">${escapeHtml(station.address) || "Adresse non renseignée"}</span>
          <span class="card__meta">${meta.join(" · ")}</span>
          ${stationTags(station)}
        </span>
        <span class="card__price">${price}</span>
      </button></li>`;
  }

  function renderBest() {
    const { data } = state;
    const best = state.visible.find((station) => station.status === "ok");
    if (!best || !data.stats) return "";
    const saving = data.stats.median - best.price;
    const where = [escapeHtml(best.city), best.distance_km != null ? fmtDistance(best.distance_km) : ""].filter(Boolean).join(" · ");
    const brand = best.brand ? `${brandMark(best.brand, 16, "card__brand")} ` : "";
    return `
      <div class="best"><button type="button" data-id="${best.id}">
        <span class="best__label">Le moins cher · ${escapeHtml(FUEL_LABELS[data.fuel])}</span>
        <span class="best__row">
          <span class="best__price">${fmtPrice(best.price)}<small>€/L</small></span>
          <span class="best__where">${brand}${escapeHtml(best.address)}<span>${where}</span></span>
        </span>
        ${saving >= 0.005 ? `<p class="best__saving"><strong>${nf2.format(saving * TANK_LITRES)} € d'économie</strong> sur un plein de ${TANK_LITRES} L par rapport au prix médian du secteur (${fmtPrice(data.stats.median)} €)</p>` : ""}
      </button></div>`;
  }

  function renderList() {
    const { data } = state;
    const fuel = FUEL_LABELS[data.fuel];

    if (!state.visible.length) {
      const next = state.config.radius_options_km.find((km) => km > (data.radius_km || Infinity));
      el.results.innerHTML = `<li class="empty">
        <p>${state.openOnly ? `Aucune station ouverte avec ${escapeHtml(fuel)} dans cette zone.` : `Aucune station ne déclare de ${escapeHtml(fuel)} dans cette zone.`}</p>
        ${state.openOnly ? '<button type="button" class="btn" data-action="show-all">Afficher aussi les stations fermées</button>' : ""}
        ${next ? `<button type="button" class="btn btn--primary" data-action="widen" data-radius="${next}">Élargir à ${nf1.format(next)} km</button>` : ""}
      </li>`;
      return;
    }

    const cheapest = state.visible.find((station) => station.status === "ok")?.price;
    const visible = state.visible.slice(0, state.shown);
    let html = renderBest();
    let rank = 0;
    let dividerShown = false;
    for (const station of visible) {
      if (station.status !== "ok" && !dividerShown) {
        html += '<li class="results__divider">En rupture de stock</li>';
        dividerShown = true;
      }
      html += stationCard(station, station.status === "ok" ? ++rank : null, cheapest);
    }
    const remaining = state.visible.length - visible.length;
    if (remaining > 0) {
      html += `<li><button type="button" class="btn more" data-action="more">Afficher ${Math.min(remaining, LIST_PAGE)} stations de plus</button></li>`;
    }
    el.results.innerHTML = html;
  }

  /* ================= Fiche station ================= */
  function dayText(day) {
    if (!day) return "Non renseigné";
    const slots = (day.slots || []).filter(([open, close]) => open !== close);
    if (slots.some(([open, close]) => open === "00:00" && ["23:59", "00:00", "24:00"].includes(close))) return "24 h/24";
    if (slots.length) return slots.map(([open, close]) => `${open.replace(":", "h")} – ${close.replace(":", "h")}`).join(", ");
    return day.closed ? "Fermé" : "Non renseigné";
  }

  function renderHours(station) {
    const badge = station.automate_24_24
      ? '<p class="note"><strong>Automate 24 h/24</strong> — paiement par carte en dehors des heures d\'ouverture.</p>' : "";
    const hours = station.hours || [];
    const informative = hours.some((day) => (day.slots || []).some(([open, close]) => open !== close));
    if (!informative) return `<p class="muted">Horaires non renseignés par la station.</p>${badge}`;
    const today = ((new Date().getDay() + 6) % 7) + 1;
    const rows = DAYS.map((name, index) => {
      const day = hours.find((item) => item.day === index + 1);
      return `<tr class="${index + 1 === today ? "is-today" : ""}"><td>${name}</td><td>${dayText(day)}</td></tr>`;
    }).join("");
    return `<table class="hours">${rows}</table>${badge}<p class="note">Horaires déclarés par la station, à titre indicatif.</p>`;
  }

  function renderDetail(station) {
    const listed = state.data?.stations.find((item) => item.id === station.id);
    const sub = [`${escapeHtml(station.cp)} ${escapeHtml(station.city)}`];
    if (listed?.distance_km != null) sub.push(fmtDistance(listed.distance_km));

    const tags = [];
    if (station.open_now === true) tags.push('<span class="tag tag--open">Ouvert maintenant</span>');
    else if (station.open_now === false) tags.push('<span class="tag tag--closed">Fermé maintenant</span>');
    if (station.automate_24_24) tags.push('<span class="tag">Automate 24/24</span>');
    if (station.highway) tags.push('<span class="tag">Autoroute</span>');

    const fuels = station.fuels.length ? `<div class="fuel-grid">${station.fuels.map((fuel) => {
      const current = fuel.code === state.fuel ? " is-current" : "";
      if (fuel.status === "ok") {
        const stale = ageDays(fuel.updated_at) > STALE_PRICE_DAYS;
        return `<div class="fuel-card${current}">
          <div class="fuel-card__name">${escapeHtml(fuel.label)}</div>
          <div class="fuel-card__price">${fmtPrice(fuel.price)}<small> €/L</small></div>
          <div class="fuel-card__meta${stale ? " tag tag--warn" : ""}">maj ${fmtAge(fuel.updated_at)}</div>
        </div>`;
      }
      if (fuel.status === "rupture") {
        return `<div class="fuel-card fuel-card--out${current}">
          <div class="fuel-card__name">${escapeHtml(fuel.label)}</div>
          <div class="fuel-card__price">Rupture</div>
          <div class="fuel-card__meta">${fuel.rupture_since ? `depuis le ${fmtDate(fuel.rupture_since)}` : "en cours"}</div>
        </div>`;
      }
      return `<div class="fuel-card fuel-card--na${current}">
        <div class="fuel-card__name">${escapeHtml(fuel.label)}</div>
        <div class="fuel-card__price">Non distribué</div>
      </div>`;
    }).join("")}</div>` : '<p class="muted">Aucun prix déclaré par cette station.</p>';

    const services = station.services.length
      ? `<ul class="services">${station.services.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>`
      : '<p class="muted">Aucun service renseigné.</p>';

    const destination = `${station.lat},${station.lon}`;
    return `
      ${station.brand ? `<p class="detail__brand">${brandMark(station.brand, 32, "detail__brand-text")}</p>` : ""}
      <h2>${escapeHtml(station.address) || "Station-service"}</h2>
      <p class="detail__sub">${sub.join(" · ")}</p>
      ${tags.length ? `<div class="detail__tags">${tags.join("")}</div>` : ""}
      <div class="detail__actions">
        <a class="btn btn--primary" href="https://www.google.com/maps/dir/?api=1&destination=${destination}" target="_blank" rel="noopener">Itinéraire</a>
        <a class="btn" href="https://waze.com/ul?ll=${destination}&navigate=yes" target="_blank" rel="noopener">Waze</a>
      </div>
      <h3>Prix</h3>
      ${fuels}
      <p class="note">Les carburants absents de cette liste ne sont pas déclarés par la station.</p>
      <h3>Horaires</h3>
      ${renderHours(station)}
      <h3>Services</h3>
      ${services}`;
  }

  async function selectStation(id, { fromMap = false } = {}) {
    state.selectedId = id;
    document.querySelectorAll(".card.is-selected").forEach((node) => node.classList.remove("is-selected"));
    const card = document.querySelector(`.card[data-id="${id}"]`);
    card?.classList.add("is-selected");
    if (fromMap) card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    layoutPins();

    const listed = state.data?.stations.find((station) => station.id === id);
    if (listed && !fromMap) map.setView([listed.lat, listed.lon], Math.max(map.getZoom(), 13), { animate: true });

    el.detailBody.innerHTML = '<p class="muted">Chargement…</p>';
    el.detail.hidden = false;
    el.detail.style.transform = "";
    el.backdrop.hidden = false;
    el.detail.focus({ preventScroll: true });
    updateUrl();
    try {
      const station = await api(`api/stations/${id}`);
      if (state.selectedId !== id) return;
      el.detailBody.innerHTML = renderDetail(station);
      el.detailBody.scrollTop = 0;
    } catch (error) {
      el.detailBody.innerHTML = `<p class="message message--error">Fiche indisponible : ${escapeHtml(error.message)}</p>`;
    }
  }

  function closeDetail() {
    el.detail.hidden = true;
    el.backdrop.hidden = true;
    if (state.selectedId === null) return;
    document.querySelector(`.card[data-id="${state.selectedId}"]`)?.classList.remove("is-selected");
    state.selectedId = null;
    layoutPins();
    updateUrl();
  }

  /* Glisser la poignée vers le bas ferme la fiche (mobile). */
  (() => {
    let startY = null;
    el.detailBar.addEventListener("touchstart", (event) => { startY = event.touches[0].clientY; }, { passive: true });
    el.detailBar.addEventListener("touchmove", (event) => {
      if (startY === null) return;
      const delta = Math.max(0, event.touches[0].clientY - startY);
      el.detail.style.transform = `translateY(${delta}px)`;
    }, { passive: true });
    el.detailBar.addEventListener("touchend", (event) => {
      const delta = startY === null ? 0 : event.changedTouches[0].clientY - startY;
      startY = null;
      el.detail.style.transform = "";
      if (delta > 90) closeDetail();
    });
  })();

  /* ================= Carte plein écran (mobile) ================= */
  function toggleMap() {
    const full = document.body.classList.toggle("map-full");
    el.mapToggle.querySelector(".map-toggle__label").textContent = full ? "Réduire" : "Agrandir";
    requestAnimationFrame(() => {
      map.invalidateSize();
      layoutPins();
    });
  }

  /* ================= Actions globales ================= */
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action], [data-id], [data-query], [data-recent]");
    if (!target) return;
    if (target.dataset.query) return searchQuery(target.dataset.query);
    if (target.dataset.recent) return choosePlace(state.recents[Number(target.dataset.recent)]);
    switch (target.dataset.action) {
      case "locate": return locate();
      case "close-detail": return closeDetail();
      case "toggle-map": return toggleMap();
      case "more":
        state.shown += LIST_PAGE;
        return renderList();
      case "show-all":
        el.openNow.checked = false;
        state.openOnly = false;
        storage.set("openOnly", "0");
        return render();
      case "widen":
        setRadius(Number(target.dataset.radius));
        return runSearch();
      default:
        if (target.dataset.id) selectStation(Number(target.dataset.id));
    }
  });
  el.results.addEventListener("mouseover", (event) => {
    const card = event.target.closest(".card[data-id]");
    if (card) setHover(Number(card.dataset.id));
  });
  el.results.addEventListener("mouseleave", () => setHover(null));
  el.backdrop.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el.suggestions.hidden) return hideSuggestions();
    if (!el.detail.hidden) return closeDetail();
    if (document.body.classList.contains("map-full")) toggleMap();
  });

  /* ================= Statut des données ================= */
  async function refreshStatus() {
    const text = el.freshness.querySelector(".freshness__text");
    try {
      const status = await api("api/status");
      el.freshness.classList.toggle("freshness--ok", !status.stale);
      el.freshness.classList.toggle("freshness--warn", status.stale);
      if (!status.last_success_at) {
        text.textContent = status.last_error ? "Données indisponibles" : "Premier import en cours…";
      } else {
        text.textContent = `Prix ${fmtAge(status.last_success_at)}`;
      }
      el.freshness.title = status.last_success_at
        ? `${status.stations.toLocaleString("fr-FR")} stations · dernière synchronisation ${fmtDate(status.last_success_at)}${status.last_error ? ` · dernière erreur : ${status.last_error}` : ""}`
        : "";
    } catch {
      text.textContent = "Statut indisponible";
      el.freshness.classList.add("freshness--warn");
    }
  }

  /* ================= Démarrage ================= */
  function trackHeaderHeight() {
    const apply = () => document.documentElement.style.setProperty("--header-h", `${el.topbar.offsetHeight}px`);
    apply();
    new ResizeObserver(apply).observe(el.topbar);
  }

  async function init() {
    try {
      state.config = await api("api/config");
    } catch {
      state.config = {
        default_radius_km: 10, max_radius_km: 50, radius_options_km: [5, 10, 15, 20, 30, 50],
        fuels: Object.entries(FUEL_LABELS).map(([code, label]) => ({ code, label })),
        tile_url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        tile_attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        tile_max_zoom: 19,
      };
    }

    const savedFuel = storage.get("fuel");
    if (savedFuel && FUEL_LABELS[savedFuel]) state.fuel = savedFuel;
    const savedRadius = Number(storage.get("radius"));
    state.radius = savedRadius > 0 && savedRadius <= state.config.max_radius_km ? savedRadius : state.config.default_radius_km;
    if (storage.get("sort") === "distance") state.sort = "distance";
    state.openOnly = storage.get("openOnly") === "1";
    loadRecents();
    restoreFromUrl();

    trackHeaderHeight();
    buildFilters();
    renderRecents();
    initMap();
    refreshStatus();
    setInterval(refreshStatus, 5 * 60 * 1000);

    if (state.place) {
      el.input.value = state.place.label;
      runSearch();
    } else {
      el.welcome.hidden = false;
    }
  }

  init();
})();
