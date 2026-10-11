/**
 * 中文模块导读
 * 输出收集与分页：接收 DSH 输出，先脱敏，再保存到日志。
 * UTF-8 的中文或 emoji 可能跨数据块到达，需要连续解码；分页按 Unicode 码点计数，不直接按字符串 length 切。
 * 容量上限限制的是保存字节；若丢弃了输出，会记录 truncated 和丢弃数量，不能把保留的一部分叫作完整结果。
 */
/**
 * Output capture with hard limits, safe truncation and safe-by-construction
 * redaction.
 *
 * Pipeline per stream: raw bytes → incremental UTF-8 decode (StringDecoder) →
 * line-buffered redaction → bounded in-memory text + identical bytes on disk.
 *
 * Hard bounds (FIX-002 F2-01):
 *  - `pending` (decoded text fed but not yet emitted) never exceeds `capBytes`;
 *  - a single call decodes at most the remaining pending budget, so one huge
 *    chunk cannot be decoded or buffered in full;
 *  - once anything is discarded the stream is **truncated** and the retained
 *    incomplete line is dropped instead of written: a known literal may have
 *    continued inside the discarded bytes, so that prefix cannot be proven safe.
 *    Only complete (newline-terminated) lines that were flushed before the cap
 *    reach the log, plus one standalone truncation note.
 *
 * Truncation unit: the incomplete trailing line. EOF handling: when the stream
 * ends without truncation, the last line is complete (nothing was discarded) and
 * is flushed redacted. Drain policy: after truncation the child's pipe keeps
 * being drained and every further byte is counted and discarded.
 *
 * Note placement (FIX-002 R1-05): the standalone truncation note is written once
 * at {@link StreamCapture.end}, *after* every retained byte, so a legal log is
 * always `retained bytes + one note` and never `retained + note + retained`.
 * Redaction can expand text past the remaining budget, so the final retained
 * fragment is written after truncation was already detected: the note must not
 * be emitted at detection time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Redactor } from './redact.js';
import { ensureDir } from './atomic.js';
import { BridgeError } from './errors.js';

export { sliceUtf8 } from './redact.js';

/** Largest UTF-8 encoding of a single Unicode code point. */
export const MAX_CODE_POINT_BYTES = 4;

const TRUNCATION_PREFIX = '[dsh-codex-bridge] output truncated';

/** Standalone note written once when the capture had to discard stream data. */
/**
 * 生成“输出达到上限”的说明，包含保存上限和丢弃字节数。
 */
export function truncationMarker(capBytes: number, droppedBytes: number): string {
  return `\n${TRUNCATION_PREFIX}: cap ${capBytes} bytes reached, ${droppedBytes} bytes discarded; the incomplete final line was not written\n`;
}

/**
 * Remove truncation notes so pagination sees only captured output.
 *
 * Diagnostic/test helper only: the bridge read path verifies logs with
 * {@link locateTruncationNote} and never strips markers with a body-wide regex
 * (R1-05), because a body line can look exactly like a note.
 */
/**
 * 去除符合格式的截断说明；严格读取日志时还要结合记录的字节数验证，不能仅靠这一步证明完整。
 */
export function stripTruncationMarkers(text: string): string {
  if (!text.includes(TRUNCATION_PREFIX)) return text;
  // Remove the note together with its own newline; the captured text is left byte
  // for byte identical to what was retained.
  return text.replace(/\n?\[dsh-codex-bridge\] output truncated:[^\n]*\n?/g, '');
}

/**
 * True when `text` is *exactly* one standalone truncation note for `capBytes`
 * (`\n` + note + `\n`), as produced by {@link truncationMarker}.
 */
/**
 * 判断文字是否符合当前容量上限对应的截断说明格式。
 */
