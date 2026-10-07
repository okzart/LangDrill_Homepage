// The Map page (views/map.pug): a map from the provider the user picks,
// the places around a spot, and the "place pack" of English expressions for
// the kind of place they choose. Server side: src/routes/mapRoutes.js.
//
// Three providers sit behind one small interface (PROVIDERS below), so the
// rest of the page never knows which map it is talking to:
//   init(el, pos)        draw the map in `el`, centred on pos { lat, lng }
//   destroy()            remove it (before switching provider)
//   center()             → the map's current centre
//   moveTo(pos)          centre the map there
//   showUser(pos)        mark where the user is
//   showPlaces(places, onPick)   mark the places; onPick(place) on a click
//   nearby(pos)          → Promise<[place]> around pos
//   search(text, pos)    → Promise<[place]> for a typed query, near pos
// A place is { name, lat, lng, address, category } - `category` being one of
// content-sharing's place kinds (restaurant, pharmacy...) or null when the
// provider's own type maps to none of them.
//
// Positions and searches go from the browser straight to the provider;
// this site's server only ever hears which *kind* of place was picked.
(function () {
  'use strict';

  var cfg = window.LD_MAP;
  var $ = function (id) { return document.getElementById(id); };
  var KOREAN = window.LD_LANG === 'ko';
  var SEOUL = { lat: 37.5665, lng: 126.978 }; // where the map opens before any position is known
  var NEARBY_RADIUS_M = 250;
  var REFRESH_AFTER_M = 60;   // while following: look places up again after moving this far
  var ARRIVED_WITHIN_M = 80;  // while following: a place this close counts as "you are at"
  var WORD = /[A-Za-z']+/g;

  var categories = {};
  cfg.categories.forEach(function (c) { categories[c.id] = c; });
  function kindLabel(id) { var c = categories[id]; return c ? (KOREAN ? c.ko : c.en) : ''; }

  // ---- small helpers -------------------------------------------------------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  var errorBox = $('error');
  function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
  function clearError() { errorBox.hidden = true; }
  function setStatus(msg) { $('status').textContent = msg || ''; }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error(t('The map could not be loaded - check your connection.'))); };
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  // Metres between two positions (haversine).
  function distance(a, b) {
    var rad = Math.PI / 180, R = 6371000;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function distanceLabel(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km'; }

  // fetch → JSON; errors → Error(message); 401 → /login.
  function call(url, opts) {
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { location.href = '/login?next=/map'; throw new Error(t('Not logged in')); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || t('Request failed ({status})', { status: res.status }));
        return data;
      });
    });
  }

  // ---- provider: OpenStreetMap (Leaflet + Nominatim + Overpass; no key) -----
  // OpenStreetMap tag → place kind, per tag key.
  var OSM_KINDS = {
    amenity: {
      restaurant: 'restaurant', food_court: 'restaurant', cafe: 'cafe', fast_food: 'fast_food', bar: 'bar', pub: 'bar', biergarten: 'bar',
      pharmacy: 'pharmacy', hospital: 'hospital', clinic: 'hospital', doctors: 'hospital', dentist: 'hospital',
      bank: 'bank', atm: 'bank', bureau_de_change: 'bank', post_office: 'post_office', fuel: 'gas_station', parking: 'parking',
      cinema: 'cinema', theatre: 'cinema', library: 'library', police: 'police', bus_station: 'bus_station',
      school: 'school', university: 'school', college: 'school',
    },
    shop: {
      bakery: 'bakery', pastry: 'bakery', convenience: 'convenience_store', supermarket: 'supermarket', greengrocer: 'supermarket',
      books: 'bookstore', hairdresser: 'hair_salon', beauty: 'hair_salon',
      clothes: 'shopping', shoes: 'shopping', mall: 'shopping', department_store: 'shopping', electronics: 'shopping', gift: 'shopping', cosmetics: 'shopping', jewelry: 'shopping', sports: 'shopping',
    },
    tourism: { hotel: 'hotel', hostel: 'hotel', guest_house: 'hotel', motel: 'hotel', museum: 'museum', gallery: 'museum', attraction: 'tourist_attraction', viewpoint: 'tourist_attraction', theme_park: 'tourist_attraction', zoo: 'tourist_attraction', aquarium: 'tourist_attraction' },
    leisure: { park: 'park', garden: 'park', fitness_centre: 'gym', sports_centre: 'gym' },
    aeroway: { aerodrome: 'airport', terminal: 'airport' },
    railway: { station: 'train_station', halt: 'train_station', subway_entrance: 'train_station' },
    highway: { bus_stop: 'bus_station' },
  };
  function osmKind(tags) {
    for (var key in OSM_KINDS) {
      var value = tags[key];
      if (value && OSM_KINDS[key][value]) return OSM_KINDS[key][value];
    }
    return null;
  }
  // One Overpass query for everything OSM_KINDS knows, around a position.
  function overpassQuery(pos) {
    var around = '(around:' + NEARBY_RADIUS_M + ',' + pos.lat + ',' + pos.lng + ')';
    var parts = Object.keys(OSM_KINDS).map(function (key) {
      return 'nwr' + around + '[' + key + '~"^(' + Object.keys(OSM_KINDS[key]).join('|') + ')$"];';
    });
    return '[out:json][timeout:20];(' + parts.join('') + ');out center tags 80;';
  }

  var OVERPASS_SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  var osm = {
    label: 'OpenStreetMap',
    map: null, layer: null, userMark: null,
    init: function (node, pos) {
      var self = this;
      var ready = window.L ? Promise.resolve() : (loadCss('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'), loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'));
      return ready.then(function () {
        self.map = L.map(node).setView([pos.lat, pos.lng], 16);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(self.map);
        self.layer = L.layerGroup().addTo(self.map);
      });
    },
    destroy: function () { if (this.map) this.map.remove(); this.map = this.layer = this.userMark = null; },
    center: function () { var c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    moveTo: function (pos) { this.map.setView([pos.lat, pos.lng], Math.max(this.map.getZoom(), 16)); },
    showUser: function (pos) {
      if (this.userMark) this.userMark.setLatLng([pos.lat, pos.lng]);
      else this.userMark = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#b03a50', fillOpacity: 1 }).addTo(this.map);
    },
    showPlaces: function (places, onPick) {
      var layer = this.layer;
      layer.clearLayers();
      places.forEach(function (place) {
        L.circleMarker([place.lat, place.lng], { radius: 7, color: '#fff', weight: 2, fillColor: place.category ? '#416180' : '#9aa3ad', fillOpacity: 1 })
          .bindTooltip(place.name)
          .on('click', function () { onPick(place); })
          .addTo(layer);
      });
    },
    nearby: function (pos) {
      // The public Overpass servers are shared and sometimes answer "busy"
      // (429/504); the next one is tried before giving up.
      var query = new URLSearchParams({ data: overpassQuery(pos) });
      function ask(i) {
        return fetch(OVERPASS_SERVERS[i], { method: 'POST', body: query, signal: AbortSignal.timeout(12000) })
          .then(function (res) { if (!res.ok) throw new Error(); return res.json(); })
          .catch(function () {
            if (i + 1 < OVERPASS_SERVERS.length) return ask(i + 1);
            throw new Error(t('The place lookup is busy - try again in a moment.'));
          });
      }
      return ask(0)
        .then(function (data) {
          return (data.elements || []).map(function (e) {
            var tags = e.tags || {};
            var lat = e.lat !== undefined ? e.lat : e.center && e.center.lat;
            var lng = e.lon !== undefined ? e.lon : e.center && e.center.lon;
            var category = osmKind(tags);
            var name = (KOREAN ? tags.name : tags['name:en']) || tags.name || kindLabel(category);
            var address = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
            return lat === undefined || !name ? null : { name: name, lat: lat, lng: lng, address: address, category: category };
          }).filter(Boolean);
        });
    },
    search: function (text) {
      // Nominatim: one request per submitted search (its usage policy rules out search-as-you-type).
      var url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', limit: '8', q: text, 'accept-language': KOREAN ? 'ko,en' : 'en,ko' });
      return fetch(url).then(function (res) { if (!res.ok) throw new Error(t('The place search is busy - try again in a moment.')); return res.json(); }).then(function (rows) {
        return rows.map(function (r) {
          var tags = {};
          tags[r.category] = r.type;
          return { name: r.name || String(r.display_name).split(',')[0], lat: Number(r.lat), lng: Number(r.lon), address: r.display_name, category: osmKind(tags) };
        });
      });
    },
  };

  // ---- provider: Google Maps (Maps JavaScript API + Places API (New)) -------
  // Google place type → place kind. Checked in this order against the place's
  // primary type first, then its other types; "*_restaurant" is handled below.
  var GOOGLE_KINDS = {
    fast_food_restaurant: 'fast_food', hamburger_restaurant: 'fast_food', cafe: 'cafe', coffee_shop: 'cafe', tea_house: 'cafe', bar: 'bar', pub: 'bar', wine_bar: 'bar',
    bakery: 'bakery', convenience_store: 'convenience_store', supermarket: 'supermarket', grocery_store: 'supermarket', market: 'supermarket',
    book_store: 'bookstore', pharmacy: 'pharmacy', drugstore: 'pharmacy', hospital: 'hospital', doctor: 'hospital', dentist: 'hospital', dental_clinic: 'hospital',
    bank: 'bank', atm: 'bank', post_office: 'post_office', hotel: 'hotel', lodging: 'hotel', hostel: 'hotel', motel: 'hotel', guest_house: 'hotel',
    airport: 'airport', international_airport: 'airport', train_station: 'train_station', subway_station: 'train_station', light_rail_station: 'train_station', transit_station: 'train_station',
    bus_station: 'bus_station', bus_stop: 'bus_station', gas_station: 'gas_station', parking: 'parking', museum: 'museum', art_gallery: 'museum',
    movie_theater: 'cinema', performing_arts_theater: 'cinema', tourist_attraction: 'tourist_attraction', amusement_park: 'tourist_attraction', zoo: 'tourist_attraction', aquarium: 'tourist_attraction',
    park: 'park', national_park: 'park', gym: 'gym', fitness_center: 'gym', hair_salon: 'hair_salon', hair_care: 'hair_salon', beauty_salon: 'hair_salon', barber_shop: 'hair_salon',
    school: 'school', university: 'school', primary_school: 'school', secondary_school: 'school', library: 'library', police: 'police',
    shopping_mall: 'shopping', clothing_store: 'shopping', department_store: 'shopping', shoe_store: 'shopping', electronics_store: 'shopping', gift_shop: 'shopping', jewelry_store: 'shopping', store: 'shopping',
    restaurant: 'restaurant', food_court: 'restaurant', meal_takeaway: 'restaurant',
  };
  function googleKind(primary, types) {
    var all = (primary ? [primary] : []).concat(types || []);
    for (var i = 0; i < all.length; i++) {
      if (GOOGLE_KINDS[all[i]]) return GOOGLE_KINDS[all[i]];
      if (/_restaurant$/.test(all[i])) return 'restaurant';
    }
    return null;
  }
  var GOOGLE_FIELDS = ['displayName', 'location', 'primaryType', 'types', 'formattedAddress'];

  var google_ = {
    label: 'Google',
    map: null, marks: [], userMark: null,
    load: function () {
      if (window.google && window.google.maps && window.google.maps.importLibrary) return Promise.resolve();
      // Google calls this when the key is wrong, or not allowed on this site.
      window.gm_authFailure = function () { showError(t('Google Maps rejected the API key - check GOOGLE_MAPS_API_KEY and its allowed sites.')); };
      return new Promise(function (resolve, reject) {
        window.__ldGoogleReady = resolve;
        loadScript('https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: cfg.providers.keys.google, v: 'weekly', loading: 'async', libraries: 'places', language: KOREAN ? 'ko' : 'en', callback: '__ldGoogleReady' })).catch(reject);
      });
    },
    init: function (node, pos) {
      var self = this;
      return this.load().then(function () {
        self.map = new google.maps.Map(node, { center: pos, zoom: 16, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
      });
    },
    destroy: function () {
      this.marks.forEach(function (m) { m.setMap(null); });
      if (this.userMark) this.userMark.setMap(null);
      this.map = this.userMark = null;
      this.marks = [];
    },
    center: function () { var c = this.map.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
    moveTo: function (pos) { this.map.panTo(pos); if (this.map.getZoom() < 16) this.map.setZoom(16); },
    dot: function (fill, scale) { return { path: google.maps.SymbolPath.CIRCLE, scale: scale, fillColor: fill, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }; },
    showUser: function (pos) {
      if (this.userMark) this.userMark.setPosition(pos);
      else this.userMark = new google.maps.Marker({ map: this.map, position: pos, icon: this.dot('#b03a50', 8), zIndex: 999 });
    },
    showPlaces: function (places, onPick) {
      var self = this;
      this.marks.forEach(function (m) { m.setMap(null); });
      this.marks = places.map(function (place) {
        var mark = new google.maps.Marker({ map: self.map, position: { lat: place.lat, lng: place.lng }, title: place.name, icon: self.dot(place.category ? '#416180' : '#9aa3ad', 7) });
        mark.addListener('click', function () { onPick(place); });
        return mark;
      });
    },
    toPlaces: function (found) {
      return (found || []).filter(function (p) { return p.location; }).map(function (p) {
        return { name: p.displayName || '', lat: p.location.lat(), lng: p.location.lng(), address: p.formattedAddress || '', category: googleKind(p.primaryType, p.types) };
      });
    },
    nearby: function (pos) {
      var self = this;
      return google.maps.importLibrary('places').then(function (lib) {
        return lib.Place.searchNearby({ fields: GOOGLE_FIELDS, locationRestriction: { center: pos, radius: NEARBY_RADIUS_M }, maxResultCount: 20, rankPreference: lib.SearchNearbyRankPreference.DISTANCE });
      }).then(function (res) { return self.toPlaces(res.places); });
    },
    search: function (text, pos) {
      var self = this;
      return google.maps.importLibrary('places').then(function (lib) {
        return lib.Place.searchByText({ textQuery: text, fields: GOOGLE_FIELDS, locationBias: pos, maxResultCount: 8 });
      }).then(function (res) { return self.toPlaces(res.places); });
    },
  };

  // ---- provider: Kakao Maps (JavaScript SDK + its Places service) -----------
  // Kakao's category group code → place kind; refined by the category path
  // ("음식점 > 패스트푸드 > ...") in kakaoKind().
  var KAKAO_GROUPS = { FD6: 'restaurant', CE7: 'cafe', CS2: 'convenience_store', MT1: 'supermarket', PM9: 'pharmacy', HP8: 'hospital', BK9: 'bank', AD5: 'hotel', SW8: 'train_station', AT4: 'tourist_attraction', CT1: 'museum', OL7: 'gas_station', PK6: 'parking', SC4: 'school' };
  var KAKAO_WORDS = [
    ['패스트푸드', 'fast_food'], ['술집', 'bar'], ['제과', 'bakery'], ['베이커리', 'bakery'], ['서점', 'bookstore'], ['미용', 'hair_salon'], ['헬스', 'gym'], ['공원', 'park'],
    ['공항', 'airport'], ['도서관', 'library'], ['영화관', 'cinema'], ['공연장', 'cinema'], ['경찰', 'police'], ['우체국', 'post_office'], ['버스', 'bus_station'],
    ['백화점', 'shopping'], ['쇼핑', 'shopping'], ['의류', 'shopping'], ['기차역', 'train_station'], ['지하철', 'train_station'],
  ];
  function kakaoKind(row) {
    var path = row.category_name || '';
    for (var i = 0; i < KAKAO_WORDS.length; i++) if (path.indexOf(KAKAO_WORDS[i][0]) !== -1) return KAKAO_WORDS[i][1];
    return KAKAO_GROUPS[row.category_group_code] || null;
  }
  function kakaoPlace(row) {
    return { name: row.place_name, lat: Number(row.y), lng: Number(row.x), address: row.road_address_name || row.address_name || '', category: kakaoKind(row) };
  }

  var kakao_ = {
    label: 'Kakao',
    map: null, marks: [], userMark: null, places: null,
    load: function () {
      if (window.kakao && window.kakao.maps && window.kakao.maps.Map) return Promise.resolve();
      return loadScript('https://dapi.kakao.com/v2/maps/sdk.js?' + new URLSearchParams({ appkey: cfg.providers.keys.kakao, libraries: 'services', autoload: 'false' }))
        .then(function () { return new Promise(function (resolve) { kakao.maps.load(resolve); }); })
        .catch(function () { throw new Error(t('Kakao Maps could not be loaded - check KAKAO_MAP_JS_KEY and that this site is registered for it.')); });
    },
    init: function (node, pos) {
      var self = this;
      return this.load().then(function () {
        self.map = new kakao.maps.Map(node, { center: new kakao.maps.LatLng(pos.lat, pos.lng), level: 3 });
        self.places = new kakao.maps.services.Places();
      });
    },
    destroy: function () {
      this.marks.forEach(function (m) { m.setMap(null); });
      if (this.userMark) this.userMark.setMap(null);
      this.map = this.userMark = this.places = null;
      this.marks = [];
    },
    center: function () { var c = this.map.getCenter(); return { lat: c.getLat(), lng: c.getLng() }; },
    moveTo: function (pos) { this.map.setCenter(new kakao.maps.LatLng(pos.lat, pos.lng)); if (this.map.getLevel() > 3) this.map.setLevel(3); },
    showUser: function (pos) {
      var at = new kakao.maps.LatLng(pos.lat, pos.lng);
      if (this.userMark) this.userMark.setPosition(at);
      else this.userMark = new kakao.maps.Circle({ map: this.map, center: at, radius: 6, strokeWeight: 3, strokeColor: '#ffffff', fillColor: '#b03a50', fillOpacity: 1, zIndex: 9 });
    },
    showPlaces: function (places, onPick) {
      var self = this;
      this.marks.forEach(function (m) { m.setMap(null); });
      this.marks = places.map(function (place) {
        var mark = new kakao.maps.Marker({ map: self.map, position: new kakao.maps.LatLng(place.lat, place.lng), title: place.name, clickable: true });
        kakao.maps.event.addListener(mark, 'click', function () { onPick(place); });
        return mark;
      });
    },
    // Kakao has no "everything nearby" call, only one per category group -
    // so the groups are asked for side by side and merged.
    nearby: function (pos) {
      var self = this;
      var at = new kakao.maps.LatLng(pos.lat, pos.lng);
      return Promise.all(Object.keys(KAKAO_GROUPS).map(function (code) {
        return new Promise(function (resolve) {
          self.places.categorySearch(code, function (rows, status) { resolve(status === kakao.maps.services.Status.OK ? rows : []); }, { location: at, radius: NEARBY_RADIUS_M, sort: kakao.maps.services.SortBy.DISTANCE, size: 5 });
        });
      })).then(function (groups) { return [].concat.apply([], groups).map(kakaoPlace); });
    },
    search: function (text, pos) {
      var self = this;
      return new Promise(function (resolve, reject) {
        self.places.keywordSearch(text, function (rows, status) {
          if (status === kakao.maps.services.Status.ERROR) return reject(new Error(t('The place search is busy - try again in a moment.')));
          resolve(status === kakao.maps.services.Status.OK ? rows.map(kakaoPlace) : []);
        }, { location: new kakao.maps.LatLng(pos.lat, pos.lng), size: 8 });
      });
    },
  };

  var PROVIDERS = { osm: osm, google: google_, kakao: kakao_ };

  // ---- the map and its provider switch ------------------------------------
  var provider = null;      // the active entry of PROVIDERS, once its map is drawn
  var userPos = null;       // last known position of the user
  var shown = [];           // places currently listed
  var pickedPlace = null;

  function savedProvider() {
    try { return localStorage.getItem('ld_map_provider'); } catch (e) { return null; }
  }
  function useProvider(id) {
    var at = provider ? provider.center() : userPos || SEOUL;
    if (provider) provider.destroy();
    provider = null;
    $('map').textContent = '';
    document.querySelectorAll('#providers button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.id === id ? 'true' : 'false'); });
    try { localStorage.setItem('ld_map_provider', id); } catch (e) { /* private mode: the choice just isn't remembered */ }
    clearError();
    setStatus(t('Loading the map…'));
    var next = PROVIDERS[id];
    return next.init($('map'), at).then(function () {
      provider = next;
      setStatus('');
      if (userPos) provider.showUser(userPos);
      provider.showPlaces(shown, pickPlace);
    }).catch(function (err) {
      setStatus('');
      showError(err.message || t('The map could not be loaded - check your connection.'));
    });
  }
  cfg.providers.available.forEach(function (id) {
    var b = el('button', '', PROVIDERS[id].label);
    b.type = 'button';
    b.dataset.id = id;
    b.addEventListener('click', function () { if (b.getAttribute('aria-pressed') !== 'true') useProvider(id); });
    $('providers').appendChild(b);
  });
  $('providers').hidden = cfg.providers.available.length < 2;

  // ---- places ---------------------------------------------------------------
  // Lists the places (nearest to `from` first) and marks them on the map.
  function listPlaces(places, from) {
    var seen = {};
    shown = places.filter(function (p) {
      var key = p.name + '|' + p.lat.toFixed(4) + '|' + p.lng.toFixed(4);
      if (seen[key]) return false;
      seen[key] = true;
      p.distance = from ? distance(from, p) : null;
      return true;
    }).sort(function (a, b) { return (a.distance || 0) - (b.distance || 0); }).slice(0, 40);

    var list = $('places');
    list.textContent = '';
    shown.forEach(function (place) {
      var b = el('button');
      b.type = 'button';
      b.appendChild(el('span', 'name', place.name));
      b.appendChild(el('span', 'dist', place.distance !== null ? distanceLabel(place.distance) : ''));
      b.appendChild(el('span', place.category ? 'kind' : 'kind none', place.category ? kindLabel(place.category) : t('No expressions for this kind of place yet')));
      b.addEventListener('click', function () { pickPlace(place); });
      place.button = b;
      var li = el('li');
      li.appendChild(b);
      list.appendChild(li);
    });
    $('places-empty').hidden = shown.length > 0;
    if (!shown.length) $('places-empty').textContent = t('Nothing was found here. Try another spot or a wider search.');
    if (provider) provider.showPlaces(shown, pickPlace);
  }

  function pickPlace(place) {
    pickedPlace = place;
    shown.forEach(function (p) { if (p.button) p.button.setAttribute('aria-current', p === place ? 'true' : 'false'); });
    if (place.button) place.button.scrollIntoView({ block: 'nearest' });
    if (provider) provider.moveTo(place);
    if (place.category) showPack(place.category, place.name);
    else {
      $('pack-where').textContent = place.name;
      setStatus(t('No expressions for this kind of place yet - pick a kind below.'));
    }
  }

  // Looks up what is around `pos`. `arriving` = this came from following the
  // user, so the nearest known kind of place opens by itself.
  var lookups = 0;
  function lookAround(pos, arriving) {
    if (!provider) return Promise.resolve();
    var mine = ++lookups;
    setStatus(t('Looking for places nearby…'));
    return provider.nearby(pos).then(function (places) {
      if (mine !== lookups) return; // a newer lookup replaced this one
      listPlaces(places, pos);
      setStatus(t('{n} places within {m} m', { n: shown.length, m: NEARBY_RADIUS_M }));
      if (arriving) announceNearest();
    }).catch(function (err) {
      if (mine !== lookups) return;
      setStatus('');
      showError(err.message || t('The place lookup is busy - try again in a moment.'));
    });
  }

  var announced = null; // the place the banner was last shown for
  function announceNearest() {
    var near = shown.filter(function (p) { return p.category && p.distance !== null && p.distance <= ARRIVED_WITHIN_M; })[0];
    if (!near) { $('near-banner').hidden = true; return; }
    var key = near.name + '|' + near.category;
    if (announced === key) return;
    announced = key;
    $('near-text').textContent = t('You are near {name} - here is what to say at a {kind}.', { name: near.name, kind: KOREAN ? kindLabel(near.category) : kindLabel(near.category).toLowerCase() });
    $('near-banner').hidden = false;
    pickPlace(near);
  }

  // ---- the user's position ---------------------------------------------------
  function locationError(err) {
    if (!window.isSecureContext) return t('Your browser only shares your location with secure (https) sites - search for a place instead.');
    if (err && err.code === 1) return t('Location access was refused - allow it for this site, or search for a place instead.');
    return t('Your location could not be found - search for a place instead.');
  }
  function here(pos) { return { lat: pos.coords.latitude, lng: pos.coords.longitude }; }

  $('near-me').addEventListener('click', function () {
    clearError();
    if (!navigator.geolocation) return showError(locationError());
    setStatus(t('Finding where you are…'));
    navigator.geolocation.getCurrentPosition(function (pos) {
      userPos = here(pos);
      if (!provider) return;
      provider.showUser(userPos);
      provider.moveTo(userPos);
      lookAround(userPos, true);
    }, function (err) { setStatus(''); showError(locationError(err)); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });

  // "Follow me": keep watching the position; look places up again each time
  // the user has moved REFRESH_AFTER_M since the last lookup. Works while
  // this page is open - a phone app is needed for notifications in the pocket.
  var watchId = null, lastLookupAt = null;
  $('follow').addEventListener('change', function () {
    clearError();
    if (!this.checked) {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      return;
    }
    if (!navigator.geolocation) { this.checked = false; return showError(locationError()); }
    var box = this;
    lastLookupAt = null;
    watchId = navigator.geolocation.watchPosition(function (pos) {
      userPos = here(pos);
      if (!provider) return;
      provider.showUser(userPos);
      if (lastLookupAt && distance(lastLookupAt, userPos) < REFRESH_AFTER_M) return;
      lastLookupAt = userPos;
      provider.moveTo(userPos);
      lookAround(userPos, true);
    }, function (err) {
      box.checked = false;
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      showError(locationError(err));
    }, { enableHighAccuracy: true, maximumAge: 10000 });
  });

  $('here').addEventListener('click', function () { clearError(); if (provider) lookAround(provider.center(), false); });

  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('q').value.trim();
    if (!text || !provider) return;
    clearError();
    setStatus(t('Searching…'));
    var from = provider.center();
    var mine = ++lookups;
    provider.search(text, from).then(function (places) {
      if (mine !== lookups) return;
      listPlaces(places, null);
      setStatus(t('{n} results', { n: shown.length }));
      if (shown.length) pickPlace(shown[0]);
    }).catch(function (err) {
      if (mine !== lookups) return;
      setStatus('');
      showError(err.message || t('The place search is busy - try again in a moment.'));
    });
  });

  // ---- the pack of expressions ------------------------------------------------
  var packs = {};          // "restaurant/intermediate" → pack, for this page view
  var current = null;      // { category, level, pack, placeName }
  var packRequests = 0;

  function showPack(category, placeName) {
    var level = $('level').value;
    var key = category + '/' + level;
    var mine = ++packRequests;
    document.querySelectorAll('#chips button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.id === category ? 'true' : 'false'); });
    $('pack-title').textContent = kindLabel(category);
    $('pack-where').textContent = placeName || '';
    $('pack-empty').hidden = true;
    $('save-status').textContent = '';
    if (packs[key]) return renderPack(category, level, packs[key], placeName);

    $('pack').textContent = '';
    $('pack-actions').hidden = true;
    var status = $('pack-status');
    status.hidden = false;
    status.textContent = t('Getting the expressions… (the first time for a kind of place, the AI writes them - about 20 seconds)');
    call('/map/expressions?' + new URLSearchParams({ category: category, level: level })).then(function (pack) {
      packs[key] = pack;
      if (mine === packRequests) renderPack(category, level, pack, placeName);
    }).catch(function (err) {
      if (mine !== packRequests) return;
      status.hidden = true;
      showError(err.message);
    });
  }

  // "Could I have the bill, please?" with its key words in <mark>.
  function sentenceNode(line) {
    var node = el('span', 'en');
    var marked = {};
    (line.blanks || []).forEach(function (b) { marked[b.at] = true; });
    var at = 0, last = 0, m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(line.en)) !== null) {
      node.appendChild(document.createTextNode(line.en.slice(last, m.index)));
      node.appendChild(marked[at] ? el('mark', '', m[0]) : document.createTextNode(m[0]));
      last = m.index + m[0].length;
      at++;
    }
    node.appendChild(document.createTextNode(line.en.slice(last)));
    return node;
  }

  function renderPack(category, level, pack, placeName) {
    current = { category: category, level: level, pack: pack, placeName: placeName };
    $('pack-status').hidden = true;
    var box = $('pack');
    box.textContent = '';
    pack.situations.forEach(function (situation) {
      var block = el('div', 'situation');
      var h = el('h3', '', KOREAN ? situation.titleKo : situation.title);
      h.appendChild(el('small', '', KOREAN ? situation.title : situation.titleKo));
      block.appendChild(h);
      var list = el('ul', 'lines');
      situation.expressions.forEach(function (line) {
        var li = el('li');
        li.appendChild(el('span', line.role === 'hear' ? 'role hear' : 'role', line.role === 'hear' ? t('You hear') : t('You say')));
        var txt = el('div', 'txt');
        txt.appendChild(sentenceNode(line));
        txt.appendChild(el('span', 'ko', line.ko));
        li.appendChild(txt);
        var play = el('button', 'play', '▶');
        play.type = 'button';
        play.title = t('Listen');
        play.setAttribute('aria-label', t('Listen'));
        play.dataset.text = line.en;
        li.appendChild(play);
        list.appendChild(li);
      });
      block.appendChild(list);
      box.appendChild(block);
    });
    $('pack-actions').hidden = false;
    $('regenerate').hidden = !cfg.isAdmin;
    // The tutor plays the other side: staff at this kind of place.
    $('practise').href = '/chat?' + new URLSearchParams({ scenario: 'You are playing a staff member at a ' + pack.title.toLowerCase() + '. The user is a Korean learner of English practising what to say there. Stay in character, speak natural English in short turns, and wait for the user. If the user makes a mistake, give a brief correction in brackets after your reply.' });
  }

  $('level').addEventListener('change', function () { if (current) showPack(current.category, current.placeName); });

  cfg.categories.forEach(function (c) {
    var b = el('button', '', KOREAN ? c.ko : c.en);
    b.type = 'button';
    b.dataset.id = c.id;
    b.addEventListener('click', function () { clearError(); showPack(c.id, ''); $('pack-sec').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    $('chips').appendChild(b);
  });

  // Listen to a sentence (tts-service through /chat/speech).
  var player = new Audio(), playingBtn = null, playUrl = null;
  function stopPlaying() { if (playingBtn) playingBtn.classList.remove('playing'); playingBtn = null; }
  player.addEventListener('ended', stopPlaying);
  $('pack').addEventListener('click', function (e) {
    var btn = e.target.closest('.play');
    if (!btn) return;
    if (playingBtn === btn) { player.pause(); stopPlaying(); return; }
    stopPlaying();
    playingBtn = btn;
    btn.classList.add('playing');
    fetch('/chat/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: btn.dataset.text }) })
      .then(function (res) { if (!res.ok) throw new Error(); return res.blob(); })
      .then(function (blob) {
        if (playingBtn !== btn) return;
        if (playUrl) URL.revokeObjectURL(playUrl);
        playUrl = URL.createObjectURL(blob);
        player.src = playUrl;
        return player.play();
      })
      .catch(function () { stopPlaying(); showError(t('Speech is unavailable right now.')); });
  });

  // Save the whole pack as a vocab drill set: each line becomes a
  // fill-in-the-blank item with its key words hidden.
  $('save').addEventListener('click', function () {
    if (!current) return;
    clearError();
    var items = [];
    current.pack.situations.forEach(function (s) {
      s.expressions.forEach(function (line) { items.push({ ko: line.ko, answer: line.en, blanks: line.blanks }); });
    });
    var btn = $('save');
    btn.disabled = true;
    $('save-status').textContent = t('Saving and narrating {n} sentences…', { n: items.length });
    call('/map/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t('{kind} expressions', { kind: kindLabel(current.category) }), desc: t('What to say at a {kind} - from the map.', { kind: kindLabel(current.category) }), items: items }),
    }).then(function (data) {
      var status = $('save-status');
      status.textContent = t('Saved.') + ' ';
      var link = el('a', '', t('Open the set'));
      link.href = '/community/' + encodeURIComponent(data.id);
      status.appendChild(link);
    }).catch(function (err) {
      $('save-status').textContent = '';
      showError(err.message);
    }).then(function () { btn.disabled = false; });
  });

  $('regenerate').addEventListener('click', function () {
    if (!current) return;
    clearError();
    var was = current;
    var btn = $('regenerate');
    btn.disabled = true;
    $('save-status').textContent = t('Writing the pack again…');
    call('/map/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: was.category, level: was.level }) }).then(function (pack) {
      packs[was.category + '/' + was.level] = pack;
      $('save-status').textContent = '';
      if (current === was) renderPack(was.category, was.level, pack, was.placeName);
    }).catch(function (err) {
      $('save-status').textContent = '';
      showError(err.message);
    }).then(function () { btn.disabled = false; });
  });

  // ---- start ------------------------------------------------------------------
  var first = savedProvider();
  useProvider(cfg.providers.available.indexOf(first) !== -1 ? first : cfg.providers.fallback);
})();
