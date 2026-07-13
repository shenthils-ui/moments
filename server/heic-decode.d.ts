declare module 'heic-decode' {
  interface DecodeResult {
    width: number;
    height: number;
    data: ArrayBufferView & { buffer: ArrayBuffer };
  }
  function decode(opts: { buffer: Uint8Array }): Promise<DecodeResult>;
  export default decode;
}
