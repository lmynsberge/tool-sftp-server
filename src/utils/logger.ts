export interface Logger {
  debug: (text: string, obj?: string | object) => void;
  info: (text: string, obj?: string | object) => void;
  warn: (text: string, obj?: string | object) => void;
  error: (text: string, obj?: string | object) => void;
}

export const logger: Logger = console;
