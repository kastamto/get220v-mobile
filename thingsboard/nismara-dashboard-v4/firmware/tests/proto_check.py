#!/usr/bin/env python3
"""Meniru pra-proses Arduino IDE: sisipkan prototipe fungsi otomatis di atas FUNGSI PERTAMA, lalu kompilasi
(syntax-only) dengan stub host yang juga mendefinisikan konstanta pin bawaan ESP32 (T0..T9, SDA, SCL, ...).
Menangkap: tipe didefinisikan terlambat ('X' does not name a type) dan bentrok nama dengan core.

Pakai:  python3 -I proto_check.py <sketch.ino> <stubs_dir> <sketch_dir_untuk_config.h>
"""
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lint_arduino_sketch as L  # noqa: E402


def main():
    ino, stubs, sketch_dir = sys.argv[1:4]
    raw = open(ino, encoding='utf-8').read()
    raw_lines = raw.split('\n')
    code_lines = L.strip(raw).split('\n')
    protos, first = [], None
    func_re = re.compile(r'^(?!\s)(?!struct\b|enum\b|class\b|union\b|typedef\b|#|namespace\b)[\w:<>\*&\s]+?[\s\*&]+(\w+)\s*\(([^;{]*)\)\s*(?:const\s*)?\{')
    for i, ln in enumerate(code_lines):
        m = func_re.match(ln)
        if m and m.group(1) not in L.KEYWORDS:
            sig = ln[:m.end() - 1].strip()          # sampai '{' PERTAMA (fungsi satu baris punya banyak '{')
            protos.append(sig + ';')
            if first is None:
                first = i
    out = raw_lines[:first] + ['// --- prototipe otomatis (ditiru dari Arduino IDE) ---'] + protos + ['// ---'] + raw_lines[first:]
    with tempfile.TemporaryDirectory() as td:
        cpp = os.path.join(td, 'sketch.cpp')
        open(cpp, 'w', encoding='utf-8').write('\n'.join(out))
        r = subprocess.run(['g++', '-std=c++17', '-fsyntax-only', '-Wno-format-truncation', f'-I{stubs}', f'-I{sketch_dir}', cpp],
                           capture_output=True, text=True)
    errs = [l for l in r.stderr.split('\n') if 'error' in l]
    print(('FAIL ' if errs else 'ok   ') + ino + f'  ({len(protos)} prototipe otomatis disisipkan sebelum baris {first + 1})')
    for e in errs[:8]:
        print('  ' + e.replace(td, ''))
    sys.exit(1 if errs else 0)


if __name__ == '__main__':
    main()
