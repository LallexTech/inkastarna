# Inkastarna

Lagappen för Inkastarna. Innefotboll, 2 × 15 minuter, Stora Mossen. Next.js, React, Better Auth och Neon Postgres, drift på Netlify.

- Förhandsmiljö: https://pre--inkastarna.netlify.app
- Produktion efter releasegodkännande: https://inkastarna.netlify.app
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

Miljövariabler sätts i Netlify, med separata värden för `production` respektive `branch-deploy` och `deploy-preview`. Behåll lokala utvecklingsvärden i `.env.local`. Inga `.env`-filer, API-token eller registreringskoder får committas. Netlifys Free-plan använder vanliga servervariabler; de är läsbara för projektadministratören men skickas aldrig till webbläsaren. Ingen `NEXT_PUBLIC_`-variabel får innehålla en hemlighet.

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
2. Pusha och öppna PR till `pre`. Actions kontrollerar källbranch, typer, tester, bygge och webbläsarflöden. Netlify bygger en Preview.
3. Efter gröna kontroller mergas PR:en till `pre`. Granska https://pre--inkastarna.netlify.app.
4. Kör **Actions → Prepare production release** på `main`, eller öppna en PR från `pre` till `main`.
5. Produktion släpps först efter godkända kontroller och uttryckligt klartecken från lagägaren. Workflow skapar enbart release-PR:en; det mergar aldrig självt. Merge till `main` triggar produktionsbygget på Netlify.

GitHub ska kräva `Validate source branch`, `Build and test` och `Netlify preview` på `pre` och `main`, även för administratörer. Direkta pushar, force push och branchradering ska vara blockerade. Endast `pre` får vara källbranch för PR till `main`. Netlifys produktionsbranch är `main`. Branch `pre` bygger den delade förhandsmiljön `pre--inkastarna.netlify.app`. PR:er får egna förhandsbyggen. GitHub-kontrollen `Netlify preview` verifierar att rätt commit har ett färdigt Netlify-bygge.

Nya feature- och pre-byggen använder endast preview-databasen. Migrering körs före Netlify-bygget mot respektive miljös databas. Lösenord, sessionsnycklar, databasanslutningar och inbjudningskoder hanteras som servervariabler i Netlify.

## Hosting och kostnad

Projektet flyttades från Vercel efter en teamgemensam CPU-spärr utlöst av ett annat projekt. Netlify Free har 300 krediter per månad och kan också pausa sajter när gränsen nås. Förhandsbyggen används för utveckling; publicera produktion först när en release är granskad. Kontrollera aktuella priser och förbrukning i Netlify. Neon-databaserna är oförändrade och oberoende av Vercels compute-spärr.

GitHub ansluter via en läsbehörig deploynyckel för just det här repot och en webhook. GitHub Actions använder `NETLIFY_AUTH_TOKEN` som repository secret och `NETLIFY_SITE_ID` som repository variable för att verifiera bygget. Kopiera aldrig dessa värden till källkod. Netlifys schemalagda funktion anropar `/api/sync` med `CRON_SECRET` endast i produktion. Vercel-konfigurationen behålls som referens men används inte för den nya driften.
