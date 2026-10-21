// Standard PDF fonts only cover WinAnsi; replace anything else so encoding never throws.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
export function toWinAnsi(text: string): string {
  return text
    .replace(/\t/g, '    ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•●]/g, '•')
    .replace(/./gu, (ch) => {
      const code = ch.codePointAt(0)!
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch
      return '?'
    })
}
