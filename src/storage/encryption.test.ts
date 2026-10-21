import { randomBytes } from "node:crypto";
import { buffer as collect } from "node:stream/consumers";
import { expect, it } from "vitest";
import {
  decryptStorageObject,
  encryptedStorageSize,
  encryptStorageObject,
  plaintextStorageSize,
} from "./encryption.js";

const SEGMENT_BYTES = 1_048_576;
const decrypt = (body: Uint8Array, key: Buffer) => collect(decryptStorageObject(chunks(body), key));

async function* chunks(bytes: Uint8Array) {
  // Transport chunk boundaries do not coincide with encryption framing.
  for (let offset = 0; offset < bytes.length; offset += 7919) {
    yield bytes.subarray(offset, offset + 7919);
  }
}

it.each([0, SEGMENT_BYTES, 3 * SEGMENT_BYTES + 17])(
  "OCSTOR1 round trips %i bytes with exact size",
  async (size) => {
    const key = randomBytes(32);
    const plaintext = Buffer.alloc(size, 0x67);
    const ciphertext = await collect(encryptStorageObject(chunks(plaintext), key));
    expect(ciphertext.length).toBe(encryptedStorageSize(size));
    expect(plaintextStorageSize(ciphertext.length)).toBe(size);
    expect(await decrypt(ciphertext, key)).toEqual(plaintext);
  },
);

it("rejects impossible stored sizes", () => {
  const emptySize = encryptedStorageSize(0);
  const fullSegmentSize = encryptedStorageSize(SEGMENT_BYTES);
  const invalidNumbers = [-1, 0, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const size of [
    ...invalidNumbers,
    emptySize + 0.5,
    emptySize - 1,
    fullSegmentSize - 16,
    fullSegmentSize - 1,
    (SEGMENT_BYTES + 16) * 0x100000000 + emptySize,
  ]) {
    expect(() => plaintextStorageSize(size)).toThrow();
  }
});

it("rejects corrupted ciphertext and wrong keys", async () => {
  const key = randomBytes(32);
  const body = chunks(Buffer.alloc(2 * SEGMENT_BYTES));
  const ciphertext = await collect(encryptStorageObject(body, key));
  const headerEnd = 12 + ciphertext.readUInt32BE(8);
  const segmentBytes = SEGMENT_BYTES + 16;
  const reordered = Buffer.concat([
    ciphertext.subarray(0, headerEnd),
    ciphertext.subarray(headerEnd + segmentBytes, headerEnd + 2 * segmentBytes),
    ciphertext.subarray(headerEnd, headerEnd + segmentBytes),
    ciphertext.subarray(headerEnd + 2 * segmentBytes),
  ]);
  const changedHeader = Buffer.from(ciphertext);
  const saltOffset = changedHeader.indexOf('"objSalt":"') + '"objSalt":"'.length;
  changedHeader[saltOffset] = changedHeader[saltOffset] === 65 ? 66 : 65;
  for (const corrupt of [
    ciphertext.subarray(0, -16),
    reordered,
    changedHeader,
    Buffer.concat([ciphertext, Buffer.from([1])]),
  ]) {
    await expect(decrypt(corrupt, key)).rejects.toThrow();
  }
  await expect(decrypt(ciphertext, randomBytes(32))).rejects.toThrow();
});

it("bounds each ciphertext yield and closes the source on early cancellation", async () => {
  let closed = false;
  async function* source() {
    try {
      yield Buffer.alloc(4 * SEGMENT_BYTES);
    } finally {
      closed = true;
    }
  }
  let yields = 0;
  for await (const chunk of encryptStorageObject(source(), randomBytes(32))) {
    expect(chunk.byteLength).toBeLessThanOrEqual(SEGMENT_BYTES + 16);
    if (++yields === 2) {
      break;
    }
  }
  expect(closed).toBe(true);
});
