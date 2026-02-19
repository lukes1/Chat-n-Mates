# ChatWave (WhatsApp-like Demo)

Fullstack Demo mit:
- Registrierung + Login (Session-Token)
- Private 1:1 Chats in Echtzeit
- Status-Updates (laufen nach 24h ab)
- 1:1 Audio/Video-Anrufe via WebRTC (Signaling über Socket.IO)

## Lokal starten

```bash
npm install
npm start
```

Dann im Browser:

`http://localhost:3000`

## Nutzung

1. In der Login-Maske registrieren (`Username`, `Passwort`).
2. Mit dem Account einloggen.
3. In einem zweiten Browser/Inkognito mit einem zweiten Account einloggen.
4. Chat, Status und Call testen.

## Online deployen (Render)

1. Code in dein GitHub-Repo pushen.
2. Auf https://render.com einloggen.
3. `New +` -> `Blueprint` waehlen.
4. Repository verbinden.
5. Render liest automatisch `render.yaml`.
6. Deploy starten.
7. Nach dem Deploy bekommst du eine URL wie:
   `https://chatwave-xxxx.onrender.com`

## Wichtige Env-Variablen

- `PORT` wird vom Hoster gesetzt.
- `ENABLE_BOTS`:
  - `false` (empfohlen fuer echte Nutzung mit Freunden)
  - `true` (wenn du Test-Bots willst)

## Hinweise

- Accounts, Sessions, Chats und Status liegen aktuell nur im RAM.
- Nach Server-Neustart sind Daten weg.
- Keine Ende-zu-Ende-Verschluesselung.
- Fuer Produktion fehlen u.a. Datenbank, Password-Reset, TURN-Server, Security-Hardening.
