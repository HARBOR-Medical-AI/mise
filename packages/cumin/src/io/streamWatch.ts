/**
 * @file Watchdogs over a transfer to or from CUBE: each fails the transfer,
 * with a reason, when it has made no progress for a while.
 *
 * A large CUBE file is slow before its first byte (measured 15 to 20 s on
 * a 3.7 GB DICOM) and slow after it (about 300 KB/s down, about 0.4 MB/s
 * up), so any fixed deadline on the whole transfer either kills a healthy
 * one or never fires. What is worth failing is silence: a transfer that has
 * stopped moving. The watchdogs measure exactly that and name it.
 *
 * - `stream_watchStalls` watches a download: bytes arriving.
 * - `upload_watchStalls` watches an upload: bytes taken from the file as the
 *   connection to CUBE asks for them, and then CUBE's answer.
 *
 * @module
 */
import { PassThrough, type Readable } from 'node:stream';

/** How long a CUBE transfer may make no progress before it is failed. */
export const STREAM_STALL_MS: number = 120_000;

/**
 * The most an upload reads from its file at once. Small enough that the
 * reads follow the connection's pace (a whole file read in one go would
 * count as progress at once and then sit in the socket's buffer).
 */
const UPLOAD_CHUNK_BYTES: number = 64 * 1024;

/** An upload's file and the watch over how it is read. */
export interface UploadWatch {
  /** The file to hand the upload: the same bytes, counted as they are read. */
  readonly file: File;
  /** Rejects with a sentence when the upload has made no progress for the stall time; never resolves. */
  readonly stalled: Promise<never>;
  /** Ends the watch, once the upload has answered either way. */
  readonly stop: () => void;
}

/**
 * Watches an upload by how its file is read, and fails it when that stops.
 *
 * The returned file reads its bytes in small slices, each only when the
 * request asks for the next, so a slice read is a slice the connection has
 * room for. The clock starts at once and every slice resets it; after the
 * last slice it keeps running, so CUBE's silence over a whole file it has
 * taken counts as well. When the clock runs out the file's stream fails (the
 * request is abandoned rather than left open) and `stalled` rejects saying
 * how far the upload got and how long nothing moved.
 *
 * @param blob - The bytes to upload.
 * @param filename - The name the file is uploaded as, for the file and the words.
 * @param stallMs - How long the upload may make no progress.
 * @returns The file to upload, the stall, and the stop.
 */
export function upload_watchStalls(blob: Blob, filename: string, stallMs: number): UploadWatch {
  const total: number = blob.size;
  let taken: number = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped: boolean = false;
  let fail: (error: Error) => void = (): void => undefined;
  const controllers: Set<ReadableStreamDefaultController<Uint8Array>> = new Set();
  const stalled: Promise<never> = new Promise<never>((_resolve, reject): void => {
    fail = reject;
  });
  // Nothing may be left waiting on a stall that a finished upload never raced.
  stalled.catch((): void => undefined);
  const stallWords_build = (): string => {
    const seconds: number = Math.round(stallMs / 1000);
    if (taken === 0) return `CUBE took none of the ${total} bytes of ${filename} for ${seconds} s`;
    if (taken < total) return `CUBE stopped taking ${filename} after ${taken} of ${total} bytes (nothing for ${seconds} s)`;
    return `CUBE took all ${total} bytes of ${filename} and did not answer for ${seconds} s`;
  };
  const clock_reset = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout((): void => {
      const error: Error = new Error(stallWords_build());
      for (const controller of controllers) controller.error(error);
      stopped = true;
      fail(error);
    }, stallMs);
    timer.unref?.();
  };
  const stop = (): void => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const slice_read = async (offset: number): Promise<Uint8Array> => {
    const end: number = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
    const bytes: Uint8Array = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    taken = end;
    clock_reset();
    return bytes;
  };

  /** The upload's file: its bytes read a slice at a time, on demand. */
  class WatchedFile extends File {
    /** The file's bytes as a stream pulled a slice at a time. */
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      let offset: number = 0;
      let held: ReadableStreamDefaultController<Uint8Array> | null = null;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
          held = controller;
          controllers.add(controller);
        },
        pull: async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
          if (offset >= total) {
            if (held !== null) controllers.delete(held);
            controller.close();
            return;
          }
          const bytes: Uint8Array = await slice_read(offset);
          offset += bytes.byteLength;
          controller.enqueue(bytes);
        },
      }, { highWaterMark: 0 });
    }
  }

  clock_reset();
  return { file: new WatchedFile([blob], filename, { type: blob.type }), stalled, stop };
}

/**
 * Passes a stream through unchanged and fails it when it falls silent.
 *
 * The clock starts at once (the wait for the first byte counts) and is
 * reset by every chunk. When it runs out, the source is destroyed and the
 * returned stream errors with a sentence that says how long nothing came
 * and how much had come before.
 *
 * @param source - The stream to watch.
 * @param stallMs - Silence allowed before the stream is failed.
 * @param what - What is being transferred, for the error (`file 30916964`).
 * @returns The watched stream.
 */
export function stream_watchStalls(source: Readable, stallMs: number, what: string): Readable {
  const watched: PassThrough = new PassThrough();
  let received: number = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clock_reset = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout((): void => {
      const seconds: number = Math.round(stallMs / 1000);
      const error: Error = new Error(
        received === 0
          ? `CUBE sent no bytes of ${what} for ${seconds} s`
          : `CUBE stopped sending ${what} after ${received} bytes (nothing for ${seconds} s)`,
      );
      source.destroy(error);
      watched.destroy(error);
    }, stallMs);
    timer.unref?.();
  };
  const clock_stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  clock_reset();
  source.on('data', (chunk: Buffer): void => {
    received += chunk.length;
    clock_reset();
  });
  source.on('end', clock_stop);
  source.on('error', (error: Error): void => {
    clock_stop();
    watched.destroy(error);
  });
  watched.on('close', clock_stop);
  source.pipe(watched);
  return watched;
}
