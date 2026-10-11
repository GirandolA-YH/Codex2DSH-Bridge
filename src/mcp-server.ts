/**
 * 中文模块导读
 * 对外工具窗口：把 Codex 的五种操作转交给任务管理器。
 * 提交是异步的：先拿到 jobId（作业编号），再查询状态和结果，不在这里等待模型做完。
 * 这个文件负责协议与参数入口；真正的执行、保存和取消逻辑在 jobs.ts。
 */
/**
 * MCP surface: five ordinary tools, a submit-then-poll contract, and stable
 * error codes. No MCP Tasks extension is used, so any standard MCP client
 * (including Codex) can drive long jobs through `dsh_status`/`dsh_result`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeError, toErrorPayload } from './errors.js';
import type { LoadedConfig } from './config.js';
import type { JobManager } from './jobs.js';

/**
 * 一个 MCP 工具的名称、说明和参数格式。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const JOB_ID_SCHEMA = { type: 'string', pattern: '^job-[0-9a-zA-Z]{6,32}$', description: 'Job id returned by dsh_submit.' };

export const TOOLS: ToolDefinition[] = [
  {
    /**
     * 检查运行情况，不启动新任务。
     */
    name: 'dsh_health',
    description:
      'Bridge version, runner availability and DSH launch configuration, configured workspaces, capability limits, the currently active job and the last few jobs. Never returns credentials.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    /**
     * 提交一次任务并立即取得编号，后续另查进度。
     */
    name: 'dsh_submit',
    description:
      'Accept one task file and start a DSH headless job asynchronously. Returns a jobId immediately (does not wait for the model). The task file is copied and hashed before acceptance, so later edits to the original do not change the accepted work. At most one job may be active: a second job returns BUSY. Re-sending the same requestId with identical content returns the original job instead of starting a second run.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9._:-]{1,128}$',
          description: 'Client retry key. Same id + same content is idempotent; same id + different content is REQUEST_CONFLICT.',
        },
        workspaceId: { type: 'string', description: 'Configured workspace id; the caller cannot supply a directory.' },
        taskFile: { type: 'string', description: 'Absolute path to a task file inside a configured task-file root.' },
        mode: { type: 'string', enum: ['implement', 'fix', 'audit'], description: 'Work mode; audit requires an audit workspace bound to a snapshot.' },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 3600,
          description: 'Wall-clock limit; the process tree is terminated on expiry. Defaults to the configured default (1800).',
        },
      },
      required: ['requestId', 'workspaceId', 'taskFile', 'mode'],
      additionalProperties: false,
    },
  },
  {
    /**
     * 查询已受理任务的状态。
     */
    name: 'dsh_status',
    description:
      'Current or final state of one job: status, timestamps, pid, exit code, stable error code, output sizes/truncation, and audit-stability fields for audit jobs. Terminal states are immutable.',
    inputSchema: {
      type: 'object',
      properties: { jobId: JOB_ID_SCHEMA },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    /**
     * 分页读取已脱敏的输出，并检查完整性信息。
     */
    name: 'dsh_result',
    description:
      'Paginated, redacted output of one job. Character offsets keep multi-byte text intact; one page never exceeds the configured byte cap (64 KiB by default). `truncated` reports whether the per-stream capture cap (5 MiB by default) was hit.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: JOB_ID_SCHEMA,
        stream: { type: 'string', enum: ['combined', 'stdout', 'stderr'], description: 'Defaults to combined (stdout then a stderr section).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset into the selected stream.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum characters to return; also capped by the page byte limit.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    /**
     * 请求停止指定任务，实际是否停止要看返回证据。
     */
    name: 'dsh_cancel',
    description:
      'Idempotently cancel a job and terminate only the process tree this bridge started. Cancelling a terminal job returns its state unchanged; unrelated processes are never touched.',
    inputSchema: {
      type: 'object',
      properties: { jobId: JOB_ID_SCHEMA },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
];

/**
 * MCP 响应包装：文本、结构化数据和错误标志。
 */
interface CallToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * 把同一份结果同时包装为可显示的 JSON 文本与结构化数据；失败时附上错误标志。
 */
function asResult(payload: Record<string, unknown>, isError = false): CallToolResultLike {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 先检查参数必须是对象、只能包含已声明字段、必填项不能缺少；具体内容继续交给任务管理器检查。
 */
function validateArguments(args: unknown, tool: ToolDefinition): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new BridgeError('INVALID_ARGUMENT', `${tool.name}: arguments must be an object`);
  }
  const record = args as Record<string, unknown>;
  const allowed = new Set(Object.keys((tool.inputSchema['properties'] ?? {}) as Record<string, unknown>));
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new BridgeError('INVALID_ARGUMENT', `${tool.name}: unexpected arguments`, { unexpected, allowed: [...allowed] });
  }
  for (const required of (tool.inputSchema['required'] ?? []) as string[]) {
    if (record[required] === undefined || record[required] === null) {
      throw new BridgeError('INVALID_ARGUMENT', `${tool.name}: missing required argument ${required}`, { argument: required });
    }
  }
  return record;
}

/**
 * 注册五个工具和请求处理器，把各个工具名称对应到 JobManager 的方法。
 */
export function createServer(config: LoadedConfig, jobs: JobManager): Server {
  const server = new Server(
    { name: config.serverName, version: config.serverVersion },
    {
      capabilities: { tools: {} },
      instructions:
        'Local bridge that lets an MCP host (Codex) launch DeepSeek Harness headless jobs, poll them and cancel them. ' +
        'Jobs are asynchronous: dsh_submit returns a jobId, then poll dsh_status and read dsh_result. ' +
        'A completed job means the DSH process exited 0 — it is never a statement that the work was accepted or correct.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return asResult(
        { ok: false, error: { code: 'INVALID_ARGUMENT', message: `unknown tool: ${request.params.name}`, details: { tools: TOOLS.map((t) => t.name) } } },
        true,
      ) as never;
    }
    try {
      const args = validateArguments(request.params.arguments, tool);
      switch (tool.name) {
        case 'dsh_health':
          return asResult(jobs.health()) as never;
        case 'dsh_submit': {
          const ack = await jobs.submit({
            requestId: args['requestId'],
            workspaceId: args['workspaceId'],
            taskFile: args['taskFile'],
            mode: args['mode'],
            timeoutSeconds: args['timeoutSeconds'],
          });
          return asResult({
            ok: true,
            accepted: ack.accepted,
            jobId: ack.jobId,
            status: ack.status,
            reusedExistingJob: ack.reusedExistingJob,
            job: ack.view as unknown as Record<string, unknown>,
          }) as never;
        }
        case 'dsh_status':
          return asResult({ ok: true, job: jobs.status(args['jobId']) as unknown as Record<string, unknown> }) as never;
        case 'dsh_result': {
          const view = jobs.result(args['jobId'], {
            stream: args['stream'],
            offset: args['offset'],
            limit: args['limit'],
          });
          return asResult({ ok: true, job: view as unknown as Record<string, unknown>, page: view.page as unknown as Record<string, unknown> }) as never;
        }
        case 'dsh_cancel': {
          const view = await jobs.cancel(args['jobId']);
          return asResult({ ok: true, job: view as unknown as Record<string, unknown>, alreadyTerminal: view.alreadyTerminal, kill: view.kill }) as never;
        }
        default:
          throw new BridgeError('INVALID_ARGUMENT', `unhandled tool: ${tool.name}`);
      }
    } catch (error) {
      const payload = toErrorPayload(error, (text) => config.redactor.redact(text));
      config.logger.warn('tool call failed', { tool: tool.name, code: payload.code, message: payload.message });
      return asResult({ ok: false, error: payload }, true) as never;
    }
  });

  return server;
}
