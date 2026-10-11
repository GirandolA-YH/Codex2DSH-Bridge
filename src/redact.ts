/**
 * 中文模块导读
 * 脱敏器：遮盖输出中命中的密钥、认证信息和已配置秘密值。
 * 输出到达时可能只有半行，所以先缓冲，等一行完整后再匹配和写出，减少跨块秘密漏出。
 * 脱敏覆盖已声明的文字值和内置格式规则；不能保证识别世界上所有未知秘密格式。
 */
/**
 * Secret redaction.
 *
 * Design rule (FIX-001 R01): output and diagnostics are redacted before disk. The
 * streaming redactor therefore holds an *incomplete trailing line* in memory and
 * only emits text once a newline closes the line, so a known literal can never
 * be split across two writes and later reassembled in the log. All supported
 * patterns are single-line; configured literals containing CR/LF are rejected at
 * configuration load (see config.ts).
 *
 * Boundary: this is pattern matching plus a known-value list. It cannot
 * recognise every possible secret. Invalid UTF-8 is decoded by the capture layer
 * with U+FFFD replacement, which is documented there.
 *
 * R2-01: an `Authorization` header is handled as *header + scheme + credential*
 * rather than by enumerating scheme names. Any RFC 7235 scheme token (`Bearer`,
 * `Basic`, `Token`, `ApiKey`, `Digest`, `AWS4-HMAC-SHA256`, an unknown future
 * scheme) is matched case-insensitively, and the credential that follows is
 * replaced while the header and scheme stay readable. The rule is line-wise like
 * every other rule, so the streaming redactor's incomplete-line buffer also
 * covers a header split across two chunks.
 *
 * R2 boundary for configured values: every explicitly configured, non-empty
 * literal is redacted regardless of length (a short value is replaced like any
 * other). An empty literal cannot be matched without destroying the output and
 * is therefore rejected by config validation, never accepted and silently
 * ignored. A declared secret environment variable that is unset or empty has no
 * value to redact: that is a declared boundary, reported by name only, and is
 * never described as a leak.
 */

const PLACEHOLDER = '***REDACTED***';

/**
 * 一个敏感文字格式匹配与替换规则。
 */
interface PatternRule {
  readonly name: string;
  readonly regex: RegExp;
  readonly replace: (...args: string[]) => string;
}

// Header credentials have no minimum length. Quoting belongs to the value;
// comma-separated auth parameters (Digest/AWS) must be consumed together.
const AUTH_QUOTED = String.raw`"(?:\\.|[^"\\\r\n])*(?:"|(?=[\r\n]|$))|'(?:\\.|[^'\\\r\n])*(?:'|(?=[\r\n]|$))|\\"[^\r\n]*?(?:\\"|(?=[\r\n]|$))|\\'[^\r\n]*?(?:\\'|(?=[\r\n]|$))`;
const AUTH_VALUE = String.raw`(?:${AUTH_QUOTED}|[^\s"'\\(),]+)`;
const AUTH_PARAM = String.raw`[A-Za-z][A-Za-z0-9_-]*[ \t]*=[ \t]*${AUTH_VALUE}`;
const AUTHORIZATION = new RegExp(
  String.raw`(Authorization(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?[A-Za-z][A-Za-z0-9!#$%&'*+.^_\x60|~-]*[ \t]+)(?:${AUTH_PARAM}(?:[ \t]*,[ \t]*${AUTH_PARAM})*|${AUTH_VALUE})`,
  'gi',
);
const JSON_QUOTED_VALUE = String.raw`"(?:\\.|[^"\\\r\n])*"`;
// Inside one serialized JSON string, an inner backslash is four backslashes,
// an inner escaped quote is three, and the value delimiters have only one.
const SERIALIZED_JSON_VALUE = String.raw`\\"(?:\\\\\\\\|\\\\\\"|\\\\[^"\\]|[^\\\r\n])*\\"`;

