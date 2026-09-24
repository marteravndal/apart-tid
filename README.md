# Apart Tid

Tidsregistrering, rapportering og HMS for Apart Stavanger AS.

Frontend publiseres fra `main` til Vercel-prosjektet `apart-tid`. Supabase-funksjoner ligger under `supabase/functions`.

Systemet skal bruke et eget Supabase-prosjekt. Ingen ansatte, filer eller øvrige virksomhetsdata fra Augustum Tid skal importeres.

Hemmeligheter og miljøvariabler skal aldri lagres i repositoriet.

Git-integrasjonen brukes først på testprosjektet før produksjon.

## Automatiske lønnstillegg

Ved månedslåsing beregnes tillegg fra faktiske inn- og utstemplinger i tidssonen `Europe/Oslo`:

- Lønnsart 10105, kveldstillegg 12,20 kr/time: mandag-fredag kl. 21.00-24.00.
- Lønnsart 10104, nattillegg 23,19 kr/time: alle dager kl. 00.00-06.00.
- Lønnsart 10106, helgetillegg 23,19 kr/time: lørdag kl. 18.00-24.00 og søndag kl. 06.00-24.00.

Intervallene er gjensidig utelukkende. Vakter over midnatt deles ved døgnskiftet, og sommertid håndteres etter faktisk forløpt tid.
