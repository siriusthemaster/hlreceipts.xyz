import type { Metadata } from 'next'
import Receipt from '../../components/Receipt'
import { computeBill } from '../../lib/bill'
import { fetchAccount } from '../../lib/hl'
import {
  acquireLock, acquireSlot, getBill, getLastBill, releaseLock, releaseSlot, setBill,
} from '../../lib/cache'
import { normalizeAddress as normalize } from '../../lib/address'

export const dynamic = 'force-dynamic'
export const maxDuration = 60


export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
  const { address } = await params
  const addr = normalize(address)
  const og = `/api/og/v1/${addr ?? address}`
  return {
    title: 'hlreceipts',
    description: 'Everyone posts their PnL. Nobody posts what it cost.',
    openGraph: { images: [og] },
    twitter: { card: 'summary_large_image', images: [og] },
  }
}

function Shell({ title, body }: { title: string; body: string }) {
  return (
    <main className="wrap" style={{ paddingTop: 72 }}>
      <div className="label" style={{ marginBottom: 28 }}>HLRECEIPTS.XYZ</div>
      <h1 style={{ fontSize: 23, lineHeight: 1.4, margin: '0 0 14px', fontWeight: 700 }}>{title}</h1>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.7 }}>{body}</div>
      <hr className="perf" style={{ marginTop: 32 }} />
      <a href="/" className="muted" style={{ fontSize: 13 }}>← try another address</a>
    </main>
  )
}

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address: rawAddress } = await params
  const address = normalize(rawAddress)
  if (!address) {
    return <Shell title="that is not a wallet address" body="40 hex characters, with or without the 0x prefix." />
  }

  // 1. čerstvý bill
  let bill = await getBill(address)

  if (!bill) {
    // 2. thundering herd: per-adresa zámok + globálny strop. Request NIKDY nečaká.
    const slot = await acquireSlot()
    if (!slot) {
      const last = await getLastBill(address)
      if (last) return <Receipt bill={last} address={address} />
      return <Shell title="still counting" body="a lot of people are pulling receipts right now. refresh in a minute." />
    }
    const lock = await acquireLock(address)
    if (!lock) {
      await releaseSlot()
      const last = await getLastBill(address)
      if (last) return <Receipt bill={last} address={address} />
      return <Shell title="still counting" body="this address is already being counted. refresh in a minute." />
    }
    try {
      const raw = await fetchAccount(address)
      if (raw.fills.fills.length === 0) {
        return <Shell title="nothing to bill" body="this address has no Hyperliquid trading history we can see." />
      }
      bill = computeBill(raw)
      await setBill(address, bill)
    } catch {
      // 4. NIKDY 500 — ukáž posledné známe, inak priateľskú hlášku.
      const last = await getLastBill(address)
      if (last) return <Receipt bill={last} address={address} />
      return <Shell title="could not reach Hyperliquid" body="their API did not answer in time. refresh in a minute." />
    } finally {
      await releaseLock(address)
      await releaseSlot()
    }
  }

  return <Receipt bill={bill} address={address} />
}
