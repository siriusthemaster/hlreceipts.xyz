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

/** Čerstvý bill — expiruje, riadi to, kedy sa prepočítava. */
export const billKey = (address: string): string =>
  `bill:${KEY_VERSION}:${address.toLowerCase()}`

/**
 * POSLEDNÝ ZNÁMY bill — BEZ expirácie.
 *
 * Dôvod: bill:v1:{addr} expiruje po 24 h. Bez tohto kľúča by sa zdieľaný odkaz
 * starší než deň zdegradoval na pozvánku a vyzeral by ako rozbitý produkt.
 * Karta pre adresu, ktorá už raz bola vypočítaná, sa na pozvánku nesmie
 * vrátiť NIKDY — nanajvýš ukáže staršie číslo.
 */
export const lastBillKey = (address: string): string =>
  `bill:${KEY_VERSION}:${address.toLowerCase()}:last`

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

async function read(key: string): Promise<Bill | null> {
  const redis = getClient()
  if (!redis) return null
  try {
    const raw = await redis.get<Bill>(key)
    if (!raw || typeof raw !== 'object') return null
    // Minimálna kontrola tvaru: starý/poškodený payload sa zahodí radšej, než by
    // sa z neho vykreslila karta s chýbajúcimi poľami.
    if (typeof (raw as Bill).totalCost !== 'number') return null
    return raw as Bill
  } catch {
    return null
  }
}

/** Čerstvý bill (do 24 h). Miss = treba prepočítať. */
export async function getBill(address: string): Promise<Bill | null> {
  return read(billKey(address))
}

/** Posledný známy bill, bez ohľadu na vek. Fallback pre kartu, nikdy nie pre výpočet. */
export async function getLastBill(address: string): Promise<Bill | null> {
  return read(lastBillKey(address))
}

/**
 * Zapíše OBA kľúče. `:last` sa píše bez TTL, takže raz vypočítaná adresa
 * má navždy čo ukázať.
 */
export async function setBill(address: string, bill: Bill): Promise<void> {
  const redis = getClient()
  if (!redis) return
  try {
    await Promise.all([
      redis.set(billKey(address), bill, { ex: BILL_TTL_SECONDS }),
      redis.set(lastBillKey(address), bill),
    ])
  } catch {
    // ticho — neuložený bill znamená len ďalší live prepočet, nie chybu
  }
}
