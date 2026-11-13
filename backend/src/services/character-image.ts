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

export function snapshotGlobalCharacterImage(character: {
  name: string
  role?: string | null
  defaultPersonality?: string | null
  appearance: string | null
  physique: string | null
  defaultStyling: string | null
  imageUrl: string | null
  referenceImages: string | null
}) {
  return {
    name: character.name,
    role: character.role ?? null,
    defaultPersonality: character.defaultPersonality ?? null,
    appearance: character.appearance,
    physique: character.physique,
    defaultStyling: character.defaultStyling,
    imageUrl: character.imageUrl,
    referenceImages: character.referenceImages,
  }
}

export function characterTaskMatchesRevision(params: string | null | undefined, revision: number): boolean {
  try {
    const value = params ? JSON.parse(params)?.characterImageRevision : undefined
    return typeof value === 'number' ? value === revision : revision === 0
  } catch {
    return revision === 0
  }
}
