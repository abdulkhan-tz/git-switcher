#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  cwd: process.cwd(),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});
process.exit(code);
