'use client'

import { useEffect, useRef, useState } from 'react'
import type { Bill } from '../lib/bill'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const num = (v: number, d: number) => {
  const neg = v < 0
  const [i, f] = Math.abs(v).toFixed(d).split('.')
  return `${neg ? '-' : ''}${group(i)}${f ? `.${f}` : ''}`
}
/** Mínus PRED znak meny: "-$43,337", nie "$-43,337". */
const usd = (v: number) => {
  const s = num(Math.abs(v), Math.abs(v) >= 1000 ? 0 : 2)
  return `${v < 0 ? '-' : ''}$${s}`
}
const day = (ms: number) => {
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/**
 * Hero count-up, 800 ms, ease-out. Rešpektuje prefers-reduced-motion.
 *
 * Počiatočný stav je CIEĽOVÁ hodnota, nie nula. Na serveri aj bez JS tak účtenka
 * ukáže skutočné číslo; animácia sa rozbehne až po mount. Pri štarte z nuly
 * karta reálne zobrazovala "$0.00", kým sa animácia nespustila — a účtenka,
 * ktorá môže ukázať nulu, je horšia než účtenka bez animácie.
 */
function useCountUp(target: number, ms = 800): number {
  const [v, setV] = useState(target)
  const raf = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setV(target)
      return
    }
    setV(0)
    const t0 = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms)
      setV(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [target, ms])
  return v
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <hr className="perf" />
      <div className="label" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </>
  )
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="row">
      <span className="muted" style={{ fontSize: 13 }}>{k}</span>
      <span className="value" style={color ? { color } : undefined}>{v}</span>
    </div>
  )
}

