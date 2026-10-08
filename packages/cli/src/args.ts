export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['help', 'version', 'no-open', 'external', 'no-restart', 'follow', 'clear']);

/** Minimal `--key value` / `--key=value` / `--flag` parser; `--` ends option parsing. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') flags.help = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags[key] = arg.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) flags[key] = true;
      else flags[key] = argv[++i]!;
    } else positional.push(arg);
  }
  return { positional, flags };
}

export function str(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