const PATTERN_RULES: PatternRule[] = [
  {
    name: 'openai-style-key',
    regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g,
    replace: () => PLACEHOLDER,
  },
  {
    name: 'github-token',
    regex: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{16,}/g,
    replace: () => PLACEHOLDER,
  },
  {
    // R2-06: bare, single/double-quoted and serialized header values, including
    // short credentials. Trailing prose outside the value stays readable.
    name: 'authorization-scheme',
    regex: AUTHORIZATION,
    replace: (_match, prefix: string) => `${prefix}${PLACEHOLDER}`,
  },
  {
    // Kept as a distinct, narrower rule so a bare `Bearer <token>` (a shell
    // history line, a URL fragment, a log line without the header name) is still
    // covered. The general rule above covers the header form for every scheme.
    name: 'authorization-bearer',
    regex: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_match, prefix: string) => `${prefix}${PLACEHOLDER}`,
  },
  {
    name: 'authorization-basic',
    regex: /(Basic\s+)[A-Za-z0-9+/=]{8,}/g,
    replace: (_match, prefix: string) => `${prefix}${PLACEHOLDER}`,
  },
  {
    // Quoted JSON keys do not have ':' immediately after the key name. Match
    // the field explicitly, including a JSON string serialized inside a log.
    name: 'json-credential',
    regex: new RegExp(
      String.raw`((?:\\?")(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)(?:\\?")[ \t]*:[ \t]*)(?:${JSON_QUOTED_VALUE}|${SERIALIZED_JSON_VALUE})`,
      'gi',
    ),
    replace: (match, prefix: string) => {
      const quote = match.slice(prefix.length).startsWith('\\"') ? '\\"' : '"';
      return `${prefix}${quote}${PLACEHOLDER}${quote}`;
    },
  },
  {
    name: 'credential-assignment',
    regex:
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*[:=]\s*)(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s"',;]{6,}))/gi,
    replace: (_match, prefix: string) => `${prefix}${PLACEHOLDER}`,
  },
  {
    name: 'url-basic-auth',
    regex: /(:\/\/)[^\s:@/]+:[^\s@/]+@/g,
    replace: (_match, prefix: string) => `${prefix}${PLACEHOLDER}@`,
  },
];

export const REDACTION_PATTERN_NAMES = PATTERN_RULES.map((rule) => rule.name);

/**
 * 明确声明的秘密值与环境变量名称等脱敏配置。
 */
export interface RedactorOptions {
  /** Environment variable names whose *values* must never appear in output. */
  readonly extraSecretEnv?: readonly string[];
  /** Extra literal secrets supplied directly by config (values are never logged). */
  readonly extraLiteralSecrets?: readonly string[];
  /**
   * Reporting threshold for "short" literals (R2). It is **never** a filter:
   * an explicitly configured, non-empty literal of any length is always
   * redacted, and one that is shorter than this threshold is only counted so
   * diagnostics can explain the trade-off. Defaults to 8.
   */
  readonly minLiteralLength?: number;
}

/** Literals containing CR/LF cannot be matched line-wise and are rejected. */
/**
 * 找出含换行的已配置秘密值，用于检查逐行脱敏策略是否适用。
 */
export function findMultilineLiteral(literals: readonly string[]): string | null {
  for (const literal of literals) {
    if (literal.includes('\n') || literal.includes('\r')) return literal;
  }
  return null;
}

/**
 * 可复用的秘密文字遮盖规则集合。
 */
export class Redactor {
  readonly #literals: string[];
  readonly #longestLiteral: number;
  readonly #shortLiteralCount: number;
  readonly #unresolvedSecretEnv: string[];
  readonly #emptyEnv: string[];

  /**
   * 准备内置格式规则和明确声明的秘密值，同时记录缺失/空环境变量的边界信息。
   */
  constructor(env: NodeJS.ProcessEnv, options: RedactorOptions = {}) {
    // R2: an explicitly configured secret is never silently dropped. Every
    // non-empty literal is redacted, however short it is. Only the *absence* of
    // a value (an unset or empty environment variable) and the impossible empty
    // literal are not secrets; those are reported as declared boundaries.
    const reportThreshold = options.minLiteralLength ?? 8;
    const literals = new Set<string>();
    const unresolved: string[] = [];
    const emptyEnv: string[] = [];
    for (const name of options.extraSecretEnv ?? []) {
      const value = env[name];
      if (typeof value !== 'string') {
        // Declared but not set in this environment: a boundary, not a leak.
        unresolved.push(name);
        continue;
      }
      if (value === '') {
        emptyEnv.push(name);
        continue;
      }
      literals.add(value);
    }
    for (const value of options.extraLiteralSecrets ?? []) {
      if (typeof value === 'string' && value !== '') literals.add(value);
    }
    // Longest first so that overlapping literals cannot leave a suffix behind.
    this.#literals = [...literals].sort((a, b) => b.length - a.length);
    this.#longestLiteral = this.#literals.reduce((max, literal) => Math.max(max, literal.length), 0);
    this.#shortLiteralCount = this.#literals.filter((literal) => literal.length < reportThreshold).length;
    this.#unresolvedSecretEnv = unresolved;
    this.#emptyEnv = emptyEnv;
  }

  /** Number of configured literal secrets (never the values). */
  get literalCount(): number {
    return this.#literals.length;
  }

