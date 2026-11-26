#!/usr/bin/env python3
"""Lint untuk aturan khas Arduino IDE yang TIDAK tertangkap kompiler host biasa.

1. Tipe (struct/enum/class/union) harus didefinisikan SEBELUM fungsi pertama.
   Arduino IDE membuat prototipe fungsi otomatis di atas fungsi pertama; jika tipe parameter/return belum
   dikenal di titik itu -> "'Reading' does not name a type".
2. Jangan memakai nama yang bentrok dengan konstanta bawaan board ESP32 (pins_arduino.h):
   T0..T9, A0..A19, SDA, SCL, SS, MOSI, MISO, SCK, TX, RX, DAC1, DAC2, LED_BUILTIN.
3. Hindari default argument pada fungsi di .ino (prototipe otomatis bisa menggandakannya).

Pakai:  python3 -I lint_arduino_sketch.py file.ino [file2.ino ...]
"""
import re
import sys

CORE_NAMES = {f'T{i}' for i in range(10)} | {f'A{i}' for i in range(20)} | \
    {'SDA', 'SCL', 'SS', 'MOSI', 'MISO', 'SCK', 'TX', 'RX', 'DAC1', 'DAC2', 'LED_BUILTIN', 'BUILTIN_LED'}
KEYWORDS = {'if', 'for', 'while', 'switch', 'else', 'do', 'return', 'sizeof'}


def strip(src: str) -> str:
    src = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), src, flags=re.S)
    src = re.sub(r'//[^\n]*', '', src)
    src = re.sub(r'"(?:\\.|[^"\\])*"', '""', src)
    src = re.sub(r"'(?:\\.|[^'\\])+'", "' '", src)
    return src


def lint(path: str) -> list:
    raw = open(path, encoding='utf-8').read()
    code = strip(raw)
    lines = code.split('\n')
    errs = []

    # fungsi pertama (definisi di kolom 0, bukan tipe/kontrol)
    func_re = re.compile(r'^(?!\s)(?!struct\b|enum\b|class\b|union\b|typedef\b|#|namespace\b)[\w:<>\*&\s]+?[\s\*&]+(\w+)\s*\([^;{]*\)\s*(?:const\s*)?\{')
    first_func = None
    for i, ln in enumerate(lines, 1):
        m = func_re.match(ln)
        if m and m.group(1) not in KEYWORDS:
            first_func = (i, m.group(1))
            break

    type_re = re.compile(r'^\s*(?:typedef\s+)?(struct|enum(?:\s+class)?|class|union)\s+(\w+)\s*(?::\s*\w+\s*)?\{')
    for i, ln in enumerate(lines, 1):
        m = type_re.match(ln)
        if m and first_func and i > first_func[0]:
            errs.append(f'{path}:{i}: {m.group(1)} {m.group(2)} didefinisikan SETELAH fungsi pertama '
                        f'({first_func[1]}() di baris {first_func[0]}) -> pindahkan ke atas fungsi pertama')

    for i, ln in enumerate(lines, 1):
        for name in re.findall(r'\b([A-Za-z_]\w*)\b', ln):
            if name in CORE_NAMES and not ln.lstrip().startswith('#include'):
                errs.append(f'{path}:{i}: identifier "{name}" bentrok dengan konstanta bawaan board ESP32 -> ganti nama')
                break
        if func_re.match(ln) and re.search(r'\(\s*[^)]*\b\w+\s*=\s*[^,)]+', ln.split('{')[0]):
            errs.append(f'{path}:{i}: default argument pada definisi fungsi -> pecah jadi dua fungsi')
    return errs


def main():
    bad = []
    for p in sys.argv[1:]:
        e = lint(p)
        bad += e
        print(('FAIL ' if e else 'ok   ') + p)
    for e in bad:
        print('  ' + e)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
