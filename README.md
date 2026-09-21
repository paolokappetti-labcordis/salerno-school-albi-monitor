# Monitor albi scuole della provincia di Salerno

Monitor giornaliero degli albi online di 96 istituzioni scolastiche statali della provincia di Salerno.

## Funzionamento

- esegue il controllo ogni giorno alle 06:15 UTC;
- usa Chromium tramite Playwright per gestire anche portali dinamici;
- cerca nuove pubblicazioni relative a bandi, corsi, formazione, esperti, formatori e tutor;
- al primo avvio crea una baseline senza inviare le pubblicazioni già presenti;
- dalle esecuzioni successive invia una sola email riepilogativa quando trova novità pertinenti;
- conserva lo stato nel file `school-albi-state.json`.

## Configurazione richiesta

Nelle impostazioni del repository, in **Settings → Secrets and variables → Actions**, devono essere presenti:

- `GMAIL_USERNAME`: account Gmail mittente e destinatario predefinito;
- `GMAIL_APP_PASSWORD`: password per app di Google.

Facoltativamente si può aggiungere `EMAIL_RECIPIENT` per usare un destinatario diverso dal mittente.

Le credenziali non devono essere inserite nei file del repository.

## Avvio manuale

Aprire **Actions → Monitor giornaliero albi scuole Salerno → Run workflow**.

## Fonte dell'elenco

MIM Open Data, anagrafe scuole 2026/27, con verifica automatica degli albi eseguita il 19 settembre 2026.