  /** Configured literals shorter than the reporting threshold (values are never exposed). */
  get shortLiteralCount(): number {
    return this.#shortLiteralCount;
  }

  /** Declared secret environment variables that are not present in this environment. */
  get unresolvedSecretEnvNames(): readonly string[] {
    return [...this.#unresolvedSecretEnv];
  }

  /** Declared secret environment variables that are present but empty. */
  get emptySecretEnvNames(): readonly string[] {
    return [...this.#emptyEnv];
  }

  /** Longest configured literal, used to reason about line-wise safety. */
  get longestLiteralLength(): number {
    return this.#longestLiteral;
  }

  /**
   * 对一段文字执行格式规则及已配置值遮盖，不负责改变任务状态等结构数据。
   */
  redact(text: string): string {
    if (text === '') return text;
    let out = text;
    for (const rule of PATTERN_RULES) {
      out = out.replace(rule.regex, rule.replace as (...args: string[]) => string);
    }
    for (const literal of this.#literals) {
      // A diagnostic may pass through disk and then a view gate. The reserved
      // marker must remain stable even if a configured short value occurs in it.
      if (out.includes(literal)) {
        out = out.split(PLACEHOLDER).map((part) => part.split(literal).join(PLACEHOLDER)).join(PLACEHOLDER);
      }
    }
    return out;
  }

  /**
   * Redact every string reachable inside a structured value (R2-04).
   *
   * Use only for diagnostic payloads, never whole job records or MCP envelopes:
   * their identities, states, paths and hashes are machine contracts.
   */
  /**
   * 递归遮盖诊断数据中的文字；不用于整份任务档案或协议响应，避免改坏状态、编号和哈希。
   */
  redactValue<T>(value: T): T {
    return redactStructured(value, (text) => this.redact(text)) as T;
  }

  /**
   * Streaming redactor: complete lines are redacted and emitted; an incomplete
   * trailing line stays buffered until a newline or `flush()`.
   */
  /**
   * 创建逐行脱敏缓冲器，将处理后的文字交给回调。
   */
  createStream(onText: (text: string) => void): RedactingStream {
    return new RedactingStream(this, onText);
  }
}

/**
 * 处理跨数据块、跨半行输出的脱敏缓冲器。
 */
export class RedactingStream {
  readonly #redactor: Redactor;
  readonly #onText: (text: string) => void;
  #pending = '';
  #closed = false;

  /**
   * 连接脱敏器和处理后文字的接收方，准备跨块缓冲。
   */
  constructor(redactor: Redactor, onText: (text: string) => void) {
    this.#redactor = redactor;
    this.#onText = onText;
  }

  /** Characters buffered because no newline closed their line yet. */
  /**
   * 当前未遇到换行、尚在缓冲中的文字数量。
   */
  get pendingChars(): number {
    return this.#pending.length;
  }

  /**
   * 追加新文字，只有收齐的行才送入脱敏处理，避免半个密钥提前落盘。
   */
  push(chunk: Buffer | string): void {
    if (this.#closed) return;
    this.#pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = this.#pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline + 1);
      this.#pending = this.#pending.slice(newline + 1);
      this.#onText(this.#redactor.redact(line));
      newline = this.#pending.indexOf('\n');
    }
  }

  /**
   * 输出最后一段完整收到的尾行；由调用方在正常结束时触发。
   */
  flush(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pending !== '') {
      this.#onText(this.#redactor.redact(this.#pending));
      this.#pending = '';
    }
  }

  /**
   * Drop the buffered incomplete line without emitting it (FIX-002 F2-01).
   *
   * Used when the capture had to discard stream data: a known literal may have
   * continued inside the discarded bytes, so the retained prefix cannot be
   * proven safe and must never reach a disk consumer.
   */
  /**
   * 丢弃已截断的未完整尾行，避免把缺少后半段的敏感文字直接写出。
   */
  discard(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = '';
  }
}

export const REDACTION_PLACEHOLDER = PLACEHOLDER;

/**
 * Redact a structured value deeply (R2-04). Numbers, booleans and `null` are
 * returned unchanged; strings go through `redact`; arrays and plain objects are
 * rebuilt. Cycles are impossible in this codebase's records, so the walk is
 * bounded by the value's own depth.
 */
/**
 * 递归遮盖通用数据中的字符串。包含身份、状态和哈希的任务档案使用 jobs.ts 的专用投影，避免关键字段被误改。
 */
export function redactStructured(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, redact));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactStructured(item, redact);
    }
    return out;
  }
  return value;
}

/** Slice a string so that its UTF-8 encoding is at most `maxBytes` long. */
/**
 * 在给定字节预算内保留完整字符，供脱敏和输出裁剪使用。
 */
export function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return out;
}
