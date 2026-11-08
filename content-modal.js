/**
 * YT Scraper Supersónico v2.0
 * Panel Flotante In-Page (Shadow DOM), Selección por Clic con Rango (Shift+Clic),
 * Captura completa de Videos y Shorts, Auto-Scroll inteligente, Filtros y Exportación.
 */
(() => {
  if (
    window.__YT_SCRAPER_SUPERSONICO__ &&
    typeof window.__YT_SCRAPER_SUPERSONICO__.toggleModal === "function"
  ) {
    window.__YT_SCRAPER_SUPERSONICO__.toggleModal();
    return;
  }

  const STORAGE_KEY = "yt_scraper_supersonico_session_v2";
  const HOST_ID = "yt-scraper-supersonico-host";
  const PAGE_STYLE_ID = "yt-scraper-supersonico-page-styles";

  // Selectores de tarjetas de contenido en YouTube (Videos, Shorts, Búsqueda, Playlists, Inicio)
  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-reel-item-renderer",
    "ytm-shorts-lockup-view-model-v2",
    "ytm-shorts-lockup-view-model",
    "ytd-rich-grid-slim-media",
    "ytd-compact-video-renderer"
  ].join(", ");

  // Estado central de la aplicación
  const state = {
    isOpen: true,
    isMinimized: false,
    clickSelectActive: false,
    autoScrolling: false,
    drawerOpen: false,
    contentTypeFilter: "all", // 'all' | 'video' | 'short'
    limitCount: 0, // 0 = todos
    minViewsRaw: "",
    keywordFilter: "",
    sortOrder: "capture", // 'capture' | 'reverse' | 'views_desc'
    convertShortsToWatch: false,
    exportFormat: "urls", // 'urls' | 'title_url' | 'markdown' | 'csv' | 'json'
    items: new Map(), // id -> { id, type, title, viewsText, viewsCount, duration, order }
    nextOrder: 1,
    lastClickedCardId: null,
    hoveredCard: null
  };

  let scrollTimer = null;
  let domObserver = null;
  let syncDebounceTimer = null;

  // ============================================================================
  // 1. PERSISTENCIA EN SESSION STORAGE (Mantiene selección entre pestañas del canal)
  // ============================================================================
  function loadSessionState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        state.items.clear();
        let maxOrder = 0;
        for (const item of parsed.items) {
          if (item && item.id) {
            state.items.set(item.id, item);
            if (typeof item.order === "number" && item.order > maxOrder) {
              maxOrder = item.order;
            }
          }
        }
        state.nextOrder = maxOrder + 1;
      }
      if (typeof parsed.convertShortsToWatch === "boolean") {
        state.convertShortsToWatch = parsed.convertShortsToWatch;
      }
      if (parsed.exportFormat) {
        state.exportFormat = parsed.exportFormat;
      }
      if (parsed.sortOrder) {
        state.sortOrder = parsed.sortOrder;
      }
    } catch (_) {
      // Ignorar errores de parseo
    }
  }

  function saveSessionState() {
    try {
      const payload = {
        items: Array.from(state.items.values()),
        convertShortsToWatch: state.convertShortsToWatch,
        exportFormat: state.exportFormat,
        sortOrder: state.sortOrder
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // Ignorar quota exceeded
    }
  }

  // ============================================================================
  // 2. UTILIDADES DE PARSEO (URLs, IDs, Vistas, Tarjetas Visibles)
  // ============================================================================
  function parseVideoLink(href) {
    if (!href || typeof href !== "string") return null;
    try {
      const u = new URL(href, "https://www.youtube.com");
      // Caso 1: /shorts/{ID}
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{8,15})/);
      if (shortsMatch) {
        return { id: shortsMatch[1], type: "short" };
      }
      // Caso 2: /watch?v={ID}
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        if (v && /^[a-zA-Z0-9_-]{8,15}$/.test(v)) {
          return { id: v, type: "video" };
        }
      }
    } catch (_) {
      // Fallback regex simple si URL falla
      const mShort = href.match(/\/shorts\/([a-zA-Z0-9_-]{8,15})/);
      if (mShort) return { id: mShort[1], type: "short" };
      const mWatch = href.match(/[?&]v=([a-zA-Z0-9_-]{8,15})/);
      if (mWatch) return { id: mWatch[1], type: "video" };
    }
    return null;
  }

  function formatItemUrl(item) {
    if (!item || !item.id) return "";
    if (item.type === "short" && !state.convertShortsToWatch) {
      return `https://www.youtube.com/shorts/${item.id}`;
    }
    return `https://www.youtube.com/watch?v=${item.id}`;
  }

  /**
   * Parsea textos de vistas en español o inglés:
   * Ej: "1.2M de vistas", "45 K vistas", "12,3 mil visualizaciones", "850 views", "1.5B views"
   */
  function parseViewsCount(text) {
    if (!text || typeof text !== "string") return 0;
    const clean = text.replace(/\u00a0/g, " ").trim();
    if (!clean) return 0;

    if (/sin\s+vistas|no\s+views|sin\s+visualizaciones/i.test(clean)) return 0;

    // 1. Intentar emparejar primero un número acompañado explícitamente de la palabra vistas/visualizaciones/views/reproducciones
    const withKeywordRegex =
      /(\d+(?:[.,]\d+)*)\s*(mil\s+millones|millones|millón|mil|k|m|b|billones)?\s*(?:de\s+)?(?:vistas|visualizaciones|views|reproducciones)\b/i;
    // 2. Si no trae la palabra (ej. en el input manual del filtro "10K", "1.5M", "500"), aceptar número + unidad al inicio/completo
    const standaloneRegex =
      /^(\d+(?:[.,]\d+)*)\s*(mil\s+millones|millones|millón|mil|k|m|b|billones)?$/i;

    const match = clean.match(withKeywordRegex) || clean.match(standaloneRegex);
    if (!match) return 0;

    let numStr = match[1];
    const unit = (match[2] || "").toLowerCase().replace(/\s+/g, " ");

    // Si hay sufijo multiplicador (K, M, mil), la coma o punto suele ser decimal ("1,2 M" -> 1.2)
    if (unit) {
      numStr = numStr.replace(",", ".");
    } else {
      // Sin sufijo ("12,345" o "1.234.567"): si tiene bloques de 3 dígitos tras el separador, es separador de miles
      if (/^\d{1,3}([.,]\d{3})+$/.test(numStr)) {
        numStr = numStr.replace(/[.,]/g, "");
      } else {
        numStr = numStr.replace(",", ".");
      }
    }

    const base = parseFloat(numStr);
    if (isNaN(base)) return 0;

    let multiplier = 1;
    if (unit === "k" || unit === "mil") multiplier = 1e3;
    else if (unit === "m" || unit === "millón" || unit === "millones") multiplier = 1e6;
    else if (unit === "b" || unit === "mil millones" || unit.startsWith("bill")) multiplier = 1e9;

    return Math.round(base * multiplier);
  }

  /**
   * Parsea el input de filtro de mínimo de vistas del usuario (ej: "10k", "1.5M", "5000")
   */
  function parseFilterMinViews(inputStr) {
    if (!inputStr || !inputStr.trim()) return 0;
    return parseViewsCount(inputStr.trim());
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.closest("[hidden], ytd-miniplayer, #miniplayer")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  }

  /**
   * Dado cualquier elemento o tarjeta del DOM, encuentra el contenedor de tarjeta de video/Short
   * y extrae sus metadatos (id, type, title, viewsText, viewsCount, duration, cardElement)
   */
  function findCardFromNode(node) {
    if (!node || !(node instanceof Element)) return null;
    if (node.closest(`#${HOST_ID}`)) return null;

    let card = node.closest(CARD_SELECTORS);
    if (!card) {
      const anchor = node.closest('a[href*="/watch?v="], a[href*="/shorts/"]');
      if (anchor) {
        card =
          anchor.closest(CARD_SELECTORS) ||
          anchor.closest("ytd-rich-item-renderer, ytm-shorts-lockup-view-model, div#dismissible") ||
          anchor;
      }
    }
    if (!card || !isElementVisible(card)) return null;
    return card;
  }

  function extractCardData(card) {
    if (!card || !isElementVisible(card)) return null;

    // Si es un wrapper como ytd-rich-item-renderer que contiene un lockup de Short adentro,
    // seguimos usando la tarjeta exterior para el borde visual pero inspeccionamos sus enlaces internos.
    const anchors = card.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
    let parsedLink = null;

    if (card.matches && card.matches('a[href*="/watch?v="], a[href*="/shorts/"]')) {
      parsedLink = parseVideoLink(card.getAttribute("href"));
    }

    if (!parsedLink) {
      for (const a of anchors) {
        const info = parseVideoLink(a.getAttribute("href"));
        if (info) {
          parsedLink = info;
          break;
        }
      }
    }

    if (!parsedLink) return null;

    // Extraer título limpio
    let title = "";
    const titleSelectors = [
      "#video-title",
      "#video-title-link",
      "a.shortsLockupViewModelHostEndpoint[title]",
      "h3 a[title]",
      ".shortsLockupViewModelHostMetadataTitle span.yt-core-attributed-string",
      "span#video-title",
      "h3 span.yt-core-attributed-string"
    ];

    for (const sel of titleSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const candidate = (el.getAttribute("title") || el.textContent || "").trim();
        if (candidate) {
          title = candidate;
          break;
        }
      }
    }

    if (!title) {
      for (const a of anchors) {
        const t = (a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent || "").trim();
        if (t && t.length > 2 && !/^\d+:\d+$/.test(t)) {
          title = t.replace(/\s+/g, " ");
          break;
        }
      }
    }
    if (!title) {
      title = parsedLink.type === "short" ? `Short (${parsedLink.id})` : `Video (${parsedLink.id})`;
    }

    // Extraer texto de vistas
    let viewsText = "";
    const viewSelectors = [
      "#metadata-line span.inline-metadata-item",
      ".shortsLockupViewModelHostMetadataSubhead span.yt-core-attributed-string",
      "ytd-video-meta-block span.inline-metadata-item",
      ".yt-content-metadata-view-model-wiz__metadata-text",
      "#metadata span"
    ];

    for (const sel of viewSelectors) {
      const els = card.querySelectorAll(sel);
      for (const el of els) {
        const txt = (el.textContent || "").trim();
        if (/vista|visualizaci|view|reproducci/i.test(txt)) {
          viewsText = txt;
          break;
        }
      }
      if (viewsText) break;
    }

    // Fallback para buscar vistas en aria-label o texto general de la tarjeta si no estaba en un nodo separado
    if (!viewsText) {
      for (const a of anchors) {
        const aria = a.getAttribute("aria-label") || "";
        const m = aria.match(
          /(\d+(?:[.,]\d+)*\s*(?:mil\s+millones|millones|millón|mil|K|M|B|billones)?\s*(?:de\s+)?(?:vistas|visualizaciones|views|reproducciones))\b/i
        );
        if (m) {
          viewsText = m[1];
          break;
        }
      }
    }
    if (!viewsText) {
      const cardText = card.textContent || "";
      const m = cardText.match(
        /(\d+(?:[.,]\d+)*\s*(?:mil\s+millones|millones|millón|mil|K|M|B|billones)?\s*(?:de\s+)?(?:vistas|visualizaciones|views|reproducciones))\b/i
      );
      if (m) {
        viewsText = m[1].trim();
      }
    }

    const viewsCount = parseViewsCount(viewsText);

    // Extraer duración si existe
    let duration = "";
    const durEl = card.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer span, badge-shape .yt-badge-shape__text"
    );
    if (durEl) {
      duration = (durEl.textContent || "").trim();
    }

    return {
      id: parsedLink.id,
      type: parsedLink.type,
      title: title.replace(/\s+/g, " ").trim(),
      viewsText: viewsText || (parsedLink.type === "short" ? "Short" : ""),
      viewsCount,
      duration,
      card
    };
  }

  /**
   * Obtiene todas las tarjetas únicas de Videos/Shorts actualmente visibles en la página en orden DOM
   */
  function getAllVisibleCardsData() {
    const rawCards = document.querySelectorAll(CARD_SELECTORS);
    const seenIds = new Set();
    const results = [];

    for (const card of rawCards) {
      // Evitar tarjetas anidadas duplicadas (ej. ytd-rich-item-renderer que contiene ytm-shorts-lockup-view-model)
      const parentCard = card.parentElement ? card.parentElement.closest(CARD_SELECTORS) : null;
      const targetCard = parentCard || card;

      if (!isElementVisible(targetCard)) continue;
      const data = extractCardData(targetCard);
      if (!data || seenIds.has(data.id)) continue;

      seenIds.add(data.id);
      results.push(data);
    }

    // Fallback si YouTube cambia el nombre de algún custom element pero siguen los anchors visibles
    if (results.length === 0) {
      const anchors = document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
      for (const a of anchors) {
        if (!isElementVisible(a)) continue;
        const card = findCardFromNode(a);
        if (!card) continue;
        const data = extractCardData(card);
        if (!data || seenIds.has(data.id)) continue;
        seenIds.add(data.id);
        results.push(data);
      }
    }

    return results;
  }

  /**
   * Comprueba si un item cumple los filtros activos (Tipo de contenido, Mínimo de vistas, Palabra clave)
   */
  function itemMatchesFilters(itemData) {
    if (!itemData) return false;

    // 1. Filtro por tipo (Todos / Solo Videos / Solo Shorts)
    if (state.contentTypeFilter === "video" && itemData.type !== "video") return false;
    if (state.contentTypeFilter === "short" && itemData.type !== "short") return false;

    // 2. Filtro por mínimo de vistas
    const minViews = parseFilterMinViews(state.minViewsRaw);
    if (minViews > 0 && itemData.viewsCount < minViews) {
      return false;
    }

    // 3. Filtro por palabra clave en el título
    const kw = state.keywordFilter.trim().toLowerCase();
    if (kw && !itemData.title.toLowerCase().includes(kw)) {
      return false;
    }

    return true;
  }

  // ============================================================================
  // 3. GESTIÓN DE LA CESTA DE SELECCIÓN Y BADGES VISUALES EN YOUTUBE
  // ============================================================================
  function addItemToSelection(itemData) {
    if (!itemData || !itemData.id) return false;
    if (state.items.has(itemData.id)) {
      // Actualizar metadatos si antes faltaban
      const existing = state.items.get(itemData.id);
      if (!existing.title && itemData.title) existing.title = itemData.title;
      if (!existing.viewsCount && itemData.viewsCount) {
        existing.viewsCount = itemData.viewsCount;
        existing.viewsText = itemData.viewsText;
      }
      return false;
    }
    state.items.set(itemData.id, {
      id: itemData.id,
      type: itemData.type,
      title: itemData.title,
      viewsText: itemData.viewsText || "",
      viewsCount: itemData.viewsCount || 0,
      duration: itemData.duration || "",
      order: state.nextOrder++
    });
    return true;
  }

  function removeItemFromSelection(id) {
    if (!state.items.has(id)) return false;
    state.items.delete(id);
    // Re-numerar orden secuencialmente (1..N) para que los badges #1, #2 sean siempre limpios
    let idx = 1;
    for (const item of state.items.values()) {
      item.order = idx++;
    }
    state.nextOrder = idx;
    return true;
  }

  function clearSelection() {
    state.items.clear();
    state.nextOrder = 1;
    state.lastClickedCardId = null;
    saveSessionState();
    syncPageCardHighlights();
    renderUI();
    setStatus("Lista limpiada.", "neutral");
  }

  /**
   * Obtiene el listado ordenado según la preferencia del usuario
   */
  function getOrderedItems() {
    const arr = Array.from(state.items.values());
    if (state.sortOrder === "reverse") {
      return arr.slice().sort((a, b) => b.order - a.order);
    }
    if (state.sortOrder === "views_desc") {
      return arr.slice().sort((a, b) => (b.viewsCount || 0) - (a.viewsCount || 0));
    }
    return arr.sort((a, b) => a.order - b.order);
  }

  /**
   * Inyecta los estilos en la página principal de YouTube para resaltar las tarjetas seleccionadas
   * y mostrar el indicador cuando el Modo Selección por Clic está activo.
   */
  function ensurePageStyles() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_STYLE_ID;
    style.textContent = `
      .yt-supersonico-card-selected {
        position: relative !important;
        outline: 2px solid #3b82f6 !important;
        outline-offset: 2px !important;
        border-radius: 12px !important;
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
      .yt-supersonico-card-selected::after {
        content: "#" attr(data-yt-supersonico-order) " ✓";
        position: absolute !important;
        top: 8px !important;
        left: 8px !important;
        z-index: 2147483640 !important;
        background: #2563eb !important;
        color: #ffffff !important;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        padding: 5px 8px !important;
        border-radius: 6px !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45) !important;
        pointer-events: none !important;
        letter-spacing: 0.02em !important;
      }
      body.yt-supersonico-click-mode-active .yt-supersonico-card-hover:not(.yt-supersonico-card-selected) {
        outline: 2px dashed rgba(59, 130, 246, 0.75) !important;
        outline-offset: 2px !important;
        border-radius: 12px !important;
        cursor: pointer !important;
      }
      body.yt-supersonico-click-mode-active .yt-supersonico-card-selected {
        cursor: pointer !important;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Sincroniza los bordes y badges (#1, #2...) sobre las tarjetas visibles de YouTube
   */
  function syncPageCardHighlights() {
    ensurePageStyles();
    document.body.classList.toggle("yt-supersonico-click-mode-active", state.clickSelectActive);

    // Calcular mapa de posición según el orden activo
    const ordered = getOrderedItems();
    const orderMap = new Map();
    ordered.forEach((item, index) => {
      orderMap.set(item.id, index + 1);
    });

    // Limpiar tarjetas previamente marcadas que ya no estén seleccionadas
    const marked = document.querySelectorAll(".yt-supersonico-card-selected");
    for (const el of marked) {
      const id = el.getAttribute("data-yt-supersonico-id");
      if (!id || !orderMap.has(id)) {
        el.classList.remove("yt-supersonico-card-selected");
        el.removeAttribute("data-yt-supersonico-order");
        el.removeAttribute("data-yt-supersonico-id");
      }
    }

    if (orderMap.size === 0) return;

    const visibleCards = getAllVisibleCardsData();
    for (const data of visibleCards) {
      const displayOrder = orderMap.get(data.id);
      if (displayOrder) {
        data.card.classList.add("yt-supersonico-card-selected");
        data.card.setAttribute("data-yt-supersonico-id", data.id);
        data.card.setAttribute("data-yt-supersonico-order", String(displayOrder));
      }
    }
  }

  // ============================================================================
  // 4. MODO 1: SELECCIÓN INTERACTIVA POR CLIC (Bloquea apertura + Shift+Clic Rango)
  // ============================================================================
  function setClickSelectMode(enabled) {
    state.clickSelectActive = Boolean(enabled);
    if (!state.clickSelectActive && state.hoveredCard) {
      state.hoveredCard.classList.remove("yt-supersonico-card-hover");
      state.hoveredCard = null;
    }
    syncPageCardHighlights();
    renderUI();
    if (state.clickSelectActive) {
      setStatus(
        "Modo Selección por Clic ENCENDIDO: Haz clic en cualquier video o Short para sumarlo/quitarlo (Shift+Clic selecciona un rango).",
        "active"
      );
    } else {
      setStatus("Modo Selección por Clic APAGADO: Puedes navegar normalmente por YouTube.", "neutral");
    }
  }

  function handleDocumentMouseOver(e) {
    if (!state.clickSelectActive) return;
    const card = findCardFromNode(e.target);
    if (state.hoveredCard && state.hoveredCard !== card) {
      state.hoveredCard.classList.remove("yt-supersonico-card-hover");
      state.hoveredCard = null;
    }
    if (card) {
      card.classList.add("yt-supersonico-card-hover");
      state.hoveredCard = card;
    }
  }

  function handleDocumentPointerIntercept(e) {
    if (!state.clickSelectActive) return;
    if (e.target && e.target.closest && e.target.closest(`#${HOST_ID}`)) return;

    const card = findCardFromNode(e.target);
    if (!card) return;

    const data = extractCardData(card);
    if (!data) return;

    // Bloquear por completo que YouTube abra el video o reproduzca navegación SPA
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    }

    // Solo procesar el cambio de selección en el evento 'click' principal (evita doble disparo en mousedown/auxclick)
    if (e.type !== "click" || e.button !== 0) return;

    // Soporte de Selección por Rango con Shift + Clic
    if (e.shiftKey && state.lastClickedCardId && state.lastClickedCardId !== data.id) {
      const visible = getAllVisibleCardsData();
      const idxA = visible.findIndex((item) => item.id === state.lastClickedCardId);
      const idxB = visible.findIndex((item) => item.id === data.id);

      if (idxA !== -1 && idxB !== -1) {
        const start = Math.min(idxA, idxB);
        const end = Math.max(idxA, idxB);
        let addedInRange = 0;

        for (let i = start; i <= end; i++) {
          const candidate = visible[i];
          if (state.limitCount > 0 && state.items.size >= state.limitCount) {
            break;
          }
          if (itemMatchesFilters(candidate)) {
            if (addItemToSelection(candidate)) {
              addedInRange++;
            }
          }
        }
        state.lastClickedCardId = data.id;
        saveSessionState();
        syncPageCardHighlights();
        renderUI();
        setStatus(
          `Rango seleccionado (+${addedInRange} videos). Total: ${state.items.size}.`,
          "success"
        );
        return;
      }
    }

    // Clic individual: alternar selección
    if (state.items.has(data.id)) {
      removeItemFromSelection(data.id);
      setStatus(`Quitado: "${truncateText(data.title, 36)}". Total: ${state.items.size}.`, "neutral");
    } else {
      if (state.limitCount > 0 && state.items.size >= state.limitCount) {
        setStatus(
          `Límite alcanzado (${state.limitCount}). Sube el límite o pon 0 para agregar más.`,
          "warn"
        );
        return;
      }
      addItemToSelection(data);
      state.lastClickedCardId = data.id;
      setStatus(
        `Capturado #${state.items.size} (${data.type.toUpperCase()}): "${truncateText(data.title, 34)}"`,
        "success"
      );
    }

    saveSessionState();
    syncPageCardHighlights();
    renderUI();
  }

  // ============================================================================
  // 5. MODO 2: SELECCIONAR VISIBLES Y AUTO-SCROLL MASIVO POR CANTIDAD
  // ============================================================================
  function selectCurrentlyVisibleCards() {
    const visible = getAllVisibleCardsData();
    let added = 0;
    let matched = 0;

    for (const item of visible) {
      if (!itemMatchesFilters(item)) continue;
      matched++;
      if (state.limitCount > 0 && state.items.size >= state.limitCount) {
        break;
      }
      if (addItemToSelection(item)) {
        added++;
      }
    }

    saveSessionState();
    syncPageCardHighlights();
    renderUI();

    if (matched === 0) {
      setStatus("No se encontraron videos/Shorts visibles que coincidan con el filtro actual.", "warn");
    } else {
      setStatus(
        `Se agregaron ${added} nuevos de ${matched} visibles en pantalla (Total: ${state.items.size}).`,
        "success"
      );
    }
  }

  function getScrollableContainer() {
    const ytdApp = document.querySelector("ytd-app");
    if (ytdApp && ytdApp.scrollHeight > window.innerHeight + 50) {
      const style = window.getComputedStyle(ytdApp);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        return ytdApp;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function startAutoScrollCapture() {
    if (state.autoScrolling) {
      stopAutoScrollCapture("Auto-Scroll pausado por el usuario.");
      return;
    }

    state.autoScrolling = true;
    renderUI();

    let lastScrollHeight = 0;
    let stagnantTicks = 0;

    const collectStep = () => {
      if (!state.autoScrolling) return;

      const visible = getAllVisibleCardsData();
      for (const item of visible) {
        if (state.limitCount > 0 && state.items.size >= state.limitCount) {
          stopAutoScrollCapture(
            `¡Meta alcanzada! ${state.items.size} enlaces listos para copiar.`
          );
          return;
        }
        if (itemMatchesFilters(item)) {
          addItemToSelection(item);
        }
      }

      saveSessionState();
      syncPageCardHighlights();
      renderUI();

      if (state.limitCount > 0 && state.items.size >= state.limitCount) {
        stopAutoScrollCapture(
          `¡Meta alcanzada! ${state.items.size} enlaces listos para copiar.`
        );
        return;
      }

      const scroller = getScrollableContainer();
      const currentHeight = Math.max(
        scroller.scrollHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0
      );

      window.scrollTo({ top: currentHeight, behavior: "smooth" });
      if (scroller !== document.documentElement && scroller !== document.body) {
        scroller.scrollTop = scroller.scrollHeight;
      }

      setStatus(
        `Auto-Scroll activo... Capturados: ${state.items.size}${
          state.limitCount > 0 ? ` / ${state.limitCount}` : ""
        }`,
        "active"
      );

      if (Math.abs(currentHeight - lastScrollHeight) < 10) {
        stagnantTicks++;
        if (stagnantTicks >= 6) {
          stopAutoScrollCapture(
            `Fin de la página alcanzado. ${state.items.size} enlaces capturados.`
          );
          return;
        }
      } else {
        stagnantTicks = 0;
        lastScrollHeight = currentHeight;
      }
    };

    // Primer barrido inmediato antes del primer salto de scroll
    collectStep();
    if (state.autoScrolling) {
      scrollTimer = setInterval(collectStep, 850);
    }
  }

  function stopAutoScrollCapture(message) {
    state.autoScrolling = false;
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    saveSessionState();
    syncPageCardHighlights();
    renderUI();
    if (message) {
      setStatus(message, "success");
    }
  }

  // ============================================================================
  // 6. FORMATEO DE SALIDA, COPIA AL PORTAPAPELES Y DESCARGA OPCIONAL
  // ============================================================================
  function buildFormattedOutput() {
    const items = getOrderedItems();
    if (items.length === 0) return "";

    switch (state.exportFormat) {
      case "title_url":
        return items.map((it) => `${it.title} - ${formatItemUrl(it)}`).join("\n");

      case "markdown":
        return items
          .map(
            (it, idx) =>
              `${idx + 1}. [${it.title.replace(/[\[\]]/g, "")}](${formatItemUrl(it)}) (${
                it.type === "short" ? "Short" : "Video"
              }${it.viewsText ? ` · ${it.viewsText}` : ""})`
          )
          .join("\n");

      case "csv": {
        const header = "orden,id,tipo,titulo,vistas_texto,vistas_num,url";
        const rows = items.map((it, idx) => {
          const safeTitle = `"${(it.title || "").replace(/"/g, '""')}"`;
          const safeViews = `"${(it.viewsText || "").replace(/"/g, '""')}"`;
          return `${idx + 1},${it.id},${it.type},${safeTitle},${safeViews},${it.viewsCount || 0},${formatItemUrl(it)}`;
        });
        return [header, ...rows].join("\n");
      }

      case "json":
        return JSON.stringify(
          items.map((it, idx) => ({
            order: idx + 1,
            id: it.id,
            type: it.type,
            title: it.title,
            viewsText: it.viewsText,
            viewsCount: it.viewsCount,
            url: formatItemUrl(it)
          })),
          null,
          2
        );

      case "urls":
      default:
        return items.map((it) => formatItemUrl(it)).join("\n");
    }
  }

  async function copySelectedToClipboard() {
    if (state.items.size === 0) {
      setStatus("No hay videos seleccionados todavía. Usa el Modo Clic o Seleccionar Visibles.", "warn");
      return;
    }

    const content = buildFormattedOutput();
    try {
      await navigator.clipboard.writeText(content);
      setStatus(`¡${state.items.size} enlaces copiados al portapapeles!`, "success");
      flashCopyButtonSuccess();
    } catch (_) {
      // Fallback con textarea temporal
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setStatus(`¡${state.items.size} enlaces copiados al portapapeles!`, "success");
      flashCopyButtonSuccess();
    }
  }

  function downloadSelectedToFile() {
    if (state.items.size === 0) {
      setStatus("No hay videos seleccionados para descargar.", "warn");
      return;
    }

    const content = buildFormattedOutput();
    const extMap = {
      urls: "txt",
      title_url: "txt",
      markdown: "md",
      csv: "csv",
      json: "json"
    };
    const mimeMap = {
      urls: "text/plain;charset=utf-8",
      title_url: "text/plain;charset=utf-8",
      markdown: "text/markdown;charset=utf-8",
      csv: "text/csv;charset=utf-8",
      json: "application/json;charset=utf-8"
    };

    const ext = extMap[state.exportFormat] || "txt";
    const mime = mimeMap[state.exportFormat] || "text/plain;charset=utf-8";

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yt_links_${state.items.size}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    setStatus(`Archivo yt_links_${state.items.size}.${ext} descargado.`, "success");
  }

  // ============================================================================
  // 7. CONSTRUCCIÓN DE LA INTERFAZ FLOTANTE (Shadow DOM - Estilo Linear/Runway)
  // ============================================================================
  let shadowRoot = null;
  let refs = {};

  function truncateText(str, max) {
    if (!str) return "";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function createShadowModal() {
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) existingHost.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position: fixed; top: 72px; right: 24px; z-index: 2147483646; font-family: Inter, system-ui, -apple-system, sans-serif;";
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });

    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #f3f4f6;
          user-select: none;
        }
        * {
          box-sizing: border-box;
        }
        .panel {
          width: 376px;
          background: #0a0c10;
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 14px;
          box-shadow: 0 22px 48px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.03);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .panel.hidden {
          display: none !important;
        }
        .panel.minimized .panel-body {
          display: none !important;
        }

        /* Header arrastrable */
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          background: #12151d;
          border-bottom: 1px solid rgba(255, 255, 255, 0.07);
          cursor: grab;
        }
        .header:active {
          cursor: grabbing;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 9px;
        }
        .brand-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #3b82f6;
          box-shadow: 0 0 8px rgba(59, 130, 246, 0.6);
        }
        .brand-dot.recording {
          background: #10b981;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.8);
        }
        .brand-title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: #f9fafb;
        }
        .badge-total {
          font-size: 11px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(59, 130, 246, 0.16);
          color: #60a5fa;
          border: 1px solid rgba(59, 130, 246, 0.3);
        }
        .header-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .icon-btn {
          background: transparent;
          border: 1px solid transparent;
          color: #9ca3af;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.15s ease;
        }
        .icon-btn:hover {
          background: rgba(255, 255, 255, 0.07);
          color: #f9fafb;
        }

        .panel-body {
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: calc(100vh - 140px);
          overflow-y: auto;
        }
        .panel-body::-webkit-scrollbar {
          width: 5px;
        }
        .panel-body::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 4px;
        }

        /* Tarjeta Interruptor Modo Clic */
        .click-mode-box {
          background: #12151d;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 11px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          transition: border-color 0.18s ease, background 0.18s ease;
        }
        .click-mode-box.active {
          background: rgba(16, 185, 129, 0.08);
          border-color: rgba(16, 185, 129, 0.45);
        }
        .click-mode-info {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .click-mode-title {
          font-size: 12.5px;
          font-weight: 600;
          color: #f3f4f6;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .click-mode-desc {
          font-size: 11px;
          color: #9ca3af;
          line-height: 1.35;
        }
        .toggle-btn {
          flex-shrink: 0;
          padding: 7px 13px;
          border-radius: 8px;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: #1e2330;
          color: #e5e7eb;
          transition: all 0.15s ease;
        }
        .toggle-btn:hover {
          background: #262c3c;
          border-color: rgba(255, 255, 255, 0.22);
        }
        .toggle-btn.on {
          background: #10b981;
          border-color: #059669;
          color: #052e16;
          font-weight: 700;
          box-shadow: 0 0 14px rgba(16, 185, 129, 0.35);
        }

        /* Selector de Tipo: Todos / Videos / Shorts */
        .section-label {
          font-size: 10.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #9ca3af;
          margin-bottom: 5px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .segmented {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          background: #12151d;
          padding: 3px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.07);
          gap: 3px;
        }
        .seg-btn {
          background: transparent;
          border: none;
          color: #9ca3af;
          font-size: 11.5px;
          font-weight: 500;
          padding: 6px 4px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.14s ease;
        }
        .seg-btn:hover {
          color: #e5e7eb;
        }
        .seg-btn.active {
          background: #2563eb;
          color: #ffffff;
          font-weight: 600;
        }

        /* Fila de Controles de Cantidad y Auto-Scroll */
        .grid-2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .field label {
          font-size: 10.5px;
          color: #9ca3af;
          font-weight: 500;
        }
        input[type="number"],
        input[type="text"],
        select {
          width: 100%;
          background: #12151d;
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 7px;
          color: #f3f4f6;
          font-size: 12px;
          padding: 7px 9px;
          outline: none;
          transition: border-color 0.15s ease;
        }
        input:focus,
        select:focus {
          border-color: #3b82f6;
        }

        .actions-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .btn-secondary {
          background: #161b26;
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #e5e7eb;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
        }
        .btn-secondary:hover {
          background: #1f2637;
          border-color: rgba(255, 255, 255, 0.2);
        }
        .btn-secondary.scrolling {
          background: rgba(239, 68, 68, 0.16);
          border-color: rgba(239, 68, 68, 0.5);
          color: #fca5a5;
        }

        /* Opciones de Formato y Shorts Switch */
        .options-card {
          background: #12151d;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 10px;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11.5px;
          color: #d1d5db;
          cursor: pointer;
        }
        .checkbox-row input {
          accent-color: #3b82f6;
          width: 14px;
          height: 14px;
          cursor: pointer;
        }

        /* Barra resumen + Cajón Desplegable de Previsualización */
        .basket-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #12151d;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 8px;
          padding: 7px 10px;
          font-size: 11.5px;
        }
        .basket-counts {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #d1d5db;
        }
        .pill {
          padding: 2px 6px;
          border-radius: 5px;
          font-size: 10.5px;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.06);
          color: #cbd5e1;
        }
        .pill.short {
          background: rgba(244, 63, 94, 0.14);
          color: #fda4af;
        }
        .pill.video {
          background: rgba(59, 130, 246, 0.14);
          color: #93c5fd;
        }
        .basket-links {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .text-link {
          background: none;
          border: none;
          color: #60a5fa;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          padding: 0;
        }
        .text-link:hover {
          text-decoration: underline;
        }
        .text-link.danger {
          color: #f87171;
        }

        .drawer {
          background: #0d1017;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 8px;
          max-height: 175px;
          overflow-y: auto;
          display: none;
          flex-direction: column;
          divide-y: 1px solid rgba(255, 255, 255, 0.05);
        }
        .drawer.open {
          display: flex;
        }
        .drawer-empty {
          padding: 14px;
          text-align: center;
          font-size: 11px;
          color: #6b7280;
        }
        .drawer-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 9px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          font-size: 11px;
        }
        .drawer-item:last-child {
          border-bottom: none;
        }
        .drawer-item-left {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;
        }
        .drawer-idx {
          color: #6b7280;
          font-weight: 600;
          font-size: 10px;
          min-width: 20px;
        }
        .drawer-type {
          font-size: 9px;
          font-weight: 700;
          padding: 1px 4px;
          border-radius: 4px;
          text-transform: uppercase;
        }
        .drawer-type.short {
          background: rgba(244, 63, 94, 0.18);
          color: #fda4af;
        }
        .drawer-type.video {
          background: rgba(59, 130, 246, 0.18);
          color: #93c5fd;
        }
        .drawer-title {
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }
        .drawer-views {
          color: #9ca3af;
          font-size: 10px;
          white-space: nowrap;
        }
        .drawer-remove {
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
          font-size: 13px;
          line-height: 1;
          padding: 2px 4px;
          border-radius: 4px;
        }
        .drawer-remove:hover {
          color: #f87171;
          background: rgba(248, 113, 113, 0.12);
        }

        /* Botones primarios de Exportación (Copiar + Descargar) */
        .export-row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
        }
        .btn-primary {
          background: #2563eb;
          border: 1px solid #3b82f6;
          color: #ffffff;
          border-radius: 9px;
          padding: 10px 14px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          transition: all 0.15s ease;
        }
        .btn-primary:hover {
          background: #1d4ed8;
        }
        .btn-primary.copied {
          background: #059669;
          border-color: #10b981;
        }
        .btn-download {
          background: #12151d;
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #d1d5db;
          border-radius: 9px;
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .btn-download:hover {
          background: #1e2330;
          color: #ffffff;
        }

        /* Barra de estado inferior */
        .status-bar {
          font-size: 11px;
          line-height: 1.35;
          padding: 8px 10px;
          border-radius: 8px;
          background: #12151d;
          color: #9ca3af;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .status-bar.active {
          color: #6ee7b7;
          border-color: rgba(16, 185, 129, 0.3);
          background: rgba(16, 185, 129, 0.07);
        }
        .status-bar.success {
          color: #93c5fd;
          border-color: rgba(59, 130, 246, 0.3);
          background: rgba(59, 130, 246, 0.08);
        }
        .status-bar.warn {
          color: #fcd34d;
          border-color: rgba(245, 158, 11, 0.3);
          background: rgba(245, 158, 11, 0.08);
        }
      </style>

      <div class="panel" id="panel">
        <div class="header" id="dragHeader">
          <div class="brand">
            <span class="brand-dot" id="brandDot"></span>
            <span class="brand-title">YT Scraper Supersónico</span>
            <span class="badge-total" id="headerCountBadge">0</span>
          </div>
          <div class="header-actions">
            <button class="icon-btn" id="btnMinimize" title="Minimizar / Expandir">—</button>
            <button class="icon-btn" id="btnClose" title="Ocultar panel">✕</button>
          </div>
        </div>

        <div class="panel-body">
          <!-- 1. Interruptor Modo Selección por Clic -->
          <div class="click-mode-box" id="clickModeBox">
            <div class="click-mode-info">
              <div class="click-mode-title">
                <span>Modo Selección por Clic</span>
              </div>
              <div class="click-mode-desc">
                Haz clic en cualquier video o Short para sumarlo sin que se abra. Usa <b>Shift+Clic</b> para rangos.
              </div>
            </div>
            <button class="toggle-btn" id="btnToggleClickMode">ENCENDER</button>
          </div>

          <!-- 2. Filtro de Tipo de Contenido (Videos + Shorts) -->
          <div>
            <div class="section-label">
              <span>Tipo de Contenido a Capturar</span>
            </div>
            <div class="segmented" id="typeSegmented">
              <button class="seg-btn active" data-type="all">Todos</button>
              <button class="seg-btn" data-type="video">Solo Videos</button>
              <button class="seg-btn" data-type="short">Solo Shorts</button>
            </div>
          </div>

          <!-- 3. Captura Masiva y Filtros Inteligentes -->
          <div class="grid-2">
            <div class="field">
              <label for="inputLimit">Límite (0 = todos)</label>
              <input type="number" id="inputLimit" min="0" placeholder="0 = sin límite" value="0" />
            </div>
            <div class="field">
              <label for="inputMinViews">Mínimo de vistas</label>
              <input type="text" id="inputMinViews" placeholder="Ej: 10K, 1M, 500" />
            </div>
          </div>

          <div class="field">
            <label for="inputKeyword">Filtrar por palabra en título (opcional)</label>
            <input type="text" id="inputKeyword" placeholder="Ej: Parte 1, Resumen, Tutorial..." />
          </div>

          <div class="actions-row">
            <button class="btn-secondary" id="btnSelectVisible" title="Marca todos los videos/Shorts cargados en pantalla ahora mismo">
              + Seleccionar Visibles
            </button>
            <button class="btn-secondary" id="btnAutoScroll" title="Baja automáticamente por la página capturando videos y Shorts">
              Auto-Scroll Masivo
            </button>
          </div>

          <!-- 4. Opciones de Orden, Formato y Conversión de Shorts -->
          <div class="options-card">
            <div class="grid-2">
              <div class="field">
                <label for="selectSort">Orden de lista</label>
                <select id="selectSort">
                  <option value="capture">Orden de captura</option>
                  <option value="reverse">Invertir (Viejo → Nuevo)</option>
                  <option value="views_desc">Más vistos primero</option>
                </select>
              </div>
              <div class="field">
                <label for="selectFormat">Formato de salida</label>
                <select id="selectFormat">
                  <option value="urls">Solo URLs (1 por línea)</option>
                  <option value="title_url">Título + URL</option>
                  <option value="markdown">Lista Markdown</option>
                  <option value="csv">CSV (Excel)</option>
                  <option value="json">JSON Completo</option>
                </select>
              </div>
            </div>

            <label class="checkbox-row">
              <span>Convertir enlaces <code>/shorts/ID</code> a <code>/watch?v=ID</code></span>
              <input type="checkbox" id="chkConvertShorts" />
            </label>
          </div>

          <!-- 5. Cesta Acumuladora + Cajón Desplegable -->
          <div class="basket-bar">
            <div class="basket-counts">
              <span class="pill video" id="countVideosPill">0 Videos</span>
              <span class="pill short" id="countShortsPill">0 Shorts</span>
            </div>
            <div class="basket-links">
              <button class="text-link" id="btnToggleDrawer">Ver lista ▾</button>
              <button class="text-link danger" id="btnClearAll">Limpiar</button>
            </div>
          </div>

          <div class="drawer" id="previewDrawer"></div>

          <!-- 6. Acciones Primarias: Copiar Enlaces y Descargar -->
          <div class="export-row">
            <button class="btn-primary" id="btnCopyLinks">
              Copiar Enlaces (0)
            </button>
            <button class="btn-download" id="btnDownloadFile" title="Descargar en disco">
              Descargar
            </button>
          </div>

          <div class="status-bar" id="statusBar">
            Listo. Enciende el Modo Clic o usa Seleccionar Visibles / Auto-Scroll.
          </div>
        </div>
      </div>
    `;

    refs = {
      host,
      panel: shadowRoot.getElementById("panel"),
      dragHeader: shadowRoot.getElementById("dragHeader"),
      brandDot: shadowRoot.getElementById("brandDot"),
      headerCountBadge: shadowRoot.getElementById("headerCountBadge"),
      btnMinimize: shadowRoot.getElementById("btnMinimize"),
      btnClose: shadowRoot.getElementById("btnClose"),
      clickModeBox: shadowRoot.getElementById("clickModeBox"),
      btnToggleClickMode: shadowRoot.getElementById("btnToggleClickMode"),
      typeSegmented: shadowRoot.getElementById("typeSegmented"),
      inputLimit: shadowRoot.getElementById("inputLimit"),
      inputMinViews: shadowRoot.getElementById("inputMinViews"),
      inputKeyword: shadowRoot.getElementById("inputKeyword"),
      btnSelectVisible: shadowRoot.getElementById("btnSelectVisible"),
      btnAutoScroll: shadowRoot.getElementById("btnAutoScroll"),
      selectSort: shadowRoot.getElementById("selectSort"),
      selectFormat: shadowRoot.getElementById("selectFormat"),
      chkConvertShorts: shadowRoot.getElementById("chkConvertShorts"),
      countVideosPill: shadowRoot.getElementById("countVideosPill"),
      countShortsPill: shadowRoot.getElementById("countShortsPill"),
      btnToggleDrawer: shadowRoot.getElementById("btnToggleDrawer"),
      btnClearAll: shadowRoot.getElementById("btnClearAll"),
      previewDrawer: shadowRoot.getElementById("previewDrawer"),
      btnCopyLinks: shadowRoot.getElementById("btnCopyLinks"),
      btnDownloadFile: shadowRoot.getElementById("btnDownloadFile"),
      statusBar: shadowRoot.getElementById("statusBar")
    };

    bindModalEvents();
    setupDraggableHeader(host, refs.dragHeader);
  }

  function bindModalEvents() {
    refs.btnMinimize.addEventListener("click", () => {
      state.isMinimized = !state.isMinimized;
      renderUI();
    });

    refs.btnClose.addEventListener("click", () => {
      // Al cerrar el panel, apagamos el interceptador de clics para no bloquear YouTube
      if (state.clickSelectActive) {
        setClickSelectMode(false);
      }
      if (state.autoScrolling) {
        stopAutoScrollCapture();
      }
      state.isOpen = false;
      renderUI();
    });

    refs.btnToggleClickMode.addEventListener("click", () => {
      setClickSelectMode(!state.clickSelectActive);
    });

    refs.typeSegmented.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      state.contentTypeFilter = btn.getAttribute("data-type") || "all";
      renderUI();
    });

    refs.inputLimit.addEventListener("input", () => {
      state.limitCount = Math.max(0, parseInt(refs.inputLimit.value, 10) || 0);
    });

    refs.inputMinViews.addEventListener("input", () => {
      state.minViewsRaw = refs.inputMinViews.value || "";
    });

    refs.inputKeyword.addEventListener("input", () => {
      state.keywordFilter = refs.inputKeyword.value || "";
    });

    refs.btnSelectVisible.addEventListener("click", () => {
      selectCurrentlyVisibleCards();
    });

    refs.btnAutoScroll.addEventListener("click", () => {
      startAutoScrollCapture();
    });

    refs.selectSort.addEventListener("change", () => {
      state.sortOrder = refs.selectSort.value;
      saveSessionState();
      syncPageCardHighlights();
      renderUI();
    });

    refs.selectFormat.addEventListener("change", () => {
      state.exportFormat = refs.selectFormat.value;
      saveSessionState();
    });

    refs.chkConvertShorts.addEventListener("change", () => {
      state.convertShortsToWatch = refs.chkConvertShorts.checked;
      saveSessionState();
    });

    refs.btnToggleDrawer.addEventListener("click", () => {
      state.drawerOpen = !state.drawerOpen;
      renderUI();
    });

    refs.btnClearAll.addEventListener("click", () => {
      clearSelection();
    });

    refs.previewDrawer.addEventListener("click", (e) => {
      const btn = e.target.closest(".drawer-remove");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      if (id) {
        removeItemFromSelection(id);
        saveSessionState();
        syncPageCardHighlights();
        renderUI();
      }
    });

    refs.btnCopyLinks.addEventListener("click", () => {
      copySelectedToClipboard();
    });

    refs.btnDownloadFile.addEventListener("click", () => {
      downloadSelectedToFile();
    });
  }

  function setupDraggableHeader(hostEl, handleEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = hostEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      hostEl.style.right = "auto";
      hostEl.style.left = `${initialLeft}px`;
      hostEl.style.top = `${initialTop}px`;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - 120);
      const maxTop = Math.max(0, window.innerHeight - 60);
      const nextLeft = Math.min(Math.max(8, initialLeft + dx), maxLeft);
      const nextTop = Math.min(Math.max(8, initialTop + dy), maxTop);
      hostEl.style.left = `${nextLeft}px`;
      hostEl.style.top = `${nextTop}px`;
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function setStatus(text, tone = "neutral") {
    if (!refs.statusBar) return;
    refs.statusBar.textContent = text;
    refs.statusBar.className = `status-bar ${tone}`;
  }

  function flashCopyButtonSuccess() {
    if (!refs.btnCopyLinks) return;
    refs.btnCopyLinks.classList.add("copied");
    refs.btnCopyLinks.textContent = `¡Copiados (${state.items.size})! ✓`;
    setTimeout(() => {
      if (!refs.btnCopyLinks) return;
      refs.btnCopyLinks.classList.remove("copied");
      refs.btnCopyLinks.textContent = `Copiar Enlaces (${state.items.size})`;
    }, 1600);
  }

  function renderUI() {
    if (!refs.panel) return;

    refs.panel.classList.toggle("hidden", !state.isOpen);
    refs.panel.classList.toggle("minimized", state.isMinimized);
    refs.btnMinimize.textContent = state.isMinimized ? "▢" : "—";

    const total = state.items.size;
    let videoCount = 0;
    let shortCount = 0;
    for (const item of state.items.values()) {
      if (item.type === "short") shortCount++;
      else videoCount++;
    }

    refs.headerCountBadge.textContent = String(total);
    refs.countVideosPill.textContent = `${videoCount} Video${videoCount === 1 ? "" : "s"}`;
    refs.countShortsPill.textContent = `${shortCount} Short${shortCount === 1 ? "" : "s"}`;

    // Estado del interruptor Modo Clic
    refs.clickModeBox.classList.toggle("active", state.clickSelectActive);
    refs.brandDot.classList.toggle("recording", state.clickSelectActive || state.autoScrolling);
    refs.btnToggleClickMode.classList.toggle("on", state.clickSelectActive);
    refs.btnToggleClickMode.textContent = state.clickSelectActive ? "ENCENDIDO" : "ENCENDER";

    // Botones de filtro de tipo
    const segBtns = refs.typeSegmented.querySelectorAll(".seg-btn");
    segBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-type") === state.contentTypeFilter);
    });

    // Estado de Auto-Scroll
    refs.btnAutoScroll.classList.toggle("scrolling", state.autoScrolling);
    refs.btnAutoScroll.textContent = state.autoScrolling
      ? "⏹ Detener Auto-Scroll"
      : "Auto-Scroll Masivo";

    // Selectores sincronizados
    refs.selectSort.value = state.sortOrder;
    refs.selectFormat.value = state.exportFormat;
    refs.chkConvertShorts.checked = state.convertShortsToWatch;

    // Botón Copiar
    if (!refs.btnCopyLinks.classList.contains("copied")) {
      refs.btnCopyLinks.textContent = `Copiar Enlaces (${total})`;
    }

    // Cajón de previsualización
    refs.btnToggleDrawer.textContent = state.drawerOpen ? "Ocultar lista ▴" : "Ver lista ▾";
    refs.previewDrawer.classList.toggle("open", state.drawerOpen);

    if (state.drawerOpen) {
      const ordered = getOrderedItems();
      if (ordered.length === 0) {
        refs.previewDrawer.innerHTML = `<div class="drawer-empty">Aún no has seleccionado ningún video o Short.</div>`;
      } else {
        refs.previewDrawer.innerHTML = ordered
          .map(
            (item, idx) => `
            <div class="drawer-item">
              <div class="drawer-item-left">
                <span class="drawer-idx">#${idx + 1}</span>
                <span class="drawer-type ${item.type}">${item.type === "short" ? "SHORT" : "VIDEO"}</span>
                <span class="drawer-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
              </div>
              ${item.viewsText ? `<span class="drawer-views">${escapeHtml(item.viewsText)}</span>` : ""}
              <button class="drawer-remove" data-id="${escapeHtml(item.id)}" title="Quitar de la lista">✕</button>
            </div>
          `
          )
          .join("");
      }
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ============================================================================
  // 8. INICIALIZACIÓN, OBSERVADOR SPA DE YOUTUBE Y API GLOBAL
  // ============================================================================
  function initListeners() {
    // Interceptores en fase de captura (capture: true) para bloquear la apertura de videos de YouTube cuando el Modo Clic está activo
    document.addEventListener("click", handleDocumentPointerIntercept, true);
    document.addEventListener("auxclick", handleDocumentPointerIntercept, true);
    document.addEventListener("mousedown", handleDocumentPointerIntercept, true);
    document.addEventListener("pointerdown", handleDocumentPointerIntercept, true);
    document.addEventListener("mouseover", handleDocumentMouseOver, true);

    // Re-sincronizar badges cuando el usuario cambia entre pestañas del canal (Videos <-> Shorts) o hace scroll manual
    domObserver = new MutationObserver(() => {
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => {
        if (state.items.size > 0 || state.clickSelectActive) {
          syncPageCardHighlights();
        }
      }, 250);
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener("yt-navigate-finish", () => {
      setTimeout(() => {
        syncPageCardHighlights();
        renderUI();
      }, 350);
    });
  }

  function toggleModal() {
    state.isOpen = !state.isOpen;
    if (!state.isOpen) {
      if (state.clickSelectActive) setClickSelectMode(false);
      if (state.autoScrolling) stopAutoScrollCapture();
    } else {
      syncPageCardHighlights();
    }
    renderUI();
  }

  // API expuesta para background.js y pruebas
  window.__YT_SCRAPER_SUPERSONICO__ = {
    toggleModal,
    getState: () => state,
    parseVideoLink,
    parseViewsCount,
    selectCurrentlyVisibleCards,
    setClickSelectMode,
    clearSelection,
    buildFormattedOutput
  };

  // Arranque
  loadSessionState();
  ensurePageStyles();
  createShadowModal();
  initListeners();
  syncPageCardHighlights();
  renderUI();
})();
