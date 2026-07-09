import { xdelta3WasmBase64 } from './wasm-embedded';

export type SourceReader = {
  size: number;
  /**
   * Read up to `into.length` bytes at `offset` into `into`.
   * Returns the number of bytes read.
   */
  read(offset: number, into: Uint8Array): number | Promise<number>;
};

const STATUS_NEED_INPUT = 1;
const STATUS_HAVE_OUTPUT = 2;
const STATUS_NEED_SOURCE_BLOCK = 3;
const STATUS_CONTINUE = 4;

type Xdelta3WasmExports = {
  memory: WebAssembly.Memory;
  xd3w_new(sourceSize: number): number;
  xd3w_free(handle: number): void;
  xd3w_input_buf(handle: number): number;
  xd3w_input_cap(): number;
  xd3w_avail_input(handle: number, len: number, isFinal: number): void;
  xd3w_step(handle: number): number;
  xd3w_output_ptr(handle: number): number;
  xd3w_output_len(handle: number): number;
  xd3w_consume_output(handle: number): void;
  xd3w_source_ptr(handle: number): number;
  xd3w_source_request_offset(handle: number): number;
  xd3w_source_request_len(handle: number): number;
  xd3w_provide_source(handle: number, onblk: number): void;
  xd3w_close(handle: number): number;
  xd3w_errmsg(handle: number): number;
};

type BufferConstructorLike = {
  from(input: string, encoding: 'base64'): Uint8Array;
};

let wasmReady: Promise<Xdelta3WasmExports> | null = null;

function base64ToBytes(base64: string): Uint8Array {
  const maybeBuffer = (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
  if (maybeBuffer) {
    return new Uint8Array(maybeBuffer.from(base64, 'base64'));
  }
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function loadWasm(): Promise<Xdelta3WasmExports> {
  if (!wasmReady) {
    wasmReady = WebAssembly.instantiate(base64ToBytes(xdelta3WasmBase64), {
      env: {
        emscripten_notify_memory_growth: () => undefined,
      },
    }).then((result) => {
      const instantiated = result as WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
      const instance = 'instance' in instantiated ? instantiated.instance : instantiated;
      const exports = instance.exports as unknown as Xdelta3WasmExports & {
        _initialize?: () => void;
      };
      exports._initialize?.();
      return exports;
    });
  }
  return await wasmReady;
}

function memoryBytes(wasm: Xdelta3WasmExports, ptr: number, len: number): Uint8Array {
  return new Uint8Array(wasm.memory.buffer, ptr, len);
}

function copyFromMemory(wasm: Xdelta3WasmExports, ptr: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(memoryBytes(wasm, ptr, len));
  return out;
}

function readCString(wasm: Xdelta3WasmExports, ptr: number): string {
  if (ptr === 0) {
    return '';
  }
  const bytes = new Uint8Array(wasm.memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

function errorMessage(wasm: Xdelta3WasmExports, handle: number, code: number): Error {
  const message = readCString(wasm, wasm.xd3w_errmsg(handle));
  return new Error(
    message ? `xdelta3 encode failed: ${message} (code=${code})` : `xdelta3 encode failed (code=${code})`,
  );
}

async function* drainEncoder(
  wasm: Xdelta3WasmExports,
  handle: number,
  source: SourceReader,
): AsyncIterable<Uint8Array> {
  for (;;) {
    const status = wasm.xd3w_step(handle);
    switch (status) {
      case STATUS_NEED_INPUT:
        return;

      case STATUS_HAVE_OUTPUT: {
        const len = wasm.xd3w_output_len(handle);
        if (len > 0) {
          const ptr = wasm.xd3w_output_ptr(handle);
          if (ptr === 0) {
            throw new Error('xdelta3 encoder produced output without a pointer');
          }
          yield copyFromMemory(wasm, ptr, len);
        }
        wasm.xd3w_consume_output(handle);
        break;
      }

      case STATUS_NEED_SOURCE_BLOCK: {
        const sourcePtr = wasm.xd3w_source_ptr(handle);
        if (sourcePtr === 0) {
          throw new Error('xdelta3 encoder did not provide a source buffer');
        }
        const offset = wasm.xd3w_source_request_offset(handle);
        const maxLen = wasm.xd3w_source_request_len(handle);
        if (!Number.isFinite(offset) || offset < 0 || maxLen < 0) {
          throw new Error(`xdelta3 encoder requested invalid source range: offset=${offset} len=${maxLen}`);
        }
        const sourceView = memoryBytes(wasm, sourcePtr, maxLen);
        const bytesRead = maxLen === 0 ? 0 : await source.read(offset, sourceView);
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > maxLen) {
          throw new Error(`source reader returned invalid byte count: ${bytesRead}`);
        }
        wasm.xd3w_provide_source(handle, bytesRead);
        break;
      }

      case STATUS_CONTINUE:
        break;

      default:
        throw errorMessage(wasm, handle, status);
    }
  }
}

async function* feedChunk(
  wasm: Xdelta3WasmExports,
  handle: number,
  source: SourceReader,
  chunk: Uint8Array,
  isFinalChunk: boolean,
): AsyncIterable<Uint8Array> {
  const inputPtr = wasm.xd3w_input_buf(handle);
  const inputCap = wasm.xd3w_input_cap();
  if (inputPtr === 0 || inputCap <= 0) {
    throw new Error('xdelta3 encoder did not provide an input buffer');
  }

  if (chunk.byteLength === 0) {
    if (isFinalChunk) {
      wasm.xd3w_avail_input(handle, 0, 1);
      yield* drainEncoder(wasm, handle, source);
    }
    return;
  }

  for (let offset = 0; offset < chunk.byteLength; offset += inputCap) {
    const end = Math.min(offset + inputCap, chunk.byteLength);
    const segment = chunk.subarray(offset, end);
    memoryBytes(wasm, inputPtr, segment.byteLength).set(segment);
    const isFinalSegment = isFinalChunk && end === chunk.byteLength;
    wasm.xd3w_avail_input(handle, segment.byteLength, isFinalSegment ? 1 : 0);
    yield* drainEncoder(wasm, handle, source);
  }
}

/**
 * Encode a VCDIFF/xdelta3 patch for `target` relative to `source`.
 */
export async function* encode(
  target: AsyncIterable<Uint8Array>,
  source: SourceReader,
): AsyncIterable<Uint8Array> {
  const wasm = await loadWasm();
  const handle = wasm.xd3w_new(source.size);
  if (handle === 0) {
    throw new Error('failed to allocate xdelta3 encoder');
  }

  try {
    let pending: Uint8Array | null = null;
    for await (const chunk of target) {
      if (pending) {
        yield* feedChunk(wasm, handle, source, pending, false);
      }
      pending = chunk;
    }

    if (pending) {
      yield* feedChunk(wasm, handle, source, pending, true);
    } else {
      yield* feedChunk(wasm, handle, source, new Uint8Array(0), true);
    }

    const closeRet = wasm.xd3w_close(handle);
    if (closeRet !== 0) {
      throw errorMessage(wasm, handle, closeRet);
    }
  } finally {
    wasm.xd3w_free(handle);
  }
}
