/**
 * Hyperliquid public info API client.
 *
 * Každé číslo z tohto API prichádza ako STRING (px, sz, fee, closedPnl, usdc…).
 * Konverzia je VŽDY cez Number() na mieste použitia — nikdy implicitne cez `+`
 * alebo porovnanie, lebo "0.1" > "0.09" je v JS false. Viď RECON.md §1.
 */

const INFO_URL = 'https://api.hyperliquid.xyz/info'

/** RECON.md §2: stránka userFillsByTime je presne 2000. */
const FILLS_PAGE = 2000
/** RECON.md §3a: stránka userFunding je presne 500. */
const FUNDING_PAGE = 500
/** Poistka proti nekonečnému cyklu; 40 × 2000 = 80k fillov, ďaleko nad realitou. */
const MAX_PAGES = 40

// ── typy presne podľa reálnych odpovedí (RECON.md §1) ───────────────────────

export interface HlFill {
  coin: string
  px: string
  sz: string
  side: string
  time: number
  startPosition: string
  dir: string
  closedPnl: string
  hash: string
  oid: number
  crossed: boolean
  fee: string
  feeToken: string
  tid: number
  twapId: number | null
  /** len na niektorých filloch */
  cloid?: string
  /** len na niektorých filloch — RECON.md §8 */
  builderFee?: string
  /** POZOR: liquidatedUser je PROTISTRANA, nie náš user. RECON.md §1 */
  liquidation?: { liquidatedUser: string; markPx: string; method: string }
}

export interface HlFunding {
  time: number
  hash: string
  delta: {
    type: string
    coin: string
    /** < 0 = ZAPLATENÝ funding, > 0 = PRIJATÝ. RECON.md §3a */
    usdc: string
    szi: string
    fundingRate: string
    nSamples: number | null
  }
}

export interface HlLedgerEntry {
  time: number
  hash: string
  delta: Record<string, unknown> & { type: string }
}

export interface HlState {
  marginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  withdrawable: string
  assetPositions: unknown[]
  time: number
}

export interface FillsResult {
  fills: HlFill[]
  oldestTs: number | null
  newestTs: number | null
  pageCount: number
}

export interface FundingResult {
  funding: HlFunding[]
  pageCount: number
  /** false = nedostránkovali sme až po newestTs; MUSÍ ísť do UI, nie len do logu. */
  fundingComplete: boolean
}

export interface LedgerResult {
  ledger: HlLedgerEntry[]
  pageCount: number
  complete: boolean
}

// ── transport ───────────────────────────────────────────────────────────────

export class HlError extends Error {}

/**
 * Jedno volanie /info s retry a exponenciálnym backoffom.
 *
 * RECON.md §7: 429 sme nedosiahli ani pri ~32 req/s, takže limit NEPOZNÁME.
 * Retry tu preto nie je optimalizácia, ale poistka na neznámy strop a sieťové
 * výpadky. Retryujeme 429 a 5xx; 4xx okrem 429 je chyba tela a retry ju neopraví.
 */
