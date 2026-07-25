import assert from "node:assert/strict"
import test from "node:test"
import { buildWav, toBase64 } from "../src/recorder"
import { advancePosition, copyPosition, finalSuffix } from "../src/text"

test("buildWav writes a valid 16kHz mono PCM header", () => {
  const pcm = new Uint8Array([0x00, 0x80, 0xff, 0x7f])
  const wav = buildWav([pcm.subarray(0, 2), pcm.subarray(2)])
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (start: number, length: number) => String.fromCharCode(...wav.subarray(start, start + length))

  assert.equal(ascii(0, 4), "RIFF")
  assert.equal(ascii(8, 4), "WAVE")
  assert.equal(ascii(12, 4), "fmt ")
  assert.equal(ascii(36, 4), "data")
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), pcm.length)
  assert.deepEqual(wav.subarray(44), pcm)
})

test("toBase64 matches Node Buffer encoding for large audio", () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"))
})

test("text positions advance across lines without mutating the input", () => {
  const original = { line: 3, ch: 4 }
  assert.deepEqual(copyPosition(original), original)
  assert.notEqual(copyPosition(original), original)
  assert.deepEqual(advancePosition(original, "ab\ncde"), { line: 4, ch: 3 })
  assert.deepEqual(original, { line: 3, ch: 4 })
})

test("finalSuffix preserves the boundary whitespace", () => {
  assert.equal(finalSuffix("hello", "hello world"), " world")
  assert.equal(finalSuffix("", " 完整文本 "), "完整文本")
  assert.equal(finalSuffix("旧文本", "修正文本"), "")
})
