# ChatnMates (WhatsApp-like Demo)

Fullstack Demo mit:
- Registrierung + Login (Session-Token)
- Kontaktanfragen + Freundesliste (nur bestaetigte Kontakte sichtbar)
- Private 1:1 Chats in Echtzeit
- Gruppen erstellen und in Gruppen chatten
- Kontakt loeschen und Chatverlauf leeren (Direktchat/Gruppe)
- Emoji-Quick-Buttons im Chat
- Status-Updates (laufen nach 24h ab)
- 1:1 Audio/Video-Anrufe via WebRTC (Signaling über Socket.IO)
- PostgreSQL Persistenz (Accounts, Chats, Status)

## Lokal starten (mit PostgreSQL)

Voraussetzung: PostgreSQL läuft lokal und `DATABASE_URL` ist gesetzt.

PowerShell Beispiel:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/chatnmates"
npm install
npm start
```

Dann im Browser:

`http://localhost:3000`

## Online deployen (Render Free)

1. Code in dein GitHub-Repo pushen.
2. Auf https://render.com einloggen.
3. `New +` -> `Blueprint` waehlen.
4. Repository verbinden.
5. Render liest `render.yaml` und erstellt Web-Service + PostgreSQL.
6. Deploy starten.

## Wichtige Env-Variablen

- `PORT` wird vom Hoster gesetzt.
- `DATABASE_URL` ist Pflicht (wird in `render.yaml` aus der DB gesetzt).
- `ENABLE_BOTS`:
  - `false` (empfohlen fuer echte Nutzung mit Freunden)
  - `true` (wenn du Test-Bots willst)

## Hinweise

- Kontakte bleiben sichtbar und wechseln auf `offline`, wenn jemand den Browser schliesst.
- Sessions liegen derzeit in-memory (bei Neustart erneuter Login noetig).
- Keine Ende-zu-Ende-Verschluesselung.
- Render Free PostgreSQL hat Limits und kann ablaufen.
