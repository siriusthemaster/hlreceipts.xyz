'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { normalizeAddress } from '../lib/address'

export default function Landing() {
  const router = useRouter()
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const addr = normalizeAddress(raw)
    if (!addr) {
      setErr('that does not look like a wallet address — 40 hex characters')
      return
    }
    setErr(null)
    setBusy(true)
    router.push(`/${addr}`)
  }

  return (
    <main className="wrap" style={{ paddingTop: 72 }}>
      <div className="label" style={{ marginBottom: 28 }}>HLRECEIPTS.XYZ</div>

      <h1 style={{ fontSize: 27, lineHeight: 1.35, margin: '0 0 32px', fontWeight: 700 }}>
        Everyone posts their PnL.<br />
        <span className="muted">Nobody posts what it cost.</span>
      </h1>

      <form onSubmit={submit}>
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="0x… your Hyperliquid address"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          aria-label="Hyperliquid address"
        />
        <div style={{ height: 10 }} />
        <button type="submit" disabled={busy}>
          {busy ? 'COUNTING…' : 'SEE THE BILL'}
        </button>
      </form>

      {err ? (
        <div className="muted" style={{ marginTop: 14, fontSize: 13, color: 'var(--hero)' }}>
          {err}
        </div>
      ) : null}

      <hr className="perf" style={{ marginTop: 40 }} />
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
        built by @0xtomdev · from public Hyperliquid data · not financial advice
      </div>
    </main>
  )
}
