import { readPsd } from "ag-psd";
import * as THREE from "three";

export function decodeBase64(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Decodes any previewable image into RGBA pixels. Browser formats go through createImageBitmap;
 * PSD, TGA, EXR and HDR use dedicated decoders (loaded on demand, they are rarely needed).
 */
export async function decodeImageBytes(bytes: Uint8Array, format: string, mimeType: string): Promise<ImageData> {
  switch (format) {
    case "psd":
      return decodePsd(bytes);
    case "tga": {
      const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
      // The typings claim a DataTexture; at runtime parse() returns the raw RGBA pixels.
      const image = new TGALoader().parse(toArrayBuffer(bytes)) as unknown as { data: Uint8Array; width: number; height: number };
      return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    }
    case "exr": {
      const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
      const image = new EXRLoader().setDataType(THREE.FloatType).parse(toArrayBuffer(bytes));
      // EXRLoader lays rows out bottom-up for WebGL.
      return toneMapFloatImage(image.data as Float32Array, image.width, image.height, true);
    }
    case "hdr": {
      const { RGBELoader } = await import("three/examples/jsm/loaders/RGBELoader.js");
      const image = new RGBELoader().setDataType(THREE.FloatType).parse(toArrayBuffer(bytes));
      return toneMapFloatImage(image.data as Float32Array, image.width, image.height, false);
    }
    default:
      return decodeBitmap(bytes, mimeType);
  }
}

function decodePsd(bytes: Uint8Array) {
  const psd = readPsd(toArrayBuffer(bytes)) as { imageData?: ImageData; canvas?: HTMLCanvasElement };

  if (psd.imageData) {
    return new ImageData(new Uint8ClampedArray(psd.imageData.data), psd.imageData.width, psd.imageData.height);
  }

  const context = psd.canvas?.getContext("2d");
  if (!psd.canvas || !context) {
    throw new Error("This PSD has no flattened preview. Save it with \"Maximize compatibility\" enabled.");
  }

  return context.getImageData(0, 0, psd.canvas.width, psd.canvas.height);
}

async function decodeBitmap(bytes: Uint8Array, mimeType: string) {
  const blob = new Blob([toArrayBuffer(bytes)], { type: mimeType || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Image preview canvas could not be initialized.");
    }

    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

/** Reinhard tone mapping plus gamma: enough to make linear HDR pixels readable on screen. */
function toneMapFloatImage(data: Float32Array, width: number, height: number, bottomUp: boolean) {
  const channels = Math.max(1, Math.round(data.length / (width * height)));
  const output = new Uint8ClampedArray(width * height * 4);
  const encode = (value: number) => Math.pow(Math.max(value, 0) / (1 + Math.max(value, 0)), 1 / 2.2) * 255;

  for (let y = 0; y < height; y += 1) {
    const sourceRow = bottomUp ? height - 1 - y : y;

    for (let x = 0; x < width; x += 1) {
      const source = (sourceRow * width + x) * channels;
      const target = (y * width + x) * 4;
      const red = data[source];
      output[target] = encode(red);
      output[target + 1] = encode(channels > 1 ? data[source + 1] : red);
      output[target + 2] = encode(channels > 2 ? data[source + 2] : red);
      output[target + 3] = channels > 3 ? Math.min(Math.max(data[source + 3], 0), 1) * 255 : 255;
    }
  }

  return new ImageData(output, width, height);
}

export function imageDataToCanvas(imageData: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d")?.putImageData(imageData, 0, 0);
  return canvas;
}
