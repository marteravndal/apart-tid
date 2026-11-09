# Egendefinerte skift

ADMIN kan velge «Egendefinert skift» under «+ Vakt», eller trykke på pluss i den nye raden nederst i vaktlisten. Start og slutt velges fritt, med minuttpresisjon. Ved redigering beholdes lagrede tider. Bytte fra en standardtype til egendefinert beholder tidene i skjemaet.

Vakten føres på startdatoen. Slutt før start betyr neste dag. Like klokkeslett avvises; skjemaet viser varighet og sluttdag. Eksisterende kontroller for overlapp, aktiv ansatt og registrert fravær gjelder også egendefinerte vakter. Feil vises i skjemaet uten å fjerne innholdet.

Alle dager reserverer like mange egendefinerte rader, minimum én og ellers etter dagen med flest slike vakter. Standardradene for dag, kveld og de to nattskiftene beholdes. Vakten vises med samme type i ansattkalender og admin-appen. Kopiering og publisering bruker samme flyt som før. Tillegg og kostnader beregnes etter faktiske klokkeslett, ikke skiftnavnet.

## Leveranse

- Migrasjon `20261109111617_allow_custom_roster_shifts.sql` utvider eksisterende typebegrensning; ingen data eller tilganger endres.
- Edge-funksjonene `roster` og `admin-dashboard` støtter den nye typen.
- Frontend inkluderer egne rader, etiketter, validering og service worker cache v24.

## Verifisering

`node --test tests/custom-shifts.test.cjs` tester lagring/redigering, vilkårlige minutter, midnatt, avvisning av like/ugyldige tider, overlapp/fravær og administratorrettigheter med syntetiske data.

`NODE_PATH=../test-runtime/node_modules node tests/custom-shifts.dom.cjs` tester skjema og innsendte data, tomme startfelt, likt antall rader per dag, feilbevaring, ansattvisning og tilleggsberegning i jsdom. Dette er ikke en nettleserbasert layouttest.

Den konkrete feilmeldingen brukeren tidligere fikk er ikke identifisert. Denne endringen omgår ikke gyldige fraværs- eller overlappkontroller.