export function isTruncationMarker(text: string, capBytes: number): boolean {
  const template = truncationMarker(capBytes, 0);
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped.replace('0 bytes discarded', '\\d+ bytes discarded')}$`);
  return pattern.test(text);
}

/** Upper bound on note candidates inspected in one log before giving up. */
const MAX_TRUNCATION_NOTE_CANDIDATES = 4096;

/**
 * Locate the single standalone truncation note inside a truncated log (R1-05).
 *
 * The extra bytes on disk (`data.length - expectedBytes`) fix the note's exact
 * length, so every candidate can be validated as one whole note; the retained
 * text is then exactly `data` minus that note.
 *
 * - **Canonical (written by this version):** the note is the file *suffix*.
 * - **Legacy (written before R1-05):** the note could sit *before* the last
 *   retained fragment, because it was emitted the moment data was discarded.
 *   Such a log is still accepted, but only when the evidence is unambiguous.
 *
 * `null` means "not provable": no note, a note of the wrong length (e.g. bytes
 * were removed from the retained text and the note's own bytes now cover the
 * gap), or several byte-identical notes, which a pre-R1-05 log cannot
 * disambiguate. The caller must refuse rather than guess.
 */
/**
 * 在字节日志里寻找唯一、合法的截断说明；去除后必须恰好符合保存字节数，歧义时拒绝认可。
 */
export function locateTruncationNote(
  data: Buffer,
  expectedBytes: number,
  capBytes: number,
): { start: number; bytes: number; trailing: boolean } | null {
  const noteBytes = data.length - expectedBytes;
  if (noteBytes <= 0) return null;
  const needle = Buffer.from(`\n${TRUNCATION_PREFIX}:`, 'utf8');
  let start = -1;
  let from = 0;
  let examined = 0;
  for (;;) {
    const at = data.indexOf(needle, from);
    if (at < 0) break;
    examined += 1;
    if (examined > MAX_TRUNCATION_NOTE_CANDIDATES) return null;
    if (at + noteBytes <= data.length) {
      const candidate = data.subarray(at, at + noteBytes).toString('utf8');
      if (isTruncationMarker(candidate, capBytes)) {
        // A second well-formed note of the same length is unprovable, not a coin toss.
        if (start >= 0) return null;
        start = at;
      }
    }
    from = at + 1;
  }
  if (start < 0) return null;
  return { start, bytes: noteBytes, trailing: start + noteBytes === data.length };
}

/**
 * 一个输出流的保存上限、日志位置及脱敏器。
 */
export interface StreamCaptureOptions {
  capBytes: number;
  redactor: Redactor;
  logFile: string;
}

/**
 * 一条输出流的收集器，分别为 stdout 与 stderr 创建。
 */
export class StreamCapture {
  readonly #capBytes: number;
  readonly #redactor: Redactor;
  readonly #logFile: string;
  readonly #decoder = new StringDecoder('utf8');
  readonly #stream: ReturnType<Redactor['createStream']>;
  #chunks: string[] = [];
  #storedBytes = 0;
  #fedBytes = 0;
  #rawBytes = 0;
  #droppedBytes = 0;
  #truncated = false;
  #markerWritten = false;
  #ended = false;

  /**
   * 为一个输出流准备容量上限、UTF-8 连续解码器和脱敏回调。
   */
  constructor(options: StreamCaptureOptions) {
    this.#capBytes = options.capBytes;
    this.#redactor = options.redactor;
    this.#logFile = options.logFile;
    ensureDir(path.dirname(options.logFile));
    /**
     * 写日志前先经过逐行脱敏；回调收到的已经是处理后的文字。
     */
    this.#stream = options.redactor.createStream((text) => this.#append(text));
  }

  /**
   * 接收原始字节块，连续解码并送往脱敏器；达到上限后仍统计被丢弃字节。
   */
  push(chunk: Buffer): void {
    if (this.#ended) return;
    this.#rawBytes += chunk.length;
    if (this.#truncated) {
      this.#droppedBytes += chunk.length;
      return;
    }
    const pending = this.#fedBytes - this.#storedBytes;
    const budget = this.#capBytes - pending;
    if (budget <= 0) {
      this.#truncate(chunk.length);
      return;
    }
    const usable = chunk.length > budget ? chunk.subarray(0, budget) : chunk;
    const overflow = chunk.length - usable.length;
    const text = this.#decoder.write(usable);
    this.#fedBytes += Buffer.byteLength(text, 'utf8');
    this.#stream.push(text);
    if (overflow > 0) this.#truncate(overflow);
  }

  /**
   * 结束收集并处理尾部；截断的半行会丢弃，最后只写一次准确的截断说明。
   */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#truncated) {
      // The retained trailing line is incomplete: discard it and record why.
      this.#stream.discard();
    } else {
      const tail = this.#decoder.end();
      if (tail !== '') {
        this.#fedBytes += Buffer.byteLength(tail, 'utf8');
        this.#stream.push(tail);
      }
      // Flushing the last line can itself cross the cap, so truncation is not
      // final until here.
      this.#stream.flush();
    }
    // R1-05: every retained byte is on disk by now, so the note is a suffix and
    // reports the final discarded-byte count.
    this.#writeMarker();
  }

  /**
   * 子进程原始输出字节总数，与最终保留字节数可能不同。
   */
  get rawBytes(): number {
    return this.#rawBytes;
  }

  /**
   * 已经保留的脱敏内容字节数，用于结束后核验日志长度。
   */
  get storedBytes(): number {
    return this.#storedBytes;
  }

  /**
   * 是否因容量限制丢弃过内容；true 时不能宣称输出完整。
   */
  get truncated(): boolean {
    return this.#truncated;
  }

  /**
   * 因上限或截断被丢弃的字节计数。
   */
  get droppedBytes(): number {
    return this.#droppedBytes;
  }

  /** Stored text: complete lines only. Redaction happened before any write. */
  /**
   * 返回内存中已保留的脱敏文字；运行中尚未收齐的半行不会直接显示。
   */
  text(): string {
    return this.#chunks.join('');
  }

  /**
   * 标记丢弃并累计数量，延后到结束时写说明，避免说明插进保留内容中间。
   */
  #truncate(dropped: number): void {
    // R1-05: only flag the loss here. The note is written once from `end()`, after
    // the retained bytes, so it can never split the retained output.
    this.#droppedBytes += dropped;
    this.#truncated = true;
  }

  /**
   * 仅对截断的输出写一次说明；说明字节与正文保留字节分开计数。
   */
  #writeMarker(): void {
    // Only a truncated stream gets a note, and only one: `end()` calls this on
    // every stream, so both conditions are required here.
    if (!this.#truncated || this.#markerWritten) return;
    this.#markerWritten = true;
    try {
      fs.appendFileSync(this.#logFile, truncationMarker(this.#capBytes, this.#droppedBytes));
    } catch {
      /* logging must never break a job */
    }
  }

  /**
   * 将脱敏后的文字按剩余字节预算保存到内存和磁盘，必要时裁剪完整字符。
   */
  #append(text: string): void {
    if (text === '') return;
    const remaining = this.#capBytes - this.#storedBytes;
    if (remaining <= 0) {
      // The stored cap is reached: keep draining, count the loss and stop.
      this.#truncate(Buffer.byteLength(text, 'utf8'));
      return;
    }
    let piece = text;
    const size = Buffer.byteLength(piece, 'utf8');
    if (size > remaining) {
      piece = sliceUtf8ByBytes(piece, remaining);
      this.#truncate(size - Buffer.byteLength(piece, 'utf8'));
    }
    if (piece === '') return;
    this.#chunks.push(piece);
    this.#storedBytes += Buffer.byteLength(piece, 'utf8');
    fs.appendFileSync(this.#logFile, piece);
  }
}

/** Byte-bounded UTF-8 slice that never splits a code point. */
/**
 * 按 UTF-8 字节预算裁剪文字，同时避免切断一个中文或 emoji 字符。
 */
export function sliceUtf8ByBytes(text: string, maxBytes: number): string {
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

/**
 * 要读哪条输出流，从哪个码点偏移开始，最多取多少码点。
 */
export interface PageRequest {
  stream: 'combined' | 'stdout' | 'stderr';
  offset: number;
  limit: number;
}

/**
 * 一页正文与偏移、总码点、字节数和截断标志。
 */
export interface PageResult {
  stream: 'combined' | 'stdout' | 'stderr';
  offset: number;
  nextOffset: number;
  totalChars: number;
  pageChars: number;
  pageBytes: number;
  maxPageBytes: number;
  /** `offset` and `nextOffset` count Unicode code points, not UTF-16 units. */
  offsetUnit: 'code-point';
  truncated: { stdout: boolean; stderr: boolean };
  output: string;
}

/** Build the combined view used by `dsh_result` when `stream=combined`. */
/**
 * 把标准输出和错误输出按固定分隔符组合；这是展示形式，不把 stderr 自动判定为作业失败。
 */
export function combinedText(stdout: string, stderr: string): string {
  if (stderr === '') return stdout;
  return `${stdout}\n----- stderr -----\n${stderr}`;
}

/**
 * 按 Unicode 码点计数；例如单个火箭 emoji 在这里计为一个，而不是两个 UTF-16 单元。
 */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

/**
 * Paginate by Unicode code points under a **hard** byte ceiling.
 *
 * - `offset`/`nextOffset` are code-point indexes, so a page never splits a
 *   surrogate pair.
 * - `maxPageBytes` is never exceeded: the smallest legal budget
 *   ({@link MAX_CODE_POINT_BYTES}) always fits one code point, so a page can
 *   still advance without an exemption. Smaller budgets are a caller/config
 *   error and are rejected (FIX-002 F2-05).
 */
/**
 * 按码点偏移读取一页，同时严格限制字节数。调用方应读取 page.output，并用 nextOffset 继续，直到 totalChars。
 */
export function paginate(
  text: string,
  request: PageRequest,
  maxPageBytes: number,
  truncated: { stdout: boolean; stderr: boolean },
): PageResult {
  if (!Number.isInteger(maxPageBytes) || maxPageBytes < MAX_CODE_POINT_BYTES) {
    throw new BridgeError('INVALID_ARGUMENT', `maxPageBytes must be at least ${MAX_CODE_POINT_BYTES} (largest UTF-8 code point)`, {
      maxPageBytes,
      minimum: MAX_CODE_POINT_BYTES,
    });
  }
  const totalChars = countCodePoints(text);
  const offset = Math.max(0, Math.min(request.offset, totalChars));
  const limit = Math.max(1, Math.min(request.limit, 1_000_000_000));

  let output = '';
  let pageBytes = 0;
  let taken = 0;
  let index = 0;
  for (const char of text) {
    if (index < offset) {
      index += 1;
      continue;
    }
    if (taken >= limit) break;
    const size = Buffer.byteLength(char, 'utf8');
    if (pageBytes + size > maxPageBytes) break;
    output += char;
    pageBytes += size;
    taken += 1;
    index += 1;
  }

  return {
    stream: request.stream,
    offset,
    nextOffset: offset + taken,
    totalChars,
    pageChars: taken,
    pageBytes,
    maxPageBytes,
    offsetUnit: 'code-point',
    truncated,
    output,
  };
}
