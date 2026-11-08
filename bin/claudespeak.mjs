#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) { console.error(`claudespeak needs Node.js 20 or newer (this is ${process.version}).`); process.exit(1); }
try { await main(process.argv.slice(2)); }
catch (e) { console.error("Error: " + e.message); process.exit(1); }
