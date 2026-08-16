# RECON.md — Hyperliquid public info API

> Empirický prieskum, 2026-08-16. Endpoint `POST https://api.hyperliquid.xyz/info`,
> bez auth, `Content-Type: application/json`. Všetko sú čítacie volania.
> Vzorka: **A** `0x980adFdc…` (16 fillov) · **B** `0x856c3503…` (2000+) · **C** `0x64f4e14a…` (7785)

---

## 0. Tri veci, ktoré rozbijú naivný výpočet

1. **`feeToken` NIE JE vždy USDC.** Vo vzorke 8 rôznych tokenov. Naivné
   `sum(fee)` sčíta USDC + HYPE + UPUMP do jedného čísla. Nezmysel.
2. **`fee` UŽ OBSAHUJE `builderFee`.** Nie je to príplatok navyše.
3. **Vlastná likvidácia NIE JE vo `userFills`.** Pole `liquidation` na fille
   opisuje **protistranu**, nie teba.

---

## 1. `userFills`

**Strop: presne 2000.** A vrátila 16 (celá história), B aj C presne 2000 → strop
potvrdený. Poradie **DESC** (najnovšie prvé).

### Polia (typy overené na reálnych dátach)

| pole | typ | pozn. |
|---|---|---|
| `coin` | `str` | `"ETH"` |
| `px`, `sz`, `fee`, `closedPnl`, `startPosition` | **`str`** | čísla ako reťazce — parsovať |
| `oid`, `tid`, `time` | `int` | `time` = ms |
| `crossed` | `bool` | `true` = taker |
| `side` | `str` | `"A"` / `"B"` |
| `dir` | `str` | viď nižšie |
| `feeToken` | `str` | **mení sa** |
| `hash` | `str` | |
| `twapId` | `null`/int | |
| `cloid` | `str` | **len niekedy** |
| `builderFee` | `str` | **len niekedy** — 12 z 4016 vo vzorke |
| `liquidation` | `dict` | **len niekedy** — 4 z 4016 |

### `dir` — unikátne hodnoty z reálnych dát (4016 fillov)

```
2131  Close Long        481  Sell              5  Spot Dust Conversion
 490  Close Short       378  Buy               1  Long > Short
 278  Open Long         252  Open Short
```
`Buy`/`Sell` = spot. `Long > Short` = otočenie pozície jedným fillom.

### Likvidácia — POZOR

```json
"liquidation": {"liquidatedUser":"0x7360…","markPx":"0.073895","method":"market"}
```
**`liquidatedUser` ani raz (0 zo 4) nebola dotazovaná adresa.** Tieto fily sú
prípady, keď náš user obchodoval **proti** cudzej likvidácii.

**Vlastná likvidácia je v `userNonFundingLedgerUpdates`** (§3b):
```json
{"type":"liquidation","liquidatedNtlPos":"16284.535","accountValue":"218.907536",
 "leverageType":"Cross","liquidatedPositions":[{"coin":"XPL","szi":"41050.0"}]}
```
⚠️ Nepotvrdené: nemali sme adresu, ktorá bola likvidovaná **a** má to vo filloch,
takže sa nedá vylúčiť, že pri vlastnej likvidácii je pole aj na fille. Overiť na
adrese so známou likvidáciou.

### `fee` — znamienko

| | počet | podiel |
|---|---:|---:|
| záporné (**rebate**) | 399 | **9.94 %** |
| nula | 5 | 0.12 % |
| kladné | 3612 | 89.94 % |

Najzápornejšie `-0.199999`. **Rebaty treba nechať v súčte** — sú to reálne
vrátené peniaze, nie chyba.

### `feeToken` — 8 hodnôt, súčty sa NESMÚ miešať

| token | fillov | Σ fee |
|---|---:|---:|
| USDC | 3638 | 1461.567112 |
| HYPE | 157 | 4.346694 |
| UZEC | 65 | 0.237177 |
| UBTC | 61 | 0.002475 |
| UETH | 36 | 0.079986 |
| UPUMP | 21 | **4510.887753** |
| UMON | 21 | 497.552226 |
| USOL | 17 | 0.284578 |

Non-USDC sú **spotové** poplatky. Na USD prevod treba cenu tokenu v čase fillu —
API ju v odpovedi nedáva.

---

## 2. `userFillsByTime` — plná história

- **Stránka: presne 2000.** Poradie **ASC** (najstaršie prvé) — opačne než `userFills`.
- Stránkovanie: `startTime = posledný_time + 1`.
- **Celkový strop sme NEDOSIAHLI.** C: 4 strany → **7785 unikátnych fillov**,
  5. strana prázdna. (Dokumentovaný strop 10 000 sme neprekročili.)
- ⚠️ **~3 duplicitné `tid` na hranici každej strany** → **dedup podľa `tid` je povinný**.

