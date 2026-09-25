/**
 * Airline → captain-language policy.
 *
 * The game's `CallsignService` allocates a flight's callsign from the pool
 * shared by the aircraft's captain voice and the airport's ATC voice
 * (`CallsignPool.GetCallsignPool`). A callsign clip is only recorded for one
 * captain language, so a flight's `Language` must match its callsign's airline:
 * Chinese (CN) carriers speak Chinese, every other carrier speaks English.
 * A mismatch makes the game throw at level load:
 *
 *   InvalidOperationException: Flight plan '<reg>' failed to allocate callsign
 *   '<cs>' for crew voice '<voice>'.
 *
 * (Empirically the game's own levels use zh for CN carriers only — CAL (TW),
 * CPA (HK), ANA, AXM, MAS, LNI … are all en — and CAL2017 was fuzz-discovered
 * paired with a zh `CN-Captain-Young` voice.)
 *
 * `countries` is the install's `airline_country_registry.cfg` map
 * (airline code → ISO country code), loaded by the main process and exposed as
 * `airportValues._airlineCountries`. Unknown airlines return `null` so a caller
 * never forces a language it cannot justify.
 *
 * @param {string} code - 3-letter ICAO airline code (the callsign prefix)
 * @param {Object<string,string>|null} countries - airline → country map
 * @param {string[]|null} availableLanguages - languages the airport supports
 *        (`values.Language`); a CN carrier falls back to 'en' when the airport
 *        has no Chinese ATC/captain voices (e.g. KJFK).
 * @returns {'zh'|'en'|null}
 */
export function languageForAirline(code, countries, availableLanguages) {
  const country = countries && code ? countries[code] : undefined;
  if (!country) return null;
  if (country === 'CN') {
    // No language list means the airport context is unknown — keep the
    // historical Chinese-airport default (zh). A known list without 'zh'
    // (e.g. KJFK) forces English.
    if (!Array.isArray(availableLanguages)) return 'zh';
    return availableLanguages.includes('zh') ? 'zh' : 'en';
  }
  return 'en';
}

/**
 * The airline code that owns a flight's callsign. The game allocates by the
 * callsign prefix (the callsign IS the airline + flight number), so prefer it
 * and fall back to the `AirlineName` / `AirlineCode` field.
 * @param {object} flight
 * @returns {string} uppercase 3-letter code, or ''
 */
export function airlineCodeForFlight(flight) {
  const cs = String((flight && flight.CallSign) || '').trim();
  if (cs.length >= 3) return cs.slice(0, 3).toUpperCase();
  const name = String((flight && (flight.AirlineName || flight.AirlineCode)) || '').trim();
  return name.slice(0, 3).toUpperCase();
}

/**
 * Expected captain `Language` for a flight, or null when the airline is unknown.
 * @param {object} flight
 * @param {Object<string,string>|null} countries
 * @param {string[]|null} availableLanguages
 * @returns {'zh'|'en'|null}
 */
export function expectedLanguageForFlight(flight, countries, availableLanguages) {
  return languageForAirline(airlineCodeForFlight(flight), countries, availableLanguages);
}
