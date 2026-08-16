/**
 * Jediná normalizácia adresy pre celú appku.
 *
 * Žije v lib/, nie v page.tsx: Next.js v page súbore povoľuje len default export
 * a svoje vlastné polia (metadata, dynamic, …) — akýkoľvek iný pomenovaný export
 * zhodí `next build` na typovej kontrole. Turbopack ju preskakuje, takže
 * `next build --turbopack` prejde a produkčný build padne.
 *
 * Prijíma s 0x aj bez, orezáva, dáva na malé písmená a vyžaduje 40 hex znakov.
 */
export function normalizeAddress(raw: string): string | null {
  let s: string
  try {
    s = decodeURIComponent(raw)
  } catch {
    s = raw
  }
  s = s.trim().toLowerCase().replace(/^0x/, '')
  return /^[0-9a-f]{40}$/.test(s) ? `0x${s}` : null
}
