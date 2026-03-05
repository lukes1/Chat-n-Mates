import argparse
import sys
import time
from dataclasses import dataclass

import serial


@dataclass(frozen=True)
class ServoDef:
    board: str
    min_angle: int
    max_angle: int
    start_angle: int


SERVO_DEFS = {
    "JAW": ServoDef("A", 0, 40, 0),
    "HEAD_TURN": ServoDef("A", 0, 180, 90),
    "HEAD_LR": ServoDef("B", 35, 145, 90),
    "HEAD_UD": ServoDef("B", 20, 130, 80),
}


class ArduinoLink:
    def __init__(self, name: str, port: str, baud: int, timeout: float = 1.0):
        self.name = name
        self.port = port
        self.ser = serial.Serial(port=port, baudrate=baud, timeout=timeout)

    def warmup(self) -> None:
        time.sleep(2.0)
        self.ser.reset_input_buffer()

    def send(self, command: str) -> str:
        self.ser.write((command + "\n").encode("ascii"))
        self.ser.flush()
        reply = self.ser.readline().decode("ascii", errors="replace").strip()
        return reply

    def close(self) -> None:
        if self.ser and self.ser.is_open:
            self.ser.close()


def clamp(value: int, min_value: int, max_value: int) -> int:
    return max(min_value, min(max_value, value))


def run_cli(link_a: ArduinoLink, link_b: ArduinoLink) -> None:
    links = {"A": link_a, "B": link_b}

    print("Verbunden. Befehle: home | status | set <SERVO> <WINKEL> | quit")

    while True:
        try:
            raw = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBeende.")
            return

        if not raw:
            continue

        parts = raw.split()
        cmd = parts[0].lower()

        if cmd in ("quit", "exit"):
            return

        if cmd == "home":
            print(f"A: {link_a.send('HOME')}")
            print(f"B: {link_b.send('HOME')}")
            continue

        if cmd == "status":
            print(f"A: {link_a.send('PING')}")
            print(f"A: {link_a.send('LIST')}")
            print(f"B: {link_b.send('PING')}")
            print(f"B: {link_b.send('LIST')}")
            continue

        if cmd == "set":
            if len(parts) != 3:
                print("Fehler: set <SERVO> <WINKEL>")
                continue

            servo_name = parts[1].upper()
            if servo_name not in SERVO_DEFS:
                print(f"Fehler: unbekanntes Servo '{servo_name}'")
                continue

            try:
                angle = int(parts[2])
            except ValueError:
                print("Fehler: Winkel muss eine Zahl sein")
                continue

            cfg = SERVO_DEFS[servo_name]
            safe_angle = clamp(angle, cfg.min_angle, cfg.max_angle)
            link = links[cfg.board]
            reply = link.send(f"SET {servo_name} {safe_angle}")
            print(f"{cfg.board}: {reply}")
            continue

        print("Unbekannter Befehl")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="InMoov Dual Arduino Controller")
    parser.add_argument("--port-a", required=True, help="COM-Port fuer Arduino A (z.B. COM5)")
    parser.add_argument("--port-b", required=True, help="COM-Port fuer Arduino B (z.B. COM6)")
    parser.add_argument("--baud", type=int, default=115200, help="Baudrate (default: 115200)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        link_a = ArduinoLink("A", args.port_a, args.baud)
        link_b = ArduinoLink("B", args.port_b, args.baud)
    except serial.SerialException as exc:
        print(f"Serial-Fehler beim Oeffnen: {exc}")
        return 1

    try:
        link_a.warmup()
        link_b.warmup()

        print(f"A: {link_a.send('PING')}")
        print(f"B: {link_b.send('PING')}")
        print(f"A: {link_a.send('HOME')}")
        print(f"B: {link_b.send('HOME')}")

        run_cli(link_a, link_b)
        return 0
    finally:
        link_a.close()
        link_b.close()


if __name__ == "__main__":
    sys.exit(main())
