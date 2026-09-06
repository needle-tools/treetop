export interface SearchPointerPosition {
  x: number;
  y: number;
}

export function shouldAdoptPointerSearchSelection(
  previous: SearchPointerPosition | null,
  next: SearchPointerPosition,
): boolean {
  return previous === null || previous.x !== next.x || previous.y !== next.y;
}
