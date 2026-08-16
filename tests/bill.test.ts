import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillKey, type HlFill, type RawAccount } from '../lib/hl'
import { computeBill } from '../lib/bill'

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

const A_FILLS: HlFill[] = fx('A_fills.json')
const A_STATE = fx('A_state.json')
const C_MIXED = fx('C_mixed_tokens.json')
const C_ZERO = fx('C_zero_tid.json')
const C_LEDGER = fx('C_ledger.json')

/** Zabalí fily do RawAccount, aby sa dal volať computeBill bez siete. */
function raw(fills: HlFill[], over: Partial<RawAccount> = {}): RawAccount {
  const sorted = [...fills].sort((a, b) => a.time - b.time)
  return {
    address: '0xtest',
    fills: {
      fills: sorted,
      oldestTs: sorted.length ? sorted[0].time : null,
      newestTs: sorted.length ? sorted[sorted.length - 1].time : null,
      pageCount: 1,
      hitPageCap: false,
      fetchClean: true,
      retries: 0,
    },
    funding: { funding: [], pageCount: 1, fundingComplete: true, fetchClean: true, retries: 0 },
    ledger: { ledger: [], pageCount: 1, complete: true, fetchClean: true, retries: 0 },
    state: { marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, withdrawable: '0', assetPositions: [], time: 0 },
    ...over,
  }
}

describe('dedup fillov', () => {
  // POZOR na premisu: pôvodné zadanie predpokladalo ~3 duplicitné tid na hranici
  // strany. Reálne meranie na B aj C ukázalo NULA takých duplikátov — a namiesto
  // toho `tid === 0` ako SENTINEL na 12 navzájom rozdielnych filloch adresy C.
  // Dedup podľa holého tid ich zlial do 1 a zahodil 11 reálnych fillov.
  it('tid=0 sú navzájom rozdielne fily a NESMÚ sa zliať', () => {
    const zero: HlFill[] = C_ZERO.zeroTidFills
    expect(zero.length).toBe(12)
    expect(new Set(zero.map((f) => f.tid))).toEqual(new Set([0]))

    const naive = new Set(zero.map((f) => f.tid))
    expect(naive.size).toBe(1) // takto by sa 12 fillov scvrklo na 1

    const correct = new Set(zero.map(fillKey))
    expect(correct.size).toBe(12) // kompozitný kľúč ich zachová
  })

  it('byte-identický fill doručený dvakrát sa zlúči', () => {
    const f = A_FILLS[0]
    const keys = new Set([fillKey(f), fillKey({ ...f })])
    expect(keys.size).toBe(1)
  })
})

describe('mena — iba USDC do peňazí (RECON D2)', () => {
  const mixed: HlFill[] = [...C_MIXED.nonUsdc, ...C_MIXED.usdc]

  it('non-USDC fily nie sú v hlFees ani appFees, ale sú spočítané', () => {
    const bill = computeBill(raw(mixed))
    const usdcOnly = C_MIXED.usdc as HlFill[]
    const expected = usdcOnly.reduce(
      (s, f) => s + Number(f.fee) - Number(f.builderFee ?? 0),
      0,
    )
    expect(bill.hlFees).toBeCloseTo(expected, 9)
    expect(bill.excludedFillCount).toBe(C_MIXED.nonUsdc.length)
    expect(bill.excludedTokens.length).toBeGreaterThan(0)
    expect(bill.excludedTokens).not.toContain('USDC')
  })

  it('non-USDC sa nikdy nezahodí ticho', () => {
    const bill = computeBill(raw(mixed))
    // fillCount je počet VŠETKÝCH fillov vrátane vylúčených — vylúčenie sa deje
    // len v peňažných súčtoch, nikdy zahodením záznamu.
    expect(bill.fillCount).toBe(mixed.length)
    expect(bill.excludedFillCount).toBe(C_MIXED.nonUsdc.length)
    expect(bill.excludedFillCount).toBeGreaterThan(0)
    expect(bill.excludedFillCount).toBeLessThan(bill.fillCount)
  })
})

describe('builder rate ladder', () => {
  it('adresa A: jediná sadzba 2.5 bp a Σ share == 100 %', () => {
    const bill = computeBill(raw(A_FILLS))
    expect(bill.builderRates.length).toBe(1)
    expect(bill.builderRates[0].bp).toBe(2.5)
    expect(bill.builderRates[0].fillCount).toBe(12)
    const sum = bill.builderRates.reduce((s, b) => s + b.share, 0)
    expect(sum).toBeCloseTo(1, 12)
  })

  it('appky sa nikdy nepomenúvajú — bucket nesie iba sadzbu', () => {
    const bill = computeBill(raw(A_FILLS))
    for (const b of bill.builderRates) {
      expect(Object.keys(b).sort()).toEqual(['bp', 'fillCount', 'share', 'volume'])
    }
  })
})

