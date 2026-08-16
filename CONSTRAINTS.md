# CONSTRAINTS — nemenné fakty, overené na reálnych dátach

## Hyperliquid API
- `fee` UŽ OBSAHUJE `builderFee`. HL podiel = fee − builderFee.
  NIKDY nesčítavaj fee + builderFee.
- `tid == 0` je SENTINEL, nie identifikátor. Dedup podľa holého tid
  zlial 12 reálnych fillov do 1 a ticho zahodil 11. Kľúč musí byť kompozitný.
- Adresa buildera vo fille NIE JE. 17 polí, žiadna atribúcia.
  Reverzný lookup neexistuje (422). maxBuilderFee vracia schválenie,
  nie priradenie. Appky sa smú len AGREGOVAŤ, nikdy pomenovať.
- Vlastná likvidácia NIE JE vo userFills. Iba userNonFundingLedgerUpdates,
  delta.type == "liquidation". fill.liquidation.liquidatedUser je PROTISTRANA.
- nonUserFundingUpdates neexistuje (422). Správne: userNonFundingLedgerUpdates.
- feeToken nie je vždy USDC. Non-USDC = spot, nedá sa preceniť.
  Vylúč z peňazí, ale VŽDY priznaj počet a tokeny.
- portfolio.allTime má ~80 bodov na 535 dní. Peak equity je NEPOUŽITEĽNÉ.

## Netlify
- Deploy VŽDY: netlify deploy --prod --site cf7c173b-fb1e-4865-b674-66d487ce0892
  Hostname v --site padá na Blobs 400. Iba kanonické UUID.
- Netlify Edge IGNORUJE neznáme query parametre pri cache kľúči.
  Verziovanie cez ?v= nefunguje. Verzia patrí do CESTY.
- s-maxage a stale-while-revalidate sa neposielajú klientovi.
  TTL over IBA cez hlavičku `cache-status: ttl=`.
- `immutable` na dynamickej route = číslo zamrzne na rok. Nikdy.

## Pravidlá výstupu
- Chýbajúce dáta = null a UI ukáže "n/a". NIKDY 0 namiesto neznáma.
- Vylúčené fily sa VŽDY počítajú a zobrazujú. Nikdy ticho nezahadzuj.
- Každé verejné číslo musí byť reprodukovateľné z raw API odpovede.
