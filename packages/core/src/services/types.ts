/** A local process the helper can start in the background and watch (a dev server, a database, …). */
export interface ServiceDef {
  name: string;
  description?: string;
  /** Working directory for `prepare` and `command`. `~` is expanded. */
  cwd: string;
  /** Shell command that runs the service. End it with `exec …` so the process the helper tracks is the service itself. */
  command: string;
  /** Optional shell command run first (a build, say). If it fails the service is not started. */
  prepare?: string;
  /** TCP port the service listens on; this is how "up" is detected, including for processes started elsewhere. */
  port: number;
  /** Extra environment for `prepare` and `command`. */
  env?: Record<string, string>;
  /** Names of services that must be up before this one is started. */
  dependsOn?: string[];
  /** Seconds to wait for the port to open after starting. Default 120. */
  startTimeoutSec?: number;
}

export type ServiceState =
  /** Listening, and started by the helper. */
  | 'up'
  /** Listening, but started by something else (an IDE, a terminal); the helper will not stop it. */
  | 'external'
  /** Started by the helper, process alive, port not open yet. */
  | 'starting'
  | 'down';

/** An ordered set of services to start (and stop, in reverse) together. */
export interface ServiceGroup {
  name: string;
  /** Start sequence. Each service's own `dependsOn` is still started before it. */
  members: string[];
}

export interface ServiceStatus {
  name: string;
  description?: string;
  port: number;
  /** The configuration the service runs with. */
  cwd: string;
  command: string;
  prepare?: string;
  env?: Record<string, string>;
  startTimeoutSec?: number;
  state: ServiceState;
  /** Pid of the process the helper started, when it is still alive. */
  pid?: number;
  /** Pid found listening on the port when something else started it. */
  externalPid?: number;
  /** What that process is, so a stop is never a blind kill. */
  externalCommand?: string;
  startedAt?: string;
  logFile: string;
  dependsOn: string[];
  /** Names of the groups this service belongs to. */
  groups: string[];
  /** Branch, uncommitted-file and stash counts for the folder; only when asked for. */
  git?: import('./git.js').GitSummary | null;
}

export type ServiceEvent =
  | { type: 'skip'; name: string; reason: string }
  | { type: 'prepare'; name: string }
  | { type: 'start'; name: string; pid: number; logFile: string }
  | { type: 'ready'; name: string; seconds: number }
  | { type: 'stopped'; name: string; external?: boolean };
