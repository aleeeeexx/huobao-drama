export function parseCharacterReferenceImages(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && !!item)
  } catch { /* Legacy data may contain a single URL. */ }
  return value.startsWith('/') || /^https?:\/\//i.test(value) ? [value] : []
}

export function snapshotCharacterReferences(imageUrl: string | null, references: string | null): string {
  return JSON.stringify([...new Set([...(imageUrl ? [imageUrl] : []), ...parseCharacterReferenceImages(references)])])
}

export function characterTaskMatchesRevision(params: string | null | undefined, revision: number): boolean {
  try {
    const value = params ? JSON.parse(params)?.characterImageRevision : undefined
    return typeof value === 'number' ? value === revision : revision === 0
  } catch {
    return revision === 0
  }
}
