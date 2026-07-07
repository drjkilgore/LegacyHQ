// HomegoingHQ — provider discovery via Google Places API (New)
// Env var: GOOGLE_MAPS_API_KEY  (Places API enabled)
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return { statusCode: 200, headers, body: JSON.stringify({ error: "Provider discovery isn't configured yet — add GOOGLE_MAPS_API_KEY." }) };
  const FIELDS = "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.currentOpeningHours.openNow,places.businessStatus";
  const search = async (textQuery, center, radiusMeters) => {
    const body = { textQuery, pageSize: 15 };
    if (center) body.locationBias = { circle: { center, radius: Math.min(radiusMeters, 50000) } };
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify(body)
    });
    return r.json();
  };
  const dist = (a, b) => { // miles, haversine
    const R = 3958.8, toR = d => d * Math.PI / 180;
    const dLat = toR(b.latitude - a.latitude), dLon = toR(b.longitude - a.longitude);
    const h = Math.sin(dLat/2)**2 + Math.cos(toR(a.latitude))*Math.cos(toR(b.latitude))*Math.sin(dLon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(h));
  };
  try {
    const { category, address, lat, lng, radiusMiles } = JSON.parse(event.body || "{}");
    // 1) resolve center
    let center = (lat && lng) ? { latitude: lat, longitude: lng } : null;
    if (!center && address) {
      const g = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "places.location,places.formattedAddress" },
        body: JSON.stringify({ textQuery: address, pageSize: 1 })
      }).then(r => r.json());
      if (g.places && g.places[0]) center = g.places[0].location;
    }
    if (!center) return { statusCode: 200, headers, body: JSON.stringify({ error: "Couldn't find that location — try a fuller address or city, state." }) };
    // 2) search with auto-expanding radius
    const ladder = [radiusMiles || 10, 20, 30, 50, 75, 100].filter((v, i, a) => a.indexOf(v) === i && v >= (radiusMiles || 10));
    let places = [], usedRadius = ladder[0];
    for (const mi of ladder) {
      const d = await search(category + " near " + (address || "me"), center, mi * 1609);
      places = (d.places || []).filter(p => p.businessStatus !== "CLOSED_PERMANENTLY");
      usedRadius = mi;
      if (places.length >= 5) break;
    }
    const out = places.map(p => ({
      name: p.displayName?.text || "Unknown",
      address: p.formattedAddress || "",
      phone: p.nationalPhoneNumber || "",
      website: p.websiteUri || "",
      mapsUrl: p.googleMapsUri || "",
      rating: p.rating || null,
      ratingCount: p.userRatingCount || 0,
      openNow: p.currentOpeningHours ? !!p.currentOpeningHours.openNow : null,
      distanceMi: p.location ? Math.round(dist(center, p.location) * 10) / 10 : null
    })).sort((a, b) => (a.distanceMi ?? 999) - (b.distanceMi ?? 999));
    return { statusCode: 200, headers, body: JSON.stringify({ providers: out, radiusUsed: usedRadius, center }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
