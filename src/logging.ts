/**
 * 中文模块导读
 * 桥自己的运行日志：用于观察启动、受理、结束及异常，而不是 DSH 的业务输出。
 * 日志经过脱敏并写往 stderr，避免混入 stdout 上的 MCP 协议数据。
 */
/**
 * Service logging.
 *
 * stdout is reserved for the MCP protocol stream: nothing in this module may
 * ever write to it. All diagnostics go to stderr, and every message passes
 * through the redactor first.
 */
import type { Redactor } from './redact.js';

/**
 * 桥日志级别，用于控制显示多少诊断信息。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 日志附加字段的格式。
 */
export interface LogFields {
  [key: string]: unknown;
}

/**
 * 桥自身的诊断日志输出器。
 */
export class Logger {
  readonly #level: LogLevel;
  readonly #redactor: Redactor;
  readonly #sink: (line: string) => void;

  /**
   * 设定日志等级和脱敏规则。
   */
  constructor(level: LogLevel, redactor: Redactor, sink?: (line: string) => void) {
    this.#level = level;
    this.#redactor = redactor;
    this.#sink = sink ?? ((line: string) => process.stderr.write(line + '\n'));
  }

  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  /**
   * 过滤低于日志等级的信息，脱敏后写 stderr，保留 stdout 给 MCP 协议。
   */
  #write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: this.#redactor.redact(message),
    };
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        // R2-04: fields are redacted *recursively*. A diagnostic that carries a
        // nested payload (an error object, a findings array, a partial record)
        // is the same surface as a top-level string, so a string buried one
        // level down must not be the one that escapes.
        record[key] = this.#redactor.redactValue(value);
      }
    }
    this.#sink(JSON.stringify(record));
  }
}
