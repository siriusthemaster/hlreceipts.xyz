/**
 * computeBill — „koľko ťa Hyperliquid stál“.
 *
 * Každé pravidlo tu má číslo nálezu z RECON.md. Ak meníš pravidlo, prečítaj
 * najprv ten nález; všetky boli overené na reálnych dátach, nie z dokumentácie.
 *
 * NULL vs 0: 0 znamená „vieme, že je to nula“ (súčet cez prázdnu množinu).
 * null znamená „nevieme“ a UI to MUSÍ ukázať ako "n/a". Nikdy nepodsúvaj 0
 * namiesto neznáma — z nuly si čitateľ odvodí tvrdenie, ktoré nemáme podložené.
 */

import type { HlFill, RawAccount } from './hl'

/** Podiel pod týmto prahom sa zlúči do "other". */
const OTHER_SHARE_THRESHOLD = 0.01
/** Pod touto equity je pomer cost/equity nezmyselne veľký -> radšej null. */
const MIN_EQUITY_FOR_RATIO = 100

export interface BuilderRateBucket {
  /** bp sadzba zaokrúhlená na 1 desatinné; null = zlúčený zvyšok "other". */
  bp: number | null
  volume: number
  /** 0..1 podiel na objeme s builder fee */
  share: number
  fillCount: number
}

export interface TradeRef {
  coin: string
  time: number
  value: number
}

export interface Bill {
  address: string

  // ── peniaze (RECON.md D1 + D2: fee OBSAHUJE builderFee; iba USDC) ────────
  /** Σ (fee − builderFee) — vzal Hyperliquid. */
  hlFees: number
  /** Σ builderFee — vzali appky. */
  appFees: number
  fundingPaid: number
  fundingReceived: number
  /** hlFees + appFees + max(0, fundingPaid − fundingReceived) */
  totalCost: number

  // ── builder ladder (RECON.md: adresa buildera vo fille NIE JE) ───────────
  builderRates: BuilderRateBucket[]

  // ── mena (RECON.md D2) ──────────────────────────────────────────────────
  /** Fily, ktoré NIE SÚ v žiadnom peňažnom súčte, lebo feeToken !== USDC. */
  excludedFillCount: number
  excludedTokens: string[]

  // ── likvidácie (RECON.md D3) ────────────────────────────────────────────
  liquidationCount: number

  // ── menovateľ (RECON.md D6) ─────────────────────────────────────────────
  currentEquity: number | null
  /** null keď equity < 100 alebo ju nevieme; vtedy použi costVsVolumeBp. */
  costVsEquity: number | null
  costVsVolumeBp: number | null

  // ── ostatné ─────────────────────────────────────────────────────────────
  volumeTraded: number
  realizedPnl: number
  worstTrade: TradeRef | null
  biggestFill: TradeRef | null
  mostExpensiveCoin: { coin: string; fees: number } | null
  mostExpensiveHourUTC: { hour: number; fees: number } | null
  windowStart: number | null
  windowEnd: number | null
  fillCount: number
  pageCount: number

