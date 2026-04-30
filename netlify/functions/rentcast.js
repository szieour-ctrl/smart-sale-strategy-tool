const https = require("https");

// Server-side proxy for RentCast property lookup via Pabbly.
// Called by the browser instead of hitting Pabbly directly — this way
// we can read the full JSON response (no CORS limitation server-side).

const PABBLY_LOOKUP_URL = "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjcwNTZmMDYzNTA0MzA1MjZjNTUzMTUxMzEi_pc";

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          // Pabbly sometimes returns plain text on webhook receipt
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out after 15s"));
    });
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let address;
  try {
    const body = JSON.parse(event.body);
    address = body.address;
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON — expected { address: '...' }" })
    };
  }

  if (!address || typeof address !== "string" || address.trim().length < 5) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Missing or invalid address" })
    };
  }

  try {
    const result = await postJson(PABBLY_LOOKUP_URL, { address: address.trim() });

    const raw = result.body;

    // Pabbly returns a string ack only — no data yet
    if (typeof raw === "string") {
      return {
        statusCode: 202,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "pending", address: address.trim() })
      };
    }

    // Pabbly returns an ARRAY of step results:
    // [0] = {address} — webhook input echo
    // [1] = {status, message} — filter result
    // [2] = [{...property details...}] — RentCast properties endpoint (array)
    // [3] = {price, priceRangeLow, priceRangeHigh, comparables:[...]} — AVM+comps
    // [4+] = other steps (Data Forwarder with unresolved {{}} templates, etc.)
    // Always build from [2] and [3] directly — never trust Data Forwarder templates.

    let shaped = null;

    if (Array.isArray(raw)) {
      const propArr = raw.find(item => Array.isArray(item));
      const avm     = raw.find(item =>
        item && typeof item === "object" && !Array.isArray(item) &&
        typeof item.price === "number" && Array.isArray(item.comparables)
      );
      const prop = propArr && propArr[0] ? propArr[0] : {};

      if (prop.formattedAddress || (avm && avm.price)) {
        shaped = {
          address: prop.formattedAddress || address.trim(),
          property: {
            living_area:   prop.squareFootage  || null,
            bedrooms:      prop.bedrooms       || null,
            bathrooms:     prop.bathrooms      || null,
            year_built:    prop.yearBuilt      || null,
            lot_size:      prop.lotSize        || null,
            property_type: prop.propertyType   || null,
            garage_spaces: prop.features && prop.features.garageSpaces != null
                             ? prop.features.garageSpaces : null
          },
          valuation: {
            estimated_value: avm ? avm.price           : null,
            price_low:       avm ? avm.priceRangeLow   : null,
            price_high:      avm ? avm.priceRangeHigh  : null,
            latitude:        avm ? avm.latitude        : prop.latitude,
            longitude:       avm ? avm.longitude       : prop.longitude
          },
          subject_property: {
            formatted_address:   prop.formattedAddress
                                 || (avm && avm.subjectProperty && avm.subjectProperty.formattedAddress)
                                 || address.trim(),
            subject_property_id: prop.id
                                 || (avm && avm.subjectProperty && avm.subjectProperty.id)
                                 || null
          },
          comparables: avm && Array.isArray(avm.comparables)
            ? avm.comparables.slice(0, 10).map(c => ({
                address:        c.formattedAddress  || null,
                price:          c.price             || null,
                sqft:           c.squareFootage     || null,
                beds:           c.bedrooms          || null,
                baths:          c.bathrooms         || null,
                days_on_market: c.daysOnMarket      || null,
                status:         c.status            || null,
                correlation:    c.correlation       || null
              }))
            : []
        };
      }
    } else if (raw && typeof raw === "object") {
      shaped = raw;
    }

    if (!shaped) {
      return {
        statusCode: 202,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "pending", address: address.trim() })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(shaped)
    };

  } catch (e) {
    console.error("RentCast proxy error:", e.message);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Lookup failed: " + e.message })
    };
  }
};

