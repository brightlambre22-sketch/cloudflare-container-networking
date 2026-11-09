(function () {
  "use strict";
  var products = [];
  var activeStore = "all";
  var nextCursor = null;
  var currentSearch = null;
  var currentLocation = "";
  var params = new URLSearchParams(window.location.search);
  var api = "/api/marketplace/products";
  var fallbackImages = {
    electronics: "/emporium/img/cat-electronics.jpg", home: "/emporium/img/cat-home.jpg",
    fashion: "/emporium/img/cat-fashion.jpg", sports: "/emporium/img/cat-sports.jpg",
    beauty: "/emporium/img/cat-beauty.jpg", deals: "/emporium/img/cat-deals.jpg"
  };
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]; }); }
  function money(v) { return "$" + Number(v).toFixed(2); }
  function categoryKey(value) {
    var raw = String(value || "other").trim().toLowerCase();
    if (raw.indexOf("elect") >= 0 || raw.indexOf("tech") >= 0) return "electronics";
    if (raw.indexOf("home") >= 0 || raw.indexOf("living") >= 0) return "home";
    if (raw.indexOf("fashion") >= 0 || raw.indexOf("clothing") >= 0) return "fashion";
    if (raw.indexOf("sport") >= 0 || raw.indexOf("fitness") >= 0) return "sports";
    if (raw.indexOf("beauty") >= 0 || raw.indexOf("skin") >= 0) return "beauty";
    return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
  }
  function safeImage(value, category) {
    if (typeof value === "string" && value) {
      try { var url = new URL(value, window.location.origin); if (url.protocol === "https:" || url.origin === window.location.origin) return url.href; } catch (_) {}
    }
    var key = String(category || "").toLowerCase();
    for (var name in fallbackImages) if (key.indexOf(name) >= 0) return fallbackImages[name];
    return "/emporium/img/hero-product.jpg";
  }
  function setStatus(message, isError) {
    var node = document.getElementById("vq-status");
    if (node) { node.textContent = message; node.classList.toggle("is-error", !!isError); }
  }
  function renderFilters(categories) {
    var root = document.getElementById("category-filters");
    if (!root) return;
    var active = root.querySelector(".is-active");
    var selected = active ? active.getAttribute("data-filter") : "all";
    root.innerHTML = "<button class=\"filter " + (selected === "all" ? "is-active" : "") + "\" data-filter=\"all\" role=\"tab\" aria-selected=\"" + (selected === "all") + "\">All</button>" +
      categories.map(function (category) {
        var value = categoryKey(category);
        return "<button class=\"filter " + (value === selected ? "is-active" : "") + "\" data-filter=\"" + esc(value) + "\" role=\"tab\" aria-selected=\"" + (value === selected) + "\">" + esc(category) + "</button>";
      }).join("");
  }
  function productCard(p) {
    var id = String(p.product_id || p.id || "");
    var site = String(p.site_id || "");
    var category = String(p.category || "Other");
    var image = safeImage(p.image_url, category);
    var storeName = p.store && p.store.name ? p.store.name : "Local merchant";
    var qty = Math.max(0, Number(p.quantity) || 0);
    var productForDetail = { id: id, site_id: site, name: p.name, description: p.description || "", category: category, price: Number(p.price), quantity: qty, image_url: image, store: p.store || {} };
    var itemKey = site + "::" + id;
    try { sessionStorage.setItem("vq-product-" + itemKey, JSON.stringify(productForDetail)); } catch (_) {}
    var detail = "product.html?product_id=" + encodeURIComponent(id) + "&site_id=" + encodeURIComponent(site);
    return "<article class=\"pcard reveal\" data-category=\"" + esc(categoryKey(category)) + "\" data-store-site=\"" + esc(site) + "\">" +
      "<div class=\"pcard__media\"><span class=\"badge-emp badge-emp--best\">In stock · " + qty + "</span>" +
      "<a href=\"" + detail + "\" class=\"pcard__imglink\"><img src=\"" + esc(image) + "\" width=\"300\" height=\"300\" loading=\"lazy\" alt=\"" + esc(p.name) + "\"></a>" +
      "<button class=\"pcard__quick\" type=\"button\" data-add-to-cart data-product-id=\"" + esc(id) + "\" data-cart-key=\"" + esc(site + "::" + id) + "\" data-site-id=\"" + esc(site) + "\" data-store-name=\"" + esc(storeName) + "\" data-stock=\"" + qty + "\" data-name=\"" + esc(p.name) + "\" data-price=\"" + esc(p.price) + "\" data-img=\"" + esc(image) + "\">Add to cart</button></div>" +
      "<div class=\"pcard__body\"><span class=\"pcard__cat\">" + esc(category) + " · " + esc(storeName) + "</span>" +
      "<h3 class=\"pcard__title\"><a href=\"" + detail + "\">" + esc(p.name) + "</a></h3>" +
      "<p class=\"vq-card-stock\">" + (qty === 1 ? "1 available" : qty + " available") + "</p>" +
      "<div class=\"pcard__price\"><span class=\"price-now\">" + money(p.price) + "</span></div></div></article>";
  }
  function applyFilter(value) {
    document.querySelectorAll("[data-products] .pcard").forEach(function (card) {
      var categoryMatch = value === "all" || card.getAttribute("data-category") === value;
      var storeMatch = activeStore === "all" || card.getAttribute("data-store-site") === activeStore;
      card.hidden = !categoryMatch || !storeMatch;
    });
    document.querySelectorAll("#category-filters [data-filter]").forEach(function (button) {
      var on = button.getAttribute("data-filter") === value;
      button.classList.toggle("is-active", on); button.setAttribute("aria-selected", on ? "true" : "false");
    });
    var empty = document.querySelector("[data-empty]");
    if (empty) empty.hidden = document.querySelectorAll("[data-products] .pcard:not([hidden])").length > 0;
  }
  function renderStores(items) {
    var panel = document.getElementById("vq-store-map"), plot = document.getElementById("vq-map-plot"), list = document.getElementById("vq-store-list");
    if (!panel || !plot || !list) return;
    var stores = [];
    items.forEach(function (product) {
      var store = product.store || {}, site = String(product.site_id || "");
      if (!site || stores.some(function (item) { return item.site === site; })) return;
      stores.push({ site: site, name: String(store.name || "Local merchant"), address: [store.city, store.state].filter(Boolean).join(", "), lat: Number(store.latitude), lng: Number(store.longitude), distance: Number.isFinite(Number(product.distance_miles)) ? Number(product.distance_miles) : null });
    });
    if (!stores.length) { panel.hidden = true; return; }
    panel.hidden = false;
    var valid = stores.filter(function (s) { return Number.isFinite(s.lat) && Number.isFinite(s.lng); });
    var lats = valid.map(function (s) { return s.lat; }), lngs = valid.map(function (s) { return s.lng; });
    var minLat = Math.min.apply(Math, lats), maxLat = Math.max.apply(Math, lats), minLng = Math.min.apply(Math, lngs), maxLng = Math.max.apply(Math, lngs);
    var latSpan = maxLat - minLat || 0.02, lngSpan = maxLng - minLng || 0.02;
    var width = 760, height = 260, marks = valid.map(function (store, index) {
      var x = 36 + ((store.lng - minLng) / lngSpan) * (width - 72);
      var y = 30 + ((maxLat - store.lat) / latSpan) * (height - 60);
      return "<g><title>" + esc(store.name) + (store.address ? " · " + esc(store.address) : "") + "</title><circle cx=\"" + x.toFixed(1) + "\" cy=\"" + y.toFixed(1) + "\" r=\"15\"/><text x=\"" + x.toFixed(1) + "\" y=\"" + (y + 5).toFixed(1) + "\">" + (index + 1) + "</text></g>";
    }).join("");
    plot.innerHTML = "<svg viewBox=\"0 0 760 260\" aria-hidden=\"true\"><path d=\"M0 65H760M0 130H760M0 195H760M190 0V260M380 0V260M570 0V260\" class=\"vq-map-grid\"/>" + marks + "</svg>";
    list.innerHTML = stores.map(function (store, index) {
      return "<li><button type=\"button\" data-store-filter=\"" + esc(store.site) + "\" aria-pressed=\"false\" class=\"vq-store-filter\"><span class=\"vq-store-number\">" + (index + 1) + "</span><span><strong>" + esc(store.name) + "</strong><small>" + esc(store.address || "Local shop") + "</small></span>" + (store.distance === null ? "" : "<small>" + store.distance.toFixed(1) + " mi</small>") + "</button></li>";
    }).join("");
  }
  function queryFor(location) {
    var search = new URLSearchParams();
    var place = String(location || "").trim();
    if (/^\d{5}(?:-\d{4})?$/.test(place)) search.set("postal_code", place);
    else {
      search.set("city", place);
      var state = document.getElementById("vq-state");
      if (state && /^[a-z]{2}$/i.test(state.value.trim())) search.set("state", state.value.trim());
    }
    var q = document.getElementById("q") || document.getElementById("qm");
    if (q && q.value.trim()) search.set("q", q.value.trim());
    var radius = document.getElementById("vq-radius"), sort = document.getElementById("vq-sort");
    var min = document.getElementById("vq-min-price"), max = document.getElementById("vq-max-price");
    if (radius) search.set("radius", radius.value);
    if (sort) {
      if (!search.has("postal_code") && sort.value === "distance") sort.value = "price_asc";
      search.set("sort", sort.value);
    }
    if (min && min.value !== "") search.set("min_price", min.value);
    if (max && max.value !== "") search.set("max_price", max.value);
    search.set("limit", "100");
    return search;
  }
  async function fetchProducts(search, label, append) {
    setStatus((append ? "Loading more" : "Looking for products") + " near " + label + "…");
    try {
      if (search.has("postal_code")) {
        var locationResponse = await fetch("/api/marketplace/location?postal_code=" + encodeURIComponent(search.get("postal_code")), { headers: { "accept": "application/json" } });
        var locationData = await locationResponse.json();
        if (!locationResponse.ok || !locationData.ok) throw new Error(locationData.message || locationData.error || "We couldn't locate that ZIP code.");
        search.delete("postal_code"); search.delete("city"); search.delete("state");
        search.set("lat", String(locationData.latitude)); search.set("lng", String(locationData.longitude));
      }
      if (append && nextCursor) search.set("cursor", nextCursor);
      else search.delete("cursor");
      var response = await fetch(api + "?" + search.toString(), { headers: { "accept": "application/json" } });
      var data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || data.error || "Search is temporarily unavailable.");
      var resultProducts = Array.isArray(data.products) ? data.products : [];
      products = append ? products.concat(resultProducts) : resultProducts;
      if (!append) { activeStore = "all"; currentSearch = new URLSearchParams(search.toString()); currentLocation = label; }
      nextCursor = data.next_cursor || null;
      renderFilters(data.categories || []);
      var grid = document.querySelector("[data-products]");
      if (grid) grid.innerHTML = append ? grid.innerHTML + resultProducts.map(productCard).join("") : products.map(productCard).join("");
      renderStores(products);
      var loadMore = document.getElementById("vq-load-more");
      if (loadMore) loadMore.hidden = !nextCursor;
      var count = data.total_count || products.length;
      setStatus(count ? products.length + " of " + count + " live product" + (count === 1 ? "" : "s") + " from nearby merchants. Each order is paid directly to its shop." : "No live products found nearby. Try a nearby city or ZIP code.");
      applyFilter("all");
      if (!append) window.history.replaceState({}, "", window.location.pathname + "?location=" + encodeURIComponent(label));
    } catch (error) {
      setStatus(error.message || "Search is temporarily unavailable.", true);
    }
  }
  async function searchProducts(event) {
    if (event) event.preventDefault();
    var input = document.getElementById("vq-location");
    var location = input ? input.value.trim() : "";
    if (!location) { setStatus("Enter a city or ZIP code to find nearby stores.", true); return; }
    fetchProducts(queryFor(location), location, false);
  }
  function initSearch() {
    var form = document.getElementById("location-search");
    if (form) form.addEventListener("submit", searchProducts);
    var desktop = document.getElementById("q"), mobile = document.getElementById("qm");
    [desktop, mobile].forEach(function (input) {
      if (!input) return;
      input.addEventListener("input", function () { [desktop, mobile].forEach(function (other) { if (other && other !== input) other.value = input.value; }); });
      var searchForm = input.closest("form");
      if (searchForm) searchForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var location = document.getElementById("vq-location");
        if (location && location.value.trim()) searchProducts(); else { setStatus("Enter a city or ZIP code before searching.", true); if (location) location.focus(); }
      });
    });
    var filters = document.getElementById("category-filters");
    if (filters) filters.addEventListener("click", function (event) {
      var button = event.target.closest("[data-filter]");
      if (button) applyFilter(button.getAttribute("data-filter"));
    });
    document.addEventListener("click", function (event) {
      var storeButton = event.target.closest("[data-store-filter]");
      if (storeButton) {
        activeStore = activeStore === storeButton.getAttribute("data-store-filter") ? "all" : storeButton.getAttribute("data-store-filter");
        document.querySelectorAll("[data-store-filter]").forEach(function (button) { button.setAttribute("aria-pressed", button.getAttribute("data-store-filter") === activeStore ? "true" : "false"); });
        var activeCategory = document.querySelector("#category-filters .is-active");
        applyFilter(activeCategory ? activeCategory.getAttribute("data-filter") : "all");
        return;
      }
      var link = event.target.closest("[data-filter-link]");
      if (!link) return;
      var category = link.getAttribute("data-filter-link");
      var button = document.querySelector('#category-filters [data-filter="' + CSS.escape(String(category).toLowerCase()) + '"]');
      if (button) { event.preventDefault(); applyFilter(button.getAttribute("data-filter")); document.getElementById("products").scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
    var initial = params.get("location");
    if (initial) { var locationInput = document.getElementById("vq-location"); if (locationInput) locationInput.value = initial; searchProducts(); }
    var locate = document.getElementById("vq-use-location");
    if (locate) locate.addEventListener("click", function () {
      if (!navigator.geolocation) { setStatus("Location services aren't available in this browser. Enter a city or ZIP instead.", true); return; }
      setStatus("Waiting for your location…");
      navigator.geolocation.getCurrentPosition(function (position) {
        var search = queryFor("location"); search.delete("city"); search.delete("state"); search.delete("postal_code");
        search.set("sort", "distance");
        var sort = document.getElementById("vq-sort"); if (sort) sort.value = "distance";
        search.set("lat", String(position.coords.latitude)); search.set("lng", String(position.coords.longitude));
        fetchProducts(search, "your location", false);
      }, function () { setStatus("Location access was unavailable. Enter a city or ZIP code instead.", true); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
    var loadMore = document.getElementById("vq-load-more");
    if (loadMore) loadMore.addEventListener("click", function () {
      if (!currentSearch || !nextCursor) return;
      var search = new URLSearchParams(currentSearch.toString());
      loadMore.disabled = true;
      fetchProducts(search, currentLocation, true).finally(function () { loadMore.disabled = false; });
    });
  }
  function initProductPage() {
    var root = document.getElementById("vq-product-detail");
    if (!root) return;
    var id = params.get("product_id");
    var product = null;
    var siteId = params.get("site_id") || "";
    try { product = JSON.parse(sessionStorage.getItem("vq-product-" + siteId + "::" + id) || "null"); } catch (_) {}
    if (!product) { root.innerHTML = "<p>Product details are unavailable. <a href=\"/marketplace\">Return to the marketplace and search again.</a></p>"; return; }
    var image = safeImage(product.image_url, product.category);
    root.innerHTML = "<div class=\"vq-pdp-media\"><img src=\"" + esc(image) + "\" alt=\"" + esc(product.name) + "\"></div>" +
      "<div class=\"vq-pdp-copy\"><p class=\"eyebrow\">" + esc(product.category || "Local product") + "</p><h1>" + esc(product.name) + "</h1>" +
      "<p class=\"vq-pdp-store\">Sold by " + esc(product.store && product.store.name || "local merchant") + (product.store && product.store.city ? " · " + esc(product.store.city) : "") + "</p>" +
      "<p class=\"vq-pdp-price\">" + money(product.price) + "</p><p>" + esc(product.description || "Available from this independent merchant while supplies last.") + "</p>" +
      "<p class=\"vq-card-stock\">" + Number(product.quantity) + " available</p>" +
      "<button class=\"btn-emp btn-emp--primary btn-emp--lg\" type=\"button\" data-add-to-cart data-product-id=\"" + esc(product.id) + "\" data-cart-key=\"" + esc(product.site_id + "::" + product.id) + "\" data-site-id=\"" + esc(product.site_id) + "\" data-store-name=\"" + esc(product.store && product.store.name || "local merchant") + "\" data-stock=\"" + Number(product.quantity) + "\" data-name=\"" + esc(product.name) + "\" data-price=\"" + Number(product.price) + "\" data-img=\"" + esc(image) + "\">Add to cart</button><p class=\"vq-merchant-pay\">Payment goes directly to the merchant.</p></div>";
  }
  function initCheckout() {
    var button = document.getElementById("vq-checkout");
    if (!button) return;
    button.addEventListener("click", async function () {
      var status = document.getElementById("vq-cart-status");
      var items = [];
      try { items = JSON.parse(localStorage.getItem("vq-market-cart") || "[]"); } catch (_) {}
      var stores = Array.from(new Set(items.map(function (item) { return item.siteId; })));
      if (!items.length) { status.textContent = "Your cart is empty."; return; }
      if (stores.length !== 1 || !/^[a-f0-9]{32}$/.test(stores[0] || "")) { status.textContent = "Checkout is one store per order. Remove items from other stores to continue."; return; }
      button.disabled = true; status.textContent = "Preparing secure merchant checkout…";
      try {
        var response = await fetch("/api/payments/public/checkout/" + stores[0], { method: "POST", headers: { "content-type": "application/json", "accept": "application/json" }, body: JSON.stringify({ items: items.map(function (item) { return { product_id: item.productId, quantity: item.qty }; }) }) });
        var data = await response.json();
        if (!response.ok || !data.url) throw new Error(data.error || "Merchant checkout could not be created.");
        window.location.assign(data.url);
      } catch (error) { status.textContent = error.message || "Checkout is temporarily unavailable."; button.disabled = false; }
    });
  }
  document.addEventListener("DOMContentLoaded", function () { initSearch(); initProductPage(); initCheckout(); });
})();
