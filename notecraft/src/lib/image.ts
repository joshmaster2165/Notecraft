// Picture edits that change the pixels (OneNote's Rotate Left / Rotate Right).

/** Rotate a picture a quarter turn; `dir` 1 is clockwise. Keeps JPEGs as JPEG. */
export async function rotateDataUrl(src: string, dir: 1 | -1): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalHeight;
  canvas.height = img.naturalWidth;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const jpeg = /^data:image\/jpe?g/i.test(src);
  return canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92);
}
