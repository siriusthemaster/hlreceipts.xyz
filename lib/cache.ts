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

// ── ochrana pred thundering herd ────────────────────────────────────────────
//
// Scenár: niekto tweetne whale adresu, 500 ľudí klikne naraz. Bez zámku by sa
// spustilo 500 súbežných výpočtov TEJ ISTEJ adresy, každý po ~200 strán —
// desaťtisíce HTTP volaní na Hyperliquid za sekundy.
//
// Dve nezávislé poistky:
//   1. per-adresa zámok  — jednu adresu počíta naraz práve jeden request
//   2. globálny strop    — celá appka počíta naraz najviac MAX_CONCURRENT adries
// Request sa NIKDY neblokuje čakaním; keď neprejde, vráti "still counting".

const LOCK_TTL_SECONDS = 180
const CONCURRENCY_KEY = 'compute:concurrent'
export const MAX_CONCURRENT = 5

const lockKey = (address: string): string => `lock:${address.toLowerCase()}`

/** true = zámok získaný, si zodpovedný za releaseLock v finally. */
export async function acquireLock(address: string): Promise<boolean> {
  const redis = getClient()
  if (!redis) return true // bez Redisu nie je čo koordinovať — počítaj
  try {
    const res = await redis.set(lockKey(address), '1', {
      nx: true,
      ex: LOCK_TTL_SECONDS,
    })
    return res === 'OK'
  } catch {
    return true // cache nesmie zablokovať produkt
  }
}

export async function releaseLock(address: string): Promise<void> {
  const redis = getClient()
  if (!redis) return
  try {
    await redis.del(lockKey(address))
  } catch {
    // TTL 180 s ho aj tak uvoľní
  }
}

/** true = slot v globálnom strope získaný. Vždy páruj s releaseSlot v finally. */
export async function acquireSlot(): Promise<boolean> {
  const redis = getClient()
  if (!redis) return true
  try {
    const n = await redis.incr(CONCURRENCY_KEY)
    // Poistka proti zaseknutému počítadlu, keby proces zomrel pred DECR.
    if (n === 1) await redis.expire(CONCURRENCY_KEY, LOCK_TTL_SECONDS)
    if (n > MAX_CONCURRENT) {
      await redis.decr(CONCURRENCY_KEY)
      return false
    }
    return true
  } catch {
    return true
  }
}

export async function releaseSlot(): Promise<void> {
  const redis = getClient()
  if (!redis) return
  try {
    const n = await redis.decr(CONCURRENCY_KEY)
    if (n < 0) await redis.set(CONCURRENCY_KEY, 0)
  } catch {
    // expire ho vyčistí
  }
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
