/**
 * Redis cache nad @upstash/redis.
 *
 * PRAVIDLO: cache NIKDY nezhodí appku. Každá cesta sem je best-effort — chýbajúce
 * env, nedostupný Redis, poškodený payload, timeout → vrátime null / ticho
 * neuložíme, a volajúci počíta naživo. Cache je zrýchlenie, nie zdroj pravdy.
 */

import { Redis } from '@upstash/redis'
import type { Bill } from './bill'

/**
 * v1 MUSÍ sedieť s verziou v ceste OG route (/api/og/v1/[address]).
 * Pri KAŽDEJ zmene výpočtu alebo tvaru Billu bumpni OBOJE naraz — inak by sa
 * na novú kartu servíroval starý bill z cache.
 */
const KEY_VERSION = 'v1'

/** MUSÍ sedieť s s-maxage v OG route (86400). */
export const BILL_TTL_SECONDS = 86_400

export const billKey = (address: string): string =>
  `bill:${KEY_VERSION}:${address.toLowerCase()}`

let client: Redis | null | undefined

/** null = Redis nie je nakonfigurovaný. Nikdy nehádže. */
function getClient(): Redis | null {
  if (client !== undefined) return client
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    client = null
    return null
  }
  try {
    client = new Redis({ url, token })
  } catch {
    client = null
  }
  return client
}

export async function getBill(address: string): Promise<Bill | null> {
  const redis = getClient()
  if (!redis) return null
  try {
    const raw = await redis.get<Bill>(billKey(address))
    if (!raw || typeof raw !== 'object') return null
    // Minimálna kontrola tvaru: starý/poškodený payload sa zahodí radšej, než by
    // sa z neho vykreslila karta s chýbajúcimi poľami.
    if (typeof (raw as Bill).totalCost !== 'number') return null
    return raw as Bill
  } catch {
    return null
  }
}

export async function setBill(address: string, bill: Bill): Promise<void> {
  const redis = getClient()
  if (!redis) return
  try {
    await redis.set(billKey(address), bill, { ex: BILL_TTL_SECONDS })
  } catch {
    // ticho — neuložený bill znamená len ďalší live prepočet, nie chybu
  }
}
