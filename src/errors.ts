/**
 * 中文模块导读
 * 错误词典：用稳定的错误代码告诉调用方到底在哪个环节失败。
 * 对外返回错误前仍要脱敏；不能因为出错就把含凭据的原始异常直接交给日志或 Codex。
 */
/**
 * Stable error codes for the DSH execution bridge.
 *
 * Every code is part of the MCP tool contract: Codex (the caller) may branch on
 * them, so they must not be renamed casually. Protocol-level failures (bad JSON,
 * unknown method) are handled by the MCP SDK and are not part of this list.
 */
export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'INVALID_MODE',
  'INVALID_TIMEOUT',
  'UNKNOWN_WORKSPACE',
  'WORKSPACE_DIR_MISSING',
  'WORKSPACE_MODE_NOT_ALLOWED',
  'EMPTY_TASK',
  'TASK_FILE_NOT_FOUND',
  'TASK_FILE_UNREADABLE',
  'TASK_FILE_TOO_LARGE',
  'TASK_FILE_NOT_UTF8',
  'PATH_NOT_ALLOWED',
  'JOB_NOT_FOUND',
  'JOB_RECORD_UNREADABLE',
  'JOB_NOT_TERMINAL',
  'REQUEST_CONFLICT',
  'BUSY',
  'RUNNER_UNAVAILABLE',
  'SPAWN_FAILED',
  'PROCESS_EXIT_NONZERO',
  'TIMEOUT',
  'INTERRUPTED',
  'STATE_WRITE_FAILED',
  'STATE_DIR_BUSY',
  'ORPHAN_UNRESOLVED',
  'ORPHAN_IDENTITY_UNVERIFIED',
  'OWNERSHIP_LOST',
  'REQUEST_INDEX_UNREADABLE',
  'OUTPUT_LOG_UNREADABLE',
  'OUTPUT_LOG_INCOMPLETE',
  'CLEANUP_UNCONFIRMED',
  'SNAPSHOT_FAILED',
  'AUDIT_REQUIRES_SNAPSHOT',
  'AUDIT_SOURCE_MODIFIED',
  'AUDIT_SNAPSHOT_MODIFIED',
  'AUDIT_UNDETECTED_INPUT',
  'CONFIG_INVALID',
  'INTERNAL_ERROR',
] as const;

/**
 * 可被调用方稳定识别的错误类别。
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Typed, client-visible failure carrying a stable code and structured details. */
/**
 * 带稳定错误代码和详情的桥接异常。
 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 对外错误结构，包含错误代码、文字说明和可选详情。
 */
export interface ErrorPayload {
  code: ErrorCode | 'INTERNAL_ERROR';
  message: string;
  details: Record<string, unknown>;
}

/** Normalize any thrown value into a stable, client-visible error payload. */
/**
 * 把异常转成稳定的错误代码、说明和详情；返回前遮盖说明中的敏感文字。
 */
export function toErrorPayload(error: unknown, redact: (text: string) => string): ErrorPayload {
  if (error instanceof BridgeError) {
    return {
      code: error.code,
      message: redact(error.message),
      details: redactValue(error.details, redact) as Record<string, unknown>,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'INTERNAL_ERROR', message: redact(message), details: {} };
}

/**
 * 递归处理错误详情中的文字，保留数组和对象形状。
 */
function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, redact);
    }
    return out;
  }
  return value;
}