export default function Receipt({ bill, address }: { bill: Bill; address: string }) {
  const shown = useCountUp(bill.totalCost)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<'idle' | 'ok' | 'err'>('idle')
  const [copied, setCopied] = useState(false)

  const fundingNet = bill.fundingReceived - bill.fundingPaid
  const fundingIsIncome = fundingNet > 0

  const denom =
    bill.costVsEquity !== null
      ? `${bill.costVsEquity.toFixed(1)}x your current equity`
      : bill.costVsVolumeBp !== null
        ? `${bill.costVsVolumeBp.toFixed(1)} bp of everything you traded`
        : null

  const shareText = `my hyperliquid bill: ${usd(bill.totalCost)}\n\nhlreceipts.xyz`
  const imageUrl = `https://hlreceipts.xyz/api/og/v1/${address}`

  async function joinWaitlist(e: React.FormEvent) {
    e.preventDefault()
    try {
      const r = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setSent(r.ok ? 'ok' : 'err')
    } catch {
      setSent('err')
    }
  }

  return (
    <main className="wrap">
      <div className="row" style={{ padding: 0 }}>
        <span className="label">HLRECEIPTS.XYZ</span>
        <span className="label">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      </div>

      {/* ── THE DAMAGE ─────────────────────────────────────────────
          Hero je CELKOVÝ náklad, nie „čo vzala burza“. Funding ide
          protistrane, nie Hyperliquidu — preto to rozpad nižšie rozlišuje
          a nikde netvrdíme, že celú sumu vzala burza. */}
      <Section title="THE DAMAGE">
        <div className="hero-num" style={{ fontSize: 56, margin: '6px 0 10px' }}>
          {usd(shown)}{bill.isFloor ? '+' : ''}
        </div>
        {denom ? <div className="value">{denom}</div> : null}
      </Section>

      <Section title="BREAKDOWN">
        <Row k="Hyperliquid took" v={usd(bill.hlFees)} />
        <Row k="The apps took" v={usd(bill.appFees)} />
        <Row
          k={fundingIsIncome ? 'Funding net (received)' : 'Funding net (paid)'}
          v={`${fundingIsIncome ? '+' : ''}${usd(fundingNet)}`}
          color={fundingIsIncome ? 'var(--gain)' : undefined}
        />
        <Row k="Liquidations" v={String(bill.liquidationCount)} />
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          Funding is paid to the traders on the other side of your position, not to the exchange.
        </div>
      </Section>

      {bill.builderRates.length > 0 ? (
        <Section title="BUILDER RATES YOU PAID">
          <div className="row" style={{ paddingBottom: 4 }}>
            <span className="label">RATE</span>
            <span className="label">VOLUME</span>
            <span className="label">SHARE</span>
          </div>
          {bill.builderRates.map((r, i) => (
            <div className="row" key={i}>
              <span className="value">{r.bp === null ? 'other' : `${r.bp} bp`}</span>
              <span className="value">{usd(r.volume)}</span>
              <span className="value">{(r.share * 100).toFixed(1)}%</span>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
            SOGO Terminal is one of these apps. Our direct lane is 2.5bp.
          </div>
        </Section>
      ) : null}

      <Section title="THE WOUNDS">
        <Row
          k="Worst trade"
          v={bill.worstTrade ? `${usd(bill.worstTrade.value)} · ${bill.worstTrade.coin}` : 'n/a'}
        />
        <Row
          k="Biggest fill"
          v={bill.biggestFill ? `${usd(bill.biggestFill.value)} · ${bill.biggestFill.coin}` : 'n/a'}
        />
      </Section>

      <Section title="LEAKS">
        <Row
          k="Most expensive coin"
          v={bill.mostExpensiveCoin ? `${bill.mostExpensiveCoin.coin} · ${usd(bill.mostExpensiveCoin.fees)}` : 'n/a'}
        />
        <Row
          k="Most expensive hour"
          v={bill.mostExpensiveHourUTC ? `${String(bill.mostExpensiveHourUTC.hour).padStart(2, '0')}:00 UTC · ${usd(bill.mostExpensiveHourUTC.fees)}` : 'n/a'}
        />
      </Section>

      <Section title="COVERAGE">
        <div className="value" style={{ fontSize: 13 }}>
          {group(String(bill.fillCount))} fills
          {bill.windowStart !== null && bill.windowEnd !== null
            ? ` · ${day(bill.windowStart)} → ${day(bill.windowEnd)}`
            : ''}
        </div>
        {bill.isFloor ? (
          <div style={{ color: 'var(--hero)', fontSize: 13, marginTop: 8 }}>
            partial history — this is a floor
          </div>
        ) : null}
        {bill.excludedFillCount > 0 ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {bill.excludedFillCount} spot fills in {bill.excludedTokens.length} tokens excluded
          </div>
        ) : null}
      </Section>

      <Section title="SHARE">
        <a
          href={`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none' }}
        >
          <button type="button">SHARE ON X</button>
        </a>
        <div style={{ height: 8 }} />
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            navigator.clipboard?.writeText(imageUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? 'COPIED' : 'COPY IMAGE LINK'}
        </button>
      </Section>

      {/* ── [LOCKED] ─────────────────────────────────────────────── */}
      <Section title="[LOCKED]">
        <div className="card locked">
          <div className="blur">
            <div className="row"><span className="muted">fee by venue</span><span className="value">$—</span></div>
            <div className="row"><span className="muted">funding by asset</span><span className="value">$—</span></div>
            <div className="row"><span className="muted">hour-of-day heatmap</span><span className="value">—</span></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>THE FULL AUTOPSY</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
              fee by venue, funding by asset, hour-of-day heatmap, 12-month trend, CSV export
            </div>
            <form onSubmit={joinWaitlist} style={{ marginTop: 14 }}>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                aria-label="email for waitlist"
              />
              <div style={{ height: 8 }} />
              <button type="submit" className="btn-ghost">
                {sent === 'ok' ? "YOU'RE ON THE LIST" : sent === 'err' ? 'TRY AGAIN' : 'JOIN THE WAITLIST'}
              </button>
            </form>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>$5. Not live yet.</div>
          </div>
        </div>
      </Section>

      <hr className="perf" />
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
        built by @0xtomdev · from public Hyperliquid data · not financial advice
      </div>
    </main>
  )
}
