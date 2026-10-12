# Kontrollassistent: Trenger oppfølging

ADMIN finner blokken under Aktivitet i dag / Gjøremål, før Lønnskostnader i Oversikt. En regelbasert kontroll kjøres i databasen hvert femte minutt og ved oppdatering av blokken. Det benyttes ingen ekstern språkmodell og ingen nye meldinger sendes til ansatte.

## Regler

Kontrollperioden er forrige, inneværende og neste uke, bestemt i Europe/Oslo. Åpne stemplinger og usendte utstemplingsvarsler kontrolleres uten aldersgrense. Andre historiske avvik faller ut når kontrollperioden flyttes.

- Automatisk utstemplede registreringer som ikke er godkjent.
- Åpen stempling minst 30 minutter etter planlagt slutt, eller etter 11,5 timer dersom publisert vakt ikke kan kobles til registreringen.
- Manglende stempling minst 30 minutter etter publisert vaktstart. Registrert fravær og avklaringer i Ukesluttkontroll hensyntas. Dette er en kontrolloppgave, ikke en konklusjon om at den ansatte har uteblitt.
- Minst 15 minutters avvik ved start eller slutt på avsluttede arbeidsregistreringer som ikke allerede er godkjent. Automatisk utstemplede får eget varsel.
- Overlappende tidsregistreringer, og overlappende planlagte vakter for samme ansatt. Vakters slutt er eksklusiv: 16–23 og 23–07 overlapper ikke.
- Planlagt vakt som berører sykefravær eller godkjent ferie/permisjon, også over midnatt. Avviste/slettede fravær teller ikke. Ingen helsenotater eller diagnoser leses.
- Planlagte timer over veiledende ukenorm: 165 × 12 / 52 × stillingsprosent / 100. Dette er ikke en juridisk grense eller en konklusjon om feil stillingsprosent.
- Varsel om automatisk utstempling som fortsatt ikke er sendt etter fem minutter, eller er merket for manuell oppfølging.

Stempling kontrolleres mot publisert øyeblikksbilde av vaktlisten, slik ansatte har sett det. Overlapp, fravær og stillingsprosent kontrolleres mot den gjeldende planen, inkludert upubliserte endringer. Timenes varighet er faktisk medgått tid, også ved sommertid/vintertid. En registrering kobles til nærmeste overlappende vakt innen tolv timer fra planlagt start, med eksplisitt vakttilknytning først; samme prinsipp brukes i Ukesluttkontroll.

Tomme visuelle plasser regnes ikke som ubemannede skift fordi systemet ikke har et definert minimumsbehov for bemanning.

## Saksbehandling

Velg område og status. Åpne stempling/vaktliste eller gå til den ansattes uke. «Marker behandlet» krever kommentar. Endring av timer, vaktliste, fravær eller lønn skjer fortsatt gjennom eksisterende funksjoner og krever ADMIN-handling.

Grunnlaget får et fingeravtrykk. Behandlede saker forblir behandlet ved uendret grunnlag; de gjenåpnes automatisk ved relevante endringer eller dersom et forsvunnet avvik kommer tilbake. Korrigerte avvik og saker utenfor perioden vises som «Ikke lenger i kontrollen», uten å påstå at en person har behandlet dem. Tidligere kommentar og auditlogg beholdes. Manuell gjenåpning krever ny kommentar. Samtidige/stale behandlinger avvises.

Historikk vises i 90 dager, med maksimum 1000 saker og tydelig avkortingsvarsel. Åpne saker prioriteres. Grensesnittet viser ti kort om gangen og har «Vis flere».

## Drift og tilgang

`control-assistant` krever gyldig innlogging og aktiv ADMIN i riktig organisasjon. Databasens RPC bekrefter ADMIN på nytt. Tabellene har RLS og ingen tilgang for anon/authenticated; bare tjenesten har eksplisitte rettigheter. Behandlingshistorikk loggføres med autentisert aktør. Forespørsler kan ikke bestemme organisasjon eller aktør.

`apart-control-assistant` kjører `scan_control_alerts()` hvert femte minutt. Bakgrunnsstatus og siste vellykkede automatiske utstemplingsjobb vises som driftsvarsel ved manglende kjøring. Manglende e-postnøkkel vises separat uten å eksponere nøkkelen. Ingen ekstra API-nøkkel eller AI-abonnement kreves for denne versjonen.

## Verifisering

`tests/control-assistant.sql` bruker syntetiske data i en transaksjon som tilbakeføres. Den dekker de ni kontrollene, nattevakt/fravær over midnatt, publisert kontra upublisert vaktliste, ingen lønnsendring ved behandling, gjenåpning ved nye tider, foreldet grunnlag, organisasjonsisolasjon og auditlogg. Edge- og DOM-tester kontrollerer ADMIN-tilgang, nyttelast, filtrering, kommentarer, avbryt, snarveier og HTML-escaping.
