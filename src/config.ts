import type { LaunchOptions } from "playwright-core";

export const VERSION = "0.1.0";

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
    throw new Error(`${flag} 需要一个值`);
  }
  return value;
}

export function parseWindowSize(value: string): [number, number] {
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) {
    throw new Error("--window-size 格式应为 WIDTHxHEIGHT，例如 1920x1080");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240 || width > 16384 || height > 16384) {
    throw new Error("窗口尺寸超出允许范围：320x240 至 16384x16384");
  }
  return [width, height];
}

export function parseProxy(value: string): NonNullable<LaunchOptions["proxy"]> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--proxy 必须是有效 URL");
  }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) {
    throw new Error("--proxy 仅支持 http、https、socks4 和 socks5");
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
        config.timezone = readValue(argv, index, arg);
        index += 1;
        break;
      case "--proxy":
        config.proxy = parseProxy(readValue(argv, index, arg));
        index += 1;
        break;
      case "--max-text-chars": {
        const value = Number(readValue(argv, index, arg));
        if (!Number.isInteger(value) || value < 1_000 || value > 1_000_000) {
          throw new Error("--max-text-chars 必须是 1000 至 1000000 之间的整数");
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
        throw new Error(`未知参数：${arg}`);
    }
  }

  return { config, help, version };
}

export const HELP = `chromiumfish_mcp ${VERSION}

用法：
  chromiumfish_mcp [选项]

选项：
  --persona-seed VALUE       固定浏览器指纹人格
  --chrome-path PATH         使用本地 ChromiumFish 可执行文件
  --browser-version VERSION  指定上游浏览器构建版本
  --headed                  显示浏览器窗口，默认无头模式
  --window-size WIDTHxHEIGHT 窗口尺寸，默认 1920x1080
  --timezone ZONE           IANA 时区或 auto
  --proxy URL               浏览器代理
  --allowed-host HOST       允许导航的主机，可重复传入
  --max-text-chars N        页面文本最大字符数，默认 50000
  --allow-eval              启用任意 JavaScript 执行工具
  --allow-native-agent      启用浏览器内置代理工具
  --help                    显示帮助
  --version                 显示版本

原生代理只从 OPENAI_API_KEY、OPENAI_API_BASE 和 OPENAI_API_MODEL 读取配置。`;
