import type { LaunchOptions } from "playwright-core";

export const VERSION = "0.2.0";

export interface ServerConfig {
  personaSeed?: string;
  chromePath?: string;
  browserVersion?: string;
  headless: boolean;
  windowSize: [number, number];
  timezone?: string;
  proxy?: LaunchOptions["proxy"];
  allowEval: boolean;
  allowNativeAgent: boolean;
  maxTextChars: number;
  allowedHosts: string[];
}

export interface ParsedCli {
  config: ServerConfig;
  help: boolean;
  version: boolean;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseWindowSize(value: string): [number, number] {
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) {
    throw new Error("--window-size must use WIDTHxHEIGHT format, for example 1920x1080");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240 || width > 16384 || height > 16384) {
    throw new Error("Window size must be between 320x240 and 16384x16384");
  }
  return [width, height];
}

export function parseProxy(value: string): NonNullable<LaunchOptions["proxy"]> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--proxy must be a valid URL");
  }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) {
    throw new Error("--proxy supports only http, https, socks4, and socks5");
  }
  const server = `${url.protocol}//${url.host}`;
  const proxy: NonNullable<LaunchOptions["proxy"]> = { server };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

export function parseCli(argv: string[]): ParsedCli {
  const config: ServerConfig = {
    headless: true,
    windowSize: [1920, 1080],
    allowEval: false,
    allowNativeAgent: false,
    maxTextChars: 50_000,
    allowedHosts: [],
  };
  if (process.env.CHROME_BIN) config.chromePath = process.env.CHROME_BIN;
  let help = false;
  let version = false;
  let timezoneArg: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--version":
      case "-V":
        version = true;
        break;
      case "--headed":
        config.headless = false;
        break;
      case "--allow-eval":
        config.allowEval = true;
        break;
      case "--allow-native-agent":
        config.allowNativeAgent = true;
        break;
      case "--persona-seed":
        config.personaSeed = readValue(argv, index, arg);
        index += 1;
        break;
      case "--chrome-path":
        config.chromePath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--browser-version":
        config.browserVersion = readValue(argv, index, arg);
        index += 1;
        break;
      case "--window-size":
        config.windowSize = parseWindowSize(readValue(argv, index, arg));
        index += 1;
        break;
      case "--timezone":
        timezoneArg = readValue(argv, index, arg);
        index += 1;
        break;
      case "--proxy":
        config.proxy = parseProxy(readValue(argv, index, arg));
        index += 1;
        break;
      case "--max-text-chars": {
        const value = Number(readValue(argv, index, arg));
        if (!Number.isInteger(value) || value < 1_000 || value > 1_000_000) {
          throw new Error("--max-text-chars must be an integer between 1000 and 1000000");
        }
        config.maxTextChars = value;
        index += 1;
        break;
      }
      case "--allowed-host":
        config.allowedHosts.push(readValue(argv, index, arg).toLowerCase());
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (timezoneArg === undefined) {
    // Local executables cannot resolve "auto", so they keep the host time zone by default.
    if (!config.chromePath) config.timezone = "auto";
  } else if (timezoneArg !== "system") {
    config.timezone = timezoneArg;
  }

  return { config, help, version };
}

export const HELP = `chromiumfish_mcp ${VERSION}

Usage:
  chromiumfish_mcp [options]

Options:
  --persona-seed VALUE       Use a stable browser fingerprint persona
  --chrome-path PATH         Use a local ChromiumFish executable
  --browser-version VERSION  Select an upstream browser build
  --headed                   Show the browser window (default: headless)
  --window-size WIDTHxHEIGHT Set the window size (default: 1920x1080)
  --timezone ZONE            Use an IANA time zone, auto, or system (default: auto)
  --proxy URL                Route browser traffic through a proxy
  --allowed-host HOST        Allow navigation to a host; repeatable
  --max-text-chars N         Set the text and snapshot hard limit (default: 50000)
  --allow-eval               Enable the arbitrary JavaScript execution tool
  --allow-native-agent       Enable the native browser agent tool
  --help                     Show help
  --version                  Show version

The native agent reads configuration only from OPENAI_API_KEY, OPENAI_API_BASE, and OPENAI_API_MODEL.`;
