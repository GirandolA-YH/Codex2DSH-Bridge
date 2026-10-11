/**
 * 中文模块导读
 * 可靠写文件的小工具：先写临时文件，再改名替换正式文件，减少读到半份内容的机会。
 * 替换短暂失败时保留旧的完整文件，不先删除旧文件来腾位置。
 */
/** Small filesystem helpers: atomic writes, strict JSON reads, directory creation. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 确保目录存在；缺少的父目录也一并创建。
 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a file by creating a unique temporary sibling and renaming it over the
 * destination. Readers therefore never observe a half-written file, and a
 * crashed writer cannot leave a truncated destination.
 */
/**
 * 先写同目录的临时文件，再替换正式文件。替换失败时尽量清理临时副本，并把错误交回调用方。
 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data);
    // Windows readers/scanners can briefly deny replacement. Keep the previous
    // complete destination; never unlink it to make a rename succeed.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

/** Create a file only if it does not exist yet. Returns false when it existed. */
/**
 * 只在文件尚不存在时创建。返回 false 表示别人已经占了这个位置，不覆盖对方内容。
 */
export function createFileExclusive(file: string, data: string): boolean {
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * 把数据转成 JSON，再用原子替换保存；读者尽量看到完整的旧版或新版。
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 读取 JSON 的便捷版本；失败时使用调用方给定的备用值。重要任务证据使用下方严格读取版本。
 */
export function readJson<T>(file: string, fallback: T): T {
  const result = readJsonStrict<T>(file);
  return result.status === 'ok' ? result.value : fallback;
}

/**
 * Read and parse JSON while distinguishing "not there" from "there but
 * unusable" (FIX-001 R05). Callers must not treat `invalid` as "never existed".
 */
/**
 * 严格读取结果：ok 是成功，missing 是不存在，invalid 是存在但不可使用。
 */
export type JsonReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/**
 * 区分三种情况：读到有效内容、文件不存在、文件存在但不可读或不是合法 JSON。
 */
export function readJsonStrict<T>(file: string): JsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', reason: `read failed: ${code ?? String(error)}` };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch (error) {
    return { status: 'invalid', reason: `parse failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 检查路径是否对应文件；检查失败时返回 false。
 */
export function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 检查路径是否对应目录；检查失败时返回 false。
 */
export function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 尝试移除指定文件；文件本来不存在时不视为失败。
 */
export function removeIfExists(target: string): void {
  try {
    fs.rmSync(target, { force: true, recursive: false });
  } catch {
    /* best effort */
  }
}

/**
 * 等待指定毫秒数后继续；只暂停调用它的异步流程。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
