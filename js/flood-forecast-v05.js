/* THESSALY-HCML — Flood Forecast Engine v0.5
 * Rainfall-forcing module for the Pamisos and Pineios pilot basins.
 * Experimental decision support only. Not an official warning or calibrated
 * hydrological/hydraulic forecast. No water-level or discharge prediction.
 */
(function (global) {
  "use strict";
  const VERSION = "0.5.0";
  const HORIZON_HOURS = 72;
  const API = "https://api.open-meteo.com/v1/forecast";
  const BASINS = {
    pamisos: {
      id: "pamisos", name: "Πάμισος", areaKm2: 146.8,
      latitude: 39.38, longitude: 21.72,
      runoff: { low: 0.25, central: 0.40, high: 0.60 },
      initialLossMm: { low: 8, central: 5, high: 2 },
      calibration: "PARTIAL_DANIEL_2023",
      caveat: "Προσωρινοί συντελεστές. Το σημείο βροχής δεν αντιπροσωπεύει χωρικό μέσο όρο λεκάνης."
    },
    pineios: {
      id: "pineios", name: "Πηνειός", areaKm2: 6500,
      latitude: 39.55, longitude: 22.05,
      runoff: { low: 0.15, central: 0.30, high: 0.50 },
      initialLossMm: { low: 10, central: 6, high: 3 },
      calibration: "NOT_CALIBRATED",
      caveat: "Μεγάλη λεκάνη: απαιτείται χωρική ολοκλήρωση βροχής και υπολεκάνες. Το σημείο βροχής δεν είναι αντιπροσωπευτικό."
    }
  };

  function assertBasin(id) {
    const basin = BASINS[id];
    if (!basin) throw new Error("Άγνωστη λεκάνη: " + id);
    return basin;
  }
  function buildUrl(basin) {
    const params = new URLSearchParams({
      latitude: String(basin.latitude),
      longitude: String(basin.longitude),
      hourly: "precipitation,soil_moisture_0_to_7cm",
      forecast_days: "4",
      past_hours: "0",
      timezone: "Europe/Athens"
    });
    return API + "?" + params.toString();
  }
  function toValidNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }
  function makeRows(times, precipitation, soilMoisture) {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < times.length; i++) {
      const t = Date.parse(times[i]);
      const p = toValidNumber(precipitation[i]);
      if (!Number.isFinite(t) || p === null) continue;
      if (t < now - 60 * 60 * 1000 || t > now + HORIZON_HOURS * 3600000) continue;
      rows.push({
        timestamp: t,
        precipitationMm: Math.max(0, p),
        soilMoisture: toValidNumber((soilMoisture || [])[i])
      });
    }
    return rows;
  }
  function estimateRunoffVolume(basin, rainfallMm, scenario) {
    const coeff = basin.runoff[scenario];
    const loss = basin.initialLossMm[scenario];
    const effectiveMm = Math.max(0, rainfallMm - loss);
    const volumeM3 = effectiveMm / 1000 * basin.areaKm2 * 1e6 * coeff;
    return {
      rainfallMm: Number(rainfallMm.toFixed(1)),
      effectiveRainMm: Number(effectiveMm.toFixed(1)),
      runoffCoefficient: coeff,
      initialLossMm: loss,
      runoffVolumeM3: Math.round(volumeM3),
      status: "SCENARIO_ESTIMATE_NOT_FORECAST"
    };
  }
  function aggregate(basin, rows) {
    const buckets = [
      { label: "0–6 ώρες", hours: 6 },
      { label: "6–12 ώρες", hours: 6 },
      { label: "12–24 ώρες", hours: 12 },
      { label: "24–48 ώρες", hours: 24 },
      { label: "48–72 ώρες", hours: 24 }
    ];
    const start = Date.now();
    let offset = 0;
    return buckets.map((bucket) => {
      const end = offset + bucket.hours;
      const selected = rows.filter((row) => {
        const h = (row.timestamp - start) / 3600000;
        return h >= offset && h < end;
      });
      const rain = selected.reduce((sum, row) => sum + row.precipitationMm, 0);
      const validSoil = selected.map((row) => row.soilMoisture).filter((v) => v !== null);
      const meanSoil = validSoil.length
        ? validSoil.reduce((a, b) => a + b, 0) / validSoil.length : null;
      const result = {
        period: bucket.label,
        hoursFromNow: [offset, end],
        rainfallMm: Number(rain.toFixed(1)),
        meanTopsoilMoistureM3M3: meanSoil === null ? null : Number(meanSoil.toFixed(3)),
        runoffScenarios: {
          low: estimateRunoffVolume(basin, rain, "low"),
          central: estimateRunoffVolume(basin, rain, "central"),
          high: estimateRunoffVolume(basin, rain, "high")
        },
        dataPoints: selected.length
      };
      offset = end;
      return result;
    });
  }
  async function forecast(basinId, options) {
    const basin = assertBasin(basinId);
    const opts = options || {};
    const fetcher = opts.fetch || global.fetch;
    if (typeof fetcher !== "function") throw new Error("Δεν υπάρχει διαθέσιμη λειτουργία fetch.");
    const response = await fetcher(buildUrl(basin), {
      method: "GET", headers: { Accept: "application/json" }, signal: opts.signal
    });
    if (!response.ok) throw new Error("Open-Meteo HTTP " + response.status);
    const data = await response.json();
    if (!data.hourly || !Array.isArray(data.hourly.time) ||
        !Array.isArray(data.hourly.precipitation)) {
      throw new Error("Μη έγκυρη απάντηση ωριαίας πρόγνωσης.");
    }
    const rows = makeRows(data.hourly.time, data.hourly.precipitation,
      data.hourly.soil_moisture_0_to_7cm);
    if (!rows.length) throw new Error("Δεν επιστράφηκαν έγκυρα ωριαία δεδομένα.");
    return {
      engine: "THESSALY-HCML FLOOD FORECAST ENGINE",
      version: VERSION,
      generatedAt: new Date().toISOString(),
      source: "Open-Meteo forecast API",
      sourceTimezone: data.timezone || "Europe/Athens",
      horizonHours: HORIZON_HOURS,
      basin: { id: basin.id, name: basin.name, areaKm2: basin.areaKm2,
        calibration: basin.calibration },
      status: "EXPERIMENTAL_RAINFALL_FORCING",
      windows: aggregate(basin, rows),
      limitations: [
        "Η βροχόπτωση προέρχεται από ένα αντιπροσωπευτικό σημείο και όχι από χωρικό μέσο όρο λεκάνης.",
        "Οι όγκοι απορροής είναι εύρη σεναρίων με προσωρινούς συντελεστές, όχι βαθμονομημένες προβλέψεις.",
        "Δεν υπολογίζονται στάθμη, παροχή αιχμής, χρόνος άφιξης ή έκταση κατάκλυσης.",
        "Δεν υποκαθιστά EFAS, GloFAS, ΕΜΥ, HCMR, επίσημες προειδοποιήσεις ή εντολές Πολιτικής Προστασίας."
      ],
      basinCaveat: basin.caveat
    };
  }
  global.ThessalyFloodForecastV05 = {
    version: VERSION, basins: BASINS, forecast: forecast
  };
  if (global.dispatchEvent && typeof global.CustomEvent === "function") {
    global.dispatchEvent(new CustomEvent("thessaly-flood-forecast-v05-ready", {
      detail: { version: VERSION, basins: Object.keys(BASINS) }
    }));
  }
})(window);
