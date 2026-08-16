import { ImageResponse } from 'next/og'
import { getBill, getLastBill } from '../../../../../lib/cache'
import type { Bill } from '../../../../../lib/bill'

export const runtime = 'edge'

// Verzia je v ceste. Pri KAŽDEJ zmene výpočtu alebo vizuálu bumpni v1 -> v2.
// Netlify Edge ignoruje query parametre pri cache kľúči, preto nie ?v=.
//
// Bez toho by sa karta s nesprávnou sumou nedala opraviť: pôvodná odpoveď niesla
// `immutable, max-age=31536000` a ?v=<ts> stále vracalo cache hit.
//
// TÁTO ROUTE NIKDY NEPOČÍTA BILL. Číta ho výhradne z cache; miss = generická
// karta. Výpočet je desiatky sekúnd a stovky HTTP volaní — na edge nemá čo robiť.

const T = {
  bg: '#0A0B0D',
  text: '#E6E9EF',
  muted: '#9AA3AD',
  hairline: '#24282E',
  hero: '#FF4D4D',
  positive: '#00E28A', // IBA keď je funding čistý PRÍJEM
} as const

// s-maxage MUSÍ zostať v zhode s Redis TTL billu (86400, viď lib/cache.ts).
const CACHE_CONTROL =
  'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

/**
 * Formátovanie BEZ toLocaleString: edge runtime nemá zaručené plné ICU a
 * `toLocaleString('en-US', …)` sa tam správa inak než v Node. Ručné oddeľovanie
 * tisícov je deterministické všade.
 */
const group = (intPart: string): string =>
  intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const num = (v: number, digits: number): string => {
  const neg = v < 0
  const fixed = Math.abs(v).toFixed(digits)
  const [i, d] = fixed.split('.')
  return `${neg ? '-' : ''}${group(i)}${d ? `.${d}` : ''}`
}

const usd = (v: number): string => `$${num(v, Math.abs(v) >= 1000 ? 0 : 2)}`

const shortAddr = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a

function denominatorLine(bill: Bill): string | null {
  if (bill.costVsEquity !== null) {
    return `${bill.costVsEquity.toFixed(1)}x your current equity`
  }
  if (bill.costVsVolumeBp !== null) {
    return `${bill.costVsVolumeBp.toFixed(1)} bp of everything you traded`
  }
  return null
}

function footerLine(bill: Bill): string {
  const since =
    bill.windowStart !== null
      ? (() => {
          const d = new Date(bill.windowStart)
          return ` since ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
        })()
      : ''
  let s = `${group(String(bill.fillCount))} fills${since}`
  if (bill.isFloor) s += ' · partial history, this is a floor'
  if (bill.excludedFillCount > 0) {
    s += ` · ${bill.excludedFillCount} spot fills in ${bill.excludedTokens.length} tokens excluded`
  }
  return s
}

function Column({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{ color: T.muted, fontSize: 20, letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 40, marginTop: 10 }}>{value}</div>
    </div>
  )
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params

  const font = await fetch(
    new URL('./JetBrainsMono-Bold.ttf', import.meta.url),
  ).then((res) => res.arrayBuffer())

  // Poradie je záväzné: čerstvý -> posledný známy -> až potom pozvánka.
  // Adresa, ktorá už raz bola vypočítaná, sa na pozvánku nesmie vrátiť nikdy;
  // po expirácii TTL ukáže staršie číslo, nie prázdnu kartu.
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address)
  const bill = valid ? ((await getBill(address)) ?? (await getLastBill(address))) : null

  const shell = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: T.bg,
    fontFamily: 'JetBrains Mono',
    padding: '56px 64px',
  }

  const opts = {
    width: 1200,
    height: 630,
    fonts: [{ name: 'JetBrains Mono', data: font, style: 'normal' as const, weight: 700 as const }],
    headers: { 'cache-control': CACHE_CONTROL },
  }

  // Cache miss: nič sa nepočíta, len pozvánka. Nikdy nevymýšľame čísla.
  if (!bill) {
    return new ImageResponse(
      (
        <div style={{ ...shell, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', color: T.muted, fontSize: 22, letterSpacing: 2 }}>
            HLRECEIPTS.XYZ
          </div>
          <div style={{ display: 'flex', color: T.text, fontSize: 56, lineHeight: 1.25 }}>
            paste an address at hlreceipts.xyz
          </div>
          <div style={{ display: 'flex', color: T.muted, fontSize: 22 }}>
            {/^0x[0-9a-fA-F]{40}$/.test(address) ? shortAddr(address) : ''}
          </div>
        </div>
      ),
      opts,
    )
  }

  const denom = denominatorLine(bill)
  const fundingNetIncome = bill.fundingReceived > bill.fundingPaid

  return new ImageResponse(
    (
      <div style={{ ...shell, justifyContent: 'space-between' }}>
        {/* hlavička */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: T.muted, fontSize: 22, letterSpacing: 2 }}>HLRECEIPTS.XYZ</div>
          <div style={{ color: T.muted, fontSize: 22 }}>{shortAddr(address)}</div>
        </div>

        {/* hero + veta */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/*
            JEDEN textový potomok, zámerne. satori vyžaduje explicitné
            display:flex na každom elemente s VIAC než jedným dieťaťom; dva
            súrodenecké reťazce tu zhodili celý render na HTTP 500.
          */}
          <div style={{ color: T.hero, fontSize: 150, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {`${usd(bill.totalCost)}${bill.isFloor ? '+' : ''}`}
          </div>
          {denom !== null ? (
            <div style={{ color: T.text, fontSize: 34, marginTop: 18 }}>{denom}</div>
          ) : null}
        </div>

        {/* štyri stĺpce */}
        <div
          style={{
            display: 'flex',
            borderTop: `1px solid ${T.hairline}`,
            paddingTop: 26,
          }}
        >
          <Column label="HYPERLIQUID TOOK" value={usd(bill.hlFees)} color={T.text} />
          <Column label="THE APPS TOOK" value={usd(bill.appFees)} color={T.text} />
          <Column
            label={fundingNetIncome ? 'FUNDING RECEIVED' : 'FUNDING PAID'}
            value={usd(fundingNetIncome ? bill.fundingReceived - bill.fundingPaid : bill.fundingPaid)}
            color={fundingNetIncome ? T.positive : T.text}
          />
          <Column label="LIQUIDATIONS" value={String(bill.liquidationCount)} color={T.text} />
        </div>

        {/* pätička */}
        <div style={{ display: 'flex', color: T.muted, fontSize: 20 }}>{footerLine(bill)}</div>
      </div>
    ),
    opts,
  )
}
