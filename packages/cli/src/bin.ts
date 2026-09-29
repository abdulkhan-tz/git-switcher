#!/usr/bin/env node
import { main } from './main.js';
import { startUi } from './ui.js';

const code = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  cwd: process.cwd(),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
}, { startUi });
process.exit(code);
