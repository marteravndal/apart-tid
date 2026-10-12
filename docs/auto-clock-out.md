# Automatisk utstempling

Åpne arbeidsregistreringer avsluttes etter 12 løpende timer. Supabase Cron kjører hvert minutt og setter sluttiden til starttid + 12 timer, også ved forsinket kjøring og overgang til/fra sommertid. Funksjonen kjører uten at noen har appen åpen.

Registreringen får `auto_clocked_out=true`, en merknad og en `auto_clock_out`-hendelse med før-/ettertid og ST-referanse. Eksisterende godkjenninger nullstilles. Låste lønnsperioder omgås aldri. Historikken/merkingen beholdes ved ADMIN-korrigering og arkivering. Ukesluttkontroll krever fortsatt manuell godkjenning.

Merkingen «Automatisk utstemplet» vises i ansattes timeliste, ADMINs stemplingslogg, Stempling og Ukesluttkontroll. Ansattes åpne stemplingsstatus oppdateres hvert minutt når siden er synlig.

## E-post og drift

Utstempling, historikk og to varslingsjobber lagres atomisk. Mottakere er den aktuelle ansattes registrerte e-postadresse og ADMIN-adressen post@apartstavanger.no. Avsender er Apart Tid <post@apartstavanger.no>. E-posten ber om korrigering av faktisk arbeidstid; den innfører ikke automatisk lønnstrekk.

E-post krever `RESEND_API_KEY` i Supabase → Edge Functions → Secrets og godkjent avsenderdomene hos Resend. Uten nøkkelen fungerer utstemplingen, mens varslene blir liggende i kø. Under Stempling vises status separat for ansatt og ADMIN. «Sendt» betyr at e-postleverandøren har akseptert meldingen, ikke bekreftet levering til innboksen.

Cron bruker en dedikert hemmelighet lagret i Vault. Worker-endepunktet har egen autentisering med SHA-256-kontroll; det er ikke et offentlig sende-endepunkt. Verken ansatte eller anonyme brukere kan lese køen, lese konfigurasjonen eller kjøre RPC-funksjonene. Forespørselens innhold kan ikke velge mottaker eller e-posttekst.

Hver melding har en arbeidslås og fast idempotensnøkkel. Midlertidige feil forsøkes igjen, med økende ventetid. Etter 23 timer fra første forsøk stoppes automatisk sending for å unngå å sende på nytt etter utløpet av Resends 24-timers idempotensvindu. Slike meldinger merkes for manuell oppfølging. Kontroller eventuell levering hos leverandøren før ny sending. Det opprettes ingen ny melding ved gjentatt kjøring av utstemplingsjobben.

Overvåk `cron.job_run_details`, `net._http_response`, køens `needs_review/last_error` og `audit_logs` med handling `auto_clock_out_failed`. Lønnsdata som er låst krever manuell avklaring; feil på én registrering stanser ikke resten.

## Kontrollert før publisering

- SQL-test med tilbakeføring: 12-timersgrense, ikke for tidlig, ingen endring av manuelt avsluttede vakter, to mottakere, auditlogg, ingen duplikater, korrigering beholder merking, låste perioder, ugyldig arbeidslås og feil-/sendestatus.
- Isolert worker-test: avvist uautorisert kall, Oslo-tid ved vintertidsovergang, begge e-posttekster, idempotent forsøk, HTTP 429, nettverksfeil og permanent avvisning.
- DOM/API-tester med syntetiske data: ansattvisning, ADMIN-logg, Stempling og Ukesluttkontroll. Ingen testepost sendes til ansatte.
