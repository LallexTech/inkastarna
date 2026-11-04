# Inkastarna

Lagappen för Inkastarna. Innefotboll, 2 × 15 minuter, Stora Mossen. Next.js, React, Better Auth och Neon Postgres, drift på Vercel.

- Förhandsmiljö: https://inkastarna-pre.vercel.app
- Produktion efter releasegodkännande: https://inkastarna.vercel.app
- Officiell serie: https://korpenstockholm.zoezi.se/serie/9266

## Funktioner

Översikt, kommande och spelade matcher, statistik, intern skytteliga, officiell tabell, trupp och en sparbar femmannauppställning. Spelarna kan registrera sig med lagkod, logga in, ange tröjnummer/position och svara kommer/kanske/kan inte på kommande matcher. Lagledaren sparar laguppställning och registrerar mål, assist och deltagande för färdigspelade matcher.

PWA med manifest, Android-ikoner, maskbar ikon, Apple-ikon, installationsguide och en offlinesida. Spelaruppgifter och autentiserade API-svar sparas inte i service worker-cachen. Internet krävs för aktuell data och kallelsesvar.

Kalenderexport (`.ics`) och kopierbar kallelsetext finns per kommande match. Kopiering skickar inget automatiskt till Messenger. Ingen Messenger-bot eller åtkomst till privata Korpen-sidor är ansluten.

## Data och konton

Match- och tabellinformationen hämtas från samma publika Zoezi-API som seriesidan använder. Rådata med andra lags medlemsuppgifter, registreringssvar och användar-ID:n sparas aldrig. Appen lagrar en normaliserad ögonblicksbild. En misslyckad synk behåller tidigare data och visar när den senast uppdaterades. Svar på matcher är separata från det officiella Korpen-systemet.

Synk sker när appen öppnas och den sparade informationen är äldre än 15 minuter. Produktionsmiljön har dessutom ett dagligt cron-jobb kl. 06.00 UTC. Preview uppdateras vid besök. Matchdatum tolkas alltid i `Europe/Stockholm`, även över sommartidsbytet.

Spelare registrerar sitt eget förnamn från den förinlagda truppen. Varje spelarprofil kan kopplas till ett konto. Administratörsadressen sätts via `ADMIN_EMAILS`; administratören behöver en separat privat `ADMIN_JOIN_CODE` vid registreringen. `ADMIN_PLAYER_NAME` reserverar lagledarens spelarprofil. Den vanliga lagkoden ger inte möjlighet att registrera administratörskontot.

E-postverifiering och automatisk lösenordsåterställning är ännu inte anslutna. Ingen e-post skickas av appen. Lagkoden ska bara delas med laget. Konto-, profil- och kallelsedata finns i databasen, aldrig i Git. Förhandsmiljö och produktion har separata databaser och separata hemligheter.

## Lokal utveckling

```powershell
npm ci
# Konfigurera .env.local enligt .env.example; värden delas separat av projektägaren.
npm run db:migrate
npm run sync
npm run dev
```

`INITIAL_ROSTER` innehåller kommaseparerade förnamn och läses endast av migreringen. Befintliga spelare ersätts inte när migreringen körs igen. Auth-tabeller migreras med Better Auths egen migrerare. Appens schemaändringar ska vara additiva och bakåtkompatibla.

`vercel env pull` skriver över målfilen och preview-hemligheter följer inte med. Behåll lokala utvecklingsvärden separat och skriv inte över en fungerande `.env.local`. Inga `.env`-filer eller registreringskoder får committas.

## Kontroller

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Webbläsartesterna täcker mobilnavigation, PWA-ikoner/offline, registreringskod, skyddat administratörskonto, inloggning, sparade kallelsesvar, CSRF och behörigheter för laguppställningen. De skapar och städar bort två specifika QA-konton. Kör mot utvecklingsdatabasen, aldrig mot produktion. CI använder en disponibel Postgres-databas och en normaliserad matchfixture för att vara oberoende av Korpens tillgänglighet. Produktionsappen använder alltid Korpens riktiga data.

## Brancher och release

Utveckling sker via `feature/*` → `pre` → `main`.

1. Skapa `feature/beskrivning` från uppdaterad `pre`.
2. Pusha och öppna PR till `pre`. Actions kontrollerar källbranch, typer, tester, bygge och webbläsarflöden. Vercel bygger en Preview.
3. Efter gröna kontroller mergas PR:en till `pre`. Granska https://inkastarna-pre.vercel.app.
4. Kör **Actions → Prepare production release** på `main`, eller öppna en PR från `pre` till `main`.
5. Produktion släpps först efter godkända kontroller och uttryckligt klartecken från lagägaren. Workflow skapar enbart release-PR:en; det mergar aldrig självt. Merge till `main` triggar produktionsbygget på Vercel.

GitHub ska kräva `Validate source branch` och `Build and test` på `pre` och `main`, även för administratörer. Direkta pushar, force push och branchradering ska vara blockerade. Endast `pre` får vara källbranch för PR till `main`. Vercels produktionsbranch ska vara `main`. Delad preview-domän är knuten till `pre`.

Nya feature- och pre-byggen använder endast preview-databasen. Migrering körs före Vercel-bygget mot respektive miljös databas. Lösenord, sessionsnycklar, databasanslutningar och inbjudningskoder hanteras som serverhemligheter i Vercel.
