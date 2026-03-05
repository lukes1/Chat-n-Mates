#include <Servo.h>
#include <string.h>
#include <stdlib.h>

struct ServoConfig {
  const char* name;
  uint8_t pin;
  int minAngle;
  int maxAngle;
  int startAngle;
  Servo servo;
};

const char* BOARD_NAME = "ARDUINO_A";
const unsigned long SERIAL_BAUD = 115200;

const uint8_t PIN_JAW = 5;
const uint8_t PIN_HEAD_TURN = 6;

ServoConfig servos[] = {
  {"JAW", PIN_JAW, 0, 40, 0},
  {"HEAD_TURN", PIN_HEAD_TURN, 0, 180, 90}
};

const int SERVO_COUNT = sizeof(servos) / sizeof(servos[0]);

char lineBuffer[64];
size_t lineIndex = 0;

int clampAngle(int value, int minValue, int maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

ServoConfig* findServo(const char* name) {
  for (int i = 0; i < SERVO_COUNT; i++) {
    if (strcmp(servos[i].name, name) == 0) {
      return &servos[i];
    }
  }
  return NULL;
}

void writeHome() {
  for (int i = 0; i < SERVO_COUNT; i++) {
    servos[i].servo.write(servos[i].startAngle);
  }
}

void handleCommand(char* line) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;

  if (strcmp(cmd, "PING") == 0) {
    Serial.print("PONG ");
    Serial.println(BOARD_NAME);
    return;
  }

  if (strcmp(cmd, "LIST") == 0) {
    Serial.print("OK LIST");
    for (int i = 0; i < SERVO_COUNT; i++) {
      Serial.print(" ");
      Serial.print(servos[i].name);
      Serial.print("=");
      Serial.print(servos[i].minAngle);
      Serial.print("..");
      Serial.print(servos[i].maxAngle);
    }
    Serial.println();
    return;
  }

  if (strcmp(cmd, "HOME") == 0) {
    writeHome();
    Serial.println("OK HOME");
    return;
  }

  if (strcmp(cmd, "SET") == 0) {
    char* name = strtok(NULL, " ");
    char* angleRaw = strtok(NULL, " ");

    if (!name || !angleRaw) {
      Serial.println("ERR BAD_SET_FORMAT");
      return;
    }

    ServoConfig* target = findServo(name);
    if (!target) {
      Serial.print("ERR UNKNOWN_SERVO ");
      Serial.println(name);
      return;
    }

    int angle = atoi(angleRaw);
    int safeAngle = clampAngle(angle, target->minAngle, target->maxAngle);
    target->servo.write(safeAngle);

    Serial.print("OK SET ");
    Serial.print(target->name);
    Serial.print(" ");
    Serial.println(safeAngle);
    return;
  }

  Serial.print("ERR UNKNOWN_CMD ");
  Serial.println(cmd);
}

void setup() {
  Serial.begin(SERIAL_BAUD);

  for (int i = 0; i < SERVO_COUNT; i++) {
    servos[i].servo.attach(servos[i].pin);
    servos[i].servo.write(servos[i].startAngle);
  }

  Serial.println("READY ARDUINO_A");
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\r') {
      continue;
    }

    if (c == '\n') {
      lineBuffer[lineIndex] = '\0';
      handleCommand(lineBuffer);
      lineIndex = 0;
      continue;
    }

    if (lineIndex < sizeof(lineBuffer) - 1) {
      lineBuffer[lineIndex++] = c;
    }
  }
}
