<?php
/**
 * upload.php — CosmicCompass media upload endpoint for FastComet (cPanel/PHP) hosting.
 *
 * Receives a multipart/form-data POST with a "file" field, stores it, and returns:
 *   { "url": "https://.../uploads/<random-name>.<ext>" }
 *
 * This matches the contract the frontend expects in src/app.js (uploadMedia).
 *
 * ── SETUP ──────────────────────────────────────────────────────────────────
 * 1. Edit the three CONFIG values below.
 * 2. Upload this file into your site folder on FastComet (e.g. public_html or the
 *    docroot of the subdomain that serves it).
 * 3. Make sure the "uploads" folder it points at exists and is writable (0755).
 * 4. Put the matching endpoint URL into src/config.js (uploadEndpoint).
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────

// Public web address where stored files can be reached (no trailing slash).
// This must be the real URL that serves the $UPLOAD_DIR folder over the web.
$PUBLIC_BASE_URL = "https://m.globalwarningnetworks.com/uploads";

// Filesystem folder where uploaded files are saved (relative to this script).
$UPLOAD_DIR = __DIR__ . "/uploads";

// Largest file accepted, in megabytes.
$MAX_UPLOAD_MB = 25;

// Which origin (your website) is allowed to call this endpoint from the browser.
// Use the exact site URL in production, e.g. "https://www.globalwarningnetworks.com".
// "*" allows any site (simplest, least strict).
$ALLOW_ORIGIN = "*";

// Allowed file types.
$ALLOWED_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm",
];

// ── CORS / preflight ───────────────────────────────────────────────────────

header("Access-Control-Allow-Origin: $ALLOW_ORIGIN");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
  http_response_code(204);
  exit;
}

header("Content-Type: application/json");

function fail($code, $message) {
  http_response_code($code);
  echo json_encode(["error" => $message]);
  exit;
}

// ── Validate request ─────────────────────────────────────────────────────────

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
  fail(405, "Use POST.");
}

if (!isset($_FILES["file"]) || !is_uploaded_file($_FILES["file"]["tmp_name"])) {
  fail(400, "No file field named 'file'.");
}

$file = $_FILES["file"];

if ($file["error"] !== UPLOAD_ERR_OK) {
  fail(400, "Upload error code " . $file["error"] . ".");
}

if ($file["size"] > $MAX_UPLOAD_MB * 1024 * 1024) {
  fail(413, "File exceeds {$MAX_UPLOAD_MB} MB.");
}

$finfo = finfo_open(FILEINFO_MIME_TYPE);
$mime = finfo_file($finfo, $file["tmp_name"]);
finfo_close($finfo);

if (!in_array($mime, $ALLOWED_TYPES, true)) {
  fail(415, "File type not allowed: " . $mime);
}

// ── Store the file ─────────────────────────────────────────────────────────

if (!is_dir($UPLOAD_DIR) && !mkdir($UPLOAD_DIR, 0755, true)) {
  fail(500, "Upload folder is missing and could not be created.");
}

if (!is_writable($UPLOAD_DIR)) {
  fail(500, "Upload folder is not writable.");
}

$ext = strtolower(preg_replace("/[^a-zA-Z0-9]/", "", pathinfo($file["name"], PATHINFO_EXTENSION)));
$name = bin2hex(random_bytes(16)) . ($ext !== "" ? "." . $ext : "");
$destination = rtrim($UPLOAD_DIR, "/") . "/" . $name;

if (!move_uploaded_file($file["tmp_name"], $destination)) {
  fail(500, "Could not save the uploaded file.");
}

echo json_encode(["url" => rtrim($PUBLIC_BASE_URL, "/") . "/" . $name]);