export async function info<T>(
  body: Record<string, unknown>,
  opts: { retries?: number; baseDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const retries = opts.retries ?? 4
  const baseDelay = opts.baseDelayMs ?? 500
  const f = opts.fetchImpl ?? fetch
  let lastErr: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await f(INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 429 || res.status >= 500) {
        throw new HlError(`HTTP ${res.status}`)
      }
      if (!res.ok) {
        // 4xx mimo 429: zlé telo požiadavky. Retry to neopraví — padni hneď.
        throw new HlError(`HTTP ${res.status} (neretryovateľné): ${await res.text()}`)
      }
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('neretryovateľné')) throw err
      if (attempt === retries) break
      await sleep(baseDelay * 2 ** attempt)
    }
  }
  throw new HlError(
    `info(${String(body.type)}) zlyhalo po ${retries + 1} pokusoch: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── fills ───────────────────────────────────────────────────────────────────

/**
 * Celá história fillov cez userFillsByTime.
 *
 * RECON.md §2: ASC, stránky po 2000, `startTime = posledný_time + 1`.
 *
 * DEDUP NESMIE BYŤ IBA PODĽA `tid`.
 * `tid === 0` je SENTINEL, nie identifikátor: na adrese C má 12 fillov tid=0 a
 * všetkých 12 je navzájom ROZDIELNYCH (`dir: "Spot Dust Conversion"`). Dedup
 * podľa holého tid by ich zlial do jedného a ticho zahodil 11 reálnych fillov.
 *
 * Zároveň: skutočné duplikáty tid na hranici strany sú NULA (overené na B aj C).
 * Kľúč je preto kompozitný — pri tid=0 rozlíši rozdielne fily, a prípadné
 * re-doručenie toho istého fillu naprieč stranami (byte-identické) stále zlúči.
 */
/**
 * Kľúč pre dedup fillov. Exportovaný, aby ho testy vedeli overiť priamo.
 * tid != 0 -> tid stačí. tid == 0 -> sentinel, rozlíš podľa obsahu fillu.
 */
export function fillKey(f: HlFill): string {
  if (f.tid !== 0) return `t:${f.tid}`
  return `z:${f.time}:${f.coin}:${f.px}:${f.sz}:${f.dir}:${f.hash}`
}

export async function fetchAllFills(
  address: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<FillsResult> {
  const byKey = new Map<string, HlFill>()
  let startTime = 0
  let pageCount = 0

  while (pageCount < MAX_PAGES) {
    const page = await info<HlFill[]>(
      { type: 'userFillsByTime', user: address, startTime },
      opts,
    )
    pageCount++
    if (!Array.isArray(page) || page.length === 0) break

    for (const fill of page) byKey.set(fillKey(fill), fill)

    const lastTs = Number(page[page.length - 1].time)
    // Stránka kratšia než strop = koniec histórie.
    if (page.length < FILLS_PAGE) break
    // Poistka: ak sa čas neposunie, ďalšia iterácia by vrátila to isté donekonečna.
    if (lastTs + 1 <= startTime) break
    startTime = lastTs + 1
  }

  const fills = [...byKey.values()].sort((a, b) => a.time - b.time)
  return {
    fills,
    oldestTs: fills.length ? fills[0].time : null,
    newestTs: fills.length ? fills[fills.length - 1].time : null,
    pageCount,
  }
}

// ── funding ─────────────────────────────────────────────────────────────────

/**
 * Celý funding cez userFunding, stránky po 500.
 *
 * RECON.md §3a: jedna strana pokryla len zlomok histórie, takže stránkovať sa
 * MUSÍ. Cieľ je dôjsť aspoň po `newestTs` z fillov. Ak sa to nepodarí (strop
 * strán), vrátime fundingComplete=false a to ide až do UI — čiastočný funding
 * vydávaný za úplný by podhodnotil totalCost.
 */
export async function fetchAllFunding(
  address: string,
  newestTs: number | null,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<FundingResult> {
  const byKey = new Map<string, HlFunding>()
  let startTime = 0
  let pageCount = 0
  let reachedEnd = false

  while (pageCount < MAX_PAGES) {
    const page = await info<HlFunding[]>(
      { type: 'userFunding', user: address, startTime },
      opts,
    )
    pageCount++
    if (!Array.isArray(page) || page.length === 0) {
      reachedEnd = true
      break
    }

    // userFunding nemá tid; kľúč = time+coin+usdc je stabilný a dostatočný.
    for (const f of page) byKey.set(`${f.time}:${f.delta.coin}:${f.delta.usdc}`, f)

    const lastTs = Number(page[page.length - 1].time)
    if (page.length < FUNDING_PAGE) {
      reachedEnd = true
      break
    }
    if (newestTs !== null && lastTs >= newestTs) {
      reachedEnd = true
      break
    }
    if (lastTs + 1 <= startTime) break
    startTime = lastTs + 1
  }

  const funding = [...byKey.values()].sort((a, b) => a.time - b.time)
  return { funding, pageCount, fundingComplete: reachedEnd }
}

// ── ledger ──────────────────────────────────────────────────────────────────

/**
 * userNonFundingLedgerUpdates — plné stránkovanie.
 *
 * RECON.md §3b: `nonUserFundingUpdates` NEEXISTUJE (HTTP 422). Toto je jediný
 * zdroj vlastných likvidácií a vkladov/výberov.
 */
export async function fetchLedger(
  address: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<LedgerResult> {
  const byKey = new Map<string, HlLedgerEntry>()
  let startTime = 0
  let pageCount = 0
  let complete = false

  while (pageCount < MAX_PAGES) {
    const page = await info<HlLedgerEntry[]>(
      { type: 'userNonFundingLedgerUpdates', user: address, startTime },
      opts,
    )
    pageCount++
    if (!Array.isArray(page) || page.length === 0) {
      complete = true
      break
    }

    for (const e of page) byKey.set(`${e.time}:${e.hash}:${e.delta.type}`, e)

    const lastTs = Number(page[page.length - 1].time)
    if (page.length < FUNDING_PAGE) {
      complete = true
      break
    }
    if (lastTs + 1 <= startTime) break
    startTime = lastTs + 1
  }

  const ledger = [...byKey.values()].sort((a, b) => a.time - b.time)
  return { ledger, pageCount, complete }
}

// ── state ───────────────────────────────────────────────────────────────────

export async function fetchState(
  address: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<HlState> {
  return info<HlState>({ type: 'clearinghouseState', user: address }, opts)
}

// ── raw bundle pre computeBill ──────────────────────────────────────────────

export interface RawAccount {
  address: string
  fills: FillsResult
  funding: FundingResult
  ledger: LedgerResult
  state: HlState
}

export async function fetchAccount(
  address: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<RawAccount> {
  const fills = await fetchAllFills(address, opts)
  const [funding, ledger, state] = await Promise.all([
    fetchAllFunding(address, fills.newestTs, opts),
    fetchLedger(address, opts),
    fetchState(address, opts),
  ])
  return { address, fills, funding, ledger, state }
}
