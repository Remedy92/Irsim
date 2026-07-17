declare module "@cornerstonejs/codec-openjpeg/decode" {
  export interface OpenJpegFrameInfo {
    width: number;
    height: number;
    bitsPerSample: number;
    componentCount: number;
    isSigned: boolean;
  }

  export interface OpenJpegDecoder {
    getEncodedBuffer(length: number): Uint8Array;
    decode(): void;
    getDecodedBuffer(): Uint8ClampedArray;
    getFrameInfo(): OpenJpegFrameInfo;
    getIsReversible(): boolean;
    delete(): void;
  }

  export interface OpenJpegModule {
    J2KDecoder: new () => OpenJpegDecoder;
  }

  export interface OpenJpegFactoryOptions {
    print?: (message: string) => void;
    printErr?: (message: string) => void;
  }

  const createOpenJpegModule: (
    options?: OpenJpegFactoryOptions
  ) => Promise<OpenJpegModule>;

  export default createOpenJpegModule;
}

declare module "@cornerstonejs/codec-openjpeg" {
  import type {
    OpenJpegFactoryOptions,
    OpenJpegFrameInfo,
    OpenJpegModule as DecodeOpenJpegModule
  } from "@cornerstonejs/codec-openjpeg/decode";

  export interface OpenJpegEncoder {
    getDecodedBuffer(frame: OpenJpegFrameInfo): Uint8Array;
    encode(): void;
    getEncodedBuffer(): Uint8Array;
    delete(): void;
  }

  export interface OpenJpegModule extends DecodeOpenJpegModule {
    J2KEncoder: new () => OpenJpegEncoder;
  }

  const createOpenJpegModule: (
    options?: OpenJpegFactoryOptions
  ) => Promise<OpenJpegModule>;

  export default createOpenJpegModule;
}
