# InMoov Dual Arduino Control

Dieses Setup verbindet einen PC mit 2 Arduinos per Serial.

## Servo-Aufteilung (Default)
- Arduino A: `JAW`, `HEAD_TURN`
- Arduino B: `HEAD_LR`, `HEAD_UD`

## Servo-Werte
- `JAW`: Start `0`, Bereich `0..40`
- `HEAD_TURN`: Start `90`, Bereich `0..180`
- `HEAD_LR`: Start `90`, Bereich `35..145`
- `HEAD_UD`: Start `80`, Bereich `20..130`

## 1) Arduino flashen
1. `inmoov/arduino/inmoov_arduino_a.ino` auf Arduino A laden.
2. `inmoov/arduino/inmoov_arduino_b.ino` auf Arduino B laden.
3. Baudrate in beiden Sketchen: `115200`.

Hinweis: Passe bei Bedarf nur die `PIN_*` Konstanten an deine Verdrahtung an.

## 2) Python installieren
```powershell
pip install pyserial
```

## 3) Start
```powershell
python inmoov/python/inmoov_controller.py --port-a COM5 --port-b COM6
```

Dann in der Konsole Befehle eingeben:
- `home`
- `set JAW 20`
- `set HEAD_TURN 120`
- `set HEAD_LR 70`
- `set HEAD_UD 100`
- `status`
- `quit`

## Serial-Protokoll (PC -> Arduino)
- `PING`
- `LIST`
- `HOME`
- `SET <NAME> <ANGLE>`

Antworten (Arduino -> PC):
- `PONG <BOARD>`
- `OK LIST <...>`
- `OK HOME`
- `OK SET <NAME> <ANGLE>`
- `ERR <...>`
