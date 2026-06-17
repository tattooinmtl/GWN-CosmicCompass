<?php
/**
 * turn-creds.php — hands the browser short-lived TURN credentials for WebRTC.
 *
 * Returns an iceServers array ready to drop into new RTCPeerConnection({iceServers}).
 * The credential is a coturn REST-API token: username = "<expiry>:<name>",
 * credential = base64(HMAC-SHA1(username, TURN_SECRET)). coturn recomputes the
 * same HMAC and checks the expiry, so no passwords are ever stored or shipped long-term.
 *
 * SETUP: add these to your secure config.php
 *   /home/globalw4/public_html/2026/secure/config.php
 *
 *   define('TURN_SECRET', 'your_coturn_static_auth_secret');   // same hex-32 as /etc/turnserver.conf
 *   define('TURN_HOST',   '173.212.202.219');                  // VPS IP (or turn.<domain> once TLS is set up)
 */

header('Content-Type: application/json');
header('Cache-Control: no-store');

$secureConfig = '/home/globalw4/public_html/2026/secure/config.php';
if (is_readable($secureConfig)) {
  require_once $secureConfig;
}

if (!defined('TURN_SECRET') || !TURN_SECRET) {
  http_response_code(500);
  echo json_encode(['error' => 'TURN secret not configured']);
  exit;
}

$host = defined('TURN_HOST') && TURN_HOST ? TURN_HOST : '173.212.202.219';
$ttl  = 3600; // credentials valid for 1 hour

$username   = (time() + $ttl) . ':cosmic';
$credential = base64_encode(hash_hmac('sha1', $username, TURN_SECRET, true));

echo json_encode([
  'username'   => $username,
  'credential' => $credential,
  'ttl'        => $ttl,
  'iceServers' => [
    ['urls' => 'stun:stun.l.google.com:19302'],
    [
      'urls' => [
        "turn:{$host}:3478?transport=udp",
        "turn:{$host}:3478?transport=tcp",
      ],
      'username'   => $username,
      'credential' => $credential,
    ],
  ],
]);
