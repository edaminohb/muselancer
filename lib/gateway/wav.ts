/** Mono 16-bit PCM WAV at 16 kHz, the recording shape Muse Voice Transcribe accepts. */

const TARGET_RATE = 16_000;

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const ratio = sampleRate / TARGET_RATE;
  const length = Math.max(1, Math.floor(samples.length / Math.max(ratio, 0.0001)));
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.min(samples.length - 1, Math.floor(index * ratio));
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += samples[cursor] ?? 0;
    const average = Math.max(-1, Math.min(1, sum / (end - start)));
    pcm[index] = average < 0 ? average * 0x8000 : average * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(offset, pcm[index] ?? 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}
