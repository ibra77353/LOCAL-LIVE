'use strict';
// Single port source for every Windows script (start/stop/check/firewall) and for the server.
// Follows the same priority order as server.js so the port a script stops never differs
// from the port the server actually listens on:
//   Node:  PORT (env) <- data.settings.port <- config.port <- 3001
//   Nginx: data.settings.nginxPort <- config.nginxPort <- 80
// Output: "<nginxPort> <nodePort>" on one line, read by the BAT files with tokens=1,2.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
// Same rule as server.js: any non-numeric or out-of-range value falls back to the default.
function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const data = readJson('data.json');
const settings = data && data.settings ? data.settings : null;
const cfg = readJson('config.json') || {};

// When data.json cannot be read, server.js recreates it from config.json, so read config here too.
const nginxPort = toPort(settings ? settings.nginxPort : cfg.nginxPort, toPort(cfg.nginxPort, 80));
const envPort = String(process.env.PORT || '').trim();
const nodePort = envPort
  ? toPort(envPort, 3001)
  : toPort(settings ? settings.port : cfg.port, 3001);

process.stdout.write(`${nginxPort} ${nodePort}\n`);
