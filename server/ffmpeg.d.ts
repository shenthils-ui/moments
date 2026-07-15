// These are optionalDependencies (prebuilt binaries). They may be absent —
// e.g. when their download is blocked — in which case the code falls back to
// a system ffmpeg/ffprobe on PATH. Declared loosely so the build succeeds
// whether or not the packages are installed.
declare module 'ffmpeg-static' {
  const path: string | null;
  export default path;
}
declare module 'ffprobe-static' {
  export const path: string;
}