describe('prázdna adresa', () => {
  it('nespadne a vráti nuly s korektnými flagmi', () => {
    const bill = computeBill(raw([]))
    expect(bill.fillCount).toBe(0)
    expect(bill.hlFees).toBe(0)
    expect(bill.appFees).toBe(0)
    expect(bill.totalCost).toBe(0)
    expect(bill.builderRates).toEqual([])
    expect(bill.excludedFillCount).toBe(0)
    // neznáme != 0 — musí byť null
    expect(bill.worstTrade).toBeNull()
    expect(bill.biggestFill).toBeNull()
    expect(bill.mostExpensiveCoin).toBeNull()
    expect(bill.mostExpensiveHourUTC).toBeNull()
    expect(bill.windowStart).toBeNull()
    expect(bill.windowEnd).toBeNull()
    expect(bill.costVsVolumeBp).toBeNull()
  })
})

describe('pozitívna kontrola — adresa A', () => {
  it('Σ fee == 4.751401 a hlFees + appFees to presne dá', () => {
    const sumFee = A_FILLS.reduce((s, f) => s + Number(f.fee), 0)
    expect(sumFee).toBeCloseTo(4.751401, 6)

    const bill = computeBill(raw(A_FILLS))
    expect(bill.hlFees + bill.appFees).toBeCloseTo(4.751401, 6)
    expect(bill.appFees).toBeCloseTo(0.562528, 6)
  })

  it('fee OBSAHUJE builderFee — nikdy sa nesčítavajú (RECON D1)', () => {
    const bill = computeBill(raw(A_FILLS))
    const naiveWrong = A_FILLS.reduce(
      (s, f) => s + Number(f.fee) + Number(f.builderFee ?? 0),
      0,
    )
    // Chybný výpočet by nafúkol sumu o appFees. Strážime, že to nerobíme.
    expect(naiveWrong).toBeCloseTo(4.751401 + 0.562528, 6)
    expect(bill.totalCost).toBeCloseTo(4.751401, 6)
    expect(bill.totalCost).toBeLessThan(naiveWrong)
  })

  it('okno sedí na 7.–12. júl 2026', () => {
    const bill = computeBill(raw(A_FILLS))
    expect(new Date(bill.windowStart!).toISOString().slice(0, 10)).toBe('2026-07-07')
    expect(new Date(bill.windowEnd!).toISOString().slice(0, 10)).toBe('2026-07-12')
  })
})

describe('likvidácie — iba z ledgeru (RECON D3)', () => {
  it('počíta delta.type === "liquidation", nie fill.liquidation', () => {
    const bill = computeBill(
      raw(A_FILLS, {
        ledger: { ledger: C_LEDGER.ledger, pageCount: 1, complete: true, fetchClean: true, retries: 0 },
      }),
    )
    expect(bill.liquidationCount).toBe(
      C_LEDGER.ledger.filter((e: any) => e.delta.type === 'liquidation').length,
    )
  })
})

describe('menovateľ (RECON D6)', () => {
  it('equity < 100 -> costVsEquity je null, nie vymyslené číslo', () => {
    const bill = computeBill(
      raw(A_FILLS, {
        state: { ...A_STATE, marginSummary: { ...A_STATE.marginSummary, accountValue: '42.0' } },
      }),
    )
    expect(bill.costVsEquity).toBeNull()
    expect(bill.costVsVolumeBp).not.toBeNull()
  })

  it('equity >= 100 -> pomer sa počíta', () => {
    const bill = computeBill(raw(A_FILLS, { state: A_STATE }))
    expect(bill.currentEquity).toBeGreaterThanOrEqual(100)
    expect(bill.costVsEquity).toBeCloseTo(
      bill.totalCost / bill.currentEquity!,
      12,
    )
  })
})

describe('funding (RECON D4)', () => {
  it('usdc < 0 = zaplatený, > 0 = prijatý; neúplnosť ide do Billu', () => {
    const bill = computeBill(
      raw(A_FILLS, {
        funding: {
          funding: [
            { time: 1, hash: '', delta: { type: 'funding', coin: 'ETH', usdc: '-10.5', szi: '1', fundingRate: '0', nSamples: 1 } },
            { time: 2, hash: '', delta: { type: 'funding', coin: 'ETH', usdc: '3.25', szi: '1', fundingRate: '0', nSamples: 1 } },
          ],
          pageCount: 1,
          fundingComplete: false,
          fetchClean: true,
          retries: 0,
        },
      }),
    )
    expect(bill.fundingPaid).toBeCloseTo(10.5, 9)
    expect(bill.fundingReceived).toBeCloseTo(3.25, 9)
    expect(bill.fundingComplete).toBe(false)
    expect(bill.totalCost).toBeCloseTo(4.751401 + 7.25, 6)
  })

  it('prijatý > zaplatený neznižuje totalCost pod poplatky', () => {
    const bill = computeBill(
      raw(A_FILLS, {
        funding: {
          funding: [
            { time: 1, hash: '', delta: { type: 'funding', coin: 'ETH', usdc: '999', szi: '1', fundingRate: '0', nSamples: 1 } },
          ],
          pageCount: 1,
          fundingComplete: true,
          fetchClean: true,
          retries: 0,
        },
      }),
    )
    expect(bill.totalCost).toBeCloseTo(4.751401, 6)
  })
})
