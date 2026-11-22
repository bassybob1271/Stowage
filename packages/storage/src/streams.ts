import { Readable } from 'node:stream';

export function toWeb(r: Readable | NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  const node = r instanceof Readable ? r : Readable.from(r as AsyncIterable<Uint8Array>);
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

export function toNode(s: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(s as import('node:stream/web').ReadableStream<Uint8Array>);
}

export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (c) => c.close() });
}

/**
 * Skip `start` bytes and stop after `end` (inclusive) without buffering the
 * whole stream. Used to emulate range reads on adapters that can't seek.
 */
export function sliceStream(src: ReadableStream<Uint8Array>, start: number, end?: number): ReadableStream<Uint8Array> {
  let pos = 0;
  const reader = src.getReader();
  const stop = end === undefined ? Infinity : end + 1;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (pos >= stop) {
          await reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunkStart = pos;
        const chunkEnd = pos + value.byteLength;
        pos = chunkEnd;
        if (chunkEnd <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, stop - chunkStart);
        if (to > from) {
          controller.enqueue(value.subarray(from, to));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Count bytes flowing through a stream. */
export function countingStream(src: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; bytes: () => number } {
  let n = 0;
  const t = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      n += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  return { stream: src.pipeThrough(t), bytes: () => n };
}

export async function streamToBuffer(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of s as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks);
}