**Hĺbka histórie:** C až **2025-02-21**, t.j. 535 dní. A: 2026-07-07 → 2026-07-12.
**Plná história účtu je dosiahnuteľná** — na rozdiel od `userFills`.

---

## 3. Funding

### 3a `userFunding`
- Stránka **500**, poradie ASC. C: 500 položiek pokrylo len 1740096000000–1750896000000,
  zatiaľ čo fily idú do 1786869214458 → **stránkovať treba**.
- Tvar: `{time, hash, delta:{type:"funding", coin, usdc, szi, fundingRate, nSamples}}`
- **Znamienko: `delta.usdc < 0` = ZAPLATENÝ funding, `> 0` = PRIJATÝ.**
  C na prvej strane: 313 platených / 187 prijatých, Σ = **-3234.215211 USDC**.

### 3b `nonUserFundingUpdates` — **NEEXISTUJE**
`HTTP 422` pre všetky varianty tela. Správny názov je
**`userNonFundingLedgerUpdates`** (`user` + `startTime`), 78 položiek pre C:

| `delta.type` | ks | kľúčové polia |
|---|---:|---|
| `deposit` | 17 | `usdc` |
| `withdraw` | 15 | `usdc`, `fee` (**1.0 USDC**), `nonce` |
| `send` | 21 | `token`, `amount`, `destination` |
| `accountClassTransfer` | 20 | `usdc`, `toPerp` |
| `spotTransfer` | 3 | `token`, `amount`, `usdcValue` |
| `liquidation` | 1 | viď §1 |
| `spotGenesis` | 1 | |

**Čisté vklady C:** deposit 1 061 591.47 − withdraw 916 168.85 = **145 422.62 USDC**.
Toto je základ pre „koľko si vložil vs. koľko máš“.

---

## 4. `clearinghouseState`

```
marginSummary.accountValue = "19214.852222"   ← AKTUÁLNA EQUITY (str)
withdrawable               = "0.0"            ← top-level (str)
assetPositions[]           → position{coin, szi, entryPx, positionValue,
                                      unrealizedPnl, liquidationPx, marginUsed,
                                      cumFunding{allTime, sinceOpen, sinceChange}}
```
**`cumFunding.allTime`** je lifetime funding **per otvorenú pozíciu** — po zavretí
pozície mizne, takže sa nedá použiť ako lifetime súčet za účet.

---

## 5. `portfolio`

Okná: `day, week, month, allTime, perpDay, perpWeek, perpMonth, perpAllTime`.
Každé: `accountValueHistory: [[ms, "hodnota"]]`, `pnlHistory`, `vlm` (str).

| okno | bodov | rozsah | peak equity |
|---|---:|---:|---:|
| day | 13 | 1.0 d | 405 805.66 |
| week | 65 | 7.1 d | 409 844.64 |
| month | 46 | 30.5 d | 501 025.83 |
| allTime | **80** | **535.4 d** | 913 649.06 |

⚠️ **allTime má 80 bodov na 535 dní ≈ jedna vzorka za 6.7 dňa.** Na „peak equity“
použiteľné len ako **hrubý odhad** — špička medzi vzorkami je neviditeľná.
Presný peak sa dá dorátať len rekonštrukciou z fillov + ledgeru.

---

## 6. Leaderboard — **FUNGUJE**

`GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` → **HTTP 200**,
**34.5 MB**, jedným ťahom, bez auth.

```
{"leaderboardRows":[ {ethAddress, accountValue, displayName, prize,
                      windowPerformances:[["day",{pnl,roi,vlm}], ["week",…],
                                          ["month",…], ["allTime",…]]} ]}
```
**41 797 adries.** Všetky hodnoty `str`. Použiteľné na percentil („si lepší než X %“).

---

## 7. Rate limity — reálne pozorované

| test | výsledok |
|---|---|
| 20 sekvenčných volaní | **0× 429**, 7.17 s, ~2.8 req/s, latencia 336–435 ms |
| 30 paralelných (16 vlákien) | **0× 429**, 0.94 s, ~32 req/s |

**Limit sme NEDOSIAHLI ani pri ~32 req/s.** Nevieme povedať, kde 429 začína —
vieme len, že je nad touto úrovňou. Zámerne sme netlačili vyššie: agresívny test
môže zablokovať IP a HL API je na produkčnej ceste SOGO.

---

## 8. POZITÍVNA KONTROLA — adresa A

| | |
|---|---|
| `userFills` | 16 fillov |
| `userFillsByTime` od 0 | 16 fillov, **`tid` množiny identické** ✅ |
| `feeToken` | 16× USDC — **súčet je zmysluplný** |
| **Σ fee** | **4.751401 USDC** |
| Σ builderFee | 0.562528 USDC (na 12/16) |
| Σ closedPnl | −2.313010 USDC |
| Σ notional | 9 696.48 USDC |

