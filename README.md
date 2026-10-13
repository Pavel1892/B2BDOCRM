# Schlieger FVE Hub — podklady pro nasazení

Interní aplikace pro velké fotovoltaiky: leady, nabídky, smlouvy, zakázky, faktury, protokoly, servis, provize.

## Co je ve složce

| Soubor | K čemu je |
|---|---|
| `Schlieger-FVE-Hub.html` | celá aplikace (jeden soubor, běží v prohlížeči) |
| `server.mjs` | server: podává aplikaci, drží společná data, přihlašuje uživatele, kontroluje úhrady v ABŘE |
| `package.json` | jen kvůli `npm start`; žádné závislosti se neinstalují |
| `Dockerfile` | hotový obraz pro Docker |
| `.env.example` | vzor nastavení |

## Požadavky

- Node.js 20 nebo novější (žádné balíčky z npm, žádná databáze)
- trvalý disk pro složku s daty
- HTTPS před serverem (reverse proxy nebo hosting, který ho dělá sám)
- odchozí přístup na internet z prohlížečů uživatelů: aplikace si načítá písma z Google Fonts a z cdnjs.cloudflare.com
  knihovny pro tvorbu a čtení PDF (html2pdf.js, pdf-lib, pdf.js)

## Nastavení (proměnné prostředí)

| Proměnná | Povinná | Význam |
|---|---|---|
| `SESSION_SECRET` | ano | náhodný řetězec aspoň 16 znaků; podepisuje přihlašovací cookie |
| `DATA_DIR` | ano | složka na trvalém disku, např. `/data` |
| `NODE_ENV=production` | ano | zapne příznak Secure u cookie |
| `PORT` | ne | port serveru, výchozí 8080 |
| `SETUP_TOKEN` | ne | kód, bez kterého nejde založit první účet (doporučeno, pokud je adresa veřejná) |
| `ABRA_URL`, `ABRA_COMPANY`, `ABRA_USER`, `ABRA_PASSWORD` | ne | napojení na ABRA Flexi, účet jen pro čtení |
| `ABRA_SYNC_HOUR` | ne | hodina ranní kontroly úhrad, výchozí 6 (čas serveru) |

## Spuštění

Přímo:

    SESSION_SECRET=... DATA_DIR=/data NODE_ENV=production node server.mjs

Dockerem:

    docker build -t fve-hub .
    docker run -d -p 8080:8080 -v fve-hub-data:/data -e SESSION_SECRET=... fve-hub

Kontrola, že běží: `GET /api/health` vrátí `{"ok":true}`.

## První spuštění

1. Otevřít adresu aplikace. Objeví se „První spuštění" — založí se první účet s rolí Vedení
   (pokud je nastavený `SETUP_TOKEN`, je potřeba ho zadat).
2. Další uživatele přidává Vedení na stránce Uživatelé (jméno, e-mail, heslo, role).
3. Oprávnění rolí se nastavují tabulkou „Co která role vidí" na téže stránce.

## Data a zálohy

- Všechna data jsou v jednom souboru `DATA_DIR/hub-state.json` (včetně nahraných fotek a PDF jako base64).
- Server sám ukládá jednu zálohu denně jako `zaloha-RRRR-MM-DD.json` a drží posledních 30.
  Doporučujeme složku `DATA_DIR` zahrnout i do běžného zálohování serveru.
- Obnova: zastavit server, nahradit `hub-state.json` zálohou, spustit.
- Limit jednoho požadavku je 40 MB.

## Zabezpečení

- Hesla se ukládají jako scrypt s náhodnou solí.
- Přihlášení: podepsaná cookie `fvehub` (HttpOnly, SameSite=Lax, Secure v produkci), platnost 7 dní.
- Zápisy vyžadují hlavičku `X-Hub: 1` (ochrana proti podvrženým požadavkům z cizích stránek).
- Po 8 neúspěšných přihlášeních z jedné adresy je 10 minut pauza. Za reverse proxy se adresa bere z `X-Forwarded-For`.
- Role se vynucují na serveru: uživatel bez oprávnění „Přijaté faktury" je ze serveru nedostane a nemůže je uložením přepsat.
  Ostatní oprávnění zatím řídí jen zobrazení v aplikaci.
- Server běží jako jedna instance. Víc instancí nad stejnými daty spouštět nelze.

## ABRA

Napojení je napsané pro **ABRA Flexi** (REST) a ověřené jen proti zkušební napodobenině, ne proti skutečné ABŘE.
Čte evidence `faktura-vydana` a `faktura-prijata` (pole `kod`, `varSym`, `stavUhrK`) a páruje je s fakturami v aplikaci
podle čísla. Uhrazené faktury označí a založí upozornění. ABRA Gen podporovaná není.

## Rozhraní serveru

| Metoda a cesta | Popis |
|---|---|
| `GET /` | aplikace |
| `GET /api/health` | kontrola běhu |
| `GET /api/me` | stav přihlášení |
| `POST /api/setup` | založení prvního účtu (jen dokud žádný není) |
| `POST /api/login`, `POST /api/logout` | přihlášení a odhlášení |
| `GET /api/state`, `GET /api/rev` | data pro přihlášeného uživatele a číslo verze |
| `POST /api/patch` | uložení změněných záznamů |
| `POST /api/users`, `DELETE /api/users/:id` | správa uživatelů |
| `POST /api/abra/sync` | ruční kontrola úhrad v ABŘE |

## Aktualizace aplikace

Vyměnit `Schlieger-FVE-Hub.html` (případně `server.mjs`) a restartovat server. Data zůstávají.