  // ── čestnosť ────────────────────────────────────────────────────────────
  /** false = funding je len čiastočný, totalCost je PODHODNOTENÝ. Do UI! */
  fundingComplete: boolean
  ledgerComplete: boolean
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const notional = (f: HlFill): number => n(f.px) * n(f.sz)

export function computeBill(raw: RawAccount): Bill {
  const all = raw.fills.fills

  // RECON.md D2 — do peňazí IBA USDC. Ostatné sa NEZAHADZUJÚ ticho, ale sa
  // spočítajú a vyexportujú, aby ich UI mohlo priznať.
  const usdc = all.filter((f) => f.feeToken === 'USDC')
  const excluded = all.filter((f) => f.feeToken !== 'USDC')
  const excludedTokens = [...new Set(excluded.map((f) => f.feeToken))].sort()

  // RECON.md D1 — fee UŽ OBSAHUJE builderFee. Nikdy fee + builderFee.
  let hlFees = 0
  let appFees = 0
  let volumeTraded = 0
  let realizedPnl = 0
  for (const f of usdc) {
    const bf = f.builderFee === undefined ? 0 : n(f.builderFee)
    hlFees += n(f.fee) - bf
    appFees += bf
    volumeTraded += notional(f)
    realizedPnl += n(f.closedPnl)
  }

  // ── builder rate ladder ────────────────────────────────────────────────
  // Adresa buildera vo fille NIE JE (overené: 17 polí, žiadna atribúcia), a
  // maxBuilderFee vracia SCHVÁLENIE, nie priradenie konkrétneho fillu. Appky
  // preto nikdy nepomenúvame — zoskupujeme výhradne podľa sadzby.
  const rateGroups = new Map<number, { volume: number; fillCount: number }>()
  let builderVolume = 0
  for (const f of usdc) {
    if (f.builderFee === undefined) continue
    const nt = notional(f)
    if (nt <= 0) continue
    const bp = Math.round((n(f.builderFee) / nt) * 10000 * 10) / 10
    const g = rateGroups.get(bp) ?? { volume: 0, fillCount: 0 }
    g.volume += nt
    g.fillCount++
    rateGroups.set(bp, g)
    builderVolume += nt
  }

  const builderRates: BuilderRateBucket[] = []
  let otherVolume = 0
  let otherFills = 0
  for (const [bp, g] of rateGroups) {
    const share = builderVolume > 0 ? g.volume / builderVolume : 0
    if (share < OTHER_SHARE_THRESHOLD) {
      otherVolume += g.volume
      otherFills += g.fillCount
    } else {
      builderRates.push({ bp, volume: g.volume, share, fillCount: g.fillCount })
    }
  }
  builderRates.sort((a, b) => b.volume - a.volume)
  if (otherFills > 0) {
    builderRates.push({
      bp: null,
      volume: otherVolume,
      share: builderVolume > 0 ? otherVolume / builderVolume : 0,
      fillCount: otherFills,
    })
  }

  // ── funding (RECON.md D4) ──────────────────────────────────────────────
  let fundingPaid = 0
  let fundingReceived = 0
  for (const f of raw.funding.funding) {
    const v = n(f.delta.usdc)
    if (v < 0) fundingPaid += Math.abs(v)
    else if (v > 0) fundingReceived += v
  }

  // ── likvidácie (RECON.md D3) ───────────────────────────────────────────
  // IBA z ledgeru. fill.liquidation.liquidatedUser je PROTISTRANA — použiť ho
  // na detekciu vlastnej likvidácie by nahlásilo cudzie likvidácie ako naše.
  const liquidationCount = raw.ledger.ledger.filter(
    (e) => e.delta.type === 'liquidation',
  ).length

  const totalCost = hlFees + appFees + Math.max(0, fundingPaid - fundingReceived)

  // ── menovateľ (RECON.md D6) ────────────────────────────────────────────
  // portfolio.allTime má 80 bodov na 535 dní, takže peak equity ani all-time
  // high sa tvrdiť NEDÁ. Používame len AKTUÁLNU equity, a aj tú len keď je
  // dosť veľká na to, aby pomer niečo znamenal.
  const equityRaw = Number(raw.state?.marginSummary?.accountValue)
  const currentEquity = Number.isFinite(equityRaw) ? equityRaw : null
  const costVsEquity =
    currentEquity !== null && currentEquity >= MIN_EQUITY_FOR_RATIO
      ? totalCost / currentEquity
      : null
  const costVsVolumeBp =
    volumeTraded > 0 ? (totalCost / volumeTraded) * 10000 : null

  // ── superlatívy: null keď nie je z čoho vybrať ──────────────────────────
  let worstTrade: TradeRef | null = null
  let biggestFill: TradeRef | null = null
  const byCoin = new Map<string, number>()
  const byHour = new Map<number, number>()
  for (const f of usdc) {
    const pnl = n(f.closedPnl)
    if (worstTrade === null || pnl < worstTrade.value) {
      worstTrade = { coin: f.coin, time: f.time, value: pnl }
    }
    const nt = notional(f)
    if (biggestFill === null || nt > biggestFill.value) {
      biggestFill = { coin: f.coin, time: f.time, value: nt }
    }
    byCoin.set(f.coin, (byCoin.get(f.coin) ?? 0) + n(f.fee))
    const hour = new Date(f.time).getUTCHours()
    byHour.set(hour, (byHour.get(hour) ?? 0) + n(f.fee))
  }

  const topCoin = [...byCoin.entries()].sort((a, b) => b[1] - a[1])[0]
  const topHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]

  return {
    address: raw.address,
    hlFees,
    appFees,
    fundingPaid,
    fundingReceived,
    totalCost,
    builderRates,
    excludedFillCount: excluded.length,
    excludedTokens,
    liquidationCount,
    currentEquity,
    costVsEquity,
    costVsVolumeBp,
    volumeTraded,
    realizedPnl,
    worstTrade,
    biggestFill,
    mostExpensiveCoin: topCoin ? { coin: topCoin[0], fees: topCoin[1] } : null,
    mostExpensiveHourUTC: topHour ? { hour: topHour[0], fees: topHour[1] } : null,
    windowStart: raw.fills.oldestTs,
    windowEnd: raw.fills.newestTs,
    fillCount: all.length,
    pageCount: raw.fills.pageCount,
    fundingComplete: raw.funding.fundingComplete,
    ledgerComplete: raw.ledger.complete,
  }
}
