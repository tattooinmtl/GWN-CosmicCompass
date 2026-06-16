<?php
/**
 * OpenWeatherMap tile proxy — keeps the API key server-side.
 *
 * The browser requests:  owm-proxy.php?layer=<layer>&z=<z>&x=<x>&y=<y>
 * This script looks up the secret key (from your MySQL `api_keys` table) and
 * streams the PNG tile back, so the key is never exposed to the client.
 *
 * SETUP:
 *  1. Run db/api_keys.sql in phpMyAdmin to create the `api_keys` table, then
 *     inject your NEW OpenWeatherMap keys (rows 'owm_key' and 'owm_fallback').
 *  2. The DB credentials are read from your secure config.php
 *     (/home/globalw4/public_html/2026/secure/config.php) which defines
 *     DB_HOST / DB_USER / DB_PASS / DB_NAME / DB_PORT.
 */

// Load DB credentials from the secure folder (first readable path wins).
$configPaths = [
  '/home/globalw4/public_html/2026/secure/config.php',
  __DIR__ . '/owm-config.php', // optional local fallback (gitignored)
];
foreach ($configPaths as $p) {
  if (is_readable($p)) { require_once $p; break; }
}

// Only these layers may be proxied.
$layers = ['precipitation_new', 'clouds_new', 'temp_new', 'wind_new', 'pressure_new'];

$layer = $_GET['layer'] ?? '';
$z = $_GET['z'] ?? '';
$x = $_GET['x'] ?? '';
$y = $_GET['y'] ?? '';

if (!in_array($layer, $layers, true) ||
    !ctype_digit((string) $z) || !ctype_digit((string) $x) || !ctype_digit((string) $y)) {
  http_response_code(400);
  exit('bad request');
}

/**
 * Fetch the OWM keys from the `api_keys` table, cached on disk for an hour so
 * we don't open a DB connection for every single map tile. Falls back to
 * OWM_KEY / OWM_FALLBACK_KEY config constants if the DB is unavailable.
 */
function owm_keys(): array {
  $cacheFile = sys_get_temp_dir() . '/cc_owm_keys.json';
  if (is_readable($cacheFile) && (time() - filemtime($cacheFile) < 3600)) {
    $cached = json_decode((string) file_get_contents($cacheFile), true);
    if (is_array($cached) && !empty($cached['owm_key'])) return $cached;
  }

  $keys = [];
  if (defined('DB_HOST')) {
    try {
      mysqli_report(MYSQLI_REPORT_OFF);
      $port = defined('DB_PORT') ? DB_PORT : 3306;
      $conn = @new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME, $port);
      if ($conn && !$conn->connect_error) {
        // Newest row per service wins (service is not unique in this table).
        $res = $conn->query(
          "SELECT service, api_key FROM api_keys " .
          "WHERE service IN ('openweather','openweather_fallback') ORDER BY id DESC"
        );
        if ($res) {
          while ($row = $res->fetch_assoc()) {
            if ($row['service'] === 'openweather' && empty($keys['owm_key'])) {
              $keys['owm_key'] = $row['api_key'];
            } elseif ($row['service'] === 'openweather_fallback' && empty($keys['owm_fallback'])) {
              $keys['owm_fallback'] = $row['api_key'];
            }
          }
        }
        $conn->close();
      }
    } catch (Throwable $e) { /* fall through to config constants */ }
  }

  if (empty($keys['owm_key']) && defined('OWM_KEY')) $keys['owm_key'] = OWM_KEY;
  if (empty($keys['owm_fallback']) && defined('OWM_FALLBACK_KEY')) $keys['owm_fallback'] = OWM_FALLBACK_KEY;

  if (!empty($keys['owm_key'])) { @file_put_contents($cacheFile, json_encode($keys)); }
  return $keys;
}

function fetch_tile(string $key, string $layer, string $z, string $x, string $y): array {
  $url = "https://tile.openweathermap.org/map/{$layer}/{$z}/{$x}/{$y}.png?appid=" . urlencode($key);
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_FOLLOWLOCATION => true,
  ]);
  $data = curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  return [$code, $data];
}

$keys = owm_keys();
if (empty($keys['owm_key'])) {
  http_response_code(500);
  exit('OWM key not configured');
}

[$code, $data] = fetch_tile($keys['owm_key'], $layer, $z, $x, $y);

// Fall back to the secondary key if the primary fails (e.g. rate-limited).
if ($code !== 200 && !empty($keys['owm_fallback'])) {
  [$code, $data] = fetch_tile($keys['owm_fallback'], $layer, $z, $x, $y);
}

if ($code !== 200 || $data === false || $data === '') {
  http_response_code(502);
  exit('tile fetch failed');
}

header('Content-Type: image/png');
header('Cache-Control: public, max-age=600'); // 10 min browser/CDN cache
echo $data;
