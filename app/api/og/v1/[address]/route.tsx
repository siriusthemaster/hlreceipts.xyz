import { ImageResponse } from 'next/og'

export const runtime = 'edge'

// Verzia je v ceste. Pri KAŽDEJ zmene výpočtu alebo vizuálu bumpni v1 -> v2.
// Netlify Edge ignoruje query parametre pri cache kľúči, preto nie ?v=.
//
// Bez toho by sa karta s nesprávnou sumou nedala opraviť: pôvodná odpoveď niesla
// `immutable, max-age=31536000` a ?v=<ts> stále vracalo cache hit.

// SOGO tokens. Single source of truth for the card — no colour is written inline
// below, so a palette change is a one-line edit here.
const T = {
  bg: '#0A0B0D',
  surface: '#121417',
  hairline: '#24282E',
  text: '#E6E9EF',
  muted: '#9AA3AD',
  hero: '#FF4D4D', // the headline cost figure
  positive: '#00E28A', // RESERVED: "funding received" line ONLY, nowhere else
} as const

// s-maxage MUSÍ zostať v zhode s Redis TTL billu (86400). Ak sa jedno zmení,
// zmeň aj druhé, inak karta prežije dáta, z ktorých vznikla.
const CACHE_CONTROL =
  'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800'

// Font is CO-LOCATED next to this route, not in /public. On the edge runtime there
// is no fs and /public is not readable from disk; `new URL(..., import.meta.url)`
// makes Next inline the .ttf into the edge bundle at build time, so the render
// needs no network hop and cannot break when the domain changes.
//
// Tabular figures: JetBrains Mono is MONOSPACED, so every digit already occupies
// an identical advance width. fontVariantNumeric is set as well, but the guarantee
// comes from the font, not the property — satori implements only a subset of CSS
// and may ignore it.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  // Address is accepted and reserved for the real bill lookup. Nothing is rendered
  // from it yet — the displayed figure is still the hardcoded spike value.
  await params

  const font = await fetch(
    new URL('./JetBrainsMono-Bold.ttf', import.meta.url),
  ).then((res) => res.arrayBuffer())

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: T.bg,
          fontFamily: 'JetBrains Mono',
        }}
      >
        <div
          style={{
            color: T.hero,
            fontSize: 160,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          $47,312
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'JetBrains Mono',
          data: font,
          style: 'normal',
          weight: 700,
        },
      ],
      headers: {
        'cache-control': CACHE_CONTROL,
      },
    },
  )
}
