/**
 * Loose, numeric-aware version comparison good enough for Minecraft / loader versions
 * ("1.7.10_pre4" < "1.7.10" < "1.20" < "1.20.1", "20.4.80-beta" < "20.4.80").
 */
const PRE_RELEASE = /^(pre|rc|alpha|beta|snapshot|a|b)/i

function segments(v: string): string[] {
  return v.split(/[._\-+ ]/).filter(Boolean)
}

function isNum(s: string): boolean {
  return /^\d+$/.test(s)
}

export function compareVersions(a: string, b: string): number {
  const sa = segments(a)
  const sb = segments(b)
  const n = Math.max(sa.length, sb.length)
  for (let i = 0; i < n; i++) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined || y === undefined) {
      // One version is a prefix of the other: a trailing pre-release tag sorts before the release.
      const rest = (x ?? y) as string
      const longerIsA = x !== undefined
      const longerIsSmaller = !isNum(rest) && PRE_RELEASE.test(rest)
      return longerIsA === longerIsSmaller ? -1 : 1
    }
    if (x === y) continue
    const nx = isNum(x)
    const ny = isNum(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (nx !== ny) {
      // numbers sort after pre-release tags, before other words
      const word = nx ? y : x
      const numberWins = PRE_RELEASE.test(word)
      return nx === numberWins ? 1 : -1
    }
    // both words: split leading letters / trailing digits (pre4 vs pre10)
    const mx = /^([a-z]*)(\d*)$/i.exec(x)
    const my = /^([a-z]*)(\d*)$/i.exec(y)
    if (mx && my && mx[1] === my[1] && mx[2] && my[2]) {
      const d = Number(mx[2]) - Number(my[2])
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    return x < y ? -1 : 1
  }
  return 0
}
