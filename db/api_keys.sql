-- CosmicCompass — add OpenWeatherMap keys to your existing api_keys table.
-- Existing columns: id (PK, auto), service, api_key, created_at (auto).
-- Run in phpMyAdmin with the `globalw4_quakes` database selected.
--
-- owm-proxy.php reads the NEWEST row for each service below. Replace the
-- placeholders with your NEW OpenWeatherMap keys when you run it — do NOT paste
-- real keys into this committed file (regenerate at
-- https://home.openweathermap.org/api_keys; the old keys are in git history).

INSERT INTO api_keys (service, api_key) VALUES
  ('openweather',          'PASTE_YOUR_NEW_OWM_KEY_HERE'),
  ('openweather_fallback', 'PASTE_YOUR_FALLBACK_OWM_KEY_HERE');
