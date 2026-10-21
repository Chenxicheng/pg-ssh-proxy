export function sanitizeTerminal(value: string, limit = 200): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('')
    .slice(0, limit);
}
