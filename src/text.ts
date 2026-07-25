export type TextPosition = {
  line: number
  ch: number
}

export function copyPosition(position: TextPosition): TextPosition {
  return { line: position.line, ch: position.ch }
}

export function advancePosition(position: TextPosition, text: string): TextPosition {
  const lines = text.split("\n")
  if (lines.length === 1) return { line: position.line, ch: position.ch + text.length }
  return {
    line: position.line + lines.length - 1,
    ch: lines[lines.length - 1].length,
  }
}

export function finalSuffix(stableText: string, finalText: string): string {
  const stable = stableText.trim()
  const final = finalText.trim()
  if (!final) return ""
  if (!stable) return final
  return final.startsWith(stable) ? final.slice(stable.length) : ""
}