### Je `builderFee` v `fee`, alebo navyše? — VYRIEŠENÉ

| notional | fee | builderFee | fee/notional | (fee−bf)/notional |
|---:|---:|---:|---:|---:|
| 25.09 | 0.017110 | 0.006272 | **6.820 bp** | **4.320 bp** |
| 25.09 | 0.017110 | 0.006272 | 6.820 bp | 4.320 bp |
| 25.08 | 0.017103 | 0.006269 | 6.819 bp | 4.320 bp |

`builderFee` = presne **2.500 bp**, zvyšok **4.320 bp** = vlastný HL poplatok.
6.820 = 4.320 + 2.500 na **každom** fille.

> **`fee` OBSAHUJE `builderFee`.** Pre „koľko ťa stál HL“ treba
> `fee − builderFee`. Inak pripočítaš buildera k HL.

### ⚠️ Porovnanie s app.hyperliquid.xyz — NEVYKONANÉ

**Nedá sa spraviť z môjho miesta.** app.hyperliquid.xyz zobrazuje poplatky len
prihlásenému vlastníkovi peňaženky; verejný info API nemá endpoint, ktorý by
vrátil „celkové zaplatené poplatky“ na krížovú kontrolu. `userFees` vracia
`dailyUserVlm` + sadzby, **nie** kumulatívne poplatky.

**Čo je overené namiesto toho:** dva nezávislé endpointy vrátili identickú množinu
`tid`, jednotná mena, a rozklad bp presne sedí na 4.320 + 2.500. Vnútorne konzistentné.

**Ako to dopočítať za 2 minúty (ty, nie ja):** otvor app.hyperliquid.xyz s
peňaženkou A, `Σ fee` musí byť **4.751401 USDC** za 2026-07-07 → 2026-07-12.
**Kým to nepotvrdíš, číslo je neoverené voči zdroju pravdy.**

---

## ČO VIEME TVRDIŤ PRAVDIVO

### ✅ Za CELÝ život účtu (`userFillsByTime` od 0, dedup podľa `tid`)

| číslo | ako | poznámka |
|---|---|---|
| **Zaplatené poplatky HL** | `Σ(fee − builderFee)` kde `feeToken=="USDC"` | rebaty vrátane |
| **Zaplatené builder fees** | `Σ builderFee` | len kde pole existuje |
| **Obchodovaný objem** | `Σ(px × sz)` | |
| **Realizovaný PnL** | `Σ closedPnl` | |
| **Počet obchodov** | počet fillov | |
| **Rebaty** | `Σ fee` kde `fee < 0` | ~10 % fillov |

### ✅ Za celý život, iný endpoint

| číslo | zdroj |
|---|---|
| **Čisté vklady** | `userNonFundingLedgerUpdates`: `Σdeposit − Σwithdraw` |
| **Poplatky za výbery** | tamže, `withdraw.fee` (1.0 USDC/výber) |
| **Počet vlastných likvidácií** | tamže, `delta.type=="liquidation"` |
| **Aktuálna equity** | `clearinghouseState.marginSummary.accountValue` |
| **Percentil vs. 41 797 traderov** | leaderboard |

### ⚠️ Čiastočne / s výhradou

| číslo | obmedzenie |
|---|---|
| **Zaplatený funding** | `userFunding` **treba stránkovať** po 500; inak len časť |
| **Spotové poplatky** | 7 non-USDC tokenov — **na USD sa nedajú previesť** bez historických cien |
| **Peak equity** | `portfolio.allTime` má **1 vzorku / 6.7 dňa** — hrubý odhad |

### ❌ Čo NEVIEME

- **Presný peak equity** — rozlíšenie krivky to nedovoľuje.
- **Nerealizovaný PnL v čase** — len aktuálny.
- **USD hodnotu non-USDC poplatkov** — chýba cena v čase fillu.
- **Kde začína 429** — limit sme nedosiahli.
- **Či vlastná likvidácia značí aj fill** — vzorka to nepokryla.

### Navrhovaná formulácia labelu na kartu

Plná história **je** dosiahnuteľná, takže sa netreba vyhovárať na okno — ale
mena a spot áno:

> **„Zaplatené Hyperliquidu: $X“**
> malým písmom: *„perpetual poplatky v USDC za celú históriu účtu, od {dátum prvého fillu}.
> Bez spotových poplatkov platených v iných tokenoch a bez fundingu.“*

Ak sa funding dostránkuje, druhý riadok:
> **„Funding: −$Y“** — *„čistý zaplatený funding za rovnaké obdobie.“*

**Nepoužívať „lifetime“ bez dátumu.** Uveď dátum prvého fillu — je to overiteľné
a chráni to pred nárokom, ktorý nevieme podložiť pri účte staršom než 10 000 fillov.
