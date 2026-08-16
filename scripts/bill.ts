/**
 * CLI: pnpm bill 0x...
 * Vypíše celý Bill ako JSON na stdout. Diagnostika ide na stderr, aby sa dal
 * stdout rúrou posunúť do jq bez špiny.
 */
import { fetchAccount } from '../lib/hl'
import { computeBill } from '../lib/bill'
import { setBill, billKey } from '../lib/cache'

async function main() {
  const address = process.argv[2]
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error('pouzitie: pnpm bill 0x<40 hex znakov>')
    process.exit(2)
  }

  const t0 = Date.now()
  console.error(`[bill] sťahujem ${address} …`)
  const raw = await fetchAccount(address)
  console.error(
    `[bill] fills=${raw.fills.fills.length} (${raw.fills.pageCount}p) ` +
      `funding=${raw.funding.funding.length} (${raw.funding.pageCount}p, complete=${raw.funding.fundingComplete}) ` +
      `ledger=${raw.ledger.ledger.length} (${raw.ledger.pageCount}p) ` +
      `za ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )

  const bill = computeBill(raw)

  // Zápis do cache je best-effort: bez UPSTASH_* premenných je to no-op a CLI
  // dobehne rovnako. OG route číta výhradne odtiaľto, nikdy nepočíta sama.
  await setBill(address, bill)
  const cached = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  console.error(
    cached
      ? `[bill] uložené do cache: ${billKey(address)} (TTL 86400s)`
      : `[bill] cache PRESKOČENÁ — UPSTASH_REDIS_REST_URL/TOKEN nie sú nastavené`,
  )

  console.log(JSON.stringify(bill, null, 2))
}

main().catch((err) => {
  console.error('[bill] ZLYHALO:', err instanceof Error ? err.message : err)
  process.exit(1)
})
