export function newId(prefix = ""): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return prefix + rand[0]!.toString(36) + rand[1]!.toString(36);
}

export const nowIso = () => new Date().toISOString();
