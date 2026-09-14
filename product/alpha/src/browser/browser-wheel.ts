/** CDP expects CSS pixels. DOM wheel units can be pixels, lines or pages. */
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode: number }, lineHeight: number, pageHeight: number, pageWidth = pageHeight) {
  const scale = event.deltaMode === 1 ? lineHeight : 1;
  return { deltaX: event.deltaX * (event.deltaMode === 2 ? pageWidth : scale), deltaY: event.deltaY * (event.deltaMode === 2 ? pageHeight : scale) };
}
